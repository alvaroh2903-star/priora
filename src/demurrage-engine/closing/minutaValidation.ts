import { CivilDate, toOrdinal } from '../temporal/civilDate';

/**
 * Fase 8 — validação de coerência da minuta (decisão funcional da Priora; o
 * Blueprint não fixa fórmula), função PURA. Uma minuta só pode ser VALIDADA se:
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
