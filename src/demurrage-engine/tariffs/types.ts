/**
 * Tipos compartilhados do motor tarifário (Fase 4). Infraestrutura comum aos
 * três motores comerciais — os motores em si (Termo por Embarque, Termo Único,
 * Exposição Rocket) são estratégias separadas em `tariffs/engines/`.
 */

export type Moeda = string;

/** Semântica de contagem de dia da tabela — EXPLÍCITA, nunca inferida. */
export type DayCountBasis = 'since_discharge_absolute' | 'excess_over_free_time';

export type MotorComercial = 'termo_embarque' | 'termo_unico' | 'exposicao_armador';

export type QualidadeFonte =
  | 'OFICIAL_VALIDADA'
  | 'OFICIAL_NAO_VALIDADA'
  | 'PUBLICA_ESTIMATIVA'
  | 'PROVISORIA_INCOMPLETA';

export type ConfirmationStatus = 'ESTIMATED' | 'ESTIMATED_PROVISIONAL' | 'CONFIRMED' | 'UNAVAILABLE';

export type RelogioTipo = 'cliente' | 'rocket';

/** Versão do motor tarifário. Entra no input_hash do ValorApurado. */
export const TARIFF_ENGINE_VERSION = 'tariff-1.0.0';

/** Uma faixa da tabela: [diaInicial, diaFinal] (diaFinal null = aberta). */
export interface Faixa {
  tipoEquipamento: string;
  diaInicial: number;
  diaFinal: number | null;
  valorDia: number;
  moeda: Moeda;
}

/** Faixa efetivamente aplicada num cálculo, com quantos dias caíram nela. */
export interface FaixaAplicada {
  diaInicial: number;
  diaFinal: number | null;
  valorDia: number;
  dias: number;
}

/**
 * Resultado uniforme de qualquer um dos três motores — o que o
 * `ValorApuradoRepository` persiste. `UNAVAILABLE` nunca traz número.
 */
export interface MotorResult {
  motorComercial: MotorComercial;
  confirmationStatus: ConfirmationStatus;
  total: number | null;
  moeda: Moeda | null;
  diasCobrados: number | null;
  faixasAplicadas: FaixaAplicada[];
  dayCountBasisAplicada: DayCountBasis | null;
  tabelaId: string | null;
  versaoTabela: number | null;
  /** Preenchido só quando UNAVAILABLE: por que não há valor. */
  motivo: string | null;
}
