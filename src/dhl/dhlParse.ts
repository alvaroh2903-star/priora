import { TrackingResult } from '../tracking/types';

function fmtLocation(loc: any): string | null {
  const a = loc?.address;
  if (!a) return null;
  // O site já manda "CIDADE - ESTADO - PAÍS" (ex.: "ITAJAI - SANTA CATARINA -
  // BRAZIL", 18/10/2026): o código do país no fim só repetia — e nem sempre
  // bate (a entrega em Blumenau veio "KRAILLING - Bavaria - GERMANY" com "BR").
  // Mostra o texto da DHL como veio.
  if (typeof a.addressLocality === 'string' && / - /.test(a.addressLocality)) return a.addressLocality;
  const parts = [a.addressLocality, a.countryCode].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Normaliza a resposta do DHL Unified Tracking para o formato comum. */
export function normalize(json: any, trackingNumber: string): TrackingResult {
  const base: TrackingResult = {
    trackingNumber,
    carrier: 'DHL',
    found: false,
    status: null,
    statusCode: null,
    location: null,
    origin: null,
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
  // Origem e destino final: a DHL Unified Tracking devolve shipment.origin/destination.
  base.origin = fmtLocation(shipment.origin);
  base.destination = fmtLocation(shipment.destination);
  base.estimatedDelivery = shipment.estimatedTimeOfDelivery || null;
  base.events = (shipment.events || []).slice(0, 40).map((e: any) => ({
    time: e.timestamp || '',
    description: e.description || e.status || '',
    location: fmtLocation(e.location),
  }));

  return base;
}
