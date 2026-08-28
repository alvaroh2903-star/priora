import { Page } from 'playwright';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { PortalScraper, ScrapeContext } from './scraperTypes';
import { resolveTrackingUrl } from './registry';
import { withPage, withRemotePage } from '../browser';
import { isSBConfigured } from '../scrapingBrowser';
import {
  acceptCookies,
  detectCaptcha,
  detectLogin,
  getBodyText,
  tryFillSearch,
} from './pageUtils';
import { scrapeHapag, deriveContainers, firstContainerNo } from './scrapers/hapag';
import { extractCarrierEvents } from './scrapers/dispatch';
import { solveCaptchaIfPresent } from '../antiCaptcha';
import { isAntiCaptchaConfigured } from '../../config';

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

/**
 * Decide se este armador roda no Scraping Browser (navegador remoto que fura
 * Cloudflare/SPA). Usa o remoto quando configurado, a não ser que o armador
 * esteja marcado `needsScrapingBrowser: false` (portal simples → navegador local,
 * mais barato). Sem Scraping Browser configurado, cai sempre no local.
 */
function shouldUseScrapingBrowser(carrier: CarrierMeta): boolean {
  return isSBConfigured() && carrier.needsScrapingBrowser !== false;
}

/** Scraper genérico: navega, detecta login/CAPTCHA, captura o texto renderizado. */
async function genericScrape(
  page: Page,
  ctx: ScrapeContext,
  usedDeepLink: boolean,
): Promise<Partial<TrackingResult>> {
  await acceptCookies(page);
  // Espera os resultados renderizarem (timeline Maersk, .hal-event, tabela…).
  await page
    .waitForSelector(
      '.transport-plan__list__item, [data-test="milestone"], .hal-event, table tr, [role="row"]',
      { timeout: 15000 },
    )
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);

  let body = await getBodyText(page);
  // Se a referência não apareceu (deep link não auto-buscou), preenche o form.
  if (!usedDeepLink || !body.toUpperCase().includes(ctx.reference.toUpperCase())) {
    if (await tryFillSearch(page, ctx.reference)) {
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await acceptCookies(page);
      await page.waitForTimeout(1500);
      body = await getBodyText(page);
    }
  }

  const needsCaptcha = await detectCaptcha(page);
  const needsLogin = await detectLogin(page, body);

  // Extração ESTRUTURADA multi-armador (dispatcher: Maersk, tabelas…) do DOM.
  const html = await page.content();
  const events = extractCarrierEvents(html);
  if (events.length > 0) {
    const containerHint =
      firstContainerNo(html) || (ctx.referenceType === 'container' ? ctx.reference : null);
    return {
      events,
      containers: deriveContainers(events, containerHint),
      needsCaptcha,
      needsLogin,
      ok: true,
      message: `${events.length} evento(s) extraído(s) do portal.`,
    };
  }

  // Sem estrutura reconhecida ainda: texto cru p/ a Clara + diagnóstico honesto.
  const raw = body.slice(0, 4000);
  const mentionsRef = raw.toUpperCase().includes(ctx.reference.toUpperCase());
  return {
    needsCaptcha,
    needsLogin,
    raw,
    ok: false,
    message: needsCaptcha
      ? 'Portal exigiu CAPTCHA (resolução entra na próxima etapa).'
      : needsLogin
      ? 'Portal exigiu login (autenticação entra na próxima etapa).'
      : mentionsRef
      ? 'Página carregada. Parser específico deste portal a implementar.'
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

  // Portais difíceis (Cloudflare/SPA) rodam no navegador remoto do Bright Data;
  // simples, no Chromium local. O corpo do scraper é o MESMO nos dois casos.
  const useRemote = shouldUseScrapingBrowser(carrier);
  const runner = useRemote ? withRemotePage : withPage;

  try {
    return await runner(async (page) => {
      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });

      // Anti-captcha (se configurado): tenta resolver um captcha logo na entrada.
      // No Scraping Browser o solver é do próprio Bright Data (redundante, inócuo).
      await solveCaptchaIfPresent(page, sourceUrl);

      const specific = SCRAPERS[carrier.id];
      const run = () =>
        specific ? specific(page, ctx) : genericScrape(page, ctx, usedDeepLink);

      let partial = await run();

      // Se o portal AINDA exige captcha, tenta resolver e roda o scraper 1x mais.
      if (partial.needsCaptcha) {
        const solved = await solveCaptchaIfPresent(page, sourceUrl);
        if (solved) {
          await page.waitForLoadState('networkidle').catch(() => undefined);
          partial = await run();
        }
      }

      // Mensagem final honesta quando o captcha persiste.
      if (partial.needsCaptcha) {
        partial = {
          ...partial,
          message: isAntiCaptchaConfigured()
            ? 'Portal exigiu CAPTCHA e a resolução automática não teve sucesso (ver logs do anti-captcha).'
            : 'Portal exigiu CAPTCHA e não há serviço de resolução configurado (defina ANTICAPTCHA_KEY).',
        };
      }

      return { ...base, ...partial };
    });
  } catch (err) {
    return {
      ...base,
      message: `Falha ao consultar o portal: ${(err as Error).message}`,
    };
  }
}
