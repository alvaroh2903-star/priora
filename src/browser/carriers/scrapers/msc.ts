import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { stripTags } from './hapag';

/**
 * Priora — Parser DEDICADO da MSC (msc.com/track-a-shipment).
 *
 * A página de resultados da MSC é Alpine.js: os eventos são templates `x-for` que
 * a SPA preenche a partir de um JSON estruturado buscado por baixo. Em vez de
 * raspar esse DOM frágil, o driver (`driveMscForm`) CAPTURA a resposta JSON da
 * rede e este parser lê direto dela — nossa "própria API" (robusto, sem seletores).
 *
 * Forma do JSON (validada ao vivo, BL MEDUY8275040):
 *   Data.BillOfLadings[].ContainersInfo[]:
 *     ContainerNumber, ContainerType ("40' HIGH CUBE"), PodEtaDate, LatestMove,
 *     Delivered, Events[]:
 *       { Order, Date (DD/MM/YYYY), Location, UnLocationCode, Description,
 *         Detail:[navio, viagem] | ["LADEN"], EquipmentHandling{Name,Smdg}, Vessel }
 *
 * A classificação (descarga/retirada/devolução × transbordo/origem) fica com o
 * `classifyEvent` compartilhado — que já trata "Full Transshipment Discharged"
 * (T/S, não é a descarga no destino) como `other`.
 */

interface MscEvent {
  Date?: string;
  Location?: string;
  Description?: string;
  Detail?: unknown;
}
interface MscContainer {
  ContainerNumber?: string;
  ContainerType?: string;
  Events?: MscEvent[];
}
interface MscBillOfLading {
  ContainersInfo?: MscContainer[];
}
interface MscRoot {
  Data?: { BillOfLadings?: MscBillOfLading[] };
}

/** MSC usa DD/MM/YYYY (ex.: "06/09/2026" = 6 de setembro). */
export function mscDateToISO(d: string | null | undefined): string | null {
  const m = (d || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = m[2].padStart(2, '0');
  if (+mon < 1 || +mon > 12 || +day < 1 || +day > 31) return null;
  return `${m[3]}-${mon}-${day}`;
}

/** Extrai navio/viagem do campo Detail ("[navio, viagem]"; ignora LADEN/EMPTY). */
function vesselVoyageFromDetail(detail: unknown): { vessel: string | null; voyage: string | null } {
  if (!Array.isArray(detail) || detail.length < 2) return { vessel: null, voyage: null };
  const first = String(detail[0] ?? '').trim();
  const second = String(detail[1] ?? '').trim();
  if (!first || /^(laden|empty)$/i.test(first)) return { vessel: null, voyage: null };
  return { vessel: first || null, voyage: second || null };
}

export function extractMscEvents(apiJson: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  let root: MscRoot;
  try {
    root = JSON.parse(apiJson) as MscRoot;
  } catch {
    return out;
  }
  const bls = root?.Data?.BillOfLadings;
  if (!Array.isArray(bls)) return out;

  for (const bl of bls) {
    const containers = bl?.ContainersInfo;
    if (!Array.isArray(containers)) continue;
    for (const c of containers) {
      const container = typeof c?.ContainerNumber === 'string' ? c.ContainerNumber.trim() || null : null;
      const tipo = typeof c?.ContainerType === 'string' ? c.ContainerType.replace(/\s+/g, ' ').trim() || null : null;
      const events = c?.Events;
      if (!Array.isArray(events)) continue;
      for (const e of events) {
        const date = mscDateToISO(e?.Date);
        const status = typeof e?.Description === 'string' ? e.Description.trim() : '';
        if (!date || !status) continue; // sem data ou descrição não vira evento
        const location = typeof e?.Location === 'string' ? e.Location.trim() || null : null;
        const { vessel, voyage } = vesselVoyageFromDetail(e?.Detail);
        out.push({
          date,
          status,
          location,
          vessel,
          voyage,
          type: classifyEvent(status),
          container,
          tipo,
        });
      }
    }
  }
  return out;
}

/**
 * Assinatura do DOM da MSC: o componente Alpine `msc-flow-tracking` (exclusivo do
 * portal). Usada pelo despachante — nunca a palavra "MSC" (aparece em navio de BL
 * de outros armadores).
 */
export const MSC_DOM_RE = /msc-flow-tracking__/;

/**
 * Parser do DOM RENDERIZADO da MSC — reserva para quando o JSON da API não chega.
 *
 * Visto ao vivo (MEDUY6394819, 10/10): o JSON interno não foi capturado da rede e
 * os eventos só vinham pela IA. Mas o Alpine deixa, em cada valor renderizado, o
 * NOME do campo no atributo `x-text` — um contrato mais estável que classe CSS:
 *   container.ContainerNumber / container.ContainerType  → contêiner e tipo
 *   event.Date (DD/MM/AAAA) → abre um evento novo
 *   …(event.Location) / event.Description / eventDetailsLabel(event.Detail)
 * Os <template> (o Alpine os mantém no DOM, por isso a página tem ~800 KB) têm os
 * mesmos atributos com texto VAZIO — só valores preenchidos contam. Ignora
 * `container.PodEtaDate` (ETA = previsão).
 */
export function extractMscDomEvents(html: string): TrackingEvent[] {
  const out: TrackingEvent[] = [];
  if (!MSC_DOM_RE.test(html)) return out;

  const tokenRe = /x-text="([^"]+)"[^>]*>([^<]*)</g;
  let container: string | null = null;
  let tipo: string | null = null;
  let cur: { date: string | null; status: string; location: string | null; detail: string | null } | null = null;

  const flush = () => {
    if (cur && cur.date && cur.status) {
      // "EMPTY"/"LADEN" é o estado do contêiner, não navio; o resto é navio/viagem.
      const vessel = cur.detail && !/^(laden|empty)$/i.test(cur.detail) ? cur.detail : null;
      out.push({
        date: cur.date,
        status: cur.status,
        location: cur.location,
        vessel,
        voyage: null,
        type: classifyEvent(cur.status),
        container,
        tipo,
      });
    }
    cur = null;
  };

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    const field = m[1];
    const value = stripTags(m[2]);
    if (!value) continue; // template (não renderizado)
    if (field === 'container.ContainerNumber') {
      flush();
      container = value.toUpperCase();
      tipo = null;
    } else if (field === 'container.ContainerType') {
      tipo = value;
    } else if (field === 'event.Date') {
      flush();
      cur = { date: mscDateToISO(value), status: '', location: null, detail: null };
    } else if (cur && /\bevent\.Location\b/.test(field)) {
      cur.location = value;
    } else if (cur && field === 'event.Description') {
      cur.status = value;
    } else if (cur && /eventDetailsLabel\(event\.Detail\)/.test(field)) {
      cur.detail = value;
    }
  }
  flush();
  // Mesmo contêiner pode ser renderizado 2× (layout de impressão/responsivo).
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.container}|${e.date}|${e.status}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
