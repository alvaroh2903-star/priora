import { trackShipment, TrackingResult, detectCarrier, getCarrier } from '../browser/carriers';
import { canUseScrapflyApi } from '../browser/carriers/scrapflyFetch';
import { mapLanes } from '../browser/carriers/concurrency';
import {
  getBotResult,
  saveBotResult,
  isResolved,
  scrapeIntervalMs,
  refKey,
} from './demurrageBotStore';
import { trackingToDemurrageContainers } from './trackingMapper';
import { config } from '../config';

/**
 * Priora — Enriquecimento de UMA referência (BL/contêiner/booking): o coração do
 * "puxar". Extraído da rota para que o botão (/api/demurrage/bot/enrich) e o
 * DISPARO AUTOMÁTICO em segundo plano (autoSync) usem exatamente o mesmo código —
 * mesmo cache, mesmo TTL adaptativo, mesma camada de IA.
 */

/** Resposta enxuta e pronta para o cálculo de demurrage. */
export function shapeEnrich(result: TrackingResult) {
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
    demurrageContainers: trackingToDemurrageContainers(result),
  };
}

export type EnrichResult = ReturnType<typeof shapeEnrich> & {
  cached: boolean;
  resolved?: boolean;
  at: string;
  organizedByAI: boolean;
};

/**
 * Raspagens em andamento, por referência normalizada. Com o disparo automático
 * rodando em paralelo ao botão, o mesmo BL podia ser raspado duas vezes ao mesmo
 * tempo — duas sessões pagas no Scrapfly para o mesmo dado. Quem chega depois
 * pega carona na raspagem que já está rodando.
 */
const inFlight = new Map<string, Promise<EnrichResult>>();

async function scrapeAndStore(ref: string, carrierId: string | undefined): Promise<EnrichResult> {
  // A CAMADA DE RESILIÊNCIA (IA/Clara) já roda DENTRO do trackShipment quando o
  // parser dedicado não reconhece o layout — então aqui não re-organiza (evita
  // gastar IA em dobro). `result.organizedByAI` diz se os dados vieram da IA.
  const result = await trackShipment(ref, { carrierId });
  const rec = saveBotResult(ref, result);
  return {
    ...shapeEnrich(result),
    cached: false,
    at: rec.at,
    organizedByAI: result.organizedByAI === true,
  };
}

/** Enriquece UMA referência (usa cache fresco; senão raspa e, se preciso, IA). */
export async function enrichOne(
  ref: string,
  carrierId?: string,
  refresh = false,
): Promise<EnrichResult> {
  const cached = refresh ? null : getBotResult(ref);
  // ECONOMIA de crédito Scrapfly — TTL ADAPTATIVO ao estado do BL: serve do cache
  // SEM abrir sessão enquanto dentro do intervalo (Infinity=resolvido nunca raspa;
  // trânsito=espera dias até o navio chegar; ativo=12h p/ pegar retirada/devolução).
  if (cached) {
    const interval = scrapeIntervalMs(cached.result, config.bot.resultTtlMs, config.bot.transitTtlMs);
    const idadeMs = Date.now() - Date.parse(cached.at);
    if (Number.isFinite(idadeMs) && idadeMs < interval) {
      return {
        ...shapeEnrich(cached.result),
        cached: true,
        resolved: isResolved(cached.result),
        at: cached.at,
        // Vem do que foi GRAVADO: um resultado que saiu da IA continua marcado
        // assim mesmo servido do cache. Antes era `false` fixo — e isso escondia
        // do monitoramento justamente os armadores que caíram para a IA.
        organizedByAI: cached.result.organizedByAI === true,
      };
    }
  }

  const key = refKey(ref);
  const running = inFlight.get(key);
  if (running) return running;
  const p = scrapeAndStore(ref, carrierId).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Pista de uma referência: 'api' (CMA/ZIM pela API da Scrapfly) ou 'browser'. */
export function enrichLane(ref: string, carrierId?: string): 'api' | 'browser' {
  const carrier = carrierId ? getCarrier(carrierId) : detectCarrier(ref).carrier;
  return carrier && canUseScrapflyApi(carrier) ? 'api' : 'browser';
}

/**
 * Vários BLs de uma vez (lote do botão e disparo automático): pista da API
 * (até BOT_API_CONCURRENCY em paralelo) e pista de navegador (BOT_CONCURRENCY,
 * padrão 1 — a vaga do navegador remoto já serializa) andando JUNTAS. Ordem do
 * resultado = ordem de `refs`. Erro de um BL não derruba os outros.
 */
export async function enrichMany(
  refs: string[],
  opts: { refresh?: boolean } = {},
): Promise<Array<EnrichResult | { reference: string; ok: false; error: string }>> {
  return mapLanes(
    refs,
    (ref) => enrichLane(ref),
    { api: config.bot.apiConcurrency, browser: config.bot.concurrency },
    async (ref) => {
      try {
        return await enrichOne(ref, undefined, opts.refresh === true);
      } catch (err) {
        return { reference: ref, ok: false as const, error: (err as Error).message };
      }
    },
  );
}
