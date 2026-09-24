import { Faixa, MotorResult } from '../types';

/**
 * Termo por Embarque (Blueprint Cap. 24.1) — cobrança do CLIENTE.
 *
 * Regra de negócio própria: tarifa FIXA por dia, da tabela Rocket vinculada
 * àquele embarque/condição comercial. Sem progressão de faixa, sem free time na
 * fórmula tarifária (o free time já foi aplicado no relógio, que entrega os dias
 * de demurrage). Não usa `bracketEngine`. Não usa tabela de armador — a
 * exposição da Rocket é outro motor.
 *
 *   valor = dias_demurrage_cliente × diária Rocket do tipo de equipamento
 *
 * Equipamento não reconhecido ou sem tarifa na tabela → UNAVAILABLE (bloqueia
 * só a tarifa; o relógio segue vivo). Nunca aproxima por semelhança.
 */

export interface TermoPorEmbarqueInput {
  /** Código normalizado do equipamento (null = não reconhecido). */
  equipamentoNormalizado: string | null;
  /** Dias de demurrage do relógio do cliente (House). */
  diasDemurrageCliente: number;
  /** Faixas da tabela Rocket (Termo por Embarque): uma faixa aberta [1,∞) por equipamento. */
  faixas: Faixa[];
  tabelaId: string;
  versaoTabela: number;
}

export function calcularTermoPorEmbarque(input: TermoPorEmbarqueInput): MotorResult {
  const base = {
    motorComercial: 'termo_embarque' as const,
    tabelaId: input.tabelaId,
    versaoTabela: input.versaoTabela,
    dayCountBasisAplicada: null,
  };

  if (input.equipamentoNormalizado === null) {
    return {
      ...base, tabelaId: null, versaoTabela: null,
      confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null,
      faixasAplicadas: [], motivo: 'equipamento nao reconhecido',
    };
  }

  const doEquip = input.faixas.filter((f) => f.tipoEquipamento === input.equipamentoNormalizado);
  if (doEquip.length === 0) {
    return {
      ...base, confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null,
      faixasAplicadas: [], motivo: `sem tarifa para o equipamento ${input.equipamentoNormalizado}`,
    };
  }
  // Termo por Embarque é tarifa única por equipamento (uma faixa aberta).
  const faixa = doEquip[0];
  const total = (Math.round(faixa.valorDia * 100) * input.diasDemurrageCliente) / 100;
  return {
    ...base,
    confirmationStatus: 'ESTIMATED',
    total,
    moeda: faixa.moeda,
    diasCobrados: input.diasDemurrageCliente,
    faixasAplicadas: [
      { diaInicial: faixa.diaInicial, diaFinal: faixa.diaFinal, valorDia: faixa.valorDia, dias: input.diasDemurrageCliente },
    ],
    motivo: null,
  };
}
