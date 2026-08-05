/**
 * Priora — Módulo Demurrage / Calculadora (blueprint §8).
 *
 * Lógica PURA e testável: dado o início da contagem, a devolução do contêiner,
 * o free time e a tabela de tarifas por faixa, calcula os dias excedentes e o
 * custo total. Sem rede/IA aqui — só aritmética de datas e faixas.
 *
 *   diasCorridos   = ceil(returnDate - startDate) em dias
 *   diasExcedentes = max(0, diasCorridos - freeTimeDays)
 *   total          = soma, por dia excedente, da tarifa da faixa correspondente
 */

export type Tier = { fromDay: number; toDay: number | null; rate: number };

export interface TariffTable {
  carrier: string;
  currency: string;
  tiers: Tier[];
}

export interface DemurrageInput {
  /** Início da contagem (descarga ou disponibilidade, conforme regra do cliente). */
  startDate: string;
  /** Devolução do contêiner (gate_out / empty_return). */
  returnDate: string;
  /** Dias de free time — vem do contexto do cliente (Microsoft), não do site. */
  freeTimeDays: number;
  tariffTable: TariffTable;
}

export interface DemurrageDay {
  day: number;
  tier: string;
  rate: number;
}

export interface DemurrageResult {
  startDate: string;
  returnDate: string;
  freeTimeDays: number;
  /** Dias corridos entre início e devolução (arredondado para cima). */
  daysElapsed: number;
  /** Dias excedentes (além do free time). */
  daysOverdue: number;
  currency: string;
  total: number;
  breakdown: DemurrageDay[];
}

const MS_DAY = 24 * 60 * 60 * 1000;

function tierFor(tiers: Tier[], day: number): Tier | null {
  return (
    tiers.find((t) => day >= t.fromDay && (t.toDay == null || day <= t.toDay)) ||
    null
  );
}

function tierLabel(t: Tier): string {
  return t.toDay == null ? `${t.fromDay}+` : `${t.fromDay}-${t.toDay}`;
}

/** Calcula o demurrage a partir das datas, free time e tabela de tarifas. */
export function calculateDemurrage(input: DemurrageInput): DemurrageResult {
  const start = Date.parse(input.startDate);
  const ret = Date.parse(input.returnDate);
  if (!Number.isFinite(start) || !Number.isFinite(ret)) {
    throw new Error('Datas inválidas para o cálculo de demurrage.');
  }
  const freeTimeDays = Math.max(0, Math.floor(input.freeTimeDays || 0));
  const daysElapsed = Math.max(0, Math.ceil((ret - start) / MS_DAY));
  const daysOverdue = Math.max(0, daysElapsed - freeTimeDays);

  const breakdown: DemurrageDay[] = [];
  let total = 0;
  for (let d = 1; d <= daysOverdue; d++) {
    const tier = tierFor(input.tariffTable.tiers, d);
    const rate = tier ? tier.rate : 0;
    total += rate;
    breakdown.push({ day: d, tier: tier ? tierLabel(tier) : 'sem-faixa', rate });
  }
  total = Math.round(total * 100) / 100;

  return {
    startDate: input.startDate,
    returnDate: input.returnDate,
    freeTimeDays,
    daysElapsed,
    daysOverdue,
    currency: input.tariffTable.currency,
    total,
    breakdown,
  };
}
