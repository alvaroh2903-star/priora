import { CivilDate, toOrdinal } from '../temporal/civilDate';

/**
 * Fase 8 — validação de coerência da minuta (decisão funcional da Priora; o
 * Blueprint não fixa fórmula), função PURA. Produção P1 (correção de minuta):
 * é a parte ESTRUTURAL da verificação técnica automática
 * (`avaliarMinutaTecnicamente`, abaixo) — nenhum gestor aprova nada. Uma
 * minuta só é estruturalmente coerente se:
 *  - o número do contêiner corresponder;
 *  - a data for válida/legível;
 *  - data_minuta >= discharge_date;
 *  - data_minuta <= hoje;
 *  - havendo Gate Out cheio confirmado, data_minuta >= gate_out_date.
 *
 * Sem tolerância fixa vs. tracking_return_date: a data pode ser anterior ou
 * posterior ao tracking desde que respeite a cronologia física. A divergência
 * (quando houver) é registrada por quem chama; aqui só decidimos aceitar/rejeitar.
 */

export type MotivoRejeicao =
  | 'NUMERO_DIVERGENTE'
  | 'DATA_ILEGIVEL'
  | 'DESCARGA_DESCONHECIDA'
  | 'DATA_ANTERIOR_A_DESCARGA'
  | 'DATA_FUTURA'
  | 'DATA_ANTERIOR_AO_GATE_OUT';

export interface MinutaValidationInput {
  numeroInformado: string | null;
  numeroContainer: string;
  dataInformada: CivilDate | null;
  dischargeDate: CivilDate | null;
  gateOutDate: CivilDate | null;
  hoje: CivilDate;
}

export type MinutaValidationResult =
  | { valida: true; dataValidada: CivilDate }
  | { valida: false; motivo: MotivoRejeicao };

function normalizarNumero(s: string | null): string {
  return String(s || '').toUpperCase().replace(/[\s-]/g, '');
}

/** Data civil legível: 'AAAA-MM-DD' com componentes de calendário reais. */
/**
 * Texto que o PostgreSQL aceita sem erro nem alteração silenciosa: sem U+0000
 * (proibido em `text`/`jsonb`) e sem surrogate UTF-16 isolado (vira U+FFFD em
 * `text` e é recusado em `jsonb`). Entrada fora disso é erro de VALIDAÇÃO
 * (400), nunca falha de banco (500).
 */
export function textoArmazenavel(s: string): boolean {
  return !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

export function dataLegivel(s: string | null): s is CivilDate {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validarMinuta(input: MinutaValidationInput): MinutaValidationResult {
  // 1) Número do contêiner.
  if (normalizarNumero(input.numeroInformado) !== normalizarNumero(input.numeroContainer)) {
    return { valida: false, motivo: 'NUMERO_DIVERGENTE' };
  }
  // 2) Data legível.
  if (!dataLegivel(input.dataInformada)) {
    return { valida: false, motivo: 'DATA_ILEGIVEL' };
  }
  const data = toOrdinal(input.dataInformada);
  // 3) Coerência com a descarga (âncora física). Sem descarga, a coerência não
  //    é verificável → não valida (determinismo de implementação, não regra nova).
  if (input.dischargeDate === null) {
    return { valida: false, motivo: 'DESCARGA_DESCONHECIDA' };
  }
  if (data < toOrdinal(input.dischargeDate)) {
    return { valida: false, motivo: 'DATA_ANTERIOR_A_DESCARGA' };
  }
  // 4) Não pode ser futura.
  if (data > toOrdinal(input.hoje)) {
    return { valida: false, motivo: 'DATA_FUTURA' };
  }
  // 5) Gate Out cheio confirmado (quando houver).
  if (input.gateOutDate !== null && data < toOrdinal(input.gateOutDate)) {
    return { valida: false, motivo: 'DATA_ANTERIOR_AO_GATE_OUT' };
  }
  return { valida: true, dataValidada: input.dataInformada };
}

/**
 * Produção P1 (correção de minuta) — verificação técnica AUTOMÁTICA da
 * minuta, função PURA. Não existe aprovação humana: o resultado decide
 * sozinho o estado da minuta.
 *
 *  - INCONSISTENTE: falhou a coerência estrutural (`validarMinuta` acima —
 *    número do contêiner, data legível, cronologia descarga/Gate Out, data
 *    futura);
 *  - RECEBIDA (aguardando): a coerência não é verificável ainda — descarga
 *    desconhecida, ou o tracking ainda não confirmou a devolução. A minuta
 *    NUNCA fabrica a devolução: sem tracking, ela espera;
 *  - DIVERGENTE: coerente, mas a data difere da devolução oficial do tracking
 *    (sem tolerância — mesma comparação exata do fluxo anterior);
 *  - ACEITA: coerente e igual à devolução do tracking.
 */
export type ResultadoAvaliacaoTecnica =
  | { estado: 'ACEITA'; dataTracking: CivilDate }
  | { estado: 'DIVERGENTE'; dataMinuta: CivilDate; dataTracking: CivilDate }
  | { estado: 'INCONSISTENTE'; motivo: MotivoRejeicao }
  | { estado: 'RECEBIDA'; aguardando: 'DESCARGA' | 'DEVOLUCAO_TRACKING' };

export interface AvaliacaoTecnicaInput extends MinutaValidationInput {
  trackingReturnDate: CivilDate | null;
}

export function avaliarMinutaTecnicamente(input: AvaliacaoTecnicaInput): ResultadoAvaliacaoTecnica {
  const coerencia = validarMinuta(input);
  if (!coerencia.valida) {
    if (coerencia.motivo === 'DESCARGA_DESCONHECIDA') return { estado: 'RECEBIDA', aguardando: 'DESCARGA' };
    return { estado: 'INCONSISTENTE', motivo: coerencia.motivo };
  }
  if (input.trackingReturnDate === null) return { estado: 'RECEBIDA', aguardando: 'DEVOLUCAO_TRACKING' };
  if (coerencia.dataValidada !== input.trackingReturnDate) {
    return { estado: 'DIVERGENTE', dataMinuta: coerencia.dataValidada, dataTracking: input.trackingReturnDate };
  }
  return { estado: 'ACEITA', dataTracking: input.trackingReturnDate };
}
