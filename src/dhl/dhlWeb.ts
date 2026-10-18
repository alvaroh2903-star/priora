import type { Page } from 'playwright';
import { withRemotePage } from '../browser/browser';
import { blockHeavyResources, isSBConfigured } from '../browser/scrapingBrowser';
import { TrackingResult } from '../tracking/types';
import { normalize } from './dhlParse';

/**
 * Priora — Rastreio DHL pelo SITE (dhl.com), sem a chave da API oficial.
 *
 * Visto em 18/10/2026:
 * - A página de rastreio e a chamada de dados dela (`/utapi`) ficam atrás da
 *   Akamai: requisição comum perde a conexão, e a API de Scrape da Scrapfly
 *   (pool padrão) passou 1 vez em 5.
 * - O navegador remoto com IP RESIDENCIAL + desbloqueio, saindo do Brasil,
 *   abriu a página e montou o app de rastreio (é o pool da OOCL/Hapag).
 *
 * Como funciona: abre a página do 1º número (a Akamai valida a sessão), lê a
 * resposta da `/utapi` que o próprio app da DHL chama, e consulta os demais
 * números pela MESMA `/utapi`, de dentro da página (mesmos cookies) — uma
 * sessão só para vários números, que é o que pesa no crédito.
 */

const PAGE_URL = (n: string) =>
  `https://www.dhl.com/br-pt/home/rastreamento.html?tracking-id=${encodeURIComponent(n)}&submit=1`;
/** Usada só se o app não fizer a chamada na 1ª página (ex.: número em formato inválido). */
const DEFAULT_UTAPI = (n: string) =>
  `https://www.dhl.com/utapi?trackingNumber=${encodeURIComponent(n)}&language=pt&requesterCountryCode=BR&source=tt`;
const INVALID_RE = /c[oó]digo de rastreamento [eé] inv[aá]lido|tracking (code|number) is invalid/i;

const BATCH_WAIT_MS = 1500;
const MAX_BATCH = 10;
const FIRST_CALL_TIMEOUT_MS = 20_000;

/** O que a `/utapi` respondeu para um número (ou por que não respondeu). */
export interface DhlWebRaw {
  number: string;
  status: number | null;
  body: string;
  /** A página disse que o número é inválido e nem chamou a `/utapi`. */
  invalid?: boolean;
  error?: string;
}

export interface DhlWebSession {
  raws: DhlWebRaw[];
  ms: number;
  trace: string[];
}

export function isDhlWebAvailable(): boolean {
  return isSBConfigured();
}

/**
 * URL da chamada de dados para outro número: troca o parâmetro que tem o 1º
 * número (é `trackingNumber` hoje, mas não dependemos do nome).
 */
export function urlForNumber(template: string, first: string, n: string): string {
  const u = new URL(template);
  const keys = [...u.searchParams.entries()].filter(([, v]) => v === first).map(([k]) => k);
  for (const k of keys) u.searchParams.set(k, n);
  if (keys.length) return u.toString();
  if (template.includes(first)) return template.split(first).join(encodeURIComponent(n));
  u.searchParams.set('trackingNumber', n);
  return u.toString();
}

/** Cabeçalhos que o fetch da página não pode (ou não deve) repetir. */
const SKIP_HEADER = /^(:|sec-|cookie$|host$|user-agent$|referer$|origin$|accept-encoding$|content-length$|connection$)/i;

/**
 * Resposta da `/utapi` → resultado no formato comum. `Error` = falha NOSSA ou
 * bloqueio (não guardar em cache, tentar depois); TrackingResult com
 * found:false = a DHL respondeu que não há envio (pode guardar).
 */
export function parseDhlWebRaw(raw: DhlWebRaw): TrackingResult | Error {
  if (raw.invalid) {
    return { ...normalize({}, raw.number), error: 'A DHL diz que o código de rastreamento é inválido.' };
  }
  if (raw.error) return new Error(`DHL (site): ${raw.error}`);
  let json: unknown;
  try {
    json = JSON.parse(raw.body);
  } catch {
    // Página de bloqueio da Akamai (HTML) ou corpo vazio.
    return new Error(`DHL (site) não devolveu dados (HTTP ${raw.status ?? '—'}) — provável bloqueio do anti-robô.`);
  }
  if (raw.status === 403 || raw.status === 429) {
    return new Error(`DHL (site) recusou a consulta (HTTP ${raw.status}).`);
  }
  return normalize(json, raw.number);
}

/** Texto da área de rastreio, inclusive dentro de web components (diagnóstico). */
async function trackingText(page: Page): Promise<string> {
  const text = await page
    .evaluate(() => {
      const deep = (n: Node): string => {
        let t = '';
        n.childNodes.forEach((c) => {
          if (c.nodeType === 3) t += `${c.textContent} `;
          else if (c.nodeType === 1) {
            const root = (c as Element).shadowRoot;
            if (root) t += deep(root);
            t += deep(c);
          }
        });
        return t;
      };
      return deep(document.body).replace(/\s+/g, ' ');
    })
    .catch(() => '');
  const at = text.search(/Rastrear e acompanhar|Track and trace/i);
  return text.slice(Math.max(at, 0), Math.max(at, 0) + 400).trim() || '(vazia)';
}

/** Uma sessão do navegador remoto para vários números (ver cabeçalho). */
async function fetchDhlWebSession(numbers: string[]): Promise<DhlWebSession> {
  const t0 = Date.now();
  const trace: string[] = [];
  const mark = (s: string) => trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
  const first = numbers[0];
  return withRemotePage(
    async (page: Page) => {
      const raws: DhlWebRaw[] = [];
      await blockHeavyResources(page, 'media');
      // Toda resposta JSON das chamadas do app — não dependemos do nome da rota
      // de dados (hoje `/utapi`); fica a que traz `shipments`.
      type Call = { url: string; headers: Record<string, string>; status: number; body: string };
      const captured: Array<Promise<Call>> = [];
      const seen: string[] = [];
      page.on('response', (r) => {
        const kind = r.request().resourceType();
        if (kind !== 'xhr' && kind !== 'fetch') return;
        const u = new URL(r.url());
        if (seen.length < 25) seen.push(`${r.status()} ${u.host}${u.pathname}`);
        if (!/json/i.test(r.headers()['content-type'] || '') && !/\/utapi\b/.test(u.pathname)) return;
        captured.push(
          (async () => ({
            url: r.url(),
            headers: await r.request().allHeaders().catch(() => ({})),
            status: r.status(),
            body: (await r.text().catch(() => '')).slice(0, 500_000),
          }))(),
        );
      });
      const isTracking = (c: Call) => /\/utapi\b/.test(c.url) || c.body.includes('"shipments"');
      await page.goto(PAGE_URL(first), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      mark('página aberta');

      // Espera a chamada do app (ou o aviso de número inválido — fica dentro de
      // web components; o getByText do Playwright enxerga o shadow DOM).
      let invalid = false;
      const deadline = Date.now() + FIRST_CALL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if ((await Promise.all(captured)).some(isTracking)) break;
        if (await page.getByText(INVALID_RE).first().isVisible().catch(() => false)) {
          invalid = true;
          break;
        }
        await page.waitForTimeout(1000);
      }
      const calls = (await Promise.all(captured)).filter(isTracking);
      mark(`dados do app: ${calls.length} chamada(s)${invalid ? ' (número inválido)' : ''}`);
      if (!calls.length) {
        mark(`chamadas vistas: ${seen.join(' | ') || 'nenhuma'}`);
        mark(`tela: ${await trackingText(page)}`);
      }
      const own = calls.find((c) => c.url.includes(first) || c.url.includes(encodeURIComponent(first))) || calls[0];
      if (own) raws.push({ number: first, status: own.status, body: own.body });
      else if (invalid) raws.push({ number: first, status: null, body: '', invalid: true });

      // Demais números (e o 1º, se o app não buscou sozinho — visto em 18/10
      // abrindo pelo link): a mesma chamada, de dentro da página, com os
      // cookies que a Akamai acabou de validar.
      const template = own ? own.url : DEFAULT_UTAPI(first);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(own?.headers || { accept: 'application/json' })) {
        if (!SKIP_HEADER.test(k)) headers[k] = v;
      }
      for (const n of numbers.filter((x) => !raws.some((r) => r.number === x))) {
        const url = urlForNumber(template, first, n);
        const r = await page
          .evaluate(
            async ({ url, hdrs }) => {
              try {
                const res = await fetch(url, { headers: hdrs, credentials: 'include' });
                return { status: res.status, body: await res.text() };
              } catch (e) {
                return { status: null, body: '', error: String(e) };
              }
            },
            { url, hdrs: headers },
          )
          .catch((e: Error) => ({ status: null, body: '', error: e.message }));
        raws.push({ number: n, ...r });
        mark(`dados ${n}: HTTP ${r.status ?? '—'}`);
        await page.waitForTimeout(800);
      }
      return { raws, ms: Date.now() - t0, trace };
    },
    { pool: 'residential_unblock', targetUrl: PAGE_URL(first), country: 'br' },
  );
}

let fetcher: (numbers: string[]) => Promise<DhlWebSession> = fetchDhlWebSession;
let lastSession: { at: string; numbers: string[]; ms: number; trace: string[] } | null = null;

/** Só para o self-test: troca o navegador por um falso (null = volta o real). */
export function setDhlWebFetcherForTest(f: ((numbers: string[]) => Promise<DhlWebSession>) | null): void {
  fetcher = f || fetchDhlWebSession;
}

/** Última sessão (diagnóstico). */
export function dhlWebLastSession(): typeof lastSession {
  return lastSession;
}

/*
 * LOTE: a tela de Courier pede todos os números DHL de uma vez. Pedidos que
 * chegam dentro de BATCH_WAIT_MS vão juntos na mesma sessão (até MAX_BATCH).
 */
let pending: Array<{ n: string; resolve: (r: TrackingResult) => void; reject: (e: Error) => void }> = [];
let timer: NodeJS.Timeout | null = null;

async function flush(): Promise<void> {
  timer = null;
  const batch = pending.splice(0, MAX_BATCH);
  if (pending.length) timer = setTimeout(() => void flush(), 0);
  if (!batch.length) return;
  const numbers = [...new Set(batch.map((b) => b.n))];
  try {
    const s = await fetcher(numbers);
    lastSession = { at: new Date().toISOString(), numbers, ms: s.ms, trace: s.trace };
    for (const b of batch) {
      const raw = s.raws.find((r) => r.number === b.n);
      const out = raw ? parseDhlWebRaw(raw) : new Error('DHL (site): número não consultado na sessão.');
      if (out instanceof Error) b.reject(out);
      else b.resolve(out);
    }
  } catch (e) {
    for (const b of batch) b.reject(e as Error);
  }
}

/** Rastreia pelo site (agrupa pedidos próximos numa sessão só). */
export function trackDhlWeb(number: string): Promise<TrackingResult> {
  return new Promise((resolve, reject) => {
    pending.push({ n: number, resolve, reject });
    if (pending.length >= MAX_BATCH) {
      if (timer) clearTimeout(timer);
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => void flush(), BATCH_WAIT_MS);
    }
  });
}
