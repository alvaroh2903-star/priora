import { NormalizedEventType } from './types';

/**
 * Priora — Normalização de eventos de rastreio (blueprint §7).
 * Classifica a descrição livre de um evento (qualquer idioma/portal) num tipo
 * padronizado, para o módulo de demurrage derivar as datas certas.
 */

// Ordem IMPORTA:
//  - empty_return antes de gate_out (uma linha "empty returned" não pode cair em
//    gate_out);
//  - berth (chegada) ANTES de discharge, senão "Vessel Arrival at Port of
//    Discharge" cairia em discharge por causa da palavra "Discharge" no NOME do
//    porto — é uma chegada (berth), não a descarga.
// "other" cobre embarque/partida etc.
const RULES: Array<[NormalizedEventType, RegExp]> = [
  [
    'empty_return',
    // "gate in empty" (CMA: "GATE IN EMPTY AT DEPOT") = vazio entrando no depósito
    // = devolução. NÃO confundir com "gate out empty" (origem), tratado à parte.
    /empty.*return|return.*empty|empty container returned|empty received|returned.*depot|empty in\b|gate\s*in\s+empty|devolu/i,
  ],
  [
    'gate_out',
    /gated?\s*out|to consignee|delivered to|picked up|full.*out|out\s?gate|import.*deliver|entregue|sa[ií]da.*cheio/i,
  ],
  ['available', /available|disponib|released|liberad|ready for (delivery|pickup)/i],
  ['berth', /berth|atrac|vessel\s+arriv|arriv.*(port|terminal|vessel)/i],
  ['discharge', /discharg|desembarq|unload/i],
];

/** Classifica a descrição de um evento no enum normalizado. */
export function classifyEvent(status: string): NormalizedEventType {
  const s = (status || '').toLowerCase();
  // Movimentos de VAZIO na ORIGEM — não são retirada do cheio nem devolução no
  // destino; sem estes guards seriam lidos como available/gate_out e poluiriam
  // as datas de demurrage com eventos de origem:
  //  - "Empty Container Release(d) to Shipper" (liberação p/ estufagem);
  //  - "Gate out Empty" (o vazio saindo do depósito na origem).
  if (/empty\s+(?:container\s+)?releas/.test(s)) return 'other';
  if (/gate\s*out\s+empty/.test(s)) return 'other';
  for (const [type, re] of RULES) {
    if (re.test(s)) return type;
  }
  return 'other';
}
