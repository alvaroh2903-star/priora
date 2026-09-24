import { posicionarFaixas } from '../bracketEngine';
import { DayCountBasis, Faixa, MotorResult, QualidadeFonte } from '../types';

/**
 * Exposição Rocket (Blueprint Cap. 24.3) — exposição da ROCKET perante o
 * armador. Regra de negócio própria, totalmente independente da cobrança do
 * cliente: usa o Master Free Time (relógio Rocket) e a tabela do ARMADOR, com
 * as faixas do armador. Nunca lê a tabela nem os dias do cliente.
 *
 * Estados (Blueprint):
 *  - `ESTIMATED_PROVISIONAL` quando a tabela é provisória/incompleta (ex.: PIL,
 *    estimativa por ponto médio) — nunca promovida a CONFIRMED;
 *  - `UNAVAILABLE` quando o dia aplicável não tem tarifa (tabela incompleta) ou
 *    o equipamento não é reconhecido — nunca aproxima por semelhança;
 *  - `ESTIMATED` no caso normal.
 *  - `CONFIRMED` só existe com referência de custo real do armador (fatura), o
 *    que é uma ação de fase financeira posterior — este motor nunca a produz.
 *    Uma tabela OFICIAL_VALIDADA, por si só, não confirma nada.
 */

export interface ExposicaoRocketInput {
  equipamentoNormalizado: string | null;
  /** Free time do relógio da Rocket (Master). */
  freeTimeDaysMaster: number;
  /** Dias de demurrage do relógio da Rocket. */
  diasDemurrageRocket: number;
  faixas: Faixa[];
  dayCountBasis: DayCountBasis;
  qualidadeFonte: QualidadeFonte;
  tabelaId: string;
  versaoTabela: number;
}

export function calcularExposicaoRocket(input: ExposicaoRocketInput): MotorResult {
  const base = {
    motorComercial: 'exposicao_armador' as const,
    tabelaId: input.tabelaId,
    versaoTabela: input.versaoTabela,
  };

  if (input.equipamentoNormalizado === null) {
    return {
      motorComercial: 'exposicao_armador', tabelaId: null, versaoTabela: null, dayCountBasisAplicada: null,
      confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null,
      faixasAplicadas: [], motivo: 'equipamento nao reconhecido',
    };
  }

  const doEquip = input.faixas.filter((f) => f.tipoEquipamento === input.equipamentoNormalizado);
  const r = posicionarFaixas({
    faixas: doEquip,
    dayCountBasis: input.dayCountBasis,
    freeTimeDays: input.freeTimeDaysMaster,
    diasDemurrage: input.diasDemurrageRocket,
  });

  if (r.status === 'UNAVAILABLE') {
    return {
      ...base, dayCountBasisAplicada: input.dayCountBasis,
      confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null,
      faixasAplicadas: [], motivo: r.motivo,
    };
  }
  return {
    ...base,
    dayCountBasisAplicada: input.dayCountBasis,
    confirmationStatus: input.qualidadeFonte === 'PROVISORIA_INCOMPLETA' ? 'ESTIMATED_PROVISIONAL' : 'ESTIMATED',
    total: r.total,
    moeda: r.moeda,
    diasCobrados: r.diasCobrados,
    faixasAplicadas: r.faixasAplicadas,
    motivo: null,
  };
}
