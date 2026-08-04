import { CARRIERS, getCarrier, resolveTrackingUrl } from './registry';
import { detectCarrier, classifyReference, normalizeRef, isValidContainer } from './detect';
import { scrapeCarrier } from './scraper';
import { CarrierMeta, ReferenceType, TrackingResult } from './types';

/**
 * Priora — Fachada do bot de armadores (usada pelas rotas).
 * Junta registro + detecção + scraping numa API simples.
 */

export { CARRIERS, getCarrier, detectCarrier, classifyReference, normalizeRef, isValidContainer };
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
}

/**
 * Rastreia uma referência: detecta o armador (ou usa o forçado), resolve a URL
 * e roda o scraper. Lança erro legível quando não dá para identificar o armador.
 */
export async function trackShipment(
  input: string,
  opts: TrackOptions = {},
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

  return scrapeCarrier(carrier, reference, referenceType);
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
