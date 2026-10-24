/**
 * Priora — Auditoria Documental
 * Camada Clara (Blueprint Cap. 7). Ela NÃO executa regras nem lê PDFs: recebe o
 * resultado já produzido pelos Playbooks e o TRADUZ para linguagem operacional
 * — resume, prioriza, orienta. Responde só a 4 perguntas (7.8): o que foi
 * encontrado, o que exige atenção, o que depende do analista, qual o próximo
 * passo. Sem porcentagens de confiança (7.11), sem inventar (7.16).
 *
 * Se a IA estiver indisponível, cai para um resumo DETERMINÍSTICO (nunca quebra).
 */
import { z } from 'zod/v4';
import { generateStructured, isAiConfigured } from '../ai/geminiClient';
import { ResultadoAuditoria } from './playbooks';

export interface ResumoClara {
  linhas: string[];
  proximoPasso: string;
  fonte: 'ia' | 'deterministico';
}

const ClaraSchema = z.object({
  linhas: z.array(z.string()),
  proximoPasso: z.string(),
});

/** O3.4: documentos cuja ausência NÃO pode ser afirmada — a leitura deles falhou agora e será refeita. */
export interface OpcoesResumoClara {
  documentosNaoLidos?: string[];
}

/** Resumo determinístico — usado como fallback e como base factual. */
function resumoDeterministico(r: ResultadoAuditoria, naoLidos: string[] = []): ResumoClara {
  const { resumo, documentosAusentes, evidencias } = r;
  const linhas: string[] = [];
  linhas.push(
    `${resumo.total} validações executadas — ${resumo.consistentes} consistentes, ` +
      `${resumo.divergencias} divergência(s), ${resumo.validacoesHumanas} para conferência humana.`,
  );
  const divs = evidencias.filter((e) => e.resultado === 'Divergência').slice(0, 3);
  for (const d of divs) {
    linhas.push(`${d.campo}${d.container ? ` (container ${d.container})` : ''}: ${d.motivo}`);
  }
  if (documentosAusentes.length) {
    linhas.push(
      `Documentos ausentes: ${documentosAusentes.join(', ')} — a auditoria permanece parcial.`,
    );
  }
  if (naoLidos.length) {
    linhas.push(
      `Não foi possível ler agora: ${naoLidos.join(', ')} — nada é concluído sobre ${naoLidos.length === 1 ? 'esse documento' : 'esses documentos'} até a nova leitura.`,
    );
  }
  let proximoPasso: string;
  if (resumo.divergencias > 0)
    proximoPasso = 'Solicitar correção ao agente para as divergências antes de emitir o CE.';
  else if (resumo.validacoesHumanas > 0)
    proximoPasso = 'Confirmar manualmente os campos de validação humana (frete/THC).';
  else if (naoLidos.length > 0)
    proximoPasso = `Reprocessar a auditoria em instantes para ler ${naoLidos.join(', ')}.`;
  else if (documentosAusentes.length > 0)
    proximoPasso = 'Anexar os documentos ausentes para completar a auditoria.';
  else proximoPasso = 'Confirmar a auditoria — nenhuma inconsistência nos campos avaliados.';
  return { linhas, proximoPasso, fonte: 'deterministico' };
}

const SYSTEM_PROMPT = `Você é a Clara, analista sênior de comércio exterior. Recebe o RESULTADO de uma auditoria documental já executada (validações determinísticas) e o traduz para o analista.

Regras (obrigatórias):
- NUNCA invente. Baseie-se só nas evidências recebidas.
- NUNCA diga que um campo de "validação humana" está correto — apenas apresente.
- Não use porcentagens de confiança, emojis, nem entusiasmo. Tom de analista experiente, objetivo.
- Seja breve. "linhas": 2 a 4 frases curtas respondendo: o que foi encontrado, o que exige atenção, o que depende do analista. "proximoPasso": uma frase com a ação recomendada.
- Priorize divergências e validações humanas; não liste tudo.`;

/** Acrescentada ao prompt SÓ quando há documento não lido (sem isso, o prompt é o de sempre). */
const REGRA_NAO_LIDOS = `
- Os documentos em "documentosNaoLidos" NÃO estão ausentes: a leitura deles falhou agora e será refeita. Não diga que estão ausentes, não peça que sejam anexados e não conclua nada que dependa deles; informe apenas que não puderam ser lidos agora.`;

/** Menção a cada documento (sem confundir "Master BL" com "CE Master"). */
function mencao(documento: string): RegExp {
  switch (documento) {
    case 'Master BL': return /(?<!ce\s)\b(master\s*bl|mbl|master)\b/i;
    case 'House BL': return /(?<!ce\s)\b(house\s*bl|hbl|house)\b/i;
    case 'CE Master': return /\bce\s*master\b/i;
    case 'CE House': return /\bce\s*house\b/i;
    default: return new RegExp(documento.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}
const AFIRMA_AUSENCIA = /ausent|faltan|falta\b|anex(ar|e|ado)|n[ãa]o\s+(foi|foram)\s+(enviad|recebid|anexad)|inexist|n[ãa]o\s+consta/i;
const AFIRMA_CONCLUSAO = /nenhuma\s+inconsist|sem\s+pend[êe]nc|conclu[íi]da\s+sem|tudo\s+(certo|em\s+ordem)|auditoria\s+(est[áa]\s+)?complet/i;

function dependeDosNaoLidos(texto: string, naoLidos: string[]): boolean {
  if (AFIRMA_CONCLUSAO.test(texto)) return true;
  if (!AFIRMA_AUSENCIA.test(texto)) return false;
  return naoLidos.some((d) => mencao(d).test(texto)) || /documentos?\s+ausentes/i.test(texto);
}

/**
 * V7: da resposta da IA, remove SÓ o que conclui a partir de um documento não lido (ausência dele, ou "sem
 * pendências" com evidência faltando). Análises independentes — p.ex. divergências entre documentos lidos — ficam.
 */
export function filtrarConclusoesSobreNaoLidos(linhas: string[], naoLidos: string[]): string[] {
  if (!naoLidos.length) return linhas;
  return linhas.filter((l) => !dependeDosNaoLidos(l, naoLidos));
}

export async function resumirAuditoria(r: ResultadoAuditoria, opcoes: OpcoesResumoClara = {}): Promise<ResumoClara> {
  const naoLidos = opcoes.documentosNaoLidos ?? [];
  const base = resumoDeterministico(r, naoLidos);
  if (!isAiConfigured()) return base;
  try {
    const contexto = {
      status: r.status,
      resumo: r.resumo,
      documentosAusentes: r.documentosAusentes,
      ...(naoLidos.length ? { documentosNaoLidos: naoLidos } : {}),
      evidencias: r.evidencias
        .filter((e) => e.resultado === 'Divergência' || e.resultado === 'Validação Humana')
        .map((e) => ({
          campo: e.campo,
          resultado: e.resultado,
          container: e.container,
          criticidade: e.criticidade,
          motivo: e.motivo,
          valores: e.valores,
        })),
    };
    const ai = await generateStructured(
      ClaraSchema,
      naoLidos.length ? SYSTEM_PROMPT + REGRA_NAO_LIDOS : SYSTEM_PROMPT,
      `Resultado da auditoria (JSON):\n${JSON.stringify(contexto)}`,
    );
    let linhas = (ai.linhas || []).filter(Boolean);
    let proximoPasso = ai.proximoPasso || base.proximoPasso;
    if (naoLidos.length) {
      // Guarda determinística: a IA pode desobedecer o prompt; nenhuma conclusão sobre o que não foi lido passa.
      linhas = filtrarConclusoesSobreNaoLidos(linhas, naoLidos);
      const aviso = base.linhas.find((l) => l.startsWith('Não foi possível ler agora'));
      if (aviso && !linhas.some((l) => /n[ãa]o\s+foi\s+poss[íi]vel\s+ler/i.test(l))) linhas.push(aviso);
      if (dependeDosNaoLidos(proximoPasso, naoLidos)) proximoPasso = base.proximoPasso;
    }
    if (linhas.length === 0) return base;
    return { linhas, proximoPasso, fonte: 'ia' };
  } catch {
    return base;
  }
}
