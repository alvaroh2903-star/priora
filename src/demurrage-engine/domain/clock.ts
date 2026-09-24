import { createHash } from 'crypto';
import { CivilDate } from '../temporal/civilDate';
import { FreeTimeClockResult } from '../temporal/freeTimeClock';
import { TEMPORAL_ENGINE_VERSION, TipoRelogio } from '../temporal/dualClockCalculator';

/**
 * Modelo de domínio do relógio de demurrage e a identidade das suas entradas
 * (input_hash). Fica FORA de `temporal/` de propósito: aqui pode usar `crypto`,
 * enquanto o motor temporal continua puro (a suíte de pureza barra qualquer
 * import não-vizinho e qualquer uso de Date dentro de `temporal/`).
 *
 * A tabela `relogios` é cache/projeção pura: tudo aqui é regenerável a partir
 * de (descarga, free time correspondente, data final, versão do motor). O
 * input_hash resume TODAS essas entradas; se qualquer uma muda, o hash muda e
 * o cache está obsoleto. Não há edição manual válida do cache.
 */

export type { TipoRelogio };
export type EstadoRelogio = 'OK' | 'PENDING' | 'INVALID';

/** Linha da tabela `relogios` (cache). Espelha 1-para-1 um FreeTimeClockResult. */
export interface RelogioCache {
  id: string;
  containerId: string;
  tipo: TipoRelogio;
  estado: EstadoRelogio;
  ultimoDiaLivre: CivilDate | null;
  primeiroDiaDemurrage: CivilDate | null;
  dataFinalApuracao: CivilDate;
  diasDemurrage: number | null;
  pendencias: string[];
  motivo: string | null;
  calculatedAt: Date;
  engineVersion: string;
  inputHash: string;
}

/** As entradas relevantes de UM relógio — o que o input_hash precisa cobrir. */
export interface EntradasRelogio {
  tipo: TipoRelogio;
  dischargeDate: CivilDate | null;
  freeTimeDays: number | null;
  finalDate: CivilDate;
  engineVersion?: string;
}

/**
 * input_hash: identidade de todas as entradas de um relógio. Determinístico e
 * estável (ordem fixa dos campos). Muda se — e só se — mudar a descarga, o free
 * time daquele relógio, a data final, a versão do motor ou o tipo do relógio.
 * Um hash gravado diferente do recalculado = cache obsoleto/inválido.
 */
export function calcularInputHash(entradas: EntradasRelogio): string {
  const engineVersion = entradas.engineVersion ?? TEMPORAL_ENGINE_VERSION;
  const payload = JSON.stringify([
    engineVersion,
    entradas.tipo,
    entradas.dischargeDate,
    entradas.freeTimeDays,
    entradas.finalDate,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

/** Projeta um resultado do motor nas colunas do cache (sem tocar no banco). */
export function projetarParaCache(resultado: FreeTimeClockResult): {
  estado: EstadoRelogio;
  ultimoDiaLivre: CivilDate | null;
  primeiroDiaDemurrage: CivilDate | null;
  diasDemurrage: number | null;
  pendencias: string[];
  motivo: string | null;
} {
  if (resultado.status === 'OK') {
    return {
      estado: 'OK',
      ultimoDiaLivre: resultado.ultimoDiaLivre,
      primeiroDiaDemurrage: resultado.primeiroDiaDemurrage,
      diasDemurrage: resultado.diasDemurrage,
      pendencias: [],
      motivo: null,
    };
  }
  if (resultado.status === 'PENDING') {
    return {
      estado: 'PENDING',
      ultimoDiaLivre: null,
      primeiroDiaDemurrage: null,
      diasDemurrage: null,
      pendencias: [...resultado.pendencias],
      motivo: null,
    };
  }
  return {
    estado: 'INVALID',
    ultimoDiaLivre: null,
    primeiroDiaDemurrage: null,
    diasDemurrage: null,
    pendencias: [...resultado.pendencias],
    motivo: resultado.motivo,
  };
}
