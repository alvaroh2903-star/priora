import { TariffTable } from './calculator';

/**
 * Priora — Módulo Demurrage / Tabelas de tarifa (blueprint §8).
 *
 * ATENÇÃO: valores de EXEMPLO (placeholder). No fluxo real, free time e tarifas
 * vêm do CONTEXTO DO CLIENTE na Microsoft (blueprint §9 — ponto aberto: a fonte
 * exata, Excel/SharePoint/Dynamics, ainda será confirmada). Estas tabelas servem
 * só para o cálculo rodar de ponta a ponta até a fonte real ser plugada.
 */

const SAMPLE: Record<string, TariffTable> = {
  default: {
    carrier: 'default',
    currency: 'USD',
    tiers: [
      { fromDay: 1, toDay: 5, rate: 120 },
      { fromDay: 6, toDay: 10, rate: 180 },
      { fromDay: 11, toDay: null, rate: 250 },
    ],
  },
};

/** Tabela de tarifa (exemplo) para um armador; cai no default se não houver. */
export function getDefaultTariff(carrier?: string): TariffTable {
  const key = (carrier || 'default').toLowerCase();
  if (SAMPLE[key]) return SAMPLE[key];
  return { ...SAMPLE.default, carrier: carrier || 'default' };
}
