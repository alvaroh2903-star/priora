import { Page } from 'playwright';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { resolveTrackingUrl } from './registry';
import { withPage } from '../browser';

/**
 * Priora — Scraper genérico dos portais de armadores (base plugável).
 *
 * Estratégia comum a todos os portais:
 *  1. Abre o deep link (quando conhecido) ou a página de rastreio.
 *  2. Se não houve deep link, tenta preencher o 1º input de busca com a
 *     referência e submeter.
 *  3. Detecta CAPTCHA e exigência de LOGIN (para o app decidir o próximo passo:
 *     resolver captcha / autenticar — próximas etapas).
 *  4. Captura o texto renderizado (fonte para extração estruturada por IA e
 *     para afinar os seletores específicos de cada portal depois).
 *
 * Scrapers específicos por armador vão sobrescrever a extração de `containers`
 * e `events`. Aqui entregamos uma base honesta: nada é inventado — o que não dá
 * para extrair volta null/vazio, com o texto bruto anexado para depuração.
 */

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
  'login',
  'entrar',
  'please log in',
  'session expired',
];

async function detectCaptcha(page: Page): Promise<boolean> {
  for (const sel of CAPTCHA_HINTS) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

async function detectLogin(page: Page, bodyText: string): Promise<boolean> {
  const hasPasswordField =
    (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (hasPasswordField) return true;
  const lower = bodyText.toLowerCase();
  return LOGIN_TEXT_HINTS.some((h) => lower.includes(h));
}

/** Tenta preencher o campo de busca e submeter (quando não há deep link). */
async function tryFillSearch(page: Page, ref: string): Promise<void> {
  const candidates = [
    'input[type="search"]',
    'input[name*="track" i]',
    'input[name*="number" i]',
    'input[name*="ref" i]',
    'input[id*="track" i]',
    'input[placeholder*="track" i]',
    'input[placeholder*="container" i]',
    'input[type="text"]',
  ];
  for (const sel of candidates) {
    const field = page.locator(sel).first();
    if ((await field.count().catch(() => 0)) > 0) {
      await field.fill(ref).catch(() => undefined);
      await field.press('Enter').catch(() => undefined);
      return;
    }
  }
}

/**
 * Executa o scraper genérico de um armador para uma referência.
 * Roda dentro de um contexto Playwright próprio (com proxy, se configurado).
 */
export async function scrapeCarrier(
  carrier: CarrierMeta,
  ref: string,
  type: ReferenceType,
): Promise<TrackingResult> {
  const sourceUrl = resolveTrackingUrl(carrier, ref, type);
  const usedDeepLink = sourceUrl !== carrier.trackingUrl;

  const base: TrackingResult = {
    carrierId: carrier.id,
    carrierName: carrier.name,
    reference: ref,
    referenceType: type,
    sourceUrl,
    ok: false,
    needsLogin: false,
    needsCaptcha: false,
    containers: [],
    events: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    return await withPage(async (page) => {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
      // Dá um tempo para SPAs renderizarem os resultados.
      await page.waitForLoadState('networkidle').catch(() => undefined);

      if (!usedDeepLink) {
        await tryFillSearch(page, ref);
        await page.waitForLoadState('networkidle').catch(() => undefined);
      }

      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      const needsCaptcha = await detectCaptcha(page);
      const needsLogin = await detectLogin(page, bodyText);

      const raw = bodyText.replace(/\s+/g, ' ').trim().slice(0, 4000);
      const mentionsRef = raw.toUpperCase().includes(ref.toUpperCase());

      return {
        ...base,
        needsCaptcha,
        needsLogin,
        raw,
        // Sem os seletores específicos do portal ainda não montamos containers/
        // events estruturados; ok=true apenas sinaliza que a página respondeu e
        // cita a referência (sem login/captcha travando).
        ok: mentionsRef && !needsLogin && !needsCaptcha,
        message: needsCaptcha
          ? 'Portal exigiu CAPTCHA (resolução de captcha entra na próxima etapa).'
          : needsLogin
          ? 'Portal exigiu login (autenticação entra na próxima etapa).'
          : mentionsRef
          ? 'Página carregada. Extração estruturada por portal a implementar.'
          : 'Página carregada, mas a referência não apareceu (verificar deep link/seletores).',
      };
    });
  } catch (err) {
    return {
      ...base,
      message: `Falha ao consultar o portal: ${(err as Error).message}`,
    };
  }
}
