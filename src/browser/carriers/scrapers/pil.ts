import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, extractRowsFromHtml } from './hapag';

/**
 * Priora — Parser do rastreio da PIL (pilship.com, "Container T&T").
 *
 * O deep-link (?refNo=) traz duas tabelas:
 *  - VIAGEM (Arrival/Delivery | Location | Vessel/Voyage | Next Location) — sem
 *    contêiner; é o schedule do navio.
 *  - CONTÊINER (Container# | Size/Type | Movement Type | Date | Latest Event |
 *    Place) — UMA linha por contêiner, com o ÚLTIMO evento e a data. Ex.:
 *      PCIU9028668 | 40HC | FCL/FCL | 10-Feb-2026 14:29 | I/B Empty Container Returned | NAVEGANTES
 *
 * Como a COSCO: só as linhas COM nº de contêiner viram evento (ignora a tabela de
 * viagem). Diferença: aqui a DATA e o STATUS ("Latest Event") ficam em células
 * SEPARADAS, e há Size/Type por linha (capturamos o tipo do contêiner).
 *
 * O histórico completo (descarga → retirada → devolução) fica atrás do link
 * "Trace" (a.trackinfo → div#container_info_sub_<contêiner> .sub-info-table),
 * que o motor de navegação clica; o parser desse detalhe entra na 2ª fase.
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;
// Tamanho/tipo ISO (40HC, 20GP, 40HQ, 45RH, 20RF…).
const SIZE_RE = /\b\d{2}(?:GP|HC|HQ|DV|DC|RF|RH|OT|FR|TK|PL|BU)\b/i;
// Palavras do "Latest Event" (movimento). Sem modais de transporte.
const MOVE_RE =
  /discharg|gate|empty|load|deliver|return|pick|arriv|depart|received|released|shipped|customs|dispatch|stripp|devan|berth/i;
// Termos de "Movement Type"/traffic (FCL/FCL, LCL, CY/CY) — não são local.
const TRAFFIC_RE = /^(?:FCL|LCL|CY|CFS|DOOR)[\s/]/i;

export function extractPilEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/container_info_sub|trackinfo/i.test(html)) return out;

  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    // 1) Contêiner (ISO 6346) — sem ele, é linha de viagem/cabeçalho → ignora.
    let container: string | null = null;
    for (const c of cells) {
      const m = c.match(CONTAINER_RE);
      if (m) {
        container = m[0];
        break;
      }
    }
    if (!container) continue;

    // 2) Data (coluna "Date") — 1ª célula com data fora a do contêiner.
    let date: string | null = null;
    let dateCell = '';
    for (const c of cells) {
      if (c.includes(container)) continue;
      const iso = parseDateToISO(c);
      if (iso) {
        date = iso;
        dateCell = c;
        break;
      }
    }

    // 3) Status ("Latest Event") — célula com palavra de movimento, != data.
    const status =
      cells.find((c) => c !== dateCell && !c.includes(container as string) && MOVE_RE.test(c)) || '';
    if (!status && !date) continue;

    // 4) Tipo (coluna "Size/Type"): 40HC etc.
    const tipoCell = cells.find((c) => SIZE_RE.test(c));
    const tipo = tipoCell ? tipoCell.match(SIZE_RE)?.[0]?.toUpperCase() || null : null;

    // 5) Local (coluna "Place") — última célula textual que não é
    //    contêiner/data/status/tipo nem traffic term (FCL/FCL).
    const location =
      [...cells]
        .reverse()
        .find(
          (c) =>
            c !== dateCell &&
            c !== status &&
            !c.includes(container as string) &&
            !SIZE_RE.test(c) &&
            !TRAFFIC_RE.test(c) &&
            /[A-Za-z]/.test(c) &&
            parseDateToISO(c) === null,
        ) || null;

    const key = `${container}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      date,
      status: status || dateCell,
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
