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

/**
 * Driver DEDICADO do formulário da Evergreen (ShipmentLink, TDB1_CargoTracking).
 *
 * A aba "Quick Tracking" (ativa por padrão) tem: radios name="SEL" (#s_bl / #s_cntr
 * / #s_bk = tipo de busca), UM input#NO visível e um <input type="button"
 * value="Submit"> cujo onclick seta os hidden (TYPE/BL/CNTR/bkno) e submete o form.
 * O preenchedor genérico não serve aqui: há 6 inputs name="NO" (5 escondidos da aba
 * "Multiple" antes do visível) e é preciso marcar o radio de tipo. Este driver
 * sempre busca por B/L (só a parte numérica — o registro já tira EGLV/EVGL).
 * Retorna true se preencheu e submeteu.
 */
export async function driveShipmentLinkForm(page: Page, ref: string): Promise<boolean> {
  const input = page.locator('input#NO');
  if ((await input.count().catch(() => 0)) === 0) return false;
  // 1) Seleciona busca por B/L (#s_bl) — sem isso o servlet busca por outro tipo
  //    e devolve "não encontrado".
  const blRadio = page.locator('#s_bl');
  if ((await blRadio.count().catch(() => 0)) > 0) {
    await blRadio.check({ timeout: 3000 }).catch(() => undefined);
  }
  // 2) Digita a B/L (parte numérica) no input visível.
  await input.first().fill(ref).catch(() => undefined);
  // 3) Clica o "Submit" visível (o da aba Multiple é escondido); senão, Enter.
  const submit = page.locator('input[type="button"][value="Submit" i]:visible').first();
  if ((await submit.count().catch(() => 0)) > 0) {
    await submit.click({ timeout: 5000 }).catch(() => undefined);
  } else {
    await input.first().press('Enter').catch(() => undefined);
  }
  // O form faz POST no mesmo servlet (sem target) → resultado na MESMA página.
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
  return true;
}
