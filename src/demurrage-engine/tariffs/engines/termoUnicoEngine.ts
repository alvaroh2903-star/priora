import { posicionarFaixas } from '../bracketEngine';
import { DayCountBasis, Faixa, MotorResult, QualidadeFonte } from '../types';

/**
 * Termo Único (Blueprint Cap. 24.2) — cobrança do CLIENTE por faixas.
 *
 * Regra de negócio própria: usa a tabela Rocket do Termo Único (não a do
 * armador), com faixas progressivas correndo em paralelo ao free time desde a
 * descarga. A SELEÇÃO da versão da tabela (decisão aprovada, revisão 7) é feita
 * pela data do 1º dia de demurrage do cliente — isso é responsabilidade do
 * repositório/serviço, que entrega aqui a tabela já resolvida. Este motor só
 * aplica as faixas ao relógio do cliente.
 *
 * O posicionamento em faixa é a infra comum (`bracketEngine`); a semântica de
 * contagem vem da própria tabela (`dayCountBasis`), nunca é inferida.
 */

export interface TermoUnicoInput {
  equipamentoNormalizado: string | null;
  /** Free time do relógio do cliente (House). */
  freeTimeDaysCliente: number;
  /** Dias de demurrage do relógio do cliente. */
  diasDemurrageCliente: number;
  faixas: Faixa[];
  dayCountBasis: DayCountBasis;
  qualidadeFonte: QualidadeFonte;
  tabelaId: string;
  versaoTabela: number;
}

export function calcularTermoUnico(input: TermoUnicoInput): MotorResult {
  const base = {
    motorComercial: 'termo_unico' as const,
    tabelaId: input.tabelaId,
    versaoTabela: input.versaoTabela,
  };

  if (input.equipamentoNormalizado === null) {
    return {
      motorComercial: 'termo_unico', tabelaId: null, versaoTabela: null, dayCountBasisAplicada: null,
      confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null,
      faixasAplicadas: [], motivo: 'equipamento nao reconhecido',
    };
  }

  const doEquip = input.faixas.filter((f) => f.tipoEquipamento === input.equipamentoNormalizado);
  const r = posicionarFaixas({
    faixas: doEquip,
    dayCountBasis: input.dayCountBasis,
    freeTimeDays: input.freeTimeDaysCliente,
    diasDemurrage: input.diasDemurrageCliente,
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
    // Tabela provisória/incompleta (ex.: PIL) nunca vira número firme.
    confirmationStatus: input.qualidadeFonte === 'PROVISORIA_INCOMPLETA' ? 'ESTIMATED_PROVISIONAL' : 'ESTIMATED',
    total: r.total,
    moeda: r.moeda,
    diasCobrados: r.diasCobrados,
    faixasAplicadas: r.faixasAplicadas,
    motivo: null,
  };
}
