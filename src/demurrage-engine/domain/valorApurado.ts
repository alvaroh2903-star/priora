import { createHash } from 'crypto';
import { CivilDate } from '../temporal/civilDate';
import { DayCountBasis, MotorComercial, RelogioTipo, TARIFF_ENGINE_VERSION } from '../tariffs/types';

/**
 * Identidade das entradas de um ValorApurado (input_hash). Igual em espírito ao
 * input_hash do relógio: resume TODAS as entradas que determinam o valor, para
 * detectar quando um recálculo produziria algo diferente (e então gerar um novo
 * ValorApurado que supersede o anterior). Fica fora de `temporal/`/`tariffs/`
 * puros porque usa `crypto`.
 */

export interface EntradasValorApurado {
  motorComercial: MotorComercial;
  relogioTipo: RelogioTipo;
  /** Código normalizado do equipamento (null = não reconhecido). */
  equipamentoNormalizado: string | null;
  tabelaId: string | null;
  versaoTabela: number | null;
  dayCountBasis: DayCountBasis | null;
  /** Free time e dias de demurrage do relógio correspondente. */
  freeTimeDays: number | null;
  diasDemurrage: number | null;
  /** Data final de apuração do relógio (entra porque muda os dias). */
  dataFinalApuracao: CivilDate;
  engineVersion?: string;
}

export function calcularInputHashValor(entradas: EntradasValorApurado): string {
  const engineVersion = entradas.engineVersion ?? TARIFF_ENGINE_VERSION;
  const payload = JSON.stringify([
    engineVersion,
    entradas.motorComercial,
    entradas.relogioTipo,
    entradas.equipamentoNormalizado,
    entradas.tabelaId,
    entradas.versaoTabela,
    entradas.dayCountBasis,
    entradas.freeTimeDays,
    entradas.diasDemurrage,
    entradas.dataFinalApuracao,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}
