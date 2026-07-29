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

/** Resumo determinístico — usado como fallback e como base factual. */
function resumoDeterministico(r: ResultadoAuditoria): ResumoClara {
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
  let proximoPasso: string;
  if (resumo.divergencias > 0)
    proximoPasso = 'Solicitar correção ao agente para as divergências antes de emitir o CE.';
  else if (resumo.validacoesHumanas > 0)
    proximoPasso = 'Confirmar manualmente os campos de validação humana (frete/THC).';
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

export async function resumirAuditoria(r: ResultadoAuditoria): Promise<ResumoClara> {
  const base = resumoDeterministico(r);
  if (!isAiConfigured()) return base;
  try {
    const contexto = {
      status: r.status,
      resumo: r.resumo,
      documentosAusentes: r.documentosAusentes,
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
      SYSTEM_PROMPT,
      `Resultado da auditoria (JSON):\n${JSON.stringify(contexto)}`,
    );
    const linhas = (ai.linhas || []).filter(Boolean);
    if (linhas.length === 0) return base;
    return { linhas, proximoPasso: ai.proximoPasso || base.proximoPasso, fonte: 'ia' };
  } catch {
    return base;
  }
}
