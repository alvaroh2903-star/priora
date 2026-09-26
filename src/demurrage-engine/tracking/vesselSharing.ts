import { CivilDate, toOrdinal } from '../temporal/civilDate';

/**
 * Fase 9 Bloco 2 — seleção/rotação PURA do tracking intercalado por VesselCall.
 * Sem banco, sem relógio: recebe fatos já reunidos e decide a referência da
 * rodada e a validade da janela de formação. A execução (claim, consulta,
 * cobertura) fica na camada com efeito colateral (vesselRound / repositório).
 */

/** Janela máxima (dias corridos) entre a confirmação mais antiga e a mais recente. */
export const JANELA_FORMACAO_DIAS = 4;
/** Validade máxima de uma cobertura compartilhada. */
export const COBERTURA_VALIDADE_HORAS = 72;
/** Fallback: no máximo 2 referências por rodada (original + 1 alternativa). */
export const MAX_TENTATIVAS_RODADA = 2;

export interface CandidatoRodada {
  containerId: string;
  trackingTargetId: string | null;
  /** Última consulta individual VÁLIDA (civil date) — null = nunca consultado. */
  ultimaConsultaValida: CivilDate | null;
}

/**
 * Ordena candidatos para a rodada: quem está há MAIS tempo sem consulta individual
 * válida primeiro (null = mais antigo), desempate estável e determinístico por
 * containerId. Retorna a lista ordenada (a referência é o primeiro; o segundo é a
 * única alternativa de fallback permitida).
 */
export function ordenarCandidatos(candidatos: CandidatoRodada[]): CandidatoRodada[] {
  const ord = (d: CivilDate | null): number => (d === null ? -Infinity : toOrdinal(d));
  return [...candidatos].sort((a, b) => {
    const da = ord(a.ultimaConsultaValida);
    const db = ord(b.ultimaConsultaValida);
    if (da !== db) return da - db; // menor ordinal (mais antigo) primeiro
    return a.containerId < b.containerId ? -1 : a.containerId > b.containerId ? 1 : 0;
  });
}

/**
 * A janela de FORMAÇÃO é válida quando o intervalo entre a confirmação mais antiga
 * e a mais recente (datas civis) não excede JANELA_FORMACAO_DIAS. Confirmações
 * antigas demais entre si → grupo não ativa.
 */
export function janelaFormacaoValida(confirmacoesDatasCivis: CivilDate[], maxDias = JANELA_FORMACAO_DIAS): boolean {
  const ords = confirmacoesDatasCivis.map(toOrdinal);
  if (ords.length < 2) return ords.length === 1; // 1 confirmação é trivialmente "dentro da janela"
  return Math.max(...ords) - Math.min(...ords) <= maxDias;
}
