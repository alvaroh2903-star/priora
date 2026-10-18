import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { resolveTrackingUrl, resolveSearchRef } from './registry';
import { scrapflyScrape, getScrapflyKey, ScrapflyScrapeResult } from '../scrapflyApi';
import { extractCarrierEvents } from './scrapers/dispatch';
import { deriveContainers, firstContainerNo } from './scrapers/hapag';
import { detectMaintenance, maintenanceMessage } from './maintenance';

/**
 * Priora — Raspagem pela API de SCRAPE da Scrapfly (ASP), para os armadores
 * marcados com `fetchVia: 'scrapfly_api'` no registro.
 *
 * Por que existe: na ZIM o navegador remoto vencia o desafio do Akamai e depois
 * era barrado com repetição; a API de Scrape com ASP trouxe o histórico completo
 * mesmo depois de várias consultas no dia (10/10: 16 eventos, 260 créditos,
 * 75 s). A navegação inteira acontece do lado da Scrapfly — aqui só montamos a
 * URL/cenário e passamos o HTML pelos MESMOS parsers da produção.
 */

const MAX_ATTEMPTS = 3;
const SHIELD_RETRY_DELAY_MS = 8_000;
/** Mesmo pool residencial do Cloud Browser (ver scrapingBrowser.ts). */
const RESIDENTIAL_POOL = (process.env.SCRAPE_RESIDENTIAL_POOL || 'public_residential_pool').trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Falha do escudo anti-bot do ASP (422 ERR::ASP::*) — a Scrapfly pede nova tentativa. */
export function isShieldFailure(error: string | null | undefined): boolean {
  return /ERR::ASP::|SHIELD_PROTECTION|unable to bypass/i.test(error || '');
}

/** Cenário (js_scenario) por armador — preencher/clicar quando não há link direto. */
export function scrapflyScenario(carrierId: string, searchRef: string): { url?: string; steps?: unknown[] } {
  if (carrierId === 'cmacgm') {
    return {
      url: 'https://www.cma-cgm.com/ebusiness/tracking/search',
      // Tetos da Scrapfly por etapa: wait_for_selector 15 s, wait_for_navigation 10 s.
      steps: [
        { wait_for_selector: { selector: '#Reference', timeout: 15000 } },
        { fill: { selector: '#Reference', value: searchRef, clear: true } },
        { wait: 800 },
        { click: { selector: '#btnTracking' } },
        { wait_for_navigation: { timeout: 10000 } },
        { wait: 3000 },
        // O resultado mostra só o ÚLTIMO movimento (visto ao vivo em 10/10:
        // HPCU5300140, "Gate in empty at Depot"); a descarga está no histórico,
        // atrás do "Display Previous Moves" da linha do contêiner (grid Kendo).
        { click: { selector: 'a[aria-label="Display Previous Moves"]', ignore_if_not_visible: true } },
        { wait: 2500 },
      ],
    };
  }
  if (carrierId === 'zim') {
    // Link direto ?consnumber= já busca. Visto em 10/10: às vezes a página vem,
    // mas a chamada interna dos dados leva "Please try again" (o Akamai barra só
    // ela). Como uma pessoa faria: espera e, se aparecer, busca de novo — com os
    // cookies do Akamai já validados pela página.
    const retry =
      "if((document.body.innerText||'').includes('Please try again')){var b=document.querySelector('.chips-search-button');if(b)b.click();}";
    return {
      steps: [
        { wait: 6000 },
        { execute: { script: retry, timeout: 3000 } },
        { wait: 8000 },
        { execute: { script: retry, timeout: 3000 } },
        { wait: 8000 },
      ],
    };
  }
  return {};
}

export function canUseScrapflyApi(carrier: CarrierMeta): boolean {
  return carrier.fetchVia === 'scrapfly_api' && Boolean(getScrapflyKey());
}

export async function scrapeViaScrapflyApi(
  carrier: CarrierMeta,
  ref: string,
  type: ReferenceType,
): Promise<TrackingResult> {
  const searchRef = resolveSearchRef(carrier, ref, type);
  const scen = scrapflyScenario(carrier.id, searchRef);
  const url = scen.url || resolveTrackingUrl(carrier, ref, type);
  const base: TrackingResult = {
    carrierId: carrier.id,
    carrierName: carrier.name,
    reference: ref,
    referenceType: type,
    sourceUrl: url,
    ok: false,
    needsLogin: false,
    needsCaptcha: false,
    containers: [],
    events: [],
    fetchedAt: new Date().toISOString(),
  };

  // Até 3 tentativas: o ASP às vezes devolve 422 numa e passa na seguinte (visto
  // na ZIM em 10/10). Cada tentativa é uma sessão nova do lado da Scrapfly.
  let r: ScrapflyScrapeResult | null = null;
  let spent = 0;
  let residential = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    r = await scrapflyScrape({
      url,
      jsScenario: scen.steps,
      renderingWait: scen.steps ? undefined : 8000,
      timeoutMs: 150_000,
      proxyPool: residential ? RESIDENTIAL_POOL : undefined,
    });
    spent += r.cost || 0;
    if (r.ok && extractCarrierEvents(r.html).length > 0) break;
    if (r.ok && detectMaintenance(r.html.replace(/<[^>]+>/g, ' '))) break;
    // Escudo do anti-bot não vencido (visto na ZIM em 18/10, as 2 tentativas em
    // sequência: "Unable to bypass akamai, please retry in few seconds"): espera
    // uns segundos, como a própria Scrapfly pede, e troca para o pool RESIDENCIAL
    // (IP de reputação melhor — mais caro, por isso só depois de uma falha).
    if (!r.ok && attempt < MAX_ATTEMPTS && isShieldFailure(r.error)) {
      residential = true;
      await sleep(SHIELD_RETRY_DELAY_MS);
    }
  }
  if (!r || !r.ok) {
    return {
      ...base,
      message: `API da Scrapfly (ASP) não trouxe a página: ${r?.error || 'sem resposta'} (${spent} créditos).`,
    };
  }
  const events = extractCarrierEvents(r.html);
  if (events.length === 0) {
    const maint = detectMaintenance(r.html.replace(/<[^>]+>/g, ' '));
    if (maint) return { ...base, portalMaintenance: maint, message: maintenanceMessage(maint) };
    return {
      ...base,
      // Texto cru p/ a camada de IA (mesma regra do caminho do navegador).
      raw: r.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 30000),
      message: `Página obtida pela API da Scrapfly (ASP, ${spent} créditos), mas o parser não reconheceu o resultado.`,
    };
  }
  const containerHint = firstContainerNo(r.html) || (type === 'container' ? ref : null);
  return {
    ...base,
    ok: true,
    events,
    containers: deriveContainers(events, containerHint),
    message: `${events.length} evento(s) via API da Scrapfly (ASP, ${spent} créditos).`,
  };
}
