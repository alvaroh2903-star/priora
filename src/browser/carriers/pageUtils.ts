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

/** Aceita o banner de cookies, se houver (best-effort, não falha). */
export async function acceptCookies(page: Page): Promise<void> {
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    const btn = page.locator(sel).first();
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.click({ timeout: 3000 }).catch(() => undefined);
      return;
    }
  }
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
  'a:has-text("Track")',
  'a:has-text("Trace")',
  'input[type="submit"]',
  'button[type="submit"]',
  'input[value*="Search" i]',
  'input[value*="Track" i]',
  '[onclick*="track" i]',
  '[onclick*="search" i]',
];

/** Preenche+submete a busca DENTRO de um frame específico (best-effort). */
async function fillSearchInFrame(frame: Frame, ref: string): Promise<boolean> {
  for (const sel of SEARCH_FIELD_CANDIDATES) {
    const field = frame.locator(sel).first();
    if ((await field.count().catch(() => 0)) === 0) continue;
    // Pula campos readonly/desabilitados (ex.: o dropdown de tipo do Ant, que é
    // um input[type=search] readonly) — digitar neles não faz a busca.
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
