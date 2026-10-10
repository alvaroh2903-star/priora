import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, stripTags } from './hapag';

/**
 * Priora — Parser DEDICADO da ZIM (zim.com/tools/track-a-shipment, React em DIV).
 *
 * Validado ao vivo (ZIMUTRT938698, 10/10/2026, depois do desafio do Akamai):
 * um cartão por contêiner (`li.card-container-v2`) e, dentro dele, a lista de
 * atividades (`li.card-container-activity`). Cada célula tem um id com o nome do
 * campo — contrato mais estável que classe CSS:
 *   N_desktop_1_cargoType      → tipo (HC40)
 *   N_desktop_2_activityDateTz → <div class="date">16-Sep-2026</div>
 *   N_desktop_3_activityDesc   → atividade ("Carrier Release")
 *   N_desktop_4_placeFromDesc  → local
 *   N_desktop_5_vessel         → "ZIM BALTIMORE/349/S" (link) ou "N/A"
 *
 * ATENÇÃO: a ÚLTIMA atividade ("Empty container gate in" = devolução) aparece só
 * no CABEÇALHO do cartão ("Last Activity") e não se repete na lista — sem lê-lo,
 * a devolução sumia.
 */

/** Assinatura do DOM do resultado da ZIM (marcas exclusivas do portal). */
export const ZIM_DOM_RE = /card-container-v2[\s\S]*?_desktop_3_activityDesc/;

/** Texto da célula `_desktop_<n>_<campo>` (até o fim do div dela). */
function cell(chunk: string, n: number, field: string): string | null {
  const m = chunk.match(new RegExp(`_desktop_${n}_${field}">([\\s\\S]*?)</div>(?:</div>)?`));
  if (!m) return null;
  const t = stripTags(m[1]);
  return t || null;
}

function eventFrom(chunk: string, container: string, tipo: string | null): TrackingEvent | null {
  const dateM = chunk.match(/_desktop_2_activityDateTz"><div class="date">([^<]+)<\/div>/);
  const date = dateM ? parseDateToISO(stripTags(dateM[1])) : null;
  const status = cell(chunk, 3, 'activityDesc');
  if (!date || !status) return null;
  const vesselTxt = cell(chunk, 5, 'vessel');
  let vessel: string | null = null;
  let voyage: string | null = null;
  if (vesselTxt && !/^n\/?a$/i.test(vesselTxt)) {
    const i = vesselTxt.indexOf('/');
    vessel = (i > 0 ? vesselTxt.slice(0, i) : vesselTxt).trim() || null;
    voyage = i > 0 ? vesselTxt.slice(i + 1).trim() || null : null;
  }
  return {
    date,
    status,
    location: cell(chunk, 4, 'placeFromDesc'),
    vessel,
    voyage,
    type: classifyEvent(status),
    container,
    tipo,
  };
}

export function extractZimEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!ZIM_DOM_RE.test(html)) return out;
  const seen = new Set<string>();
  const push = (e: TrackingEvent | null) => {
    if (!e) return;
    const k = `${e.container}|${e.date}|${e.status}|${e.location}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  for (const card of html.split('card-container-v2').slice(1)) {
    const cm = card.match(/unit-number">\s*([A-Z]{4}\d{7})/);
    if (!cm) continue;
    const container = cm[1];
    const tipo = cell(card, 1, 'cargoType');
    const parts = card.split('card-container-activity');
    // Cabeçalho do cartão = "Last Activity" (a mais recente; não se repete abaixo).
    push(eventFrom(parts[0], container, tipo));
    for (const act of parts.slice(1)) push(eventFrom(act, container, tipo));
  }
  return out;
}
