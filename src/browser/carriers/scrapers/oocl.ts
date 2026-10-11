import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { parseDateToISO, stripTags } from './hapag';

/**
 * Priora — Parser DEDICADO do rastreio da OOCL (portal SCCT em
 * pbcontroltower.digital.oocl.com/scct/public/moc/cargoTracking).
 *
 * ATENÇÃO: é um parser PRÓPRIO — NÃO é o da COSCO. Apesar de ambos serem "SCCT"
 * (mesmo grupo), o layout da OOCL é diferente: um bloco por contêiner ("Container
 * No. XXXX") seguido de uma tabela de eventos com as colunas:
 *   Event | Time | Location | Stage | Transport Mode
 * Ex.: Discharged | 18 Aug 2026 05:42 BRT | Portonave... Navegantes | Ocean | Vessel.
 *
 * Como as linhas de evento NÃO repetem o nº do contêiner, associamos cada evento
 * ao ÚLTIMO "Container No." que apareceu antes dele (varredura em ordem do DOM).
 * Nada é fixo a um BL específico — funciona p/ qualquer referência.
 */

const CONTAINER_RE = /\b[A-Z]{4}\d{7}\b/;

/**
 * Assinatura do PORTAL da OOCL (domínio do SCCT), não da palavra "OOCL": navios
 * "OOCL …" aparecem em BLs da COSCO e na lista de navios da PIL — com a palavra
 * solta, este parser lia a página de outro armador.
 */
export const OOCL_PORTAL_RE = /pbcontroltower|digital\.oocl\.com/i;

/** Células (texto, sem vazias) de um bloco de <tr>. */
function rowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let c: RegExpExecArray | null;
  while ((c = cellRe.exec(rowHtml))) {
    const t = stripTags(c[1]);
    if (t) cells.push(t);
  }
  return cells;
}

/** Um evento de `milestoneEventList` do store da OOCL (só os campos que usamos). */
interface OoclMilestone {
  eventName?: string | null;
  eventDateTime?: string | null;
  facilityName?: string | null;
  facilityCode?: string | null;
  portName?: string | null;
  city?: string | null;
  stage?: string | null;
  transportMode?: string | null;
}

interface OoclVesselInfo {
  vesselName?: string | null;
  externalVoyage?: string | null;
}

/**
 * Eventos a partir do store do app (`{ ooclStore: { summaryList } }`, lido por
 * readOoclStore no navegador). É a resposta da consulta inteira:
 * `summaryList[].containerList[].milestoneEventList[]` (eventName, eventDateTime
 * "19 Sep 2026 20:47 BRT", facilityName, city, stage, transportMode) — histórico
 * COMPLETO por contêiner, que a tela só mostra atrás de "Expand". Navio/viagem
 * saem de `routes[].vesselInfo`, casados pelo terminal (facilityCode) do evento.
 * Visto ao vivo em 11/10 (B/L 2335731403, CSGU7796499/CSGU7791100).
 */
export function extractOoclStoreEvents(apiJson: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  let summaries: Array<Record<string, unknown>> = [];
  try {
    summaries = (JSON.parse(apiJson) as { ooclStore?: { summaryList?: Array<Record<string, unknown>> } }).ooclStore?.summaryList || [];
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const s of summaries) {
    // Terminal → navio/viagem da perna marítima (só eventos de navio recebem).
    const vesselByFacility = new Map<string, OoclVesselInfo>();
    for (const r of (s.routes as Array<{ facilityCode?: string | null; vesselInfo?: OoclVesselInfo | null }>) || []) {
      if (r.facilityCode && r.vesselInfo?.vesselName) vesselByFacility.set(r.facilityCode, r.vesselInfo);
    }
    const containers = (s.containerList as Array<Record<string, unknown>>) || [];
    for (const c of containers) {
      const numero = String(c.containerNumberWithCheckDigit || c.containerNumber || '').toUpperCase() || null;
      const tipo = (c.cntrSizeType as string) || null;
      for (const e of (c.milestoneEventList as OoclMilestone[]) || []) {
        const status = (e.eventName || '').trim();
        const date = parseDateToISO(e.eventDateTime || '');
        if (!status || !date) continue;
        const location = [e.facilityName, e.city].filter(Boolean).join(' — ') || e.portName || null;
        const vi = /vessel/i.test(e.transportMode || '') && e.facilityCode ? vesselByFacility.get(e.facilityCode) : undefined;
        const key = `${numero}|${date}|${status}|${location}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          date,
          status,
          location,
          vessel: vi?.vesselName || null,
          voyage: vi?.externalVoyage || null,
          type: classifyEvent(status),
          container: numero,
          tipo,
        });
      }
    }
  }
  return out;
}

export function extractOoclEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!OOCL_PORTAL_RE.test(html)) return out;
  // A tabela "B/L Information" (liberação/alfândega: "Held at 21 Aug 2026 …")
  // NÃO é de eventos — lida como tal, virava um evento falso com o navio no
  // lugar do status (visto ao vivo em 11/10). Corta a página antes dela.
  const blInfo = html.search(/B\/L\s*Information/i);
  if (blInfo > 0) html = html.slice(0, blInfo);

  const seen = new Set<string>();
  let current: string | null = null;

  // Varre o DOM em ORDEM, alternando dois tokens:
  //  (1) "Container No. … XXXX" → troca o contêiner atual;
  //  (2) <tr>…</tr> → se for linha de evento (tem data), emite pro atual.
  const tokenRe =
    /Container\s*No\.?\s*:?[\s\S]{0,80}?\b([A-Z]{4}\d{7})\b|<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    if (m[1]) {
      current = m[1]; // cabeçalho de contêiner
      continue;
    }
    const cells = rowCells(m[2]);
    // Linha de evento: precisa do "Time" (data) e do "Event" antes dele.
    const dateIdx = cells.findIndex((c) => parseDateToISO(c));
    if (dateIdx < 1) continue;
    const date = parseDateToISO(cells[dateIdx]);
    const status = cells[dateIdx - 1]; // coluna Event
    if (!status || CONTAINER_RE.test(status)) continue;
    const location = cells[dateIdx + 1] || null; // coluna Location

    const key = `${current}|${date}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      status,
      location,
      vessel: null,
      voyage: null,
      type: classifyEvent(status),
      container: current,
    });
  }
  return out;
}
