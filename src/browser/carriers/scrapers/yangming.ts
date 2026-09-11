import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { extractRowsFromHtml } from './hapag';

/**
 * Priora — Parser DEDICADO da Yang Ming (yangming.com/en/esolution/cargo_tracking).
 *
 * App Next.js; o preenchedor genérico já submete a busca. A tabela "Container
 * Status" (grade react-aria, `<td>`) traz 1 linha por contêiner, colunas:
 *   Container No. | Size | Type | Seal No. | MoveType | Date/Time | Latest Event
 *   | Place | VGM
 * Ex.: BMOU6332262 | 40 | HQ-9'6'' container | … | 2026/08/25 15:00 | Empty
 *      Returned | RIO DE JANEIRO - Rio Brasil Terminal
 *
 * IMPORTANTE: a tabela mostra só o ÚLTIMO evento (Latest Event) por contêiner. O
 * histórico DCSA completo (descarga+retirada+devolução) fica na página de detalhe
 * (link do nº do contêiner: cargo_tracking_detail?trackNo=…&refNo=…), a plugar.
 * Data no formato YYYY/MM/DD [HH:MM].
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;
const YM_DATE_RE = /\b(\d{4})\/(\d{2})\/(\d{2})\b/;
// Código de tipo de contêiner (Yang Ming: "HQ-9'6'' container", "GP container"…).
const TYPE_CODE_RE = /\b(HQ|HC|GP|DV|DC|RF|RH|OT|FR|TK|PL|BU|RE)\b/i;

/** Data Yang Ming "YYYY/MM/DD [HH:MM]" → ISO "YYYY-MM-DD". */
export function ymDateToISO(s: string | null | undefined): string | null {
  const m = (s || '').match(YM_DATE_RE);
  if (!m) return null;
  const mon = +m[2];
  const day = +m[3];
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function extractYangMingEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/yangming|cargo_tracking_detail/i.test(html)) return out;

  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    // Contêiner (ISO 6346) — sem ele a linha é de Basic Info/Routing → ignora.
    let container: string | null = null;
    let cIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      const m = cells[i].match(CONTAINER_RE);
      if (m) {
        container = m[0];
        cIdx = i;
        break;
      }
    }
    if (!container) continue;

    // Data (coluna Date/Time) = 1ª célula YYYY/MM/DD depois do contêiner.
    let dateIdx = -1;
    let date: string | null = null;
    for (let i = cIdx + 1; i < cells.length; i++) {
      const iso = ymDateToISO(cells[i]);
      if (iso) {
        dateIdx = i;
        date = iso;
        break;
      }
    }
    if (dateIdx < 0) continue;

    // Latest Event = célula após a data; Place = a seguinte.
    const status = (cells[dateIdx + 1] || '').trim();
    if (!status || CONTAINER_RE.test(status)) continue;
    const location = (cells[dateIdx + 2] || '').trim() || null;

    // Size (dígitos, ex.: "40") + Type ("HQ-9'6'' container") → tipo "40HQ".
    const between = cells.slice(cIdx + 1, dateIdx);
    const sizeCell = between.find((c) => /^\d{2}$/.test(c.trim())) || '';
    const typeCell = between.find((c) => TYPE_CODE_RE.test(c)) || '';
    const typeCode = typeCell ? (typeCell.match(TYPE_CODE_RE)?.[0].toUpperCase() ?? '') : '';
    const tipo = `${sizeCell.trim()}${typeCode}`.trim() || null;

    const key = `${container}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      status,
      location,
      vessel: null,
      voyage: null,
      type: classifyEvent(status),
      container,
      tipo,
    });
  }
  return out;
}
