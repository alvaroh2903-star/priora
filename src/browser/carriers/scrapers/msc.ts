import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';

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
