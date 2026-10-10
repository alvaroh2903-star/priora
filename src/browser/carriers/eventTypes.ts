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
    // A ZIM escreve na ORDEM INVERSA ("Empty container gate in") — daí o
    // `empty.*gate\s*in`, senão a devolução dela não era classificada.
    /empty.*return|return.*empty|empty container returned|empty received|returned.*depot|empty in\b|gate\s*in\s+empty|empty.*gate[\s-]*in|devolu/i,
  ],
  [
    'gate_out',
    // `gated?[\s-]*out` (e não `\s*`): a ZIM escreve com HÍFEN — "Import Gate-Out
    // from Port of Discharge to Customer". Sem o hífen aqui, a RETIRADA escapava
    // e caía em `discharge`, porque o texto contém "Port of Discharge" (nome do
    // porto, não o evento) — datas de demurrage erradas.
    //
    // CHEIO recebido em DEPÓSITO NO INTERIOR (Evergreen: "Full import container
    // received at inland depot", Santos, 1 dia após a descarga) = o contêiner
    // cheio SAIU do terminal portuário — na prática, a retirada (comum em DTA /
    // porto seco). Exige cheio/importação/laden: vazio no depósito é outra coisa.
    //
    // "Pick-up by merchant haulage" (Evergreen, NO DESTINO, 3 dias após a descarga):
    // o caminhão do importador buscando o CHEIO = retirada. O "Empty pick-up" da
    // origem já foi descartado pela guarda lá embaixo.
    /gated?[\s-]*out|to consignee|delivered to|picked up|\bpick[\s-]?up\b|full.*out|out\s?gate|import.*deliver|entregue|sa[ií]da.*cheio|(?:full|import|laden)\b.*\b(?:inland depot|dry port|porto seco)/i,
  ],
  // `releas` (e não `released`): a ZIM emite "Carrier Release", sem o D. A liberação
  // de VAZIO na origem já é descartada pelo guard lá embaixo, então afrouxar aqui
  // não traz o evento de origem de volta.
  ['available', /available|disponib|releas|liberad|ready for (delivery|pickup)/i],
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
  //  - "Empty pick-up by merchant haulage" (Evergreen, na ORIGEM): o vazio sendo
  //    retirado para estufagem. Sem esta guarda, o "pick-up" abaixo o leria como
  //    retirada do cheio.
  if (/empty\s+(?:container\s+)?pick[\s-]?up/.test(s)) return 'other';
  if (/gate[\s-]*out\s+empty/.test(s)) return 'other';
  // Descarga/descida em porto de TRANSBORDO (T/S) — ex.: HMM "Feeder Discharged
  // at T/S Port", ONE "Unloaded from Vessel at Transshipment Port". NÃO é a
  // descarga no DESTINO, então não pode iniciar a contagem de demurrage.
  if (/discharg|unload/.test(s) && /\bt\/s\b|trans\w*hip|transbordo|feeder/.test(s)) {
    return 'other';
  }
  // QUALQUER movimento em porto de TRANSBORDO é etapa INTERMEDIÁRIA (o demurrage
  // conta no DESTINO), então não pode virar gate_out/available. Ex. real (MSC):
  // "Full Transshipment Positioned Out LADEN" em Busan — o "full.*out" da regra
  // de gate_out marcava isso como RETIRADA e cravava um gateOut falso. Transbordo
  // = sempre `other`.
  //
  // `trans\w*hipment` em vez de `transship|tranship` porque o portal da ZIM tem um
  // TYPO no próprio texto: "Container was loaded at Transsihipment Port to Port of
  // Discharge". A grafia errada escapava da guarda e, por conter "Port of
  // Discharge", era classificada como DESCARGA — contaminando o início da contagem.
  // O padrão tolerante cobre transshipment / transhipment / transsihipment.
  //
  // E `trans\w*hip` (sem exigir "-ment"): a Evergreen escreve "Discharged and
  // waiting for transshippING" (Ningbo, porto de transbordo). Com `...hipment`
  // isso escapava e virava DESCARGA — num BL ainda em trânsito, a descarga do
  // transbordo seria lida como início da contagem de demurrage.
  if (/trans\w*hip|transbordo/.test(s)) return 'other';
  // "Positioned Out/In" é reposicionamento de PÁTIO/ferrovia (empilhamento), não a
  // entrega ao consignatário. Jargão de terminal, nunca de retirada final.
  if (/position(?:ed)?\s+(?:out|in)\b/.test(s)) return 'other';
  for (const [type, re] of RULES) {
    if (re.test(s)) return type;
  }
  return 'other';
}
