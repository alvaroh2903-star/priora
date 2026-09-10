import { Page } from 'playwright';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { PortalScraper, ScrapeContext } from './scraperTypes';
import { resolveTrackingUrl, resolveSearchRef } from './registry';
import { withPage, withRemotePage } from '../browser';
import { isSBConfigured, driveTrackingPage } from '../scrapingBrowser';
import { detectCaptcha, detectLogin } from './pageUtils';
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

/**
 * Scraper genérico UNIFICADO: navega + pilota com o MESMO motor do diagnóstico
 * (`driveTrackingPage`) — drivers dedicados (ShipmentLink/MSC), captura do JSON da
 * API interna, popup, expansores PIL/CMA e waitOutChallenge. Depois detecta login/
 * CAPTCHA e faz a extração ESTRUTURADA (dispatcher + `apiJson`). É o que garante
 * que o "botão" de produção use exatamente o que validamos no /health/scrape-sb.
 */
async function genericScrape(
  page: Page,
  ctx: ScrapeContext,
  sourceUrl: string,
): Promise<Partial<TrackingResult>> {
  const driven = await driveTrackingPage(page, { url: sourceUrl, reference: ctx.reference });

  const needsCaptcha = await detectCaptcha(page);
  const needsLogin = await detectLogin(page, driven.textContent);

  // Extração ESTRUTURADA multi-armador. `apiJson` (ex.: MSC) tem prioridade; senão,
  // o HTML de todos os frames (o resultado pode estar num iframe/popup).
  const events = extractCarrierEvents(driven.html, driven.apiJson);
  if (events.length > 0) {
    const containerHint =
      firstContainerNo(driven.html) || (ctx.referenceType === 'container' ? ctx.reference : null);
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
  const raw = driven.textContent.slice(0, 4000);
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
  // A ref DIGITADA no form pode diferir da original (ex.: Evergreen tira o EGLV).
  const ctx: ScrapeContext = { reference: resolveSearchRef(carrier, ref, type), referenceType: type, carrier };

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
      const specific = SCRAPERS[carrier.id];

      // Caminho do scraper ESPECÍFICO (ex.: Hapag): navega, tenta captcha e roda,
      // com 1 retry se o captcha persistir.
      if (specific) {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
        await solveCaptchaIfPresent(page, sourceUrl);
        let partial = await specific(page, ctx);
        if (partial.needsCaptcha) {
          const solved = await solveCaptchaIfPresent(page, sourceUrl);
          if (solved) {
            await page.waitForLoadState('networkidle').catch(() => undefined);
            partial = await specific(page, ctx);
          }
        }
        if (partial.needsCaptcha) {
          partial = {
            ...partial,
            message: isAntiCaptchaConfigured()
              ? 'Portal exigiu CAPTCHA e a resolução automática não teve sucesso (ver logs do anti-captcha).'
              : 'Portal exigiu CAPTCHA e não há serviço de resolução configurado (defina ANTICAPTCHA_KEY).',
          };
        }
        return { ...base, ...partial };
      }

      // Caminho GENÉRICO unificado: o driveTrackingPage cuida do goto + cookies +
      // anti-captcha + drivers dedicados (ShipmentLink/MSC) + captura de JSON.
      const partial = await genericScrape(page, ctx, sourceUrl);
      return { ...base, ...partial };
    });
  } catch (err) {
    return {
      ...base,
      message: `Falha ao consultar o portal: ${(err as Error).message}`,
    };
  }
}
