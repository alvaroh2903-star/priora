import { ContainerInfo, TrackingEvent } from './types';
import { classifyEvent } from './eventTypes';
import { deriveContainers } from './scrapers/hapag';

/**
 * Priora — Mapper do padrão DCSA (Track & Trace) → nosso modelo de eventos.
 *
 * A DCSA (Digital Container Shipping Association) padronizou a API de rastreio;
 * Maersk, Hapag, CMA, MSC, ONE, ZIM… seguem esse formato. Então ESTE mapper
 * serve para VÁRIOS armadores de uma vez — é o coração da normalização (o que
 * transforma "N armadores" numa API única, o valor do produto).
 *
 * Um evento DCSA tem, no essencial:
 *   eventType: TRANSPORT | EQUIPMENT | SHIPMENT
 *   eventDateTime: ISO
 *   eventClassifierCode: ACT (atual) | EST (estimado) | PLN (planejado)
 *   transportEventTypeCode: ARRI | DEPA
 *   equipmentEventTypeCode: LOAD | DISC | GTIN | GTOT | STUF | STRP | PICK | DROP
 *   equipmentReference: nº do contêiner
 *   eventLocation / location: { locationName / UNLocationCode }
 */

/** Rótulo legível de cada código DCSA (para o campo status). */
const EQUIPMENT_LABEL: Record<string, string> = {
  LOAD: 'Loaded on vessel',
  DISC: 'Discharged',
  GTIN: 'Gate in',
  GTOT: 'Gate out',
  STUF: 'Stuffed',
  STRP: 'Stripped',
  PICK: 'Empty picked up',
  DROP: 'Empty returned',
};
const TRANSPORT_LABEL: Record<string, string> = {
  ARRI: 'Vessel arrived',
  DEPA: 'Vessel departed',
};

interface DcsaEventLike {
  eventType?: string;
  eventDateTime?: string;
  eventCreatedDateTime?: string;
  eventClassifierCode?: string;
  transportEventTypeCode?: string;
  equipmentEventTypeCode?: string;
  equipmentReference?: string;
  emptyIndicatorCode?: string; // EMPTY | LADEN
  isoEquipmentCode?: string; // 45G1, 22G1…
  eventLocation?: Record<string, unknown>;
  location?: Record<string, unknown>;
  transportCall?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Extrai um nome de local de várias formas que os armadores usam. */
function locationOf(ev: DcsaEventLike): string | null {
  const loc = (ev.eventLocation || ev.location || {}) as Record<string, unknown>;
  const name =
    (loc.locationName as string) ||
    (loc.UNLocationName as string) ||
    (loc.UNLocationCode as string) ||
    (loc.cityName as string) ||
    null;
  return name ? String(name).trim() : null;
}

/** Data ISO (AAAA-MM-DD) do evento, ou null. */
function dateOf(ev: DcsaEventLike): string | null {
  const raw = ev.eventDateTime || ev.eventCreatedDateTime;
  if (!raw) return null;
  const m = String(raw).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Converte um evento DCSA em TrackingEvent (ou null se não der p/ classificar). */
function dcsaEventToTracking(ev: DcsaEventLike): TrackingEvent | null {
  const date = dateOf(ev);
  const eq = (ev.equipmentEventTypeCode || '').toUpperCase();
  const tr = (ev.transportEventTypeCode || '').toUpperCase();

  let status: string;
  if (eq) {
    // "Gate out" cheio = retirada; vazio = devolução — usa o emptyIndicator.
    if (eq === 'GTOT' && (ev.emptyIndicatorCode || '').toUpperCase() === 'EMPTY') {
      status = 'Empty returned';
    } else {
      status = EQUIPMENT_LABEL[eq] || eq;
    }
  } else if (tr) {
    status = TRANSPORT_LABEL[tr] || tr;
  } else {
    return null; // evento sem tipo útil
  }

  return {
    date,
    status,
    location: locationOf(ev),
    vessel: null,
    voyage: null,
    type: classifyEvent(status),
  };
}

/** Mapeia uma lista de eventos DCSA para TrackingEvent[] (só os ATUAIS por padrão). */
export function mapDcsaEvents(
  events: DcsaEventLike[],
  opts: { onlyActual?: boolean } = {},
): TrackingEvent[] {
  const onlyActual = opts.onlyActual !== false; // padrão: só eventos ACT (realizados)
  const out: TrackingEvent[] = [];
  for (const ev of events || []) {
    if (onlyActual && ev.eventClassifierCode && ev.eventClassifierCode.toUpperCase() !== 'ACT') {
      continue;
    }
    const te = dcsaEventToTracking(ev);
    if (te && te.date) out.push(te);
  }
  // Ordena por data (ascendente).
  out.sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  return out;
}

/** Nº do contêiner mais frequente nos eventos DCSA (heurística simples). */
export function containerFromDcsa(events: DcsaEventLike[]): string | null {
  for (const ev of events || []) {
    const ref = (ev.equipmentReference || '').toString().trim();
    if (/^[A-Z]{4}\d{7}$/.test(ref)) return ref;
  }
  return null;
}

/** Conveniência: eventos DCSA → { events, containers } prontos p/ o TrackingResult. */
export function dcsaToTracking(events: DcsaEventLike[]): {
  events: TrackingEvent[];
  containers: ContainerInfo[];
} {
  const mapped = mapDcsaEvents(events);
  const containers = deriveContainers(mapped, containerFromDcsa(events));
  return { events: mapped, containers };
}
