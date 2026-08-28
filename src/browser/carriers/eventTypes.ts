import { NormalizedEventType } from './types';

/**
 * Priora — Normalização de eventos de rastreio (blueprint §7).
 * Classifica a descrição livre de um evento (qualquer idioma/portal) num tipo
 * padronizado, para o módulo de demurrage derivar as datas certas.
 */

// Ordem IMPORTA: empty_return antes de gate_out (uma linha "empty returned"
// não pode cair em gate_out). "other" cobre embarque/partida etc.
const RULES: Array<[NormalizedEventType, RegExp]> = [
  [
    'empty_return',
    /empty.*return|return.*empty|empty container returned|empty received|returned.*depot|empty in\b|devolu/i,
  ],
  [
    'gate_out',
    /gated?\s*out|to consignee|delivered to|picked up|full.*out|out\s?gate|import.*deliver|entregue|sa[ií]da.*cheio/i,
  ],
  ['available', /available|disponib|released|liberad|ready for (delivery|pickup)/i],
  ['discharge', /discharg|desembarq|unload/i],
  ['berth', /berth|atrac|vessel\s+arriv|arriv.*(port|terminal|vessel)/i],
];

/** Classifica a descrição de um evento no enum normalizado. */
export function classifyEvent(status: string): NormalizedEventType {
  const s = (status || '').toLowerCase();
  for (const [type, re] of RULES) {
    if (re.test(s)) return type;
  }
  return 'other';
}
