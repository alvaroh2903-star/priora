import { chromium, Browser, Page } from 'playwright';
import { acceptCookies, tryFillSearch, robustClick } from './carriers/pageUtils';
import { findCarrierDriver } from './carriers/drivers';
import { findDetailCollector, DetailPage } from './carriers/detailCollectors';
import { solveCargoSmartSlider, waitForCargoSmartSlider, SliderOutcome } from './carriers/slideCaptcha';
import { solveCaptchaIfPresent } from './antiCaptcha';
import { PoolMode } from './carriers/types';
import { withRemoteSlot } from './remoteSlot';

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
  return Boolean(getGenericWss() || getGenericWssHeavy() || getSBAuth());
}

/**
 * Endpoint CDP AGNÓSTICO de provedor. Qualquer "cloud browser" que fale CDP por
 * WebSocket (Browserbase, Steel, Browserless, Oxylabs, self-hosted browserless…)
 * entra aqui — é só colar o `wss://…` completo em SCRAPE_BROWSER_WSS. Tem
 * prioridade sobre o Bright Data, então dá para A/B testar provedores trocando
 * UMA variável, sem mexer no código. Vazio = usa o Bright Data (BRIGHTDATA_SB_AUTH).
 *
 * Esta é a URL BARATA (datacenter) usada pelos 9 armadores normais.
 */
function getGenericWss(): string {
  return (process.env.SCRAPE_BROWSER_WSS || '').trim();
}

/**
 * URL wss:// DEDICADA aos armadores com anti-bot PESADO (CMA/OOCL/ZIM). Monte no
 * API Player da Scrapfly com "Unblock Mode" LIGADO + Proxy Pool RESIDENCIAL e cole
 * aqui. É mais cara (residencial ~52 créditos/MB vs 7 do datacenter), por isso só
 * os armadores com pool='residential_unblock' a usam. Vazia = fallback: reescreve
 * só o `proxy_pool` da URL genérica p/ residencial (NÃO liga o Unblock Mode — pra
 * isso, use esta variável).
 */
function getGenericWssHeavy(): string {
  return (process.env.SCRAPE_BROWSER_WSS_HEAVY || '').trim();
}

function getSBAuth(): string {
  return (process.env.BRIGHTDATA_SB_AUTH || '').trim();
}

/** Há URL dedicada de anti-bot pesado (residencial + Unblock) configurada? */
export function isHeavyScrapeConfigured(): boolean {
  return Boolean(getGenericWssHeavy());
}

/** Nome do pool residencial da Scrapfly (melhor p/ anti-bot). Ajustável por env. */
const RESIDENTIAL_POOL = (process.env.SCRAPE_RESIDENTIAL_POOL || 'public_residential_pool').trim();

/**
 * Força o `proxy_pool` de uma URL wss:// do Scrapfly para RESIDENCIAL. Best-effort:
 * só mexe quando a URL é do Scrapfly (tem `proxy_pool` na query, ou host scrapfly);
 * Bright Data (formato "usuário:senha", sem query) e outros voltam INTACTOS. É o
 * fallback de quando não há uma SCRAPE_BROWSER_WSS_HEAVY dedicada: troca o pool,
 * mas NÃO liga o Unblock Mode (isso só vem na URL dedicada feita no API Player).
 */
function withResidentialPool(wss: string): string {
  try {
    const u = new URL(wss);
    const isScrapfly = u.searchParams.has('proxy_pool') || /scrapfly/i.test(u.host);
    if (!isScrapfly) return wss;
    u.searchParams.set('proxy_pool', RESIDENTIAL_POOL);
    return u.toString();
  } catch {
    return wss; // URL não-parseável (ex.: formato "usuário:senha" do Bright Data)
  }
}

/** Nome do provedor CDP ativo (p/ diagnóstico). */
export function scrapeBrowserProvider(): string {
  if (getGenericWss() || getGenericWssHeavy()) return 'custom-wss';
  if (getSBAuth()) return 'brightdata';
  return 'none';
}

/**
 * Arma o Unblock Mode do Scrapfly NA URL da sessão. Descoberto lendo o SDK
 * oficial (`scrapfly/browser_config.py::websocket_url`) depois que o OOCL ficou
 * 133s preso num Cloudflare Turnstile MESMO com `unblock=true` configurado:
 *
 *  - `unblock=true` sozinho é NO-OP. O bypass ASP acontece numa navegação feita
 *    PELO Scrapfly no setup da sessão, e ele só sabe PARA ONDE navegar via
 *    `target_url`. Sem isso, a sessão sobe residencial crua e somos NÓS que
 *    navegamos depois (page.goto) — direto na parede do anti-bot.
 *  - `solve_captcha=true` liga o solver nativo do Cloud Browser, que trata
 *    "GeeTest, PerimeterX hold, and puzzle captchas" — o *puzzle* é exatamente o
 *    slider do CargoSmart (OOCL). Cobrado por solve; falha não custa nada.
 *
 * Preserva o resto da URL que o operador colou (resolution, country…) e NÃO
 * mexe no `proxy_pool` já existente (o `public_residential_pool` está provado em
 * produção). Best-effort: URL não-Scrapfly volta intacta.
 */
function withUnblockMode(wss: string, targetUrl?: string): string {
  try {
    const u = new URL(wss);
    const isScrapfly = u.searchParams.has('api_key') || /scrapfly/i.test(u.host);
    if (!isScrapfly) return wss;
    u.searchParams.set('unblock', 'true');
    u.searchParams.set('solve_captcha', 'true');
    // O alvo do bypass. Sem ele o `unblock` não tem o que desbloquear.
    if (targetUrl) u.searchParams.set('target_url', targetUrl);
    return u.toString();
  } catch {
    return wss;
  }
}

/**
 * Monta o endpoint CDP conforme o POOL pedido (3 níveis — ver PoolMode):
 * - 'residential_unblock': URL dedicada residencial (SCRAPE_BROWSER_WSS_HEAVY) ou a
 *   genérica reescrita p/ residencial, SEMPRE com Unblock+solver armados
 *   (`withUnblockMode`) e apontados ao `targetUrl` desta requisição.
 * - 'residential': reescreve o `proxy_pool` da URL genérica p/ residencial (sem Unblock).
 * - 'datacenter' (padrão do builder): URL genérica como está (barato), ou Bright Data.
 *
 * `targetUrl` é a URL do portal que vamos abrir — só usada no pool de unblock.
 */
function buildWSEndpoint(pool: PoolMode = 'datacenter', targetUrl?: string): string {
  const generic = getGenericWss();
  if (pool === 'residential_unblock') {
    const dedicated = getGenericWssHeavy();
    if (dedicated) return withUnblockMode(dedicated, targetUrl);
    if (generic) return withUnblockMode(withResidentialPool(generic), targetUrl);
  } else if (pool === 'residential') {
    if (generic) return withResidentialPool(generic);
    // sem URL genérica: segue p/ o Bright Data abaixo (sem reescrita de pool).
  }
  // datacenter (ou fallback): URL genérica como está — tem prioridade.
  if (generic) return generic;
  // Bright Data: URL completa OU "usuário:senha" (montamos o host/porta padrão).
  const auth = getSBAuth();
  if (/^wss?:\/\//i.test(auth)) return auth;
  return `wss://${auth}@${CDP_HOST}:${CDP_PORT}`;
}

/** Opções de conexão ao navegador remoto. */
export interface ConnectOptions {
  /**
   * Pool de saída da sessão remota (ver PoolMode). Default: 'datacenter' (barato).
   * 'residential' p/ portais que bloqueiam datacenter (Maersk/MSC/…);
   * 'residential_unblock' p/ anti-bot pesado (CMA/OOCL/ZIM).
   */
  pool?: PoolMode;
  /**
   * URL do portal que esta sessão vai abrir. No pool 'residential_unblock' vira
   * o `target_url` do Scrapfly — é o ALVO do bypass ASP, feito por ELE antes de
   * nos entregar a sessão. Sem isso o `unblock` não faz nada (ver withUnblockMode).
   */
  targetUrl?: string;
}

/**
 * Conecta ao Scraping Browser (Chromium remoto) via CDP e devolve o Browser. Quem
 * chama é responsável por fechar. Usado pelo `withRemotePage` (browser.ts) para
 * rodar QUALQUER scraper de armador contra o navegador remoto — furando Cloudflare/
 * SPA sem trocar a lógica de cada portal. `opts.pool` escolhe o pool (ver acima).
 */
export async function connectSB(opts: ConnectOptions = {}): Promise<Browser> {
  if (!isSBConfigured()) {
    throw new Error('Cloud browser não configurado (defina SCRAPE_BROWSER_WSS ou BRIGHTDATA_SB_AUTH).');
  }
  return chromium.connectOverCDP(buildWSEndpoint(opts.pool, opts.targetUrl), { timeout: 30_000 });
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
  /**
   * Pool de saída da sessão remota (ver ConnectOptions.pool). Default: 'datacenter'.
   */
  pool?: PoolMode;
  /**
   * Como interceptar recursos (economia de banda e tempo). Default: 'media'.
   *  - 'media': intercepta SÓ URLs de mídia (imagem/fonte/vídeo) — o padrão,
   *    seguro para SPA (ver blockHeavyResources).
   *  - 'all':  comportamento LEGADO — `page.route('**\/*')`, reemite TODA
   *    requisição. Quebra SPA com ES module `crossorigin` (provado na OOCL), mas
   *    foi com ele que a ZIM entregou o histórico completo; com 'media' ela caiu
   *    no Akamai duas vezes seguidas (IPs diferentes). Mantido para testar a
   *    hipótese de que a interceptação total atrapalhava o sensor do Akamai.
   *  - 'none': sem interceptação nenhuma.
   * Diagnóstico: `?block=all|media|none` (`?noblock=1` = 'none').
   */
  blockMode?: BlockMode;
  /**
   * DIAGNÓSTICO: seletor CSS de um elemento a CLICAR depois que o resultado
   * carrega — e a página que abrir (popup ou mesma aba) passa a ser a capturada.
   * Serve para pegar o DOM das páginas de DETALHE por contêiner (Yang Ming
   * `a[href*="cargo_tracking_detail"]`, popup CntrMove da Evergreen) numa rodada
   * só, sem chumbar fluxo por armador. Só o 1º elemento que casar é seguido.
   */
  follow?: string;
  /**
   * Visitar a página/popup de DETALHE de cada contêiner (histórico completo),
   * quando o portal tem coletor (ver carriers/detailCollectors). Default: true.
   */
  collectDetails?: boolean;
}

export type BlockMode = 'media' | 'all' | 'none';

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
  /** Páginas de DETALHE por contêiner (histórico completo), quando o portal tem coletor. */
  details?: DetailPage[];
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

/**
 * Texto do body de TODOS os frames, concatenado (p/ detectar resultados/ref E
 * alimentar a camada de IA). Usa `innerText` = só o texto VISÍVEL, igual um humano
 * lê: exclui o conteúdo de `<style>`/`<script>` e elementos ocultos. Isso é crucial:
 * `textContent` trazia o CSS inteiro dos banners de cookie (ex.: Cookie Information
 * da Maersk injeta MILHARES de linhas de `.coi-banner{...}` no DOM) — enchia a
 * janela da IA de lixo e escondia os dados reais. Fallback: textContent sem
 * style/script, caso innerText venha vazio nalgum frame.
 */
export async function collectFramesText(page: Page): Promise<string> {
  const parts = await Promise.all(
    page.frames().map(async (f) => {
      const it = await f.innerText('body').catch(() => '');
      if (it && it.trim()) return it;
      // Fallback: clona o body, remove style/script/noscript e pega o texto.
      return f
        .evaluate(() => {
          const b = document.body ? (document.body.cloneNode(true) as HTMLElement) : null;
          if (!b) return '';
          b.querySelectorAll('style, script, noscript, template').forEach((el) => el.remove());
          return b.textContent || '';
        })
        .catch(() => '');
    }),
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
  if (/challenge validation|akamai challenge/i.test(title)) return true;
  if (await findAkamaiBehavioralFrame(page)) return true;
  const n = await page
    .locator('#challenge-error-text, #challenge-stage, #cf-challenge-running, script[src*="challenges.cloudflare.com"]')
    .count()
    .catch(() => 0);
  return n > 0;
}

/**
 * Desafio COMPORTAMENTAL do Akamai ("sec-cpt"). Visto ao vivo na ZIM (10/10,
 * link direto ?consnumber=): página "Challenge Validation" com um iframe que
 * traz a caixinha "I'm not a robot"/"Je ne suis pas un robot" (#robot-checkbox) e
 * o botão "Verify"/"Valider" (#progress-button), habilitado após o clique e uma
 * barra de progresso (~30 s, prova de trabalho feita pelo próprio iframe). O
 * Unblock do Scrapfly NÃO clica nisso — esperar não resolve.
 */
async function findAkamaiBehavioralFrame(page: Page): Promise<import('playwright').Frame | null> {
  for (const f of page.frames()) {
    const n = await f.locator('#sec-if-cpt-container #robot-checkbox, #sec-if-behaviours').count().catch(() => 0);
    if (n > 0) return f;
  }
  return null;
}

/** Diagnóstico da última tentativa no desafio do Akamai (vai para o `diag`). */
let lastAkamaiDiag: Record<string, unknown> | undefined;

/**
 * Faz o que uma pessoa faz no desafio do Akamai: marca a caixinha, espera o botão
 * habilitar (fim da barra de progresso) e clica em "Verify". Depois espera a
 * página sair do desafio. Devolve true se saiu.
 */
async function solveAkamaiBehavioral(page: Page, ms = 75_000): Promise<boolean> {
  const t0 = Date.now();
  const frame = await findAkamaiBehavioralFrame(page);
  if (!frame) return false;
  const d: Record<string, unknown> = { found: true };
  lastAkamaiDiag = d;
  const box = frame.locator('#sec-if-behaviours-child, #robot-checkbox').first();
  d.checkbox = await box
    .click({ timeout: 8000 })
    .then(() => 'click')
    .catch(async () =>
      frame
        .locator('#robot-checkbox')
        .evaluate((el) => (el as HTMLInputElement).click())
        .then(() => 'js')
        .catch(() => 'falhou'),
    );
  // O botão fica com a classe progress-btn-disabled até a prova de trabalho acabar.
  d.enabled = await frame
    .waitForFunction(
      () => {
        const b = document.querySelector('.behavioral-button');
        return Boolean(b) && !b!.className.includes('progress-btn-disabled');
      },
      undefined,
      { timeout: 50_000 },
    )
    .then(() => true)
    .catch(() => false);
  d.proceed = await frame
    .locator('#progress-button')
    .click({ timeout: 8000 })
    .then(() => 'click')
    .catch(() => 'falhou');
  // Passou = a página deixa de ser o desafio (recarrega no conteúdo real).
  let passed = false;
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(2500);
    const title = (await page.title().catch(() => '')) || '';
    if (!/challenge/i.test(title) && !(await findAkamaiBehavioralFrame(page))) {
      passed = true;
      break;
    }
  }
  d.passed = passed;
  d.ms = Date.now() - t0;
  return passed;
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
  // Desafio COMPORTAMENTAL do Akamai: não se resolve esperando — exige o clique.
  if (await findAkamaiBehavioralFrame(page)) {
    await solveAkamaiBehavioral(page).catch(() => undefined);
  }
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
  deadlineMs = 45_000,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  const refUpper = reference ? reference.toUpperCase() : null;
  // Conteúdo mínimo p/ considerar "renderizou de verdade" (não casca/menu só).
  const MIN_SUBSTANTIAL = 1500;
  let lastLen = -1;
  let stable = 0;
  for (;;) {
    const txt = await collectFramesText(page).catch(() => '');
    const refSeen = refUpper ? txt.toUpperCase().includes(refUpper) : false;
    const containerSeen = /\b[A-Z]{4}\d{7}\b/.test(txt);
    const substantial = txt.length >= MIN_SUBSTANTIAL;
    // "Pronto" exige SINAL de resultado (ref ou contêiner) + conteúdo substancial.
    // Isso evita capturar no primeiro container de exemplo do form, ou com a casca
    // ainda vazia (o render "magro" que derrubava armadores lentos).
    if ((refSeen || containerSeen) && substantial) {
      // ESTABILIZAÇÃO: a SPA renderiza a tabela por partes. Só captura quando o
      // tamanho do texto PARA de crescer (2 leituras iguais ~3s) — garante a tabela
      // inteira, não um pedaço. É o que mata o "puxou magro".
      if (txt.length === lastLen) {
        if (++stable >= 2) return true;
      } else {
        stable = 0;
      }
      lastLen = txt.length;
    }
    if (Date.now() >= deadline) return refSeen || containerSeen;
    await page.waitForTimeout(1500);
  }
}

/**
 * ECONOMIA DE CRÉDITO (Cloud Browser cobra por TEMPO + BANDA): bloqueia recursos
 * pesados e irrelevantes p/ extração — imagens, mídia e fontes. Corta MB (banda) E
 * acelera o load (menos coisa p/ baixar → sessão mais curta → menos blocos de 30s).
 * CSS/JS/XHR seguem passando (a SPA e a captura de JSON dependem deles). Best-effort:
 * se o browser remoto não suportar interceptação, segue sem bloqueio (sem dano).
 */
/**
 * Só as URLs de MÍDIA entram na interceptação — casadas por extensão.
 *
 * A versão anterior usava `page.route('**\/*')` e reemitia TODA requisição com
 * `route.continue()`, inclusive HTML/JS/CSS/XHR. Em navegador remoto isso quebra
 * o carregamento de ES modules com `crossorigin`, e a SPA simplesmente não monta.
 * PROVADO ao vivo na OOCL, mesma URL, só alternando o bloqueio:
 *   com interceptação total → htmlLen 2.106 (casca `<div id="scct">` vazia)
 *   sem interceptação       → htmlLen 208.496 (app montado)
 * Como o padrão abaixo casa apenas mídia, nada crítico passa por `continue()` —
 * a economia de banda continua e o risco de estragar o render some.
 */
const MEDIA_URL_RE =
  /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|avi|mov)(?:[?#]|$)/i;

async function blockHeavyResources(page: Page, mode: Exclude<BlockMode, 'none'>): Promise<void> {
  try {
    // 'all' = legado (intercepta tudo); 'media' = só URLs de mídia. Ver BlockMode.
    const pattern: string | RegExp = mode === 'all' ? '**/*' : MEDIA_URL_RE;
    await page.route(pattern, (route) => {
      const t = route.request().resourceType();
      // Confere o tipo também: evita abortar algo servido com extensão enganosa.
      if (t === 'image' || t === 'media' || t === 'font') route.abort().catch(() => undefined);
      else route.continue().catch(() => undefined);
    });
  } catch {
    /* interceptação pode não ser suportada no remoto — segue sem bloqueio */
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
/**
 * A aba JÁ está na página-alvo? No Unblock Mode o Scrapfly navega até
 * `target_url` durante o setup da sessão e nos entrega a aba pronta; um
 * `page.goto()` nosso em cima disso refaz a navegação com estado já gasto e
 * alguns portais invalidam a sessão (OOCL: "This Page Has Expired" → /moc/error).
 * Compara origem + caminho; `about:blank` (fluxo normal) nunca casa, então os
 * outros armadores seguem navegando como antes.
 */
function alreadyOnTarget(current: string, target: string): boolean {
  try {
    const a = new URL(current);
    const b = new URL(target);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false; // about:blank, URL vazia etc.
  }
}

export async function driveTrackingPage(
  page: Page,
  opts: SBScrapeOptions,
): Promise<Omit<SBScrapeResult, 'ms'>> {
  const navTimeout = opts.navigationTimeout ?? 90_000;
  const postWait = opts.postLoadWait ?? 8000;

  // Economia de banda/tempo: bloqueia imagens/mídia/fontes ANTES de navegar.
  const blockMode: BlockMode = opts.blockMode ?? 'media';
  if (blockMode !== 'none') await blockHeavyResources(page, blockMode);

  let navError: string | null = null;
  // Com o Unblock Mode, quem navega até o alvo é o PRÓPRIO Scrapfly (é assim que
  // ele vence o Cloudflare) e nos entrega a aba JÁ carregada. Navegar de novo
  // queima o estado: a OOCL respondeu "This Page Has Expired" e jogou a sessão
  // para /scct/public/moc/error — depois de termos furado o Turnstile. Então, se
  // a aba já está no alvo, NÃO renavegamos (também economiza tempo de sessão).
  // OOCL: registra a conversa do captcha da CargoSmart com o servidor (pedido da
  // imagem, envio ao soltar a barra e resposta) — é o que diz POR QUE recusou.
  const captchaNet: Array<Record<string, unknown>> = [];
  if (/oocl\.com/i.test(opts.url)) {
    page.on('response', async (r) => {
      try {
        const u = r.url();
        const t = r.request().resourceType();
        // Chamadas do captcha E as do app (XHR/fetch) — depois do captcha resolvido
        // o app caía em "This Page Has Expired": é a chamada seguinte que falha.
        const interesting = /captcha/i.test(u) || t === 'xhr' || t === 'fetch';
        if (captchaNet.length >= 24 || !interesting || /\.(css|js|png|jpe?g|svg|woff2?)(\?|$)/i.test(u)) return;
        const body = await r.text().catch(() => '');
        captchaNet.push({
          at: Date.now(),
          type: t,
          url: u.slice(0, 160),
          method: r.request().method(),
          status: r.status(),
          req: (r.request().postData() || '').slice(0, 1200),
          // Imagens em base64 encurtadas (o resto da resposta é o que interessa).
          res: body.replace(/"([A-Za-z0-9+/=]{200,})"/g, (_m, b64: string) => `"<base64 ${b64.length}>"`).slice(0, 2500),
        });
      } catch {
        /* diagnóstico best-effort */
      }
    });
    // Requisição do captcha que NEM chegou a ter resposta (conexão cortada pelo
    // firewall da CargoSmart — visto com curl em 10/10: "Connection reset").
    page.on('requestfailed', (q) => {
      const u = q.url();
      const t = q.resourceType();
      if (captchaNet.length >= 24 || !(/captcha/i.test(u) || t === 'xhr' || t === 'fetch')) return;
      captchaNet.push({ at: Date.now(), type: t, url: u.slice(0, 160), method: q.method(), failed: q.failure()?.errorText || 'falhou' });
    });
  }
  // Onde a aba estava quando a recebemos (com Unblock, o Scrapfly já navegou):
  // é o que diz se o bypass entregou o alvo, uma página de erro ou nada.
  const initialUrl = page.url();
  const navStartedAt = Date.now();
  lastAkamaiDiag = undefined;
  const preNavigated = alreadyOnTarget(initialUrl, opts.url);
  if (!preNavigated) {
    try {
      // 'commit' retorna assim que a navegação começa — não trava em SPAs pesadas
      // (ex.: ONE) que demoram no 'domcontentloaded'. A espera pelos resultados
      // (waitForSelector/networkidle abaixo) é quem garante o render.
      await page.goto(opts.url, { waitUntil: 'commit', timeout: navTimeout });
    } catch (e) {
      navError = (e as Error).message;
    }
  }

  // Portais atrás de Cloudflare (ex.: OOCL) mostram um interstitial antes do
  // conteúdo: dá tempo do Scraping Browser resolver o desafio e navegar.
  await waitOutChallenge(page).catch(() => undefined);

  await acceptCookies(page);
  // OOCL (CargoSmart): captcha de ARRASTAR a peça antes do resultado — e ele
  // EXPIRA. Era o "This Page Has Expired": o motor esperava resultado enquanto o
  // captcha vencia. Resolve na hora, antes de qualquer outra espera.
  let sliderDiag: SliderOutcome | undefined;
  if (/oocl\.com/i.test(opts.url) && (await waitForCargoSmartSlider(page, 20_000))) {
    sliderDiag = await solveCargoSmartSlider(page, { captureImages: Boolean(opts.inventory) }).catch((e) => ({
      found: true,
      solved: false,
      attempts: [],
      ms: 0,
      error: String((e as Error).message).slice(0, 200),
    }));
  }
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
    // O desafio do Akamai também aparece DEPOIS da busca (ZIM: "Please try again.
    // ⚠️ Verify" no lugar do resultado) — resolve e deixa a página recarregar.
    if (await findAkamaiBehavioralFrame(activePage)) {
      await solveAkamaiBehavioral(activePage).catch(() => undefined);
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

  // MAERSK: o layout novo ("ocean-design") mostra por contêiner só um resumo e
  // esconde os eventos num acordeão "View 11 events completed from origin" — sem
  // abrir, a descarga e a retirada nem existem na página (a IA só via chegada do
  // navio e devolução). Ordem:
  //  1. fecha o banner de cookies (visto aberto na captura, por cima de tudo);
  //  2. volta para o layout ANTIGO ("Return to old tracking"), que lista o plano
  //     de transporte inteiro e que o parser dedicado (validado) já lê;
  //  3. se o antigo não carregar, abre os acordeões do layout novo.
  // Validado ao vivo: os dois links existem em DUPLICATA (responsivo) e o 1º da
  // página é o escondido — o robustClick mira o visível.
  if (/maersk\.com/i.test(activePage.url())) {
    const md: Record<string, unknown> = {};
    const cookie = activePage.locator('button.coi-banner__accept, button:has-text("Allow all")');
    if ((await cookie.count().catch(() => 0)) > 0) {
      md.cookie = (await robustClick(cookie, 3000)).method;
      await activePage.waitForTimeout(800);
    }
    const oldLink = activePage.locator('[data-test="ocean-beta-return-link"], a:has-text("Return to old tracking")');
    if ((await oldLink.count().catch(() => 0)) > 0) {
      const r = await robustClick(oldLink, 5000);
      md.oldTracking = { click: r.method, visible: r.visible };
      await activePage.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
      const oldOk = await activePage
        .waitForSelector('.transport-plan__list__item', { timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      md.layout = oldOk ? 'antigo' : 'novo';
    } else {
      md.layout = 'novo';
    }
    if (md.layout === 'novo') {
      const sel = 'text=/View \\d+ events?/i';
      const n0 = await activePage.locator(sel).filter({ visible: true }).count().catch(() => 0);
      let opened = 0;
      for (let i = 0; i < Math.min(n0, 10); i++) {
        const vis = activePage.locator(sel).filter({ visible: true });
        if ((await vis.count().catch(() => 0)) === 0) break;
        const r = await robustClick(n0 > (await vis.count().catch(() => 0)) ? vis.first() : vis.nth(i), 4000);
        if (r.ok) opened++;
        await activePage.waitForTimeout(1500);
      }
      md.eventsOpened = `${opened}/${n0}`;
      if (n0 > 0) await activePage.waitForLoadState('networkidle', { timeout: postWait }).catch(() => undefined);
    }
    diag = { ...(diag || {}), maersk: md };
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

  // DIAGNÓSTICO `follow`: clica no 1º elemento que casar e passa a ler a página
  // que abrir (popup ou mesma aba). É como capturamos o DOM das páginas de detalhe
  // por contêiner sem gastar uma rodada só para descobrir a URL.
  let followDiag: Record<string, unknown> | undefined;
  if (opts.follow) {
    const target = activePage.locator(opts.follow).first();
    const matched = (await target.count().catch(() => 0)) > 0;
    followDiag = { selector: opts.follow, matched };
    if (matched) {
      followDiag.href = await target.getAttribute('href').catch(() => null);
      followDiag.text = ((await target.innerText().catch(() => '')) || '').slice(0, 80);
      const popupP = activePage.waitForEvent('popup', { timeout: 30_000 }).catch(() => null);
      // Clique robusto (normal → forçado → JS → ancestral): o clique normal travava
      // no "View 11 events" da Maersk (span dentro de componente web).
      const click = await robustClick(target);
      followDiag.click = { ok: click.ok, method: click.method, errors: click.errors };
      // Popup que não abre em 6s depois do clique = clique que expande/navega na
      // própria aba (não ficamos presos esperando o timeout do popup).
      const popup = await Promise.race([
        popupP,
        new Promise<null>((r) => setTimeout(() => r(null), 6000)),
      ]);
      if (popup) activePage = popup;
      followDiag.popup = Boolean(popup);
      await activePage.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
      await activePage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
      await activePage.waitForTimeout(2500); // folga p/ SPA hidratar o detalhe
      followDiag.urlAfter = activePage.url();
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

  // Histórico COMPLETO por contêiner (Yang Ming, Evergreen…): roda por último,
  // com o resumo já guardado acima, porque o coletor pode navegar a própria aba.
  let details: DetailPage[] | undefined;
  let detailsDiag: Record<string, unknown> | undefined;
  const collector = opts.collectDetails === false ? undefined : findDetailCollector(activePage.url());
  if (collector) {
    const t0 = Date.now();
    const got = await collector.collect(activePage).catch((e) => ({
      pages: [] as DetailPage[],
      log: [`coletor falhou: ${String((e as Error).message).slice(0, 160)}`],
    }));
    details = got.pages;
    detailsDiag = {
      collector: collector.id,
      count: details.length,
      containers: details.map((d) => d.container),
      log: got.log,
      ms: Date.now() - t0,
    };
  }

  return {
    ok: !navError && html.length > 0,
    html,
    textContent,
    title,
    mentionsRef,
    rowCount,
    inventory,
    // `preNavigated`/`landedUrl` mostram se a aba já veio navegada pelo Unblock
    // (e onde ela parou) — é o que diferencia "o provedor entregou a página" de
    // "nós navegamos". Some junto do diag do driver, quando houver.
    diag: {
      ...(diag || {}),
      initialUrl,
      preNavigated,
      ...(lastAkamaiDiag ? { akamai: lastAkamaiDiag } : {}),
      ...(sliderDiag ? { slider: sliderDiag } : {}),
      ...(captchaNet.length ? { captchaNet, navStartedAt } : {}),
      landedUrl: activePage.url(),
      blockMode,
      ...(followDiag ? { follow: followDiag } : {}),
      ...(detailsDiag ? { details: detailsDiag } : {}),
    },
    apiJson,
    details,
    error: navError || undefined,
  };
}

/** Uma tentativa de scrape via Scraping Browser remoto (conecta, pilota, fecha). */
async function scrapeViaSBOnce(opts: SBScrapeOptions): Promise<SBScrapeResult> {
  // Mesma vaga global do withRemotePage: o diagnóstico também entra na fila.
  return withRemoteSlot(() => scrapeViaSBOnceInSlot(opts));
}

async function scrapeViaSBOnceInSlot(opts: SBScrapeOptions): Promise<SBScrapeResult> {
  const startedAt = Date.now();
  let browser: Browser | null = null;
  try {
    // `targetUrl` = a URL que vamos abrir: no pool de unblock é o ALVO do bypass
    // ASP que o Scrapfly faz ANTES de nos devolver a sessão (ver withUnblockMode).
    browser = await connectSB({ pool: opts.pool, targetUrl: opts.url });
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
