import { CARRIERS, getCarrier, resolveTrackingUrl, resolveSearchRef } from './registry';
import { detectCarrier, classifyReference, normalizeRef, isValidContainer } from './detect';
import { scrapeCarrier } from './scraper';
import { hasApiSource, fetchViaApi } from './apiSources';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';
import { extractEventsViaAI } from './aiExtract';
import { deriveContainers } from './scrapers/hapag';
import { dropFutureEvents } from './estimates';

/**
 * Priora — Fachada do bot de armadores (usada pelas rotas).
 * Junta registro + detecção + scraping numa API simples.
 */

export { CARRIERS, getCarrier, detectCarrier, classifyReference, normalizeRef, isValidContainer, resolveSearchRef };
export type { CarrierMeta, ReferenceType, TrackingResult };

/** Lista enxuta dos armadores suportados (para a UI). */
export function listCarriers() {
  return CARRIERS.map((c) => ({
    id: c.id,
    name: c.name,
    trackingUrl: c.trackingUrl,
    hasDeepLink: Boolean(c.buildTrackingUrl),
    needsLoginForDemurrage: c.needsLoginForDemurrage,
    containerPrefixes: c.containerPrefixes,
    scac: c.scac,
    notes: c.notes,
  }));
}

export interface TrackOptions {
  /** Força um armador específico (ignora a autodetecção). */
  carrierId?: string;
  /** Informa o tipo da referência (senão é inferido). */
  referenceType?: ReferenceType;
  /**
   * CAMADA DE RESILIÊNCIA (IA): quando o parser dedicado não reconhece o layout,
   * a Clara lê o texto cru e extrai os eventos. Default LIGADO (produção não quebra
   * se o portal mudar). `false` desliga (ex.: diagnóstico do parser puro, `&ai=0`).
   */
  aiFallback?: boolean;
}

/**
 * Rastreia uma referência: detecta o armador (ou usa o forçado), resolve a URL
 * e roda o scraper. Lança erro legível quando não dá para identificar o armador.
 */
export async function trackShipment(
  input: string,
  opts: TrackOptions = {},
): Promise<TrackingResult> {
  const result = await trackShipmentRaw(input, opts);
  // Saída ÚNICA de todos os caminhos (scraping, IA, API oficial): previsão (evento
  // com data futura) não é fato e não sai daqui — ver carriers/estimates.
  return { ...result, events: dropFutureEvents(result.events || []) };
}

async function trackShipmentRaw(
  input: string,
  opts: TrackOptions,
): Promise<TrackingResult> {
  const reference = normalizeRef(input);
  if (!reference) throw new Error('Informe uma referência (contêiner, BL ou booking).');

  let carrier: CarrierMeta | undefined;
  let referenceType: ReferenceType = opts.referenceType || classifyReference(reference);

  if (opts.carrierId) {
    carrier = getCarrier(opts.carrierId);
    if (!carrier) throw new Error(`Armador desconhecido: ${opts.carrierId}`);
  } else {
    const det = detectCarrier(reference);
    carrier = det.carrier || undefined;
    if (!opts.referenceType) referenceType = det.referenceType;
  }

  if (!carrier) {
    throw new Error(
      `Não identifiquei o armador da referência "${reference}". Informe o armador manualmente (carrierId).`,
    );
  }

  // Estratégia HÍBRIDA (scraping + API oficial):
  // 1) apiFirst (portal bloqueia scraping, mas há API — ex.: Maersk) → tenta API antes.
  if (carrier.apiFirst && hasApiSource(carrier.id)) {
    const viaApi = await fetchViaApi(carrier, reference, referenceType).catch(() => null);
    if (viaApi && viaApi.ok) return viaApi;
  }
  // 2) Caminho primário: scraping (cobertura/tração).
  const scraped = await scrapeCarrier(carrier, reference, referenceType);
  if (scraped.ok && scraped.events.length > 0) return scraped;

  // 2b) CAMADA DE RESILIÊNCIA (IA): o parser dedicado não reconheceu o layout
  // (portal mudou, ou armador sem parser). A Clara lê o TEXTO CRU já raspado e
  // extrai os eventos — adapta-se a QUALQUER layout sem mexer no código. Roda AQUI
  // (navegador JÁ FECHADO → não gasta crédito Scrapfly) e passa pelo MESMO pipeline
  // validado (deriveContainers) dos parsers dedicados. É o que evita "API em
  // manutenção" quando um armador troca o site.
  if (opts.aiFallback !== false && scraped.events.length === 0 && scraped.raw && !scraped.portalMaintenance) {
    let aiEvents: TrackingResult['events'] = [];
    let aiError: string | null = null;
    try {
      aiEvents = await extractEventsViaAI(carrier.name, reference, scraped.raw);
    } catch (err) {
      aiError = (err as Error).message; // schema/quota/timeout do Gemini — fica visível no aiDiag
    }
    const aiDiag = {
      tried: true,
      rawLen: scraped.raw.length,
      events: aiEvents.length,
      error: aiError,
    };
    if (aiEvents.length > 0) {
      const containerHint = referenceType === 'container' ? reference : null;
      return {
        ...scraped,
        ok: true,
        organizedByAI: true,
        aiDiag,
        events: aiEvents,
        containers: deriveContainers(aiEvents, containerHint),
        message: `${aiEvents.length} evento(s) recuperado(s) pela IA (o layout do portal não bateu com o parser dedicado — camada de resiliência). Reafinar o parser quando der.`,
      };
    }
    // Tentou e não achou (ou erro): carimba o diagnóstico p/ depuração e segue.
    scraped.aiDiag = aiDiag;
  }

  // 3) Fallback: se nada trouxe dados e há API oficial, tenta a API.
  if (scraped.ok) return scraped;
  if (!carrier.apiFirst && hasApiSource(carrier.id)) {
    const viaApi = await fetchViaApi(carrier, reference, referenceType).catch(() => null);
    if (viaApi && viaApi.ok) return viaApi;
  }
  return scraped;
}

/** Só a detecção (sem browser) — útil para a UI sugerir o armador ao digitar. */
export function detect(input: string) {
  const det = detectCarrier(input);
  const trackingUrl = det.carrier
    ? resolveTrackingUrl(det.carrier, det.reference, det.referenceType)
    : null;
  return {
    reference: det.reference,
    referenceType: det.referenceType,
    isValidContainer: isValidContainer(det.reference),
    matchedBy: det.matchedBy,
    carrier: det.carrier
      ? { id: det.carrier.id, name: det.carrier.name, trackingUrl }
      : null,
  };
}
