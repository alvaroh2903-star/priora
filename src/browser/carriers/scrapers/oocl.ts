import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, stripTags } from './hapag';

/**
 * Priora — Parser DEDICADO do rastreio da OOCL (portal SCCT em
 * pbcontroltower.digital.oocl.com/scct/public/moc/cargoTracking).
 *
 * ATENÇÃO: é um parser PRÓPRIO — NÃO é o da COSCO. Apesar de ambos serem "SCCT"
 * (mesmo grupo), o layout da OOCL é diferente: um bloco por contêiner ("Container
 * No. XXXX") seguido de uma tabela de eventos com as colunas:
 *   Event | Time | Location | Stage | Transport Mode
 * Ex.: Discharged | 18 Aug 2026 05:42 BRT | Portonave... Navegantes | Ocean | Vessel.
 *
 * Como as linhas de evento NÃO repetem o nº do contêiner, associamos cada evento
 * ao ÚLTIMO "Container No." que apareceu antes dele (varredura em ordem do DOM).
 * Nada é fixo a um BL específico — funciona p/ qualquer referência.
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;

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

export function extractOoclEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/oocl|pbcontroltower/i.test(html)) return out;

  const seen = new Set<string>();
  let current: string | null = null;

  // Varre o DOM em ORDEM, alternando dois tokens:
  //  (1) "Container No. … XXXX" → troca o contêiner atual;
  //  (2) <tr>…</tr> → se for linha de evento (tem data), emite pro atual.
  const tokenRe =
    /Container\s*No\.?\s*:?[\s\S]{0,80}?\b([A-Z]{4}\d{7})\b|<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    if (m[1]) {
      current = m[1]; // cabeçalho de contêiner
      continue;
    }
    const cells = rowCells(m[2]);
    // Linha de evento: precisa do "Time" (data) e do "Event" antes dele.
    const dateIdx = cells.findIndex((c) => parseDateToISO(c));
    if (dateIdx < 1) continue;
    const date = parseDateToISO(cells[dateIdx]);
    const status = cells[dateIdx - 1]; // coluna Event
    if (!status || CONTAINER_RE.test(status)) continue;
    const location = cells[dateIdx + 1] || null; // coluna Location

    const key = `${current}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      status,
      location,
      vessel: null,
      voyage: null,
      type: classifyEvent(status),
      container: current,
    });
  }
  return out;
}
