import { config } from '../config';
import { TrackingResult } from '../tracking/types';

/** Indica se a DHL está configurada (API Key). */
export function isDhlConfigured(): boolean {
  return Boolean(config.dhl.apiKey);
}

function fmtLocation(loc: any): string | null {
  const a = loc?.address;
  if (!a) return null;
  const parts = [a.addressLocality, a.countryCode].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Normaliza a resposta do DHL Unified Tracking para o formato comum. */
function normalize(json: any, trackingNumber: string): TrackingResult {
  const base: TrackingResult = {
    trackingNumber,
    carrier: 'DHL',
    found: false,
    status: null,
    statusCode: null,
    location: null,
    destination: null,
    estimatedDelivery: null,
    events: [],
    error: null,
  };

  const shipment = json?.shipments?.[0];
  if (!shipment) {
    base.error =
      json?.detail || json?.title || 'Sem dados de rastreio para este número.';
    return base;
  }

  const st = shipment.status || {};
  base.found = true;
  base.status = st.description || st.status || null;
  base.statusCode = st.statusCode || null;
  base.location = fmtLocation(st.location);
  // Destino final: a DHL Unified Tracking devolve shipment.destination.
  base.destination = fmtLocation(shipment.destination);
  base.estimatedDelivery = shipment.estimatedTimeOfDelivery || null;
  base.events = (shipment.events || []).slice(0, 8).map((e: any) => ({
    time: e.timestamp || '',
    description: e.description || e.status || '',
    location: fmtLocation(e.location),
  }));

  return base;
}

/** Rastreia um número na DHL (Unified Shipment Tracking API). */
export async function trackNumber(
  trackingNumber: string,
): Promise<TrackingResult> {
  if (!isDhlConfigured()) {
    throw new Error('DHL não configurada. Defina DHL_API_KEY no servidor.');
  }
  const url = `${config.dhl.baseUrl}/track/shipments?trackingNumber=${encodeURIComponent(
    trackingNumber,
  )}`;
  const res = await fetch(url, {
    headers: {
      'DHL-API-Key': config.dhl.apiKey,
      Accept: 'application/json',
    },
  });

  const json: any = await res.json().catch(() => ({}));
  // 404 = número não encontrado (não é erro de sistema) -> found:false com detalhe.
  if (res.status === 404) {
    return normalize(json, trackingNumber);
  }
  if (!res.ok) {
    const msg = json?.detail || json?.title || `HTTP ${res.status}`;
    throw new Error(`DHL track falhou: ${msg}`);
  }
  return normalize(json, trackingNumber);
}
