import { Page } from 'playwright';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { PortalScraper, ScrapeContext } from './scraperTypes';
import { resolveTrackingUrl, resolveSearchRef } from './registry';
import { withPage, withRemotePage } from '../browser';
import { isSBConfigured, driveTrackingPage } from '../scrapingBrowser';
import { detectCaptcha, detectLogin } from './pageUtils';
import { deriveContainers, firstContainerNo } from './scrapers/hapag';
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

/**
 * Scrapers ESPECÍFICOS por armador (raro). Hoje vazio: até a Hapag usa o motor
 * genérico (driveTrackingPage), que tem `waitOutChallenge` (essencial p/ o
 * Cloudflare interativo da Hapag) + retry + bloqueio de recursos. O parser da
 * Hapag já é o fallback do dispatch (extractCarrierEvents). Um scraper próprio só
 * entra aqui se algum portal precisar de um fluxo que o genérico não cobre.
 */
const SCRAPERS: Record<string, PortalScraper> = {};

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
  // NÃO dizemos "exigiu login": o rastreio dos armadores é PÚBLICO (free time/
  // tarifa vêm do e-mail). Um campo de senha na página é o widget de login de
  // MEMBRO, não uma parede — reportá-lo como login confunde (ex.: Yang Ming). O
  // `needsLogin` fica só como flag. Vazio sem captcha = provável bloqueio
  // temporário/rate-limit → o scrapeCarrier tenta de novo numa sessão nova.
  return {
    needsCaptcha,
    needsLogin,
    raw,
    ok: false,
    message: needsCaptcha
      ? 'Portal exigiu CAPTCHA (resolução entra na próxima etapa).'
      : mentionsRef
      ? 'Página carregada. Parser específico deste portal a implementar.'
      : 'Página carregada, mas sem resultados — provável bloqueio temporário/rate-limit (nova tentativa recomendada).',
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

  // EFICIÊNCIA (crédito Scrapfly): armadores com scraping SABIDAMENTE bloqueado
  // (DataDome/CargoSmart/hCaptcha-em-React) NÃO abrem sessão no navegador remoto —
  // retornam na hora um resultado claro "use API". O diagnóstico ignora este flag.
  if (carrier.scrapeBlocked) {
    return {
      ...base,
      needsCaptcha: true,
      message:
        'Scraping bloqueado por anti-bot comportamental neste portal — integração via API oficial (não gasta crédito de navegador).',
    };
  }

  // Portais difíceis (Cloudflare/SPA) rodam no navegador remoto do Bright Data;
  // simples, no Chromium local. O corpo do scraper é o MESMO nos dois casos.
  const useRemote = shouldUseScrapingBrowser(carrier);
  const runner = useRemote ? withRemotePage : withPage;
  const specific = SCRAPERS[carrier.id];

  try {
    // Caminho do scraper ESPECÍFICO (ex.: Hapag): navega, tenta captcha e roda,
    // com 1 retry se o captcha persistir.
    if (specific) {
      return await runner(async (page) => {
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
      });
    }

    // Caminho GENÉRICO: até 2 tentativas, cada uma numa SESSÃO NOVA (IP/fingerprint
    // novo do Scrapfly). Só REINTENTA quando o resultado parece TRANSITÓRIO (veio
    // vazio, sem captcha) — bloqueio temporário/rate-limit costuma ceder com IP
    // novo (foi o caso da Yang Ming). Sucesso OU parede de captcha param na hora,
    // sem gastar sessão extra (economia de crédito).
    const maxAttempts = 2;
    let partial: Partial<TrackingResult> = {};
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      partial = await runner(async (page) => genericScrape(page, ctx, sourceUrl));
      if (partial.ok || partial.needsCaptcha) break;
    }
    return { ...base, ...partial };
  } catch (err) {
    return {
      ...base,
      message: `Falha ao consultar o portal: ${(err as Error).message}`,
    };
  }
}
