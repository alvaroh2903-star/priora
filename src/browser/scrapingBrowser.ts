import { chromium, Browser, Page } from 'playwright';
import { acceptCookies, tryFillSearch } from './carriers/pageUtils';
import { findCarrierDriver } from './carriers/drivers';
import { solveCaptchaIfPresent } from './antiCaptcha';

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
  /**
   * Coleta um inventário dos elementos interativos (inputs/selects/botões/
   * iframes/forms) ANTES de fechar o browser. Diagnóstico: revela os seletores
   * REAIS do formulário (COSCO, HMM…) sem chutar — um único teste ao vivo.
   */
  inventory?: boolean;
}

/** Descrição de um elemento interativo para diagnóstico de formulário. */
export interface DomElementInfo {
  tag: string;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  className?: string | null;
  text?: string | null;
  value?: string | null;
  options?: string[];
  visible: boolean;
}

export interface DomInventory {
  url: string;
  frameCount: number;
  inputs: DomElementInfo[];
  selects: DomElementInfo[];
  buttons: DomElementInfo[];
  iframes: { src: string | null; title: string | null }[];
  forms: { action: string | null; id: string | null; className: string | null }[];
}

export interface SBScrapeResult {
  ok: boolean;
  html: string;
  textContent: string;
  title: string;
  mentionsRef: boolean;
  rowCount: number;
  ms: number;
  inventory?: DomInventory;
  /** Diagnóstico do driver de formulário (ex.: ShipmentLink): popup? valor? etc. */
  diag?: Record<string, unknown>;
  /** JSON bruto capturado da API interna do portal (ex.: MSC), quando aplicável. */
  apiJson?: string;
  error?: string;
}

const RESULT_SELECTOR =
  'table tr, [role="row"], [role="grid"], .trck-result, .tracking-result, .hal-event, .hal-event__inline';

/**
 * Inventário dos elementos interativos da página (e de seus iframes) para
 * diagnóstico: revela os SELETORES REAIS de inputs/selects/botões que a SPA
 * renderizou, sem precisar chutar. Roda no navegador (page.evaluate) e agrega
 * cada frame separado — COSCO/HMM às vezes montam o form dentro de iframe.
 */
export async function collectInventory(page: Page): Promise<DomInventory> {
  const perFrame = async (frame: import('playwright').Frame) => {
    return frame
      .evaluate(() => {
        const vis = (el: Element): boolean => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const clip = (s: string | null | undefined, n = 80): string | null =>
          s ? s.replace(/\s+/g, ' ').trim().slice(0, n) || null : null;
        const inputs = Array.from(document.querySelectorAll('input')).map((el) => ({
          tag: 'input',
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          id: el.id || null,
          placeholder: el.getAttribute('placeholder'),
          ariaLabel: el.getAttribute('aria-label'),
          className: clip(el.className, 120),
          visible: vis(el),
        }));
        const selects = Array.from(document.querySelectorAll('select')).map((el) => ({
          tag: 'select',
          name: el.getAttribute('name'),
          id: el.id || null,
          ariaLabel: el.getAttribute('aria-label'),
          className: clip(el.className, 120),
          options: Array.from(el.querySelectorAll('option'))
            .map((o) => clip(o.textContent, 40) || '')
            .filter(Boolean)
            .slice(0, 12),
          visible: vis(el),
        }));
        // Botões "de verdade" + elementos com papel de botão (SPAs usam div/a/span).
        const btnSel = 'button, a, [role="button"], input[type="submit"], input[type="button"], [onclick]';
        const buttons = Array.from(document.querySelectorAll(btnSel))
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type'),
            id: el.id || null,
            className: clip(el.className, 120),
            text: clip(el.textContent, 40),
            value: el.getAttribute('value'),
            ariaLabel: el.getAttribute('aria-label'),
            visible: vis(el),
          }))
          // Só o que parece acionável (tem texto/ícone e está visível) p/ não poluir.
          .filter((b) => b.visible && (b.text || b.ariaLabel || b.value || b.id))
          .slice(0, 40);
        const iframes = Array.from(document.querySelectorAll('iframe')).map((el) => ({
          src: el.getAttribute('src'),
          title: el.getAttribute('title'),
        }));
        const forms = Array.from(document.querySelectorAll('form')).map((el) => ({
          action: el.getAttribute('action'),
          id: el.id || null,
          className: clip(el.className, 120),
        }));
        return { inputs, selects, buttons, iframes, forms };
      })
      .catch(() => null);
  };

  const frames = page.frames();
  const results = await Promise.all(frames.map(perFrame));
  const inv: DomInventory = {
    url: page.url(),
    frameCount: frames.length,
    inputs: [],
    selects: [],
    buttons: [],
    iframes: [],
    forms: [],
  };
  for (const r of results) {
    if (!r) continue;
    inv.inputs.push(...(r.inputs as DomElementInfo[]));
    inv.selects.push(...(r.selects as DomElementInfo[]));
    inv.buttons.push(...(r.buttons as DomElementInfo[]));
    inv.iframes.push(...r.iframes);
    inv.forms.push(...r.forms);
  }
  return inv;
}

/**
 * HTML de TODOS os frames (principal + iframes), concatenado. Vários portais
 * montam o rastreio dentro de um iframe (ex.: COSCO) — `page.content()` só pega
 * o frame principal, então a extração perderia os eventos. Aqui juntamos tudo
 * para o parser achar sua assinatura esteja o resultado no frame que estiver.
 * Frames cross-origin que recusam `.content()` são ignorados (best-effort).
 */
export async function collectFramesHtml(page: Page): Promise<string> {
  const parts = await Promise.all(page.frames().map((f) => f.content().catch(() => '')));
  return parts.filter(Boolean).join('\n<!--priora-frame-boundary-->\n');
}

/** Texto do body de TODOS os frames, concatenado (p/ detectar resultados/ref). */
export async function collectFramesText(page: Page): Promise<string> {
  const parts = await Promise.all(
    page.frames().map((f) => f.textContent('body').catch(() => '')),
  );
  return parts
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A página é um interstitial de anti-bot (Cloudflare "Just a moment"/managed
 * challenge, DataDome etc.)? Detecta pelo título e por marcadores conhecidos no
 * HTML — usado p/ ESPERAR o desafio resolver e p/ decidir um retry com sessão nova.
 */
export function isChallengePage(title: string, html: string): boolean {
  if (/just a moment|please wait|checking your browser|しばらく|verifying you are human|security check|un momento|attention required/i.test(title || '')) {
    return true;
  }
  // Cloudflare (managed/JS challenge) + DataDome (device check / "you have been
  // blocked"). Ambos disparam o retry com sessão nova (IP/fingerprint novo).
  return /challenges\.cloudflare\.com|__cf_chl_|cf_chl_opt|id="challenge-error-text"|cf-browser-verification|_cf_chl_|geo\.captcha-delivery\.com|captcha-delivery|datadome|you have been blocked/i.test(
    html || '',
  );
}

/** A página ATUAL parece um desafio de anti-bot? (título + marcadores no DOM). */
async function onChallenge(page: Page): Promise<boolean> {
  const title = (await page.title().catch(() => '')) || '';
  if (isChallengePage(title, '')) return true;
  const n = await page
    .locator('#challenge-error-text, #challenge-stage, #cf-challenge-running, script[src*="challenges.cloudflare.com"]')
    .count()
    .catch(() => 0);
  return n > 0;
}

/**
 * Espera um desafio de anti-bot (Cloudflare managed etc.) resolver: fica sondando
 * até a página SAIR do interstitial (o Scraping Browser resolve o JS/cookies e
 * navega pro conteúdo real) ou estourar o tempo. Barato e útil p/ QUALQUER portal
 * atrás de Cloudflare — não só a OOCL.
 */
async function waitOutChallenge(page: Page, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms;
  // Se nem é desafio, sai na hora.
  if (!(await onChallenge(page))) return;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await onChallenge(page))) return; // passou
  }
}

/**
 * Espera DETERMINÍSTICA pelos resultados: em vez de confiar num tempo fixo (que
 * varia conforme o provedor de navegador — Scrapfly, Browserbase, Browserless,
 * self-hosted…), sonda o conteúdo de TODOS os frames até a referência OU um nº de
 * contêiner (ISO 6346) aparecer, ou estourar o prazo. É o que garante que o
 * comportamento seja o MESMO ao trocar de ferramenta: nada de "torcer p/ 2s bastar".
 * Retorna true se detectou conteúdo de resultado; false se estourou o prazo.
 */
async function waitForResults(
  page: Page,
  reference: string | undefined,
  deadlineMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  const refUpper = reference ? reference.toUpperCase() : null;
  for (;;) {
    const txt = await collectFramesText(page).catch(() => '');
    const refSeen = refUpper ? txt.toUpperCase().includes(refUpper) : false;
    const containerSeen = /\b[A-Z]{4}\d{7}\b/.test(txt);
    if (refSeen || containerSeen) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(1000);
  }
}

/**
 * Pilota UMA página (local OU remota) até os resultados do rastreio: navega,
 * aceita cookies, espera a SPA/tabela, e se a referência não aparecer preenche
 * o formulário de busca. Retorna HTML + texto + contagem. É a lógica ÚNICA usada
 * tanto pelo Scraping Browser (remoto) quanto pelo navegador local + IPRoyal —
 * o local IGNORA robots.txt, então serve nos portais que o Bright Data recusa.
 *
 * TODO o conteúdo é lido de TODOS os frames (o rastreio pode estar num iframe),
 * e a busca do formulário (tryFillSearch) também varre os frames.
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

  // Portais atrás de Cloudflare (ex.: OOCL) mostram um interstitial antes do
  // conteúdo: dá tempo do Scraping Browser resolver o desafio e navegar.
  await waitOutChallenge(page).catch(() => undefined);

  await acceptCookies(page);
  // Captcha INTERATIVO (reCAPTCHA/hCaptcha/Turnstile) na entrada: resolve via
  // anti-captcha se configurado (no-op rápido quando não há widget). Beneficia
  // tanto o diagnóstico quanto a produção, que compartilham este motor. EXCEÇÃO:
  // portais cujo driver marca entrySolve:false (ZIM) — o captcha gateia a BUSCA,
  // não o load; resolver aqui gastaria um solve à toa (token expira antes do submit).
  if (findCarrierDriver(page.url())?.entrySolve !== false) {
    await solveCaptchaIfPresent(page, opts.url).catch(() => undefined);
  }
  await page.waitForSelector(RESULT_SELECTOR, { timeout: 25_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: postWait }).catch(() => {});
  await page.waitForTimeout(2000); // folga p/ Vue/React hidratar

  // A partir daqui os resultados podem estar em OUTRA página (popup) — ex.: o
  // servlet legado da Evergreen. `activePage` aponta p/ onde ler o resultado.
  let activePage: Page = page;
  let diag: Record<string, unknown> | undefined;
  let apiJson: string | undefined; // JSON da API interna (ex.: MSC)

  // Se a referência ainda NÃO apareceu, o deep link não auto-buscou: preenche o
  // formulário e submete (muitos portais exigem). Reusa o tryFillSearch.
  // Alguns portais desenham a referência como SVG/imagem (ex.: COSCO desenha o BL),
  // então "ref não achada no texto" NÃO significa "sem resultado": se já há um
  // número de contêiner no corpo, os resultados carregaram — pula o retrabalho.
  if (opts.reference) {
    const body0 = await collectFramesText(page); // varre todos os frames
    const refSeen = body0.toUpperCase().includes(opts.reference.toUpperCase());
    const containerSeen = /\b[A-Z]{4}\d{7}\b/.test(body0);
    // Driver dedicado do portal (registro em carriers/drivers.ts). Portais com
    // driver (form gated, exemplo de contêiner no form, captcha na busca, JSON de
    // API) ignoram o atalho containerSeen; os demais usam o atalho p/ evitar refill.
    const driver = findCarrierDriver(page.url());
    const shouldFill = driver ? !refSeen : !refSeen && !containerSeen;
    if (shouldFill) {
      let filled = false;
      if (driver) {
        const outcome = await driver.drive(page, opts.reference, opts.url);
        filled = outcome.filled;
        if (outcome.resultPage) activePage = outcome.resultPage; // ex.: popup
        if (outcome.apiJson) apiJson = outcome.apiJson; // ex.: JSON da MSC
        if (outcome.diag) diag = outcome.diag;
      }
      if (!filled) filled = await tryFillSearch(page, opts.reference);
      if (filled) {
        await activePage.waitForLoadState('networkidle', { timeout: postWait }).catch(() => {});
        await activePage.waitForSelector(RESULT_SELECTOR, { timeout: 15_000 }).catch(() => {});
        await acceptCookies(activePage);
      }
    }
    // Espera DETERMINÍSTICA pelos resultados (agnóstico de provedor): só segue
    // quando o conteúdo real apareceu (ref/contêiner) — não por tempo fixo. Vale
    // tanto p/ deep link que auto-carrega quanto p/ form submetido.
    await waitForResults(activePage, opts.reference).catch(() => undefined);
  }

  // Alguns portais escondem os eventos completos atrás de um link "detalhe" que
  // carrega via XHR (ex.: PIL, link <a class="trackinfo">). Clica e espera popular.
  const detailLinks = activePage.locator('a.trackinfo, a.trackinfo b');
  const nDetail = await detailLinks.count().catch(() => 0);
  if (nDetail > 0) {
    for (let i = 0; i < Math.min(nDetail, 4); i++) {
      await detailLinks.nth(i).click({ timeout: 3000 }).catch(() => undefined);
      await activePage.waitForTimeout(800);
    }
    // Espera o corpo de detalhe (sub-info-table) deixar de estar vazio/hidden.
    await activePage
      .waitForSelector('.sub-info-table tr, .sub-info-table td', { timeout: 12000 })
      .catch(() => undefined);
    await activePage.waitForLoadState('networkidle', { timeout: postWait }).catch(() => undefined);
    await activePage.waitForTimeout(1500);
  }

  // Outros mostram só o ÚLTIMO movimento e escondem o histórico atrás de um
  // "Display Previous Moves"/"Show all"/"Ver mais" (ex.: CMA CGM). Expande p/ o
  // parser enxergar descarga/retirada/devolução — não só o último evento.
  const expanders = [
    'a:has-text("Display Previous Moves")',
    'button:has-text("Display Previous Moves")',
    'a:has-text("Previous Moves")',
    ':has-text("Display Previous Moves")[class*="link" i]',
    'a:has-text("Show all")',
    'button:has-text("Show more")',
    'a:has-text("Ver mais")',
    'button:has-text("Ver mais")',
  ];
  for (const sel of expanders) {
    const exp = activePage.locator(sel).first();
    if ((await exp.count().catch(() => 0)) > 0) {
      await exp.click({ timeout: 3000 }).catch(() => undefined);
      await activePage.waitForTimeout(1200);
      await activePage.waitForLoadState('networkidle', { timeout: postWait }).catch(() => undefined);
      break;
    }
  }

  // Inventário do formulário (diagnóstico), coletado ENQUANTO a página vive.
  let inventory: DomInventory | undefined;
  if (opts.inventory) {
    inventory = await collectInventory(activePage).catch(() => undefined);
  }

  const title = await activePage.title().catch(() => '');
  // HTML e texto de TODOS os frames (o resultado pode estar num iframe).
  const html = await collectFramesHtml(activePage);
  const textContent =
    (await collectFramesText(activePage)) ||
    ((await activePage.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const rowCount = await activePage.locator('table tr, [role="row"]').count().catch(() => 0);
  const mentionsRef = opts.reference
    ? textContent.toUpperCase().includes(opts.reference.toUpperCase())
    : false;

  return {
    ok: !navError && html.length > 0,
    html,
    textContent,
    title,
    mentionsRef,
    rowCount,
    inventory,
    diag,
    apiJson,
    error: navError || undefined,
  };
}

/** Uma tentativa de scrape via Scraping Browser remoto (conecta, pilota, fecha). */
async function scrapeViaSBOnce(opts: SBScrapeOptions): Promise<SBScrapeResult> {
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

/**
 * Conecta ao Scraping Browser (remoto) e pilota a página até os resultados. Usado
 * nos portais atrás de Cloudflare interativo (Hapag, OOCL…). Se a 1ª tentativa
 * travar num desafio de anti-bot, tenta MAIS UMA vez com sessão nova (IP/
 * fingerprint novo do Scrapfly) — "managed challenges" costumam passar no retry.
 * Só 1 retry, p/ não gastar crédito à toa.
 */
export async function scrapeViaSB(opts: SBScrapeOptions): Promise<SBScrapeResult> {
  const r1 = await scrapeViaSBOnce(opts);
  if (!isChallengePage(r1.title, r1.html)) return r1;
  const r2 = await scrapeViaSBOnce(opts);
  // Fica com o resultado que NÃO é desafio; se ambos travaram, o de HTML maior.
  if (!isChallengePage(r2.title, r2.html)) return r2;
  return r2.html.length > r1.html.length ? r2 : r1;
}
