import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, extractRowsFromHtml } from './hapag';

/**
 * Priora — Parser DEDICADO do rastreio da CMA CGM (cma-cgm.com/ebusiness/tracking).
 *
 * Cabeçalho traz "Container XXXX" (o contêiner) e uma tabela de movimentos com
 * as colunas: Date | Moves | Location/Terminal | Vessel (Voyage). Ex.:
 *   Tuesday, 25-AUG-2026 09:18 PM | GATE IN EMPTY AT DEPOT | PARANAGUA / BRPNGDLEC | —
 * O histórico completo (descarga, gate-out…) aparece ao clicar "Display Previous
 * Moves" (o motor expande antes de capturar). Sem captcha.
 *
 * A ordem das colunas garante que o 1º campo com data é o Date e o 1º campo (após
 * a data) com palavra de movimento é o Moves — antes do Vessel — então não
 * confundimos o nome do navio com o status.
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;
const MOVE_RE =
  /discharg|gate|empty|load|deliver|return|pick|arriv|depart|received|released|customs|vessel|shipped|berth|dispatch|rail|barge/i;
// Célula de navio/voyage: tem a voyage entre parênteses (ex.: "CMA CGM X (0BDOKW1MA)").
const VOYAGE_RE = /\([0-9A-Z]{2,14}\)/;

export function extractCmaEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/cma[-\s]?cgm/i.test(html)) return out;

  // Contêiner do cabeçalho ("Container XXXX"); fallback: 1º contêiner do HTML.
  const headM = html.match(/Container[\s\S]{0,40}?\b([A-Z]{4}\d{7})\b/i);
  const container = headM ? headM[1] : html.match(CONTAINER_RE)?.[0] || null;

  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    // Data (coluna Date) — 1ª célula com data.
    let date: string | null = null;
    let dateCell = '';
    for (const c of cells) {
      const iso = parseDateToISO(c);
      if (iso) {
        date = iso;
        dateCell = c;
        break;
      }
    }
    if (!date) continue;

    // Moves (status) = 1ª célula (após a data) com palavra de movimento. Vem
    // ANTES da coluna Vessel, então find() pega o status certo, não o navio.
    const status = cells.find((c) => c !== dateCell && MOVE_RE.test(c) && !VOYAGE_RE.test(c)) || '';
    if (!status) continue;

    // Vessel (Voyage): célula com a voyage entre parênteses (opcional).
    const vesselCell = cells.find((c) => VOYAGE_RE.test(c)) || null;
    let vessel: string | null = null;
    let voyage: string | null = null;
    if (vesselCell) {
      const vm = vesselCell.match(/^(.*?)\s*\(([0-9A-Z]{2,14})\)/);
      if (vm) {
        vessel = vm[1].trim() || null;
        voyage = vm[2];
      } else {
        vessel = vesselCell.trim() || null;
      }
    }

    // Location/Terminal: célula que não é data, status nem vessel (o lugar).
    const location =
      cells.find(
        (c) =>
          c !== dateCell &&
          c !== status &&
          c !== vesselCell &&
          !VOYAGE_RE.test(c) &&
          !/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(c) && // não é só a hora
          /[A-Za-z]/.test(c) &&
          parseDateToISO(c) === null,
      ) || null;

    const key = `${container}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, status, location, vessel, voyage, type: classifyEvent(status), container });
  }
  return out;
}
