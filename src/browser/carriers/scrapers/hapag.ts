import { Page } from 'playwright';
import { ContainerInfo, NormalizedEventType, TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { ScrapeContext, ScrapeOutput } from '../scraperTypes';
import {
  acceptCookies,
  detectCaptcha,
  detectLogin,
  getBodyText,
  tryFillSearch,
} from '../pageUtils';

/**
 * Priora — Scraper do rastreio PÚBLICO da Hapag-Lloyd.
 *
 * A página pública de rastreio (por contêiner ou por B/L) mostra os EVENTOS de
 * movimentação — inclusive a retirada do cheio (gate-out) e a devolução do
 * vazio, que são exatamente as datas de que a aba Demurrage precisa. O "last
 * free day" / valor de demurrage costuma exigir login no portal comercial e
 * fica null aqui (nada é inventado).
 *
 * A lógica de extração é independente do layout exato (varre linhas de tabela,
 * detecta a data e o status por palavra-chave) e é testada offline via
 * `page.setContent()` em `npm run carriers:selftest`. Os seletores/consentimento
 * finos são afinados rodando contra o site real (o build não alcança o portal).
 */

const MESES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  // pt-BR / de
  fev: 2, abr: 4, mai: 5, ago: 8, set: 9, out: 10, dez: 12, mär: 3, okt: 10,
};

/** Converte vários formatos de data para ISO (AAAA-MM-DD), ou null. */
export function parseDateToISO(text: string): string | null {
  if (!text) return null;
  const s = text.trim();
  // ISO: 2026-05-13 (com ou sem hora)
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 13-May-2026 / 13 May 2026 / 13.MAY.2026
  m = s.match(/\b(\d{1,2})[-.\s]([A-Za-zÀ-ÿ]{3,})[-.\s](\d{4})\b/);
  if (m) {
    const mon = MESES[m[2].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${pad(mon)}-${pad(+m[1])}`;
  }
  // May 13, 2026 / May 13 2026
  m = s.match(/\b([A-Za-zÀ-ÿ]{3,})\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const mon = MESES[m[1].slice(0, 3).toLowerCase()];
    if (mon) return `${m[3]}-${pad(mon)}-${pad(+m[2])}`;
  }
  // 13.05.2026 / 13/05/2026 (dia/mês/ano — padrão BR/EU, que a Hapag usa)
  m = s.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (m) {
    const dia = +m[1];
    const mes = +m[2];
    if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
      return `${m[3]}-${pad(mes)}-${pad(dia)}`;
    }
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// Palavras que indicam um evento de movimentação (qualquer idioma comum).
const MOVE_KEYWORDS = [
  'empty', 'gate', 'load', 'discharg', 'depart', 'arriv', 'vessel', 'deliver',
  'pick', 'return', 'terminal', 'import', 'export', 'rail', 'truck', 'barge',
  'stripping', 'stuffing', 'received', 'released', 'devolu', 'entregue',
  'embarq', 'desembarq', 'chegada', 'saída', 'saida',
];

function hasMoveKeyword(text: string): boolean {
  const low = text.toLowerCase();
  return MOVE_KEYWORDS.some((k) => low.includes(k));
}

/** Converte as células de uma linha em um evento (ou null se não for evento). */
function rowToEvent(cells: string[]): TrackingEvent | null {
  let date: string | null = null;
  let dateIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    const iso = parseDateToISO(cells[i]);
    if (iso) {
      date = iso;
      dateIdx = i;
      break;
    }
  }
  if (!date) return null; // sem data não tratamos como evento (evita cabeçalhos)

  // status: célula com palavra-chave de movimentação; senão a mais "textual".
  let statusIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    if (i === dateIdx) continue;
    if (hasMoveKeyword(cells[i])) {
      statusIdx = i;
      break;
    }
  }
  if (statusIdx === -1) {
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < cells.length; i++) {
      if (i === dateIdx) continue;
      const len = cells[i].replace(/[^A-Za-zÀ-ÿ]/g, '').length;
      if (len > bestLen) {
        bestLen = len;
        best = i;
      }
    }
    statusIdx = best;
  }
  const status = (statusIdx >= 0 ? cells[statusIdx] : '').trim();

  // location: célula restante com vírgula (Cidade, País) ou a 1ª textual restante.
  const rest = cells
    .map((c, i) => ({ c, i }))
    .filter((x) => x.i !== dateIdx && x.i !== statusIdx && x.c);
  const location =
    rest.find((x) => x.c.includes(','))?.c ||
    rest.find((x) => /[A-Za-zÀ-ÿ]/.test(x.c) && parseDateToISO(x.c) === null)?.c ||
    null;

  return { date, status, location, vessel: null, voyage: null, type: classifyEvent(status) };
}

export function dedupe(events: TrackingEvent[]): TrackingEvent[] {
  const seen = new Set<string>();
  const out: TrackingEvent[] = [];
  for (const e of events) {
    const key = `${e.date}|${e.status}|${e.location}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Extração SEM navegador (a partir de HTML cru já renderizado — ex.: Bright
 * Data render:true). Evita subir um Chromium local só para parsear (OOM no
 * Render free/512MB). Reaproveita a mesma lógica pura (rowToEvent/dedupe).
 * ------------------------------------------------------------------------- */

/** Remove tags e normaliza entidades/espaços de um trecho de HTML. */
export function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai as células (por regex) de um bloco de linha e limpa cada uma. */
function cellsFrom(rowHtml: string, cellRe: RegExp): string[] {
  const cells: string[] = [];
  cellRe.lastIndex = 0;
  let c: RegExpExecArray | null;
  while ((c = cellRe.exec(rowHtml))) {
    const t = stripTags(c[1]);
    if (t) cells.push(t);
  }
  return cells;
}

/** Varre linhas (tabela real <tr> e grades ARIA role="row") do HTML cru. */
export function extractRowsFromHtml(html: string): string[][] {
  const rows: string[][] = [];
  // 1) Tabelas HTML de verdade: <tr> com <td>/<th>.
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const cells = cellsFrom(m[1], /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi);
    if (cells.length >= 2) rows.push(cells);
  }
  // 2) Grades por ARIA (divs com role="row"/"cell"/"gridcell") — best-effort.
  // Divs aninhados não fecham por regex balanceada, então FATIAMOS o HTML nos
  // inícios de role="row" e extraímos as células de cada fatia (tudo até a
  // próxima linha). Robusto a aninhamento; ignora conteúdo fora das células.
  if (/\brole=["']row["']/i.test(html)) {
    const parts = html.split(/(?=<[a-z]+[^>]*\brole=["']row["'])/i);
    for (const part of parts) {
      if (!/\brole=["']row["']/i.test(part)) continue;
      const cells = cellsFrom(
        part,
        /<[a-z]+[^>]*\brole=["'](?:cell|gridcell)["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi,
      );
      if (cells.length >= 2) rows.push(cells);
    }
  }
  return rows;
}

/**
 * Extrai os eventos da tabela de rastreio NOVA da Hapag ("Tracking BETA").
 * Cada evento é um bloco `.hal-event__inline` com 6 `span.hal-event__col`
 * identificados por `aria-labelledby="event-header-<campo>-<id>"`, onde <campo>
 * é event | locationName | date | time | transport | voyage. É uma estrutura de
 * timeline (divs), não `<table><tr>`, por isso o extrator genérico não pega.
 *
 * Exemplo de um bloco:
 *   <span ... aria-labelledby="event-header-event-2991">
 *     <span class="typography-...">Discharged</span></span>
 *   <span ... aria-labelledby="event-header-locationName-2991">SINGAPORE</span>
 *   <span ... aria-labelledby="event-header-date-2991">2026-06-23</span>
 *   ...
 */
export function extractHapagEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!/hal-event__inline/i.test(html)) return out;
  // Fatia por bloco de evento (cada um começa em "hal-event__inline").
  const parts = html.split(/hal-event__inline/i).slice(1);
  for (const part of parts) {
    const fields: Record<string, string> = {};
    const colRe =
      /aria-labelledby="event-header-([a-zA-Z]+)-\d+"[^>]*>([\s\S]*?)<\/span>/gi;
    let m: RegExpExecArray | null;
    while ((m = colRe.exec(part))) {
      const key = m[1];
      // 1ª ocorrência de cada campo = a deste bloco (evita vazar do próximo).
      if (!(key in fields)) fields[key] = stripTags(m[2]);
    }
    const date = parseDateToISO(fields.date || '');
    const status = (fields.event || '').trim();
    if (!date && !status) continue; // bloco sem conteúdo útil
    const transport = (fields.transport || '').trim();
    // "transport" traz o navio (ex.: ONE PARANA) ou o modal (Truck/Rail). Só é
    // "vessel" quando não é rodoviário/ferroviário.
    const isVessel = Boolean(transport) && !/truck|rail|barge|caminh|feeder/i.test(transport);
    out.push({
      date,
      status,
      location: fields.locationName || null,
      vessel: isVessel ? transport : null,
      voyage: fields.voyage || null,
      type: classifyEvent(status),
    });
  }
  return dedupe(out);
}

/** Acha o 1º número de contêiner (padrão ISO: AAAA + 7 dígitos) no HTML, ou null. */
export function firstContainerNo(html: string): string | null {
  const m = html.match(/\b[A-Z]{4}\d{7}\b/);
  return m ? m[0] : null;
}

/** Extrai eventos de um HTML cru já renderizado (sem navegador). */
export function extractEventsFromHtml(html: string): TrackingEvent[] {
  // 1) Hapag "Tracking BETA" (timeline .hal-event) — tem prioridade quando existe.
  const hal = extractHapagEvents(html);
  if (hal.length > 0) return hal;
  // 2) Genérico: tabelas <tr>/<td> e grades ARIA (outros armadores/layouts).
  const events: TrackingEvent[] = [];
  for (const cells of extractRowsFromHtml(html)) {
    const ev = rowToEvent(cells);
    if (ev) events.push(ev);
  }
  return dedupe(events);
}

/** Extrai os eventos de movimentação de qualquer tabela de resultados. */
export async function extractEventsFromPage(page: Page): Promise<TrackingEvent[]> {
  const rows: string[][] = await page
    .$$eval('table tr, [role="row"]', (els) =>
      els
        .map((el) =>
          Array.from(
            el.querySelectorAll('td, th, [role="cell"], [role="gridcell"]'),
          )
            .map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 0),
        )
        .filter((cells) => cells.length >= 2),
    )
    .catch(() => [] as string[][]);

  const events: TrackingEvent[] = [];
  for (const cells of rows) {
    const ev = rowToEvent(cells);
    if (ev) events.push(ev);
  }
  return dedupe(events);
}

// Derivação das datas relevantes a demurrage a partir dos eventos TIPADOS.
/** Data mais recente entre os eventos de um tipo (ou null). */
function latestByType(events: TrackingEvent[], type: NormalizedEventType): string | null {
  const dates = events
    .filter((e) => e.date && e.type === type)
    .map((e) => e.date as string)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function latestEvent(events: TrackingEvent[]): TrackingEvent | null {
  const withDate = events.filter((e) => e.date).sort((a, b) => (a.date! < b.date! ? -1 : 1));
  return withDate.length ? withDate[withDate.length - 1] : events[0] || null;
}

/** Monta UM ContainerInfo a partir dos eventos daquele contêiner. */
function buildContainerInfo(numero: string | null, events: TrackingEvent[]): ContainerInfo {
  const last = latestEvent(events);
  return {
    numero,
    tipo: null,
    status: last?.status || null,
    dischargeDate: latestByType(events, 'discharge'),
    availableDate: latestByType(events, 'available'),
    gateOut: latestByType(events, 'gate_out'),
    emptyReturn: latestByType(events, 'empty_return'),
    lastFreeDay: null, // exige login no portal comercial (próxima etapa)
  };
}

/**
 * Monta a situação dos contêineres a partir dos eventos (campos ausentes = null).
 *
 * Dois modos:
 *  - MULTI: se os eventos carregam `container` (ex.: COSCO lista vários contêineres
 *    no mesmo BL), agrupa por contêiner e devolve UM ContainerInfo por número.
 *  - ÚNICO: senão, comportamento clássico — um contêiner a partir do `containerHint`
 *    (Hapag/Maersk/ONE, que expõem os eventos de um contêiner por vez).
 */
export function deriveContainers(
  events: TrackingEvent[],
  containerHint: string | null,
): ContainerInfo[] {
  const withContainer = events.filter((e) => e.container);
  if (withContainer.length > 0) {
    const groups = new Map<string, TrackingEvent[]>();
    for (const e of withContainer) {
      const key = e.container as string;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
    return Array.from(groups.entries()).map(([numero, evs]) => buildContainerInfo(numero, evs));
  }
  if (events.length === 0 && !containerHint) return [];
  return [buildContainerInfo(containerHint, events)];
}

/** Scraper da Hapag-Lloyd: recebe a página já navegada e extrai os eventos. */
export async function scrapeHapag(page: Page, ctx: ScrapeContext): Promise<ScrapeOutput> {
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // Se a referência não aparecer (deep link não trouxe resultado), usa o form.
  let body = await getBodyText(page);
  if (!body.toUpperCase().includes(ctx.reference.toUpperCase())) {
    if (await tryFillSearch(page, ctx.reference)) {
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await acceptCookies(page);
      body = await getBodyText(page);
    }
  }

  // Os resultados renderizam via XHR após o load (SPA). Espera a timeline de
  // eventos (.hal-event) OU a tabela-resumo aparecer, e dá folga para hidratar.
  await page
    .waitForSelector('.hal-event, .hal-event__inline, table tr, [role="row"]', { timeout: 20000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  const needsCaptcha = await detectCaptcha(page);
  const needsLogin = await detectLogin(page, body);
  // Extrai do HTML renderizado (pega a timeline .hal-event nova da Hapag; o
  // extractEventsFromPage/tabela não alcança essa estrutura de divs).
  const html = await page.content();
  const events = extractEventsFromHtml(html);
  const containerHint =
    firstContainerNo(html) || (ctx.referenceType === 'container' ? ctx.reference : null);
  const containers = deriveContainers(events, containerHint);

  return {
    events,
    containers,
    needsLogin,
    needsCaptcha,
    ok: events.length > 0,
    message: events.length
      ? `${events.length} evento(s) extraído(s) do rastreio público da Hapag-Lloyd.`
      : needsCaptcha
      ? 'Hapag apresentou CAPTCHA (resolução entra na próxima etapa).'
      : needsLogin
      ? 'Hapag pediu login para exibir os dados.'
      : 'Nenhum evento extraído — verificar seletores/estrutura contra o site real.',
  };
}
