import { chromium, Browser, Page } from 'playwright';

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
  return `wss://${auth}@${CDP_HOST}:${CDP_PORT}`;
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

/**
 * Conecta ao Scraping Browser, navega para a URL, espera a SPA renderizar,
 * aceita cookies, e retorna o HTML completo + texto.
 */
export async function scrapeViaSB(opts: SBScrapeOptions): Promise<SBScrapeResult> {
  const startedAt = Date.now();
  const navTimeout = opts.navigationTimeout ?? 60_000;
  const postWait = opts.postLoadWait ?? 8000;

  let browser: Browser | null = null;
  try {
    // Conecta ao Chromium remoto do Bright Data via CDP.
    browser = await chromium.connectOverCDP(buildWSEndpoint(), {
      timeout: 30_000,
    });

    const context = browser.contexts()[0] || await browser.newContext();
    const page: Page = await context.newPage();

    // Navega para a URL. O Scraping Browser fura Cloudflare automaticamente.
    let navError: string | null = null;
    try {
      await page.goto(opts.url, {
        waitUntil: 'domcontentloaded',
        timeout: navTimeout,
      });
    } catch (e) {
      navError = (e as Error).message;
    }

    // Aceita cookies (OneTrust banner comum nos armadores).
    await page.locator('#onetrust-accept-btn-handler').click({ timeout: 3000 }).catch(() => {});
    await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});

    // Espera a SPA renderizar: tenta encontrar tabelas/grids de resultado.
    await page.waitForSelector('table tr, [role="row"], [role="grid"], .trck-result', {
      timeout: 15_000,
    }).catch(() => {});

    // Espera extra para XHRs da SPA terminarem.
    await page.waitForLoadState('networkidle', { timeout: postWait }).catch(() => {});
    // Mais um tempinho pro Vue/React hidratar.
    await page.waitForTimeout(3000);

    const title = await page.title().catch(() => '');
    const html = await page.content().catch(() => '');
    const textContent = ((await page.textContent('body').catch(() => '')) || '')
      .replace(/\s+/g, ' ')
      .trim();
    const rowCount = await page.locator('table tr, [role="row"]').count().catch(() => 0);
    const mentionsRef = opts.reference
      ? textContent.toUpperCase().includes(opts.reference.toUpperCase())
      : false;

    await page.close().catch(() => {});

    return {
      ok: !navError && html.length > 0,
      html,
      textContent,
      title,
      mentionsRef,
      rowCount,
      ms: Date.now() - startedAt,
      error: navError || undefined,
    };
  } catch (e) {
    return {
      ok: false,
      html: '',
      textContent: '',
      title: '',
      mentionsRef: false,
      rowCount: 0,
      ms: Date.now() - startedAt,
      error: (e as Error).message,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
