import { CivilDate, fromOrdinal, toOrdinal } from './civilDate';

/**
 * Motor temporal da Demurrage Engine V2 (Fase 2) — um relógio de free time.
 *
 * Função pura: sem tracking, sem Outlook, sem banco, sem tarifa, sem frontend.
 * Os dois relógios (House × Master) da Fase 3 chamam este mesmo motor uma vez
 * cada; ele não sabe qual dos dois está calculando.
 *
 * Regras (Blueprint Cap. 6 e 23; plano de migração, revisão 5):
 * - A única âncora é a data de descarga. Não existe parâmetro de Gate Out:
 *   nenhum dado é inferido a partir dele.
 * - Dias corridos, sobre datas civis 'AAAA-MM-DD'. Não há hora nem fuso.
 * - Free time de N dias: dia 1 = descarga; último dia livre = descarga + N − 1;
 *   primeiro dia de demurrage = descarga + N. Os dias de demurrage vão do
 *   primeiro dia de demurrage até a data final, inclusive; 0 se a data final
 *   vier antes do primeiro dia de demurrage.
 * - FT ausente → PENDING, nunca zero. FT 0 é válido e diferente de ausente.
 * - Descarga ausente → PENDING: o relógio não é iniciado (Cap. 31.1).
 * - Data final anterior à descarga → INVALID explícito, nunca número negativo.
 */

export type Pendencia = 'DESCARGA_AUSENTE' | 'FREE_TIME_AUSENTE';

export interface FreeTimeClockInput {
  /** Data civil da descarga, ou null se ainda não houver (relógio não iniciado). */
  dischargeDate: CivilDate | null;
  /** Dias de free time (inteiro ≥ 0), ou null se ausente. */
  freeTimeDays: number | null;
  /** Data civil até a qual se apura: hoje, ou a data de devolução. */
  finalDate: CivilDate;
}

export type FreeTimeClockResult =
  | { status: 'OK'; ultimoDiaLivre: CivilDate; primeiroDiaDemurrage: CivilDate; diasDemurrage: number }
  | { status: 'PENDING'; pendencias: Pendencia[] }
  | { status: 'INVALID'; motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA'; pendencias: Pendencia[] };

const CAMPOS_ACEITOS = ['dischargeDate', 'freeTimeDays', 'finalDate'];

function assertInput(input: unknown): asserts input is FreeTimeClockInput {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('freeTimeClock: a entrada deve ser um objeto.');
  }
  for (const campo of Object.keys(input)) {
    if (!CAMPOS_ACEITOS.includes(campo)) {
      throw new TypeError(
        `freeTimeClock: campo não aceito '${campo}'. A única âncora é dischargeDate — Gate Out e outras datas nunca entram no cálculo.`,
      );
    }
  }
  for (const campo of CAMPOS_ACEITOS) {
    if (!(campo in input)) {
      throw new TypeError(`freeTimeClock: campo obrigatório ausente '${campo}' (use null para declarar ausência).`);
    }
  }
  const { freeTimeDays, finalDate } = input as Record<string, unknown>;
  if (freeTimeDays !== null) {
    if (typeof freeTimeDays !== 'number' || !Number.isInteger(freeTimeDays)) {
      throw new TypeError(`freeTimeClock: freeTimeDays deve ser um inteiro ou null; recebido ${String(freeTimeDays)}.`);
    }
    if (freeTimeDays < 0) {
      throw new RangeError(`freeTimeClock: freeTimeDays não pode ser negativo; recebido ${freeTimeDays}.`);
    }
  }
  if (finalDate === null) {
    throw new TypeError('freeTimeClock: finalDate é obrigatório — a data final de apuração sempre é informada.');
  }
}

export function freeTimeClock(input: FreeTimeClockInput): FreeTimeClockResult {
  assertInput(input);
  const final = toOrdinal(input.finalDate);
  const descarga = input.dischargeDate === null ? null : toOrdinal(input.dischargeDate);

  const pendencias: Pendencia[] = [];
  if (descarga === null) pendencias.push('DESCARGA_AUSENTE');
  if (input.freeTimeDays === null) pendencias.push('FREE_TIME_AUSENTE');

  // Checado antes da falta de FT para que uma inconsistência de datas nunca
  // fique escondida atrás de um "pendente" (as pendências seguem informadas).
  if (descarga !== null && final < descarga) {
    return { status: 'INVALID', motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA', pendencias };
  }
  if (descarga === null || input.freeTimeDays === null) {
    return { status: 'PENDING', pendencias };
  }

  const primeiroDiaDemurrage = descarga + input.freeTimeDays;
  return {
    status: 'OK',
    ultimoDiaLivre: fromOrdinal(primeiroDiaDemurrage - 1),
    primeiroDiaDemurrage: fromOrdinal(primeiroDiaDemurrage),
    diasDemurrage: Math.max(0, final - primeiroDiaDemurrage + 1),
  };
}
