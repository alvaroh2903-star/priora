import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, stripTags } from './hapag';

/**
 * Priora — Parser DEDICADO do rastreio da HMM (hmm21.com, Track & Trace).
 *
 * Os resultados vêm numa tabela "Shipment History" (div#shipmentProgress) com as
 * colunas: Date | Time | Location | Status Description | Mode. Cada evento é um
 * <tr class="clsMoves …">. O nº do contêiner vem do campo escondido #thisCntr.
 * Ex.: 2026-07-23 | 17:49 | SINGAPORE | Feeder Discharged at T/S Port | Feeder.
 *
 * ATENÇÃO ao TRANSBORDO: a HMM marca "T/S Port"/"Feeder" nos eventos de
 * transbordo — o classificador (eventTypes) já joga descarga de T/S em "other",
 * então só a descarga NO DESTINO conta pro demurrage.
 *
 * Lê APENAS a tabela #shipmentProgress (a página tem outras — Schedule, Container
 * Info — que o parser genérico misturava).
 */

/** Células (texto, sem vazias) de um bloco de <tr>. */
function rowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let c: RegExpExecArray | null;
  while ((c = cellRe.exec(rowHtml))) {
    const t = stripTags(c[1]);
    if (t) cells.push(t);
  }
  return cells;
}

export function extractHmmEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/hmm21|id="shipmentProgress"|id="thisCntr"/i.test(html)) return out;

  // Contêiner do campo escondido #thisCntr (fallback: 1º contêiner do HTML).
  const contM = html.match(/id="thisCntr"\s+value="([A-Z]{4}\d{7})"/i);
  const container = contM ? contM[1] : html.match(/\b[A-Z]{4}\d{7}\b/)?.[0] || null;

  // Isola a tabela "Shipment History" (#shipmentProgress) — ignora as outras.
  const tblM = html.match(/id="shipmentProgress"[\s\S]*?<\/table>/i);
  const tableHtml = tblM ? tblM[0] : html;

  const seen = new Set<string>();
  const trRe = /<tr\b[^>]*class="[^"]*clsMoves[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(tableHtml))) {
    const cells = rowCells(m[1]); // [Date, Time, Location, Status, Mode]
    if (cells.length < 4) continue;
    const date = parseDateToISO(cells[0]);
    if (!date) continue;
    const location = cells[2] || null;
    const status = cells[3] || '';
    if (!status) continue;
    // Mode = navio (ex.: "ONE CONTINUITY 0078W") quando não é Truck/Feeder/Rail.
    const mode = cells[4] || '';
    const vessel = mode && !/^(truck|feeder|rail|barge)$/i.test(mode) ? mode : null;

    const key = `${container}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      status,
      location,
      vessel,
      voyage: null,
      type: classifyEvent(status),
      container,
    });
  }
  return out;
}
