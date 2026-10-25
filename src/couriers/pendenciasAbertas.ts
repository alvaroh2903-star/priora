/**
 * Priora — Módulo Courier
 * HIS-004 (parcial): pendências documentais ABERTAS de um courier, a partir dos
 * registros humanos de conferência. Concluir o courier não encerra pendência:
 * um courier "Concluído" com pendência aberta continua na lista principal.
 *
 * Aberta = registro humano ainda de pé que a tela mostra como pendente:
 *  - "ausencia-registrada": documento marcado "Não recebido" (ausência confirmada
 *    por pessoa — diferente de expectativa desconhecida, que não tem registro);
 *  - "conflito-resolucao": registro num documento que o e-mail dá como resolvido
 *    para o envelope inteiro (telex, importador, destino, Wave);
 *  - "conflito-associacao": registro num documento cuja associação ao processo
 *    não está confirmada (ambígua, presença não comprovada ou ligada a outro IM).
 *
 * "Recebido" com expectativa desconhecida (sem menção no e-mail) não é pendência.
 * Mesmas regras de evidência da tela do Courier. Puro: sem rede, sem IA, sem escrita.
 *
 * Limite conhecido: o armazenamento não tem registro de "pendência encerrada sem
 * recebimento" (aceita, dispensada). Enquanto o registro "Não recebido" estiver
 * de pé, a pendência é aberta.
 */
import type { MencaoDocumental, TipoDocumento } from './docAssociation';
import type { DocResolution } from './docResolution';

export type MotivoPendencia = 'ausencia-registrada' | 'conflito-resolucao' | 'conflito-associacao';

export interface PendenciaAberta {
  processo: string;
  documento: 'mbl' | 'hbl';
  registro: 'recebido' | 'nao_recebido';
  motivo: MotivoPendencia;
}

type Conferencia = Record<string, Partial<Record<'mbl' | 'hbl', string | null>>>;

/** Mesma leitura da tela: o que as menções dizem deste documento NESTE processo. */
function evidencia(mencoes: MencaoDocumental[], processo: string, tipo: TipoDocumento) {
  const r = { esperado: false, ambiguo: false, naoComprovado: false, outroProcesso: false };
  const p = processo.toUpperCase();
  for (const m of mencoes) {
    if (m.tipo !== tipo) continue;
    const deste = m.associacao.situacao === 'confirmada' && String(m.associacao.processo || '').toUpperCase() === p;
    const candidato = m.associacao.situacao !== 'confirmada' && m.associacao.candidatos.some((x) => x.toUpperCase() === p);
    if (m.conteudo.situacao === 'afirmado') {
      if (deste) r.esperado = true;
      else if (candidato) r.ambiguo = true;
      else if (m.associacao.situacao === 'confirmada') r.outroProcesso = true;
    } else if (deste || candidato) r.naoComprovado = true;
  }
  return r;
}

export function pendenciasAbertas(
  conferencia: Conferencia,
  mencoes: MencaoDocumental[],
  docResolution: Partial<DocResolution>,
): PendenciaAberta[] {
  const dr = docResolution || {};
  const resolvido = {
    hbl: !!(dr.telex || dr.importador || dr.destino || dr.wave),
    mbl: !!(dr.wave || dr.destino),
  };
  const abertas: PendenciaAberta[] = [];
  for (const [processo, docs] of Object.entries(conferencia || {})) {
    for (const documento of ['mbl', 'hbl'] as const) {
      const registro = docs?.[documento];
      if (registro !== 'recebido' && registro !== 'nao_recebido') continue;
      const ev = evidencia(mencoes || [], processo, documento === 'mbl' ? 'OMBL' : 'OHBL');
      const motivo: MotivoPendencia | null = resolvido[documento]
        ? 'conflito-resolucao'
        : !ev.esperado && (ev.ambiguo || ev.naoComprovado || ev.outroProcesso)
          ? 'conflito-associacao'
          : registro === 'nao_recebido'
            ? 'ausencia-registrada'
            : null;
      if (motivo) abertas.push({ processo, documento, registro, motivo });
    }
  }
  return abertas;
}
