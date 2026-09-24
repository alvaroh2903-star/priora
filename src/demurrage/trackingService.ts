import { trackShipment, TrackingResult } from '../browser/carriers';
import { ContainerInfo, TrackingEvent } from '../browser/carriers/types';
import {
  getBotResult,
  saveBotResult,
  isResolved,
  scrapeIntervalMs,
} from './demurrageBotStore';
import { trackingToDemurrageContainers } from './trackingMapper';
import { organizeScrapedTracking } from './trackingOrganizer';
import { config } from '../config';

/**
 * Priora — Camada de SERVIÇO do tracking de armador (extraída da rota Express).
 *
 * É a "API central de Tracking" consumível DENTRO do processo: cache/TTL
 * adaptativo + merge de eventos (demurrageBotStore) + raspagem (trackShipment
 * → Playwright/Scrapfly) + organização por IA quando o portal não tem parser.
 *
 * Dois consumidores compartilham exatamente esta função, sem loop HTTP:
 *  - a rota `GET/POST /api/demurrage/bot/enrich[-batch]` (delegando aqui);
 *  - a Demurrage Engine V2 (`armadorTrackingSource`), in-process.
 *
 * Scrapfly/Playwright ficam ATRÁS desta camada; nada em `src/demurrage-engine/*`
 * importa `src/browser/*` — só este serviço.
 */

/** Resposta enxuta e pronta para consumo (formato `shapeEnrich`, + `containers`). */
export interface EnrichResult {
  carrier: { id: string; name: string };
  reference: string;
  referenceType: TrackingResult['referenceType'];
  ok: boolean;
  needsLogin: boolean;
  needsCaptcha: boolean;
  message?: string;
  sourceUrl: string;
  events: TrackingEvent[];
  /** Datas normalizadas por contêiner (dischargeDate/availableDate/gateOut/emptyReturn/tipo). */
  containers: ContainerInfo[];
  demurrageContainers: ReturnType<typeof trackingToDemurrageContainers>;
  cached: boolean;
  resolved: boolean;
  at: string;
  organizedByAI: boolean;
}

/**
 * Formato para consumo. Mantém `events` e `demurrageContainers` como a rota já
 * fazia e ADICIONA `containers` (ContainerInfo[] com todas as datas) — adição
 * retrocompatível: consumidores antigos ignoram o campo novo; a Demurrage V2
 * precisa dele (dischargeDate não vem em `demurrageContainers`).
 */
function shapeEnrich(result: TrackingResult): Omit<EnrichResult, 'cached' | 'resolved' | 'at' | 'organizedByAI'> {
  return {
    carrier: { id: result.carrierId, name: result.carrierName },
    reference: result.reference,
    referenceType: result.referenceType,
    ok: result.ok,
    needsLogin: result.needsLogin,
    needsCaptcha: result.needsCaptcha,
    message: result.message,
    sourceUrl: result.sourceUrl,
    events: result.events,
    containers: result.containers,
    demurrageContainers: trackingToDemurrageContainers(result),
  };
}

/**
 * Enriquece UMA referência: usa cache fresco (TTL adaptativo ao estado do BL —
 * resolvido=Infinity, trânsito=dias, ativo=12h); senão raspa e, se preciso,
 * organiza por IA. Comportamento idêntico ao antigo `enrichOne` da rota.
 */
export async function enrichReference(
  ref: string,
  carrierId?: string,
  refresh = false,
): Promise<EnrichResult> {
  const cached = refresh ? null : getBotResult(ref);
  if (cached) {
    const interval = scrapeIntervalMs(cached.result, config.bot.resultTtlMs, config.bot.transitTtlMs);
    const idadeMs = Date.now() - Date.parse(cached.at);
    if (Number.isFinite(idadeMs) && idadeMs < interval) {
      return {
        ...shapeEnrich(cached.result),
        cached: true,
        resolved: isResolved(cached.result),
        at: cached.at,
        organizedByAI: false,
      };
    }
  }

  const result = await trackShipment(ref, { carrierId });

  const hasDates = result.containers.some((c) => c.gateOut || c.emptyReturn || c.lastFreeDay);
  let organizedByAI = false;
  if (!hasDates && result.raw) {
    const organized = await organizeScrapedTracking(result.carrierName, ref, result.raw);
    if (organized && organized.length) {
      result.containers = organized;
      organizedByAI = true;
    }
  }

  const rec = saveBotResult(ref, result);
  return {
    ...shapeEnrich(result),
    cached: false,
    resolved: isResolved(result),
    at: rec.at,
    organizedByAI,
  };
}
