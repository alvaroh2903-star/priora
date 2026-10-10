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

/**
 * Página de DETALHE do contêiner (cargo_tracking_detail?trackNo=…)? Ela tem a
 * grade "Container Status [Events compliant with DCSA standard]" com as colunas
 * Date/Time | Event | At Facility | To Facility | Mode — o resumo não tem.
 */
export function isYangMingDetailPage(html: string): boolean {
  return /At Facility/i.test(html) && /To Facility/i.test(html);
}

/** "NOME DO NAVIO (VIAGEM)" — coluna Mode da página de detalhe. */
const VESSEL_VOY_RE = /^(.+?)\s*\(([A-Z0-9]{2,12})\)\s*$/;

/**
 * Parser da página de DETALHE do contêiner — o histórico DCSA COMPLETO
 * (validado ao vivo, FFAU6989181 / YMJAB240071209):
 *   2026/09/30 15:07 | Empty Returned    | NAVEGANTES - Atlantis Terminais…
 *   2026/09/29 23:51 | Full to Consignee | NAVEGANTES - Portonave…
 *   2026/09/25 22:08 | Discharged        | NAVEGANTES - Portonave…
 *   2026/07/29 13:00 | On Board          | QINGDAO - … | NAVEGANTES | COSCO SHIPPING PERU (009W)
 * É aqui que aparece a DESCARGA que o resumo (só o último evento) escondia —
 * e a descarga é o início da contagem do demurrage.
 *
 * As linhas da grade não repetem o nº do contêiner: ele vem do cabeçalho
 * ("Container No. FFAU6989181 40'/HQ") ou do `containerHint` (o trackNo do link
 * que abriu a página). Colunas vazias somem da extração, então "To Facility" e
 * "Mode" não têm posição fixa — o navio é achado pelo formato "NOME (VIAGEM)".
 */
export function extractYangMingDetailEvents(html: string, containerHint?: string | null): TrackingEvent[] {
  // Cabeçalho em texto (tags viram espaço, senão "FFAU6989181</span><span>40'"
  // gruda o contêiner no tamanho e o limite de palavra some).
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const head = text.match(/Container No\.?\s*([A-Z]{4}\d{7})\b([^]{0,60})/);
  const container = head?.[1] || containerHint || null;
  const sizeType = head?.[2]?.match(/(\d{2})'\s*\/\s*([A-Z]{2})/);
  const tipo = sizeType ? `${sizeType[1]}${sizeType[2]}` : null;

  const out: TrackingEvent[] = [];
  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    const dIdx = cells.findIndex((c) => ymDateToISO(c) !== null);
    if (dIdx < 0) continue; // cabeçalho (Date/Time) ou linha sem data
    const date = ymDateToISO(cells[dIdx]);
    const status = (cells[dIdx + 1] || '').trim();
    if (!status || ymDateToISO(status)) continue;
    const loc = (cells[dIdx + 2] || '').trim();
    const location = loc && loc !== '-' ? loc : null;
    let vessel: string | null = null;
    let voyage: string | null = null;
    for (const c of cells.slice(dIdx + 3)) {
      const m = c.trim().match(VESSEL_VOY_RE);
      if (m) {
        vessel = m[1].trim();
        voyage = m[2];
        break;
      }
    }
    const key = `${date}|${status}|${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, status, location, vessel, voyage, type: classifyEvent(status), container, tipo });
  }
  return out;
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
