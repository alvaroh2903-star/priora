import {
  chromium,
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from 'playwright';
import { config, hasProxy } from '../config';

/**
 * Priora — Módulo Demurrage / Camada de automação de navegador (Playwright)
 * ------------------------------------------------------------------------
 * Base compartilhada pelos scrapers que buscam os dados de sobreestadia direto
 * nos portais de armadores/terminais (free time, datas de retirada/devolução,
 * diárias) — a fonte "de origem" que complementa o que a Clara extrai do e-mail.
 *
 * Responsabilidade deste arquivo: SUBIR o Chromium de forma robusta (local e no
 * Render), reaproveitar a instância entre requisições e entregar uma página
 * pronta para uso, com proxy quando configurado. Login, resolução de CAPTCHA e
 * a lógica de cada portal entram nos módulos/rotas de scraping (próximas etapas).
 */

let browserPromise: Promise<Browser> | null = null;

/**
 * User-Agent "de navegador de verdade" para não destoar num Chromium headless.
 * Os scrapers específicos podem sobrescrever ao criar o contexto.
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Argumentos de lançamento seguros para rodar em container (inclui root). */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // evita crash por /dev/shm pequeno em containers
  '--disable-gpu',
  // Reduz sinais óbvios de automação (não vence anti-bot avançado, mas ajuda).
  '--disable-blink-features=AutomationControlled',
];

/** Opções de proxy no formato do Playwright, ou undefined se não houver. */
export function proxyOption(): BrowserContextOptions['proxy'] | undefined {
  if (!hasProxy()) return undefined;
  const { server, username, password } = config.browser.proxy;
  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * Sobe (uma única vez) e reaproveita a instância do Chromium. Lançar o browser
 * é caro; contextos é que são baratos e descartáveis — um por sessão/scraper.
 */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: config.browser.headless,
        ...(config.browser.executablePath
          ? { executablePath: config.browser.executablePath }
          : {}),
        args: LAUNCH_ARGS,
      })
      .catch((err) => {
        // Permite nova tentativa numa próxima chamada em vez de "grudar" o erro.
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/**
 * Cria um contexto isolado (cookies/cache próprios), já com proxy, locale pt-BR
 * e timeout padrão de navegação. Cada scraper deve usar o seu e fechá-lo ao fim.
 */
export async function newContext(
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const browser = await getBrowser();
  const proxy = proxyOption();
  const ctx = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
    ...(proxy ? { proxy } : {}),
    ...options,
  });
  // Mascara o sinal mais óbvio de automação (navigator.webdriver).
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  ctx.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
  ctx.setDefaultTimeout(config.browser.navigationTimeoutMs);
  return ctx;
}

/**
 * Executa `fn` com uma página pronta e GARANTE o fechamento do contexto no fim
 * (mesmo em caso de erro). É o atalho preferido para tarefas curtas de scraping.
 */
export async function withPage<T>(
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
  options?: BrowserContextOptions,
): Promise<T> {
  const ctx = await newContext(options);
  try {
    const page = await ctx.newPage();
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => {
      /* fechamento best-effort */
    });
  }
}

/** Encerra o Chromium (usado no shutdown gracioso e nos testes). */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  if (browser) {
    await browser.close().catch(() => {
      /* best-effort */
    });
  }
}

// Fecha o browser ao derrubar o processo (Render envia SIGTERM no deploy/sleep).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void closeBrowser();
  });
}
