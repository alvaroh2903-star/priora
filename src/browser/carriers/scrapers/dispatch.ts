import { TrackingEvent } from '../types';
import { extractEventsFromHtml as extractHapagOrGeneric } from './hapag';
import { extractMaerskEvents } from './maersk';
import { extractOneEvents } from './one';
import { extractCoscoEvents } from './cosco';
import { extractPilEvents } from './pil';
import { extractOoclEvents } from './oocl';
import { extractCmaEvents } from './cma';
import { extractHmmEvents } from './hmm';
import { extractEvergreenEvents } from './evergreen';
import { extractMscEvents } from './msc';
import { extractYangMingEvents, extractYangMingDetailEvents, isYangMingDetailPage } from './yangming';

/**
 * Priora — Dispatcher multi-armador de extração de eventos.
 *
 * Escolhe o parser certo pela "assinatura" do DOM de cada portal (cada armador
 * desenha do seu jeito). É aqui que se PLUGA um armador novo: 1) escreve o
 * `extractXxxEvents` no seu arquivo; 2) adiciona um `if` de assinatura aqui.
 * O fluxo (scrape-sb, pipeline de produção) chama SÓ esta função.
 *
 * `apiJson` (opcional): JSON estruturado capturado da API interna do portal
 * (ex.: MSC). Quando presente e reconhecido, tem PRIORIDADE sobre o HTML — é a
 * fonte mais limpa/robusta ("nossa própria API").
 */
export function extractCarrierEvents(html: string, apiJson?: string): TrackingEvent[] {
  // MSC — JSON da API interna (Data.BillOfLadings[].ContainersInfo[].Events[]).
  // Preferido ao DOM Alpine, que é só template.
  if (apiJson) {
    const m = extractMscEvents(apiJson);
    if (m.length) return m;
  }
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
  // CMA CGM — "Tracking details" (Date|Moves|Location|Vessel), sem captcha.
  if (/cma[-\s]?cgm/i.test(html)) {
    const cm = extractCmaEvents(html);
    if (cm.length) return cm;
  }
  // HMM — Track & Trace (#shipmentProgress: Date|Time|Location|Status|Mode).
  if (/hmm21|id="shipmentProgress"|id="thisCntr"/i.test(html)) {
    const h = extractHmmEvents(html);
    if (h.length) return h;
  }
  // Evergreen (ShipmentLink) — tabela de contêineres (Current Status + Date).
  if (/shipmentlink|TDB1_CargoTracking/i.test(html)) {
    const eg = extractEvergreenEvents(html);
    if (eg.length) return eg;
  }
  // Yang Ming (Next.js) — tabela "Container Status" (grade react-aria): 1 linha/
  // contêiner com o ÚLTIMO evento. Assinatura: yangming / cargo_tracking_detail.
  if (/yangming|cargo_tracking_detail/i.test(html)) {
    // Página de DETALHE (histórico DCSA completo) tem prioridade sobre o resumo.
    if (isYangMingDetailPage(html)) {
      const det = extractYangMingDetailEvents(html);
      if (det.length) return det;
    }
    const ym = extractYangMingEvents(html);
    if (ym.length) return ym;
  }
  // Hapag (timeline .hal-event) → tabela genérica <tr>/<td> / grade ARIA.
  return extractHapagOrGeneric(html);
}

/** Página de detalhe de UM contêiner (ver carriers/detailCollectors). */
export interface DetailHtml {
  container: string | null;
  html: string;
}

/**
 * Eventos do resumo + das páginas de DETALHE por contêiner.
 *
 * O resumo de vários portais traz só o ÚLTIMO evento por contêiner; o detalhe
 * traz o histórico inteiro (é onde aparece a descarga). Regras:
 *  - contêiner COM detalhe → vale o histórico do detalhe (o último evento do
 *    resumo já está lá dentro);
 *  - contêiner sem detalhe (teto de contêineres, falha ao abrir) → segue com o
 *    evento do resumo — nada se perde;
 *  - todo evento de detalhe herda o nº do contêiner da página (as linhas do
 *    detalhe não o repetem) e, se faltar, o tipo (40HQ…) que o resumo mostrou.
 */
export function extractEventsWithDetails(
  html: string,
  apiJson?: string,
  details?: DetailHtml[],
): TrackingEvent[] {
  const summary = extractCarrierEvents(html, apiJson);
  if (!details || details.length === 0) return summary;

  const tipoBy = new Map<string, string>();
  for (const e of summary) if (e.container && e.tipo) tipoBy.set(e.container, e.tipo);

  const fromDetails: TrackingEvent[] = [];
  const covered = new Set<string>();
  for (const d of details) {
    const evs = isYangMingDetailPage(d.html)
      ? extractYangMingDetailEvents(d.html, d.container)
      : extractCarrierEvents(d.html);
    for (const e of evs) {
      const container = e.container || d.container;
      fromDetails.push({ ...e, container, tipo: e.tipo || (container ? tipoBy.get(container) ?? null : null) });
    }
    if (evs.length > 0 && d.container) covered.add(d.container);
  }
  if (fromDetails.length === 0) return summary;
  // Do resumo, só os contêineres que NÃO ganharam detalhe. Evento de resumo sem
  // contêiner não dá para atribuir com segurança quando há detalhes — fica fora.
  const rest = summary.filter((e) => e.container && !covered.has(e.container));
  return [...fromDetails, ...rest];
}
