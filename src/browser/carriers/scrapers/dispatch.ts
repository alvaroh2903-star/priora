import { TrackingEvent } from '../types';
import { extractEventsFromHtml as extractHapagOrGeneric } from './hapag';
import { extractMaerskEvents } from './maersk';
import { extractOneEvents } from './one';
import { extractCoscoEvents } from './cosco';
import { extractPilEvents } from './pil';
import { extractOoclEvents } from './oocl';

/**
 * Priora — Dispatcher multi-armador de extração de eventos.
 *
 * Escolhe o parser certo pela "assinatura" do DOM de cada portal (cada armador
 * desenha do seu jeito). É aqui que se PLUGA um armador novo: 1) escreve o
 * `extractXxxEvents` no seu arquivo; 2) adiciona um `if` de assinatura aqui.
 * O fluxo (scrape-sb, pipeline de produção) chama SÓ esta função.
 */
export function extractCarrierEvents(html: string): TrackingEvent[] {
  // Maersk — transport plan (<li class="transport-plan__list__item">).
  if (/transport-plan__list__item/i.test(html)) {
    const m = extractMaerskEvents(html);
    if (m.length) return m;
  }
  // ONE — tabela React (EventTable_table-row / EventTable_terminal-name).
  if (/EventTable_table-row/i.test(html)) {
    const o = extractOneEvents(html);
    if (o.length) return o;
  }
  // OOCL — SCCT em pbcontroltower.digital.oocl.com (mesmo grupo da COSCO, mas
  // LAYOUT DIFERENTE: Event|Time|Location|Stage|Transport). Checado ANTES da COSCO
  // porque ambos podem ter id="scct" — a OOCL tem seu parser próprio.
  if (/oocl|pbcontroltower/i.test(html)) {
    const oo = extractOoclEvents(html);
    if (oo.length) return oo;
  }
  // COSCO — app SCCT (id="scct"): tabela "Transport Detail" com 1 linha/contêiner.
  if (/id=["']scct["']|scct\/assets|CargoTrackingTransportDetail/i.test(html)) {
    const c = extractCoscoEvents(html);
    if (c.length) return c;
  }
  // PIL — "Container T&T" (a.trackinfo / container_info_sub): 1 linha/contêiner.
  if (/container_info_sub|trackinfo/i.test(html)) {
    const p = extractPilEvents(html);
    if (p.length) return p;
  }
  // Hapag (timeline .hal-event) → tabela genérica <tr>/<td> / grade ARIA.
  return extractHapagOrGeneric(html);
}
