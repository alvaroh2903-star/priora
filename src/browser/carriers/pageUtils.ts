import { Page, Frame } from 'playwright';

/**
 * Priora — Utilitários de página compartilhados pelos scrapers de armadores.
 * Consentimento de cookies, detecção de login/CAPTCHA e preenchimento de busca.
 */

const COOKIE_ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler', // OneTrust (Hapag e muitos outros)
  'button#truste-consent-button',
  'button[aria-label*="accept" i]',
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Accept All Cookies")',
  'button:has-text("I Accept")',
  'button:has-text("I agree")',
  'button:has-text("Aceitar")',
  'button:has-text("Aceitar todos")',
];

const CAPTCHA_HINTS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="captcha" i]',
  'div.g-recaptcha',
  '#captcha',
  '[class*="captcha" i]',
];

const LOGIN_TEXT_HINTS = [
  'sign in',
  'log in',
  'please log in',
  'session expired',
  'unauthorized',
];

/** Aceita o banner de cookies e fecha camadas de idioma/região (best-effort). */
export async function acceptCookies(page: Page): Promise<void> {
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    const btn = page.locator(sel).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.click({ timeout: 3000 }).catch(() => undefined);
      break;
    }
  }
  // Camada de idioma/região (ex.: ShipmentLink "Would you use language: Español?"
  // sobre um IP hispânico) — força inglês; a página recarrega em inglês, sem a
  // camada bloqueando o formulário. Também esconde a camada por JS como reforço.
  const langBtn = page
    .locator(
      'button:has-text("No, use English"), button:has-text("Continue in English"), button:has-text("Use English")',
    )
    .first();
  if ((await langBtn.count().catch(() => 0)) > 0) {
    await langBtn.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
  }
  await page
    .evaluate(() => {
      const el = document.getElementById('shipmentlink_lang_layer');
      if (el) (el as HTMLElement).style.display = 'none';
    })
    .catch(() => undefined);
}

/** Detecta a presença de um CAPTCHA na página. */
export async function detectCaptcha(page: Page): Promise<boolean> {
  for (const sel of CAPTCHA_HINTS) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

/** Detecta se a página está pedindo login. */
export async function detectLogin(page: Page, bodyText: string): Promise<boolean> {
  const hasPasswordField =
    (await page.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;
  if (hasPasswordField) return true;
  const lower = bodyText.toLowerCase();
  return LOGIN_TEXT_HINTS.some((h) => lower.includes(h));
}

/** Texto visível do body, normalizado. */
export async function getBodyText(page: Page): Promise<string> {
  const t = (await page.textContent('body').catch(() => '')) || '';
  return t.replace(/\s+/g, ' ').trim();
}

// Campos de busca candidatos (ordem = prioridade). `input[type="search"]` fica
// por último entre os "genéricos" porque alguns SPAs (Ant) usam um input search
// READONLY como dropdown de tipo — o guard isEditable pula esses.
const SEARCH_FIELD_CANDIDATES = [
  'input[name*="container" i]',
  'input[name*="booking" i]',
  'input[name*="bl" i]',
  'input[name*="track" i]',
  'input[name*="number" i]',
  'input[name*="ref" i]',
  'input[id*="track" i]',
  'input[placeholder*="container" i]',
  'input[placeholder*="b/l" i]',
  'input[placeholder*="bill of lading" i]',
  'input[placeholder*="track" i]',
  'input[type="search"]',
  'input[type="text"]',
];

// Botões de busca comuns (muitos forms/servlets NÃO submetem no Enter).
const SEARCH_BUTTONS = [
  'button:has-text("Search")',
  'button:has-text("Track")',
  'button:has-text("Trace")',
  'button:has-text("Retrieve")', // HMM
  'input[value*="Retrieve" i]',
  'button:has-text("Consultar")',
  'button:has-text("Rastrear")',
  'button:has-text("Buscar")',
  'a:has-text("Track")',
  'a:has-text("Trace")',
  'input[type="submit"]',
  'button[type="submit"]',
  'button:has-text("Submit")', // Evergreen/ShipmentLink
  'input[value*="Submit" i]',
  'input[value*="Search" i]',
  'input[value*="Track" i]',
  '[onclick*="track" i]',
  '[onclick*="search" i]',
  '[onclick*="retrieve" i]',
];

/** Preenche+submete a busca DENTRO de um frame específico (best-effort). */
async function fillSearchInFrame(frame: Frame, ref: string): Promise<boolean> {
  for (const sel of SEARCH_FIELD_CANDIDATES) {
    const fields = frame.locator(sel);
    const n = await fields.count().catch(() => 0);
    // Tenta TODOS os elementos que casam com o seletor (não só o 1º): muitos forms
    // têm campos duplicados/escondidos ANTES do visível (ex.: ShipmentLink tem 5
    // inputs name="NO" escondidos da aba "Multiple" antes do input real). Parar no
    // 1º não-editável faria pular o campo certo.
    for (let i = 0; i < Math.min(n, 10); i++) {
      const field = fields.nth(i);
      // Pula campos readonly/escondidos/desabilitados (ex.: o dropdown de tipo do
      // Ant, um input[type=search] readonly) — digitar neles não faz a busca.
      if (!(await field.isEditable().catch(() => false))) continue;
      await field.fill(ref).catch(() => undefined);
      // 1) tenta CLICAR um botão de busca; 2) senão, ENTER (o site pode exigir um).
      let clicked = false;
      for (const b of SEARCH_BUTTONS) {
        const btn = frame.locator(b).first();
        if ((await btn.count().catch(() => 0)) > 0) {
          await btn.click({ timeout: 3000 }).catch(() => undefined);
          clicked = true;
          break;
        }
      }
      if (!clicked) await field.press('Enter').catch(() => undefined);
      return true;
    }
  }
  return false;
}

/**
 * Tenta preencher o campo de busca com a referência e submeter, varrendo TODOS
 * os frames (o formulário de rastreio às vezes vive num iframe — ex.: COSCO).
 * Sempre buscamos pela referência recebida (a BL), nunca por outro número.
 */
export async function tryFillSearch(page: Page, ref: string): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await fillSearchInFrame(frame, ref)) return true;
  }
  return false;
}

/** Resultado do driver dedicado do ShipmentLink (com diagnóstico). */
export interface ShipmentLinkDriveResult {
  /** Página onde LER o resultado — a mesma, ou o popup que o Submit abriu. */
  resultPage: Page;
  /** Achou o form e submeteu. */
  submitted: boolean;
  /** Valor que ficou no input#NO após o fill (revela clique/preench. bloqueado). */
  valueAfterFill: string | null;
  /** O Submit abriu uma janela nova (popup)? */
  popupOpened: boolean;
  /** O modal de cookies estava visível ao entrar no driver (podia bloquear)? */
  cookieVisibleBefore: boolean;
}

/**
 * Driver DEDICADO do formulário da Evergreen (ShipmentLink, TDB1_CargoTracking).
 *
 * A aba "Quick Tracking" (ativa por padrão) tem: radios name="SEL" (#s_bl / #s_cntr
 * / #s_bk = tipo de busca), UM input#NO visível e um <input type="button"
 * value="Submit"> cujo onclick seta os hidden (TYPE/BL/CNTR/bkno) e submete o form.
 * O preenchedor genérico não serve aqui: há 6 inputs name="NO" (5 escondidos da aba
 * "Multiple" antes do visível) e é preciso marcar o radio de tipo. Este driver
 * sempre busca por B/L (só a parte numérica — o registro já tira EGLV/EVGL).
 *
 * O resultado pode vir na MESMA página (POST) ou num POPUP (servlet legado): o
 * driver escuta o popup e devolve a página certa em `resultPage`. Retorna null se
 * nem achou o form. O modal de cookies fica por cima e intercepta cliques, então
 * é dispensado (e esperado sumir) ANTES de mexer no form.
 */
export async function driveShipmentLinkForm(
  page: Page,
  ref: string,
): Promise<ShipmentLinkDriveResult | null> {
  const input = page.locator('input#NO');
  if ((await input.count().catch(() => 0)) === 0) return null;

  // Cookies POR CIMA do form interceptam o clique no Submit — dispensa e espera sumir.
  const cookieBtn = page.locator('#btn_cookie_accept_all');
  const cookieVisibleBefore = (await cookieBtn.isVisible().catch(() => false)) === true;
  if (cookieVisibleBefore) {
    await cookieBtn.click({ timeout: 3000 }).catch(() => undefined);
    await cookieBtn.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
  }

  // 1) Seleciona busca por B/L (#s_bl) — sem isso o servlet busca por outro tipo.
  const blRadio = page.locator('#s_bl');
  if ((await blRadio.count().catch(() => 0)) > 0) {
    await blRadio.check({ timeout: 3000 }).catch(() => undefined);
  }
  // 2) Digita a B/L (parte numérica) e confere que o valor entrou (diagnóstico).
  await input.first().fill(ref).catch(() => undefined);
  const valueAfterFill = await input.first().inputValue().catch(() => null);

  // 3) Clica o "Submit" visível (o da aba Multiple é escondido); senão, Enter. O
  //    resultado pode abrir num popup — escuta ANTES do clique.
  const submit = page.locator('input[type="button"][value="Submit" i]:visible').first();
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
  let submitted = false;
  if ((await submit.count().catch(() => 0)) > 0) {
    await submit.click({ timeout: 5000 }).catch(() => undefined);
    submitted = true;
  } else {
    await input.first().press('Enter').catch(() => undefined);
    submitted = true;
  }
  const popup = await popupPromise;
  const resultPage = popup || page;
  await resultPage.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
  return { resultPage, submitted, valueAfterFill, popupOpened: Boolean(popup), cookieVisibleBefore };
}

/**
 * Driver DEDICADO da MSC (msc.com/track-a-shipment, SPA em Alpine.js).
 *
 * O form tem `input#trackingNumber` (x-model) + radios `trackingMode` (0=Container/
 * B/L já `checked`, 1=Booking) + um botão de busca que é um ÍCONE SEM TEXTO
 * (`button.msc-search-autocomplete__search`, `<span class="msc-icon-search">`),
 * **desabilitado** até o campo focar ou ter texto. O preenchedor genérico falha
 * aqui: acha botão por texto e acaba clicando num link "Track" de navegação.
 *
 * Passos: foca o campo (habilita o botão via Alpine `focusInput`), preenche a BL,
 * dispara `input` (Alpine atualiza `trackingNumber`), clica o ícone de busca (ou
 * Enter como reforço) e espera o loader (`isLoading`) resolver. O modo padrão
 * (Container/B/L) já cobre nossas BLs. Resultado na MESMA página (SPA).
 */
export async function driveMscForm(page: Page, ref: string): Promise<boolean> {
  const input = page.locator('#trackingNumber');
  if ((await input.count().catch(() => 0)) === 0) return false;
  await input.scrollIntoViewIfNeeded().catch(() => undefined);
  await input.click().catch(() => undefined); // foca → habilita o botão (focusInput)
  await input.fill(ref).catch(() => undefined);
  await input.dispatchEvent('input').catch(() => undefined); // garante o x-model
  // Botão de busca é ícone sem texto; espera habilitar e clica. Enter como reforço.
  const searchBtn = page.locator('button.msc-search-autocomplete__search');
  if ((await searchBtn.count().catch(() => 0)) > 0) {
    await searchBtn.click({ timeout: 5000 }).catch(() => undefined);
  }
  await input.press('Enter').catch(() => undefined);
  // Loader Alpine (isLoading) aparece e some quando os resultados populam.
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  return true;
}
