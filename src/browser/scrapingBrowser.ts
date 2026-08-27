import { chromium, Browser, Page } from 'playwright';
import { acceptCookies, tryFillSearch } from './carriers/pageUtils';

/**
 * Priora — Cliente do Bright Data Scraping Browser (CDP remoto).
 *
 * Diferente do Web Unlocker API (que é "fetch e recebe HTML"), o Scraping
 * Browser dá um browser REAL (Chromium remoto) controlado via Playwright.
 * Perfeito para SPAs pesadas como Hapag-Lloyd que precisam:
 *   1. Cloudflare bypass (automático)
 *   2. Renderização completa de JS (Vue.js, React, etc.)
 *   3. Interação com a página (aceitar cookies, preencher form, etc.)
 *
 * Conexão via CDP: wss://brd-customer-<ID>-zone-<ZONE>:<PASS>@brd.superproxy.io:9222
 *
 * Credenciais no Render: BRIGHTDATA_SB_AUTH (formato "username:password")
 * O username inclui o customer ID e zona, ex.:
 *   brd-customer-hl_12345678-zone-priora_browser:senha123
 *
 * Docs: https://docs.brightdata.com/scraping-automation/scraping-browser
 */

const CDP_HOST = 'brd.superproxy.io';
const CDP_PORT = 9222;

export function isSBConfigured(): boolean {
  return Boolean(getSBAuth());
}

function getSBAuth(): string {
  return (process.env.BRIGHTDATA_SB_AUTH || '').trim();
}

function buildWSEndpoint(): string {
  const auth = getSBAuth();
  // Aceita as duas formas (à prova de erro de montagem):
  //  1) a URL COMPLETA que o botão "copy" do Bright Data dá:
  //     wss://brd-customer-<id>-zone-<zona>:<senha>@brd.superproxy.io:9222
  //  2) só o "usuário:senha" — aí montamos a URL com o host/porta padrão.
  if (/^wss?:\/\//i.test(auth)) return auth;
  return `wss://${auth}@${CDP_HOST}:${CDP_PORT}`;
}

/**
 * Conecta ao Scraping Browser (Chromium remoto do Bright Data) via CDP e devolve
 * o Browser. Quem chama é responsável por fechar. Usado pelo `withRemotePage`
 * (browser.ts) para rodar QUALQUER scraper de armador contra o navegador remoto
 * — furando Cloudflare/SPA sem trocar a lógica de cada portal.
 */
export async function connectSB(): Promise<Browser> {
  if (!isSBConfigured()) {
    throw new Error('Scraping Browser não configurado (defina BRIGHTDATA_SB_AUTH).');
  }
  return chromium.connectOverCDP(buildWSEndpoint(), { timeout: 30_000 });
}

export interface SBScrapeOptions {
  /** URL para navegar. */
  url: string;
  /** Referência para verificar se aparece no HTML (ex.: BL, container). */
  reference?: string;
  /** Timeout de navegação em ms (default: 60s). */
  navigationTimeout?: number;
  /** Tempo extra pós-load para esperar a SPA hidratar (ms, default: 8s). */
  postLoadWait?: number;
}

export interface SBScrapeResult {
  ok: boolean;
  html: string;
  textContent: string;
  title: string;
  mentionsRef: boolean;
  rowCount: number;
  ms: number;
  error?: string;
}

const RESULT_SELECTOR =
  'table tr, [role="row"], [role="grid"], .trck-result, .tracking-result, .hal-event, .hal-event__inline';

/**
 * Pilota UMA página (local OU remota) até os resultados do rastreio: navega,
 * aceita cookies, espera a SPA/tabela, e se a referência não aparecer preenche
 * o formulário de busca. Retorna HTML + texto + contagem. É a lógica ÚNICA usada
 * tanto pelo Scraping Browser (remoto) quanto pelo navegador local + IPRoyal —
 * o local IGNORA robots.txt, então serve nos portais que o Bright Data recusa.
 */
export async function driveTrackingPage(
  page: Page,
  opts: SBScrapeOptions,
): Promise<Omit<SBScrapeResult, 'ms'>> {
  const navTimeout = opts.navigationTimeout ?? 60_000;
  const postWait = opts.postLoadWait ?? 8000;

  let navError: string | null = null;
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (e) {
    navError = (e as Error).message;
  }

  await acceptCookies(page);
  await page.waitForSelector(RESULT_SELECTOR, { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: postWait }).catch(() => {});
  await page.waitForTimeout(2000); // folga p/ Vue/React hidratar

  // Se a referência ainda NÃO apareceu, o deep link não auto-buscou: preenche o
  // formulário e submete (muitos portais exigem). Reusa o tryFillSearch.
  if (opts.reference) {
    const body0 = (await page.textContent('body').catch(() => '')) || '';
    if (!body0.toUpperCase().includes(opts.reference.toUpperCase())) {
      if (await tryFillSearch(page, opts.reference)) {
        await page.waitForLoadState('networkidle', { timeout: postWait }).catch(() => {});
        await page.waitForSelector(RESULT_SELECTOR, { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await acceptCookies(page);
      }
    }
  }

  const title = await page.title().catch(() => '');
  const html = await page.content().catch(() => '');
  const textContent = (
    (await page.innerText('body').catch(() => '')) ||
    (await page.textContent('body').catch(() => '')) ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const rowCount = await page.locator('table tr, [role="row"]').count().catch(() => 0);
  const mentionsRef = opts.reference
    ? textContent.toUpperCase().includes(opts.reference.toUpperCase())
    : false;

  return { ok: !navError && html.length > 0, html, textContent, title, mentionsRef, rowCount, error: navError || undefined };
}

/**
 * Conecta ao Scraping Browser (remoto, Bright Data) e pilota a página até os
 * resultados. Usado nos portais atrás de Cloudflare interativo (ex.: Hapag).
 */
export async function scrapeViaSB(opts: SBScrapeOptions): Promise<SBScrapeResult> {
  const startedAt = Date.now();
  let browser: Browser | null = null;
  try {
    browser = await connectSB();
    const context = browser.contexts()[0] || (await browser.newContext());
    const page: Page = await context.newPage();
    try {
      const r = await driveTrackingPage(page, opts);
      return { ...r, ms: Date.now() - startedAt };
    } finally {
      await page.close().catch(() => {});
    }
  } catch (e) {
    return {
      ok: false, html: '', textContent: '', title: '', mentionsRef: false, rowCount: 0,
      ms: Date.now() - startedAt, error: (e as Error).message,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
