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
  return Boolean(getGenericWss() || getSBAuth());
}

/**
 * Endpoint CDP AGNÓSTICO de provedor. Qualquer "cloud browser" que fale CDP por
 * WebSocket (Browserbase, Steel, Browserless, Oxylabs, self-hosted browserless…)
 * entra aqui — é só colar o `wss://…` completo em SCRAPE_BROWSER_WSS. Tem
 * prioridade sobre o Bright Data, então dá para A/B testar provedores trocando
 * UMA variável, sem mexer no código. Vazio = usa o Bright Data (BRIGHTDATA_SB_AUTH).
 */
function getGenericWss(): string {
  return (process.env.SCRAPE_BROWSER_WSS || '').trim();
}

function getSBAuth(): string {
  return (process.env.BRIGHTDATA_SB_AUTH || '').trim();
}

/** Nome do provedor CDP ativo (p/ diagnóstico). */
export function scrapeBrowserProvider(): string {
  if (getGenericWss()) return 'custom-wss';
  if (getSBAuth()) return 'brightdata';
  return 'none';
}

function buildWSEndpoint(): string {
  // 1) Provedor genérico (URL wss:// completa) — tem prioridade.
  const generic = getGenericWss();
  if (generic) return generic;
  // 2) Bright Data: URL completa OU "usuário:senha" (montamos o host/porta padrão).
  const auth = getSBAuth();
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
    throw new Error('Cloud browser não configurado (defina SCRAPE_BROWSER_WSS ou BRIGHTDATA_SB_AUTH).');
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
  const navTimeout = opts.navigationTimeout ?? 90_000;
  const postWait = opts.postLoadWait ?? 8000;

  let navError: string | null = null;
  try {
    // 'commit' retorna assim que a navegação começa — não trava em SPAs pesadas
    // (ex.: ONE) que demoram no 'domcontentloaded'. A espera pelos resultados
    // (waitForSelector/networkidle abaixo) é quem garante o render.
    await page.goto(opts.url, { waitUntil: 'commit', timeout: navTimeout });
  } catch (e) {
    navError = (e as Error).message;
  }

  await acceptCookies(page);
  await page.waitForSelector(RESULT_SELECTOR, { timeout: 25_000 }).catch(() => {});
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

  // Alguns portais escondem os eventos completos atrás de um link "detalhe" que
  // carrega via XHR (ex.: PIL, link <a class="trackinfo">). Clica e espera popular.
  const detailLinks = page.locator('a.trackinfo, a.trackinfo b');
  const nDetail = await detailLinks.count().catch(() => 0);
  if (nDetail > 0) {
    for (let i = 0; i < Math.min(nDetail, 4); i++) {
      await detailLinks.nth(i).click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(800);
    }
    // Espera o corpo de detalhe (sub-info-table) deixar de estar vazio/hidden.
    await page
      .waitForSelector('.sub-info-table tr, .sub-info-table td', { timeout: 12000 })
      .catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: postWait }).catch(() => undefined);
    await page.waitForTimeout(1500);
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
    // Reusa o contexto E a página que o provedor já entrega (Scrapfly gerencia o
    // fingerprint na sessão) — criar contexto/página novos pode perdê-lo.
    const context = browser.contexts()[0] || (await browser.newContext());
    const page: Page = context.pages()[0] || (await context.newPage());
    const r = await driveTrackingPage(page, opts);
    return { ...r, ms: Date.now() - startedAt };
  } catch (e) {
    return {
      ok: false, html: '', textContent: '', title: '', mentionsRef: false, rowCount: 0,
      ms: Date.now() - startedAt, error: (e as Error).message,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
