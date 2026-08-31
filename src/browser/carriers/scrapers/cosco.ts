import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, extractRowsFromHtml } from './hapag';

/**
 * Priora — Parser do rastreio da COSCO (app SCCT, elines.coscoshipping.com).
 *
 * O deep-link do iframe (scct/public/ct/base?trackingType=BILLOFLADING&number=)
 * renderiza duas tabelas <table> reais:
 *  - "Transport Detail": UMA linha por CONTÊINER
 *      # | Container# | Transport Mode | Traffic Term | Current Location | Latest Status
 *    onde "Latest Status" traz status + data junta: "Discharged at Last POD At
 *    2026-08-28 17:42:00".
 *  - "Schedule Detail": uma linha por NAVIO (sem contêiner).
 *
 * Sacada: só as linhas do Transport Detail têm nº de contêiner (ISO 6346). Ao
 * filtrar pelas linhas COM contêiner, ignoramos o Schedule e os cabeçalhos de
 * uma vez — e emitimos um evento POR contêiner (o `deriveContainers` agrupa por
 * `container`). Um BL da COSCO costuma ter vários contêineres.
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;
// Palavras que marcam a célula de "Latest Status" (movimento do contêiner) —
// usadas SÓ no fallback (quando o status ainda não tem data). NÃO inclui os
// modais de transporte (vessel/truck/rail/barge) para não confundir a coluna
// "Transport Mode" com o status.
const MOVE_RE =
  /discharg|gate|empty|load|deliver|return|pick|arriv|depart|received|released|shipped|customs|dispatch/i;
// Célula que parece "Current Location" (terminal/porto/depósito ou "Cidade, País").
const LOCATION_RE = /terminal|\bterm\b|\bport\b|\btml\b|depot|yard|,/i;

/** Remove qualquer data/hora ISO do texto do status ("... At 2026-08-28 17:42:00"). */
function cleanStatus(raw: string): string {
  return raw
    .replace(/\bat\s+\d{4}-\d{2}-\d{2}[\sT\d:]*/gi, ' ')
    .replace(/,\s*\d{4}-\d{2}-\d{2}[\sT\d:]*/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractCoscoEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  // Assinatura do app SCCT da COSCO (evita rodar em HTML de outro armador).
  if (!/id=["']scct["']|scct\/assets|CargoTrackingTransportDetail/i.test(html)) return out;

  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    // 1) Contêiner (ISO 6346) — sem ele, é linha de Schedule/cabeçalho → ignora.
    let container: string | null = null;
    for (const c of cells) {
      const m = c.match(CONTAINER_RE);
      if (m) {
        container = m[0];
        break;
      }
    }
    if (!container) continue;

    // 2) "Latest Status" = a célula que carrega a DATA (status + "At <data>"
    //    juntos). É a única com data no Transport Detail, então serve de âncora —
    //    e evita confundir com a coluna "Transport Mode" (Vessel/Truck/Rail).
    let statusRaw = '';
    let date: string | null = null;
    for (const c of cells) {
      if (c.includes(container)) continue;
      const iso = parseDateToISO(c);
      if (iso) {
        statusRaw = c;
        date = iso;
        break;
      }
    }
    // Fallback: status ainda sem data → a célula com palavra de movimento.
    if (!statusRaw) {
      statusRaw = cells.find((c) => !c.includes(container as string) && MOVE_RE.test(c)) || '';
    }
    const status = cleanStatus(statusRaw);
    if (!status && !date) continue;

    // 4) Local: "Current Location" (terminal/porto) — nunca o próprio status/contêiner.
    const location =
      cells.find(
        (c) => c !== statusRaw && !c.includes(container as string) && LOCATION_RE.test(c),
      ) || null;

    // 5) dedupe por contêiner (Ant duplica linhas em tabela de cabeçalho fixo).
    const key = `${container}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      status: status || statusRaw,
      location,
      vessel: null,
      voyage: null,
      type: classifyEvent(status || statusRaw),
      container,
    });
  }
  return out;
}
