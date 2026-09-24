import {
  chromium,
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from 'playwright';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { config, hasProxy } from '../config';
import { connectSB } from './scrapingBrowser';

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
  // Força HTTP/1.1: alguns portais (ex.: HMM) + proxy estouram
  // net::ERR_HTTP2_PROTOCOL_ERROR no HTTP/2. HTTP/1.1 é mais estável via proxy.
  '--disable-http2',
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

/** URL do proxy LOCAL anônimo (proxy-chain) que encapsula as credenciais. */
let anonymizedProxyUrl: string | null = null;

/**
 * Resolve o `server` de proxy a passar no LAUNCH do Chromium.
 *
 * Proxy AUTENTICADO no Chromium headless estoura net::ERR_PROXY_AUTH_UNSUPPORTED
 * (usuário/senha não são suportados nesse caminho). A saída robusta e padrão de
 * mercado é subir um proxy LOCAL anônimo (proxy-chain) que ENCAMINHA para o
 * upstream já com as credenciais: o Chromium enxerga só 127.0.0.1, sem
 * autenticação. Sem usuário/senha, devolve o próprio server (proxy aberto).
 */
async function resolveLaunchProxyServer(): Promise<string | undefined> {
  if (!hasProxy()) return undefined;
  const { server, username, password } = config.browser.proxy;
  if (!username && !password) return server; // proxy sem auth: usa direto
  const u = new URL(server);
  const upstream = `${u.protocol}//${encodeURIComponent(username)}:${encodeURIComponent(
    password,
  )}@${u.host}`;
  anonymizedProxyUrl = await anonymizeProxy(upstream);
  return anonymizedProxyUrl;
}

/**
 * Sobe (uma única vez) e reaproveita a instância do Chromium. Lançar o browser
 * é caro; contextos é que são baratos e descartáveis — um por sessão/scraper.
 *
 * IMPORTANTE (pegadinha do Playwright): um proxy definido só no `newContext` é
 * IGNORADO se o navegador não tiver sido LANÇADO com proxy. Por isso, quando há
 * proxy configurado, passamos ele já no launch — assim o proxy por-contexto
 * (mesmo valor hoje, ou um diferente por scraper amanhã) passa a valer de fato.
 */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // Proxy resolvido para o LAUNCH (local anônimo se houver auth — ver acima).
      const proxyServer = await resolveLaunchProxyServer();
      return chromium.launch({
        headless: config.browser.headless,
        ...(config.browser.executablePath
          ? { executablePath: config.browser.executablePath }
          : {}),
        ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
        args: LAUNCH_ARGS,
      });
    })().catch((err) => {
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
  // ATENÇÃO: o proxy NÃO é definido por-contexto aqui de propósito. A
  // AUTENTICAÇÃO de proxy (usuário/senha) só funciona quando o proxy é passado no
  // LAUNCH (ver getBrowser). Definir um proxy autenticado por-contexto faz o
  // Chromium falhar com net::ERR_PROXY_AUTH_UNSUPPORTED. O proxy do launch já
  // vale para todos os contextos deste navegador.
  const ctx = await browser.newContext({
    userAgent: DEFAULT_USER_AGENT,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
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

/**
 * Igual ao `withPage`, mas rodando num navegador REMOTO do Bright Data
 * (Scraping Browser, via CDP). O Chromium remoto já fura Cloudflare interativo,
 * renderiza a SPA e resolve captcha — então o MESMO scraper de cada armador roda
 * sem alteração, só que num navegador que os portais difíceis não bloqueiam.
 * A conexão é aberta e fechada por chamada (sessão remota curta).
 */
export async function withRemotePage<T>(
  fn: (page: Page, ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const browser = await connectSB();
  try {
    // Reusa o contexto E a página que o provedor já entrega (Scrapfly/Bright Data
    // gerenciam o fingerprint na sessão) — criar novos pode perdê-lo.
    const ctx = browser.contexts()[0] || (await browser.newContext());
    const page = ctx.pages()[0] || (await ctx.newPage());
    ctx.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
    ctx.setDefaultTimeout(config.browser.navigationTimeoutMs);
    return await fn(page, ctx);
  } finally {
    await browser.close().catch(() => {
      /* fecha a sessão remota (para de faturar) */
    });
  }
}

/** Encerra o Chromium (e o proxy local, se houver) — shutdown e testes. */
export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    if (browser) {
      await browser.close().catch(() => {
        /* best-effort */
      });
    }
  }
  // Derruba o proxy local anônimo, se foi criado (libera a porta/recursos).
  if (anonymizedProxyUrl) {
    const url = anonymizedProxyUrl;
    anonymizedProxyUrl = null;
    await closeAnonymizedProxy(url, true).catch(() => {
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
