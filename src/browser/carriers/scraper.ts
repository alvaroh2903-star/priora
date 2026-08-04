import { Page } from 'playwright';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { PortalScraper, ScrapeContext } from './scraperTypes';
import { resolveTrackingUrl } from './registry';
import { withPage } from '../browser';
import {
  acceptCookies,
  detectCaptcha,
  detectLogin,
  getBodyText,
  tryFillSearch,
} from './pageUtils';
import { scrapeHapag } from './scrapers/hapag';

/**
 * Priora — Despacho de scraping dos portais de armadores.
 *
 * Cada armador pode ter um scraper específico (extração estruturada de eventos/
 * datas). Sem scraper específico, cai no genérico: abre a página, detecta login/
 * CAPTCHA e captura o texto bruto — base honesta, sem inventar dados.
 */

/** Scrapers específicos por armador (vão crescendo conforme afinamos cada um). */
const SCRAPERS: Record<string, PortalScraper> = {
  hapag: scrapeHapag,
};

/** Scraper genérico: navega, detecta login/CAPTCHA, captura o texto renderizado. */
async function genericScrape(
  page: Page,
  ctx: ScrapeContext,
  usedDeepLink: boolean,
): Promise<Partial<TrackingResult>> {
  await acceptCookies(page);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  if (!usedDeepLink) {
    await tryFillSearch(page, ctx.reference);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await acceptCookies(page);
  }

  const body = await getBodyText(page);
  const needsCaptcha = await detectCaptcha(page);
  const needsLogin = await detectLogin(page, body);
  const raw = body.slice(0, 4000);
  const mentionsRef = raw.toUpperCase().includes(ctx.reference.toUpperCase());

  return {
    needsCaptcha,
    needsLogin,
    raw,
    ok: mentionsRef && !needsLogin && !needsCaptcha,
    message: needsCaptcha
      ? 'Portal exigiu CAPTCHA (resolução entra na próxima etapa).'
      : needsLogin
      ? 'Portal exigiu login (autenticação entra na próxima etapa).'
      : mentionsRef
      ? 'Página carregada. Scraper específico deste portal a implementar.'
      : 'Página carregada, mas a referência não apareceu (verificar deep link/seletores).',
  };
}

/**
 * Executa o scraper de um armador para uma referência. Roda dentro de um
 * contexto Playwright próprio (com proxy, se configurado) que é fechado ao fim.
 */
export async function scrapeCarrier(
  carrier: CarrierMeta,
  ref: string,
  type: ReferenceType,
): Promise<TrackingResult> {
  const sourceUrl = resolveTrackingUrl(carrier, ref, type);
  const usedDeepLink = sourceUrl !== carrier.trackingUrl;
  const ctx: ScrapeContext = { reference: ref, referenceType: type, carrier };

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

      const specific = SCRAPERS[carrier.id];
      const partial = specific
        ? await specific(page, ctx)
        : await genericScrape(page, ctx, usedDeepLink);

      return { ...base, ...partial };
    });
  } catch (err) {
    return {
      ...base,
      message: `Falha ao consultar o portal: ${(err as Error).message}`,
    };
  }
}
