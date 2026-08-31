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
  // Vazio LIBERADO na origem ("O/B Empty Container Released") é dispatch de
  // equipamento p/ estufagem — NÃO é "disponível p/ retirada" no destino. Sem
  // este guard, o "released" cairia em `available` e poluiria o início da
  // contagem de demurrage com uma data de origem.
  if (/empty\s+(?:container\s+)?released/.test(s)) return 'other';
  for (const [type, re] of RULES) {
    if (re.test(s)) return type;
  }
  return 'other';
}
