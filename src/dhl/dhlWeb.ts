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
 *   abre a página (é o pool da OOCL/Hapag). Nessa sessão os eventos de rede não
 *   chegam até nós (o app buscou e nada apareceu), mas um `fetch` da `/utapi`
 *   feito DE DENTRO da página responde com os cookies que a Akamai validou —
 *   no mesmo formato da API oficial (Unified Tracking): 404 "No shipment with
 *   given tracking number found." para o número de teste, sessão de 33 s.
 *
 * Como funciona: abre a página uma vez e consulta todos os números do lote pela
 * `/utapi` — uma sessão só para vários números, que é o que pesa no crédito.
 */

const PAGE_URL = (n: string) =>
  `https://www.dhl.com/br-pt/home/rastreamento.html?tracking-id=${encodeURIComponent(n)}&submit=1`;
const UTAPI_URL = (n: string) =>
  `https://www.dhl.com/utapi?trackingNumber=${encodeURIComponent(n)}&language=pt&requesterCountryCode=BR&source=tt`;

const BATCH_WAIT_MS = 1500;
const MAX_BATCH = 10;
/**
 * O script da Akamai valida os cookies alguns segundos DEPOIS do carregamento:
 * aos 4 s a /utapi ainda respondia 428 (18/10/2026); aos ~20 s, 404 normal.
 * Tenta a cada RETRY_WAIT_MS até MAX_TRIES vezes no 1º número; os demais já
 * saem com os cookies validados.
 */
const AKAMAI_SETTLE_MS = 4000;
const RETRY_WAIT_MS = 4000;
const MAX_TRIES = 6;

/** O que a `/utapi` respondeu para um número (ou por que não respondeu). */
export interface DhlWebRaw {
  number: string;
  status: number | null;
  body: string;
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

const looksJson = (body: string) => /^\s*[{[]/.test(body);
/** A DHL respondeu de verdade: 200 (achou) ou 404 (não há envio). O resto é bloqueio/erro. */
const answered = (r: { status: number | null; body: string }) => (r.status === 200 || r.status === 404) && looksJson(r.body);

/**
 * Resposta da `/utapi` → resultado no formato comum. `Error` = falha NOSSA ou
 * bloqueio (não guardar em cache, tentar depois); TrackingResult com
 * found:false = a DHL respondeu que não há envio (pode guardar).
 */
export function parseDhlWebRaw(raw: DhlWebRaw): TrackingResult | Error {
  if (raw.error) return new Error(`DHL (site): ${raw.error}`);
  // 428/403/429…: a Akamai não liberou a chamada. Nunca vira "não encontrado".
  if (raw.status !== 200 && raw.status !== 404) {
    return new Error(`DHL (site) recusou a consulta (HTTP ${raw.status ?? '—'}) — provável bloqueio do anti-robô.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.body);
  } catch {
    // Página de bloqueio da Akamai (HTML) ou corpo vazio.
    return new Error(`DHL (site) não devolveu dados (HTTP ${raw.status ?? '—'}) — provável bloqueio do anti-robô.`);
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

/**
 * ECONOMIA (o IP residencial cobra por MB): além da mídia, corta CSS e tudo que
 * não é da DHL (analytics, tags, chat). O script da Akamai é do próprio
 * dhl.com e passa. Só `abort()` — nada é reemitido com `continue()` (isso
 * quebrava módulos JS no navegador remoto, ver blockHeavyResources).
 */
const THIRD_PARTY_RE = /^https?:\/\/(?![^/?#]*\bdhl\.com(?:[:/?#]|$))[^/?#]+/i;
const CSS_RE = /\.css(?:[?#]|$)/i;

async function blockNonEssential(page: Page): Promise<void> {
  await blockHeavyResources(page, 'media');
  await page.route(THIRD_PARTY_RE, (route) => route.abort().catch(() => undefined)).catch(() => undefined);
  await page.route(CSS_RE, (route) => route.abort().catch(() => undefined)).catch(() => undefined);
}

/** KB baixados pela página (Resource Timing; terceiro sem Timing-Allow-Origin conta 0). */
async function pageKb(page: Page): Promise<number | null> {
  return page
    .evaluate(() => {
      const all = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
      return Math.round(all.reduce((s, e) => s + ((e as PerformanceResourceTiming).transferSize || 0), 0) / 1024);
    })
    .catch(() => null);
}

async function fetchInPage(page: Page, n: string): Promise<Omit<DhlWebRaw, 'number'>> {
  return page
    .evaluate(async (url) => {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'include' });
        return { status: res.status, body: (await res.text()).slice(0, 500_000) };
      } catch (e) {
        return { status: null, body: '', error: String(e) };
      }
    }, UTAPI_URL(n))
    .catch((e: Error) => ({ status: null, body: '', error: e.message }));
}

/** Uma sessão do navegador remoto para vários números (ver cabeçalho). */
async function fetchDhlWebSession(numbers: string[]): Promise<DhlWebSession> {
  const t0 = Date.now();
  const trace: string[] = [];
  const mark = (s: string) => trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
  return withRemotePage(
    async (page: Page) => {
      await blockNonEssential(page);
      await page.goto(PAGE_URL(numbers[0]), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      mark('página aberta');
      await page.waitForTimeout(AKAMAI_SETTLE_MS);
      const raws: DhlWebRaw[] = [];
      // 1º número: espera a Akamai liberar (ver AKAMAI_SETTLE_MS). Se não liberar,
      // a sessão está barrada — os demais saem com uma tentativa só.
      let tries = MAX_TRIES;
      for (const n of numbers) {
        let r = await fetchInPage(page, n);
        for (let t = 1; t < tries && !answered(r); t++) {
          mark(`dados ${n}: HTTP ${r.status ?? '—'} — aguardando a Akamai`);
          await page.waitForTimeout(RETRY_WAIT_MS);
          r = await fetchInPage(page, n);
        }
        if (!answered(r)) tries = 1;
        raws.push({ number: n, ...r });
        mark(`dados ${n}: HTTP ${r.status ?? '—'}`);
        await page.waitForTimeout(800);
      }
      if (!raws.some(answered)) mark(`tela: ${await trackingText(page)}`);
      mark(`baixado: ${(await pageKb(page)) ?? '—'} KB`);
      return { raws, ms: Date.now() - t0, trace };
    },
    { pool: 'residential_unblock', targetUrl: PAGE_URL(numbers[0]), country: 'br' },
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
