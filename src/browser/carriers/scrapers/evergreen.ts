import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, extractRowsFromHtml } from './hapag';

/**
 * Priora — Parser DEDICADO da Evergreen (ShipmentLink, ct.shipmentlink.com).
 *
 * A busca (B/L SÓ com a parte numérica — o registro tira o prefixo EGLV/EVGL)
 * mostra, na MESMA página, a tabela "Container(s) information on B/L and Current
 * Status" com as colunas:
 *   Container No. | Size/Type | Seal No. | Service Type | Quantity | Method | VGM
 *   | Current Status | Date
 * Ex.: TGBU6521228 | 40'(SH) | … | Loaded (FCL) on EVER LEADER 0044-080W at NINGBO
 *      | JUL-16-2026.  (a data é MON-DD-YYYY, tratada no parseDateToISO)
 *
 * Um evento por contêiner (o "Current Status" mais recente + a data). Só linhas
 * COM nº de contêiner viram evento — ignora cabeçalhos e a tabela de Basic Info.
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;
// Tamanho/tipo Evergreen: "40'(SH)", "20'(GP)", "40'(HQ)"…
const SIZE_RE = /\b\d{2}\s*['’]?\s*\(?\s*(GP|HC|HQ|RF|RH|SH|DV|DC|OT|FR|TK|PL|BU)\b/i;

/**
 * O "Current Status" da Evergreen embute local/navio/viagem no próprio texto:
 *   "Loaded (FCL) on EVER LEADER 0044-080W at NINGBO, CHINA (CN)"
 *   "Discharged (FCL) at NAVEGANTES"
 *   "Empty Returned to Depot at NAVEGANTES"
 * Extrai: local = trecho após o ÚLTIMO " at "; navio+viagem = trecho entre " on "
 * e o " at " seguinte, com a viagem = último token que contém dígito
 * (ex.: "0044-080W") e o navio = o resto (ex.: "EVER LEADER").
 */
function parseEvergreenStatus(status: string): {
  location: string | null;
  vessel: string | null;
  voyage: string | null;
} {
  let location: string | null = null;
  let vessel: string | null = null;
  let voyage: string | null = null;
  const lower = status.toLowerCase();

  const atIdx = lower.lastIndexOf(' at ');
  if (atIdx >= 0) location = status.slice(atIdx + 4).trim() || null;

  const onIdx = lower.indexOf(' on ');
  if (onIdx >= 0) {
    const after = status.slice(onIdx + 4);
    const atInAfter = after.toLowerCase().lastIndexOf(' at ');
    const vv = (atInAfter >= 0 ? after.slice(0, atInAfter) : after).trim();
    if (vv) {
      const parts = vv.split(/\s+/);
      const last = parts[parts.length - 1];
      if (parts.length > 1 && /\d/.test(last)) {
        voyage = last;
        vessel = parts.slice(0, -1).join(' ');
      } else {
        vessel = vv;
      }
    }
  }
  return { location, vessel, voyage };
}

export function extractEvergreenEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/shipmentlink|TDB1_CargoTracking/i.test(html)) return out;

  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    // Contêiner (ISO 6346) — sem ele, é cabeçalho / Basic Info → ignora.
    let container: string | null = null;
    for (const c of cells) {
      const m = c.match(CONTAINER_RE);
      if (m) {
        container = m[0];
        break;
      }
    }
    if (!container) continue;

    // Data (coluna Date) = última célula com data.
    let dateIdx = -1;
    let date: string | null = null;
    for (let i = cells.length - 1; i >= 0; i--) {
      const iso = parseDateToISO(cells[i]);
      if (iso) {
        dateIdx = i;
        date = iso;
        break;
      }
    }
    if (dateIdx < 1) continue; // precisa do "Current Status" antes da Date

    // "Current Status" = célula imediatamente antes da Date.
    const status = (cells[dateIdx - 1] || '').trim();
    if (!status || CONTAINER_RE.test(status)) continue;

    // Tipo (Size/Type): célula com padrão de tamanho (ex.: 40'(SH)).
    const tipoCell = cells.find((c) => SIZE_RE.test(c));
    const tipo = tipoCell ? tipoCell.replace(/\s+/g, '') : null;

    const key = `${container}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { location, vessel, voyage } = parseEvergreenStatus(status);
    out.push({
      date,
      status,
      location,
      vessel,
      voyage,
      type: classifyEvent(status),
      container,
      tipo,
    });
  }
  return out;
}
