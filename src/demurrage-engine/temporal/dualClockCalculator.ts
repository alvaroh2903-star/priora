import { CivilDate } from './civilDate';
import { freeTimeClock, FreeTimeClockResult } from './freeTimeClock';

/**
 * Dois relógios House × Master (Demurrage Engine V2, Fase 3).
 *
 * Um contêiner tem dois relógios de free time independentes. Este módulo NÃO
 * tem fórmula temporal própria: ele chama o mesmo `freeTimeClock` da Fase 2
 * duas vezes — uma com o free time do documento House (relógio do Cliente) e
 * outra com o do Master BL (relógio Rocket) — sobre a MESMA descarga e a MESMA
 * data final de apuração. Só o free time difere entre as duas chamadas.
 *
 * Cada relógio carrega seu próprio status: um PENDING ou INVALID de um lado
 * nunca bloqueia nem altera o outro. Não existe "status geral" que substitua
 * os dois — o resultado é sempre o par {cliente, rocket}.
 *
 * Função pura, como o motor temporal: sem banco, sem tracking, sem relógio do
 * sistema, sem tarifa. Depende apenas dos módulos vizinhos de `temporal/`.
 */

/** Versão do motor temporal. Entra no input_hash do cache (domain/clock.ts):
 * qualquer mudança de fórmula que altere resultados deve subir esta versão,
 * invalidando os relógios já projetados. */
export const TEMPORAL_ENGINE_VERSION = 'temporal-1.0.0';

/** Os dois relógios de um contêiner. */
export type TipoRelogio = 'cliente' | 'rocket';

export interface DualClockInput {
  /** Única âncora, compartilhada pelos dois relógios. null = relógio não iniciado. */
  dischargeDate: CivilDate | null;
  /** Free time do documento House → relógio do Cliente. null = ausente. */
  houseFreeTimeDays: number | null;
  /** Free time do Master BL → relógio Rocket. null = ausente. */
  masterFreeTimeDays: number | null;
  /** Data civil até a qual se apura, comum aos dois relógios. */
  finalDate: CivilDate;
}

export interface DualClockResult {
  /** Relógio do Cliente (free time House). */
  cliente: FreeTimeClockResult;
  /** Relógio Rocket (free time Master). */
  rocket: FreeTimeClockResult;
}

const CAMPOS_ACEITOS = ['dischargeDate', 'houseFreeTimeDays', 'masterFreeTimeDays', 'finalDate'];

function assertInput(input: unknown): asserts input is DualClockInput {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('calcularDoisRelogios: a entrada deve ser um objeto.');
  }
  for (const campo of Object.keys(input)) {
    if (!CAMPOS_ACEITOS.includes(campo)) {
      throw new TypeError(
        `calcularDoisRelogios: campo não aceito '${campo}'. Os relógios recebem só descarga, os dois free times e a data final.`,
      );
    }
  }
  for (const campo of CAMPOS_ACEITOS) {
    if (!(campo in input)) {
      throw new TypeError(`calcularDoisRelogios: campo obrigatório ausente '${campo}' (use null para declarar ausência).`);
    }
  }
}

export function calcularDoisRelogios(input: DualClockInput): DualClockResult {
  assertInput(input);
  // Duas chamadas independentes ao mesmo motor. A validação fina de cada campo
  // (FT inteiro ≥ 0, finalDate obrigatória, nenhuma outra data) é do freeTimeClock.
  return {
    cliente: freeTimeClock({
      dischargeDate: input.dischargeDate,
      freeTimeDays: input.houseFreeTimeDays,
      finalDate: input.finalDate,
    }),
    rocket: freeTimeClock({
      dischargeDate: input.dischargeDate,
      freeTimeDays: input.masterFreeTimeDays,
      finalDate: input.finalDate,
    }),
  };
}
