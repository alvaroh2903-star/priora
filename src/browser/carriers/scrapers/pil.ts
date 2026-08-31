import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, extractRowsFromHtml, stripTags } from './hapag';

/**
 * Priora — Parser do rastreio da PIL (pilship.com, "Container T&T").
 *
 * O deep-link (?refNo=) traz, por contêiner:
 *  1) RESUMO — tabela `Container# | Size/Type | Movement Type | Date | Latest
 *     Event | Place`, uma linha por contêiner (último evento + tipo).
 *  2) HISTÓRICO (Trace) — ao clicar em "Trace" (a.trackinfo), carrega
 *     `<tbody class="sub-info-table" id="container_info_sub_<CONTÊINER>">` com a
 *     TIMELINE completa: `Vessel | Voyage | Event Date | Event Name | Event
 *     Location`. O `id` amarra os eventos ao contêiner.
 *
 * Preferimos o HISTÓRICO (tem descarga → retirada → devolução, tudo que o
 * demurrage precisa). Se o Trace não carregou, caímos no RESUMO (só o último
 * evento). Confirmado ao vivo: BL NNPL50072500, contêiner PCIU9028668 (descarga
 * em Navegantes 03-Fev, gate-out 10-Fev 09:24, devolução 10-Fev 14:29).
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;
const SIZE_RE = /\b\d{2}(?:GP|HC|HQ|DV|DC|RF|RH|OT|FR|TK|PL|BU)\b/i;
const MOVE_RE =
  /discharg|gate|empty|load|deliver|return|pick|arriv|depart|received|released|shipped|customs|dispatch|stripp|devan|berth/i;
const TRAFFIC_RE = /^(?:FCL|LCL|CY|CFS|DOOR)[\s/]/i;

/** Extrai as células (texto, sem vazias) de um bloco de <tr>. */
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

/**
 * HISTÓRICO: lê cada `tbody.sub-info-table#container_info_sub_<CONTÊINER>` (o
 * detalhe que o Trace carrega) e emite um evento por linha, amarrado ao contêiner
 * do `id`. Colunas: [Vessel?, Voyage?, Event Date, Event Name, Event Location].
 */
export function extractPilDetail(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  const tbodyRe =
    /<tbody[^>]*class="[^"]*sub-info-table[^"]*"[^>]*id="container_info_sub_([A-Z0-9]+)"[^>]*>([\s\S]*?)<\/tbody>/gi;
  const seen = new Set<string>();
  let t: RegExpExecArray | null;
  while ((t = tbodyRe.exec(html))) {
    const container = t[1];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let r: RegExpExecArray | null;
    while ((r = trRe.exec(t[2]))) {
      const cells = rowCells(r[1]);
      const dateIdx = cells.findIndex((c) => parseDateToISO(c));
      if (dateIdx < 0) continue; // cabeçalho ("Event Date"…) ou linha vazia.
      const date = parseDateToISO(cells[dateIdx]);
      const before = cells.slice(0, dateIdx); // [Vessel?, Voyage?]
      const after = cells.slice(dateIdx + 1); // [Event Name, Event Location]
      const status = (after[0] || '').trim();
      if (!status) continue;
      const key = `${container}|${date}|${status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        date,
        status,
        location: after[1] || null,
        vessel: before[0] || null,
        voyage: before[1] || null,
        type: classifyEvent(status),
        container,
      });
    }
  }
  return out;
}

/**
 * RESUMO: tabela de contêiner (Latest Event). Só as linhas COM nº de contêiner
 * viram evento (ignora a tabela de viagem). Data e status ficam em células
 * separadas; captura o tipo (Size/Type). Fallback quando o Trace não carregou.
 */
export function extractPilSummary(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  const seen = new Set<string>();
  for (const cells of extractRowsFromHtml(html)) {
    let container: string | null = null;
    for (const c of cells) {
      const m = c.match(CONTAINER_RE);
      if (m) {
        container = m[0];
        break;
      }
    }
    if (!container) continue;

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
    const status =
      cells.find((c) => c !== dateCell && !c.includes(container as string) && MOVE_RE.test(c)) || '';
    if (!status && !date) continue;

    const tipoCell = cells.find((c) => SIZE_RE.test(c));
    const tipo = tipoCell ? tipoCell.match(SIZE_RE)?.[0]?.toUpperCase() || null : null;
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

/** Mapa contêiner → tipo (Size/Type), lido do RESUMO. */
function tipoByContainer(html: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const e of extractPilSummary(html)) {
    if (e.container) map.set(e.container, e.tipo ?? null);
  }
  return map;
}

export function extractPilEvents(html: string): TrackingEvent[] {
  if (!/container_info_sub|trackinfo/i.test(html)) return [];
  // 1) HISTÓRICO (Trace) — completo. Anexa o tipo (que só existe no resumo).
  const detailed = extractPilDetail(html);
  if (detailed.length) {
    const tipos = tipoByContainer(html);
    for (const e of detailed) {
      if (e.container && tipos.get(e.container)) e.tipo = tipos.get(e.container) as string;
    }
    return detailed;
  }
  // 2) RESUMO — só o último evento (Trace não carregou).
  return extractPilSummary(html);
}
