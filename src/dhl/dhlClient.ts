import { config } from '../config';
import { TrackingResult } from '../tracking/types';
import { normalize } from './dhlParse';
import { isDhlWebAvailable, trackDhlWeb } from './dhlWeb';

export { normalize };

/** Indica se a DHL está configurada (API Key). */
export function isDhlConfigured(): boolean {
  return Boolean(config.dhl.apiKey);
}

/** Há algum caminho de rastreio DHL (chave da API oficial ou navegador remoto p/ o site)? */
export function isDhlAvailable(): boolean {
  return isDhlConfigured() || isDhlWebAvailable();
}

/** A DHL recusou por limite de uso (429) — ou estamos esperando o limite passar. */
export class DhlLimitError extends Error {}

/** A DHL recusou a CHAVE (401/403): a API de rastreio não está liberada para ela. */
export class DhlAuthError extends Error {}

/*
 * LIMITES DA CHAVE (ver config.dhl): a tela de Courier consulta todos os envios
 * DHL de uma vez ao abrir; sem fila, só o primeiro passaria e o resto levaria
 * 429. Aqui as chamadas saem uma por vez, espaçadas em `minIntervalMs`, e um 429
 * pausa novas chamadas até o tempo que a DHL pedir (Retry-After).
 */
let nextSlotAt = 0;
let blockedUntil = 0;
// Chave recusada (401/403) no modo auto: vai pelo site e só retenta a API depois disto.
let apiRefusedUntil = 0;
const API_REFUSED_RETRY_MS = 6 * 60 * 60 * 1000;
let usage = { dia: '', chamadas: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Espera a vez na fila: chamadas simultâneas saem espaçadas em `minIntervalMs`. */
async function takeTurn(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + config.dhl.minIntervalMs;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

function limitMessage(): string {
  const hora = new Date(blockedUntil).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Limite de consultas da DHL atingido (chave grátis: 1 a cada 5 s e ${config.dhl.dailyLimit} por dia). Nova tentativa a partir das ${hora}.`;
}

/** Uso da chave desde o último reinício do serviço (contagem nossa, por dia UTC). */
export function dhlUsage(): {
  fonte: string;
  apiRecusadaAte: string | null;
  dia: string;
  chamadas: number;
  limiteDia: number;
  intervaloMs: number;
  pausadaAte: string | null;
} {
  const dia = today();
  return {
    fonte: config.dhl.source,
    apiRecusadaAte: Date.now() < apiRefusedUntil ? new Date(apiRefusedUntil).toISOString() : null,
    dia,
    chamadas: usage.dia === dia ? usage.chamadas : 0,
    limiteDia: config.dhl.dailyLimit,
    intervaloMs: config.dhl.minIntervalMs,
    pausadaAte: Date.now() < blockedUntil ? new Date(blockedUntil).toISOString() : null,
  };
}

/** Só para o self-test: zera fila, pausa, contagem e cache. */
export function resetDhlStateForTest(): void {
  nextSlotAt = 0;
  blockedUntil = 0;
  apiRefusedUntil = 0;
  usage = { dia: '', chamadas: 0 };
  cache.clear();
  inFlight.clear();
}

/** Rastreia um número na DHL (Unified Shipment Tracking API). */
export async function trackNumber(
  trackingNumber: string,
): Promise<TrackingResult> {
  if (!isDhlConfigured()) {
    throw new Error('DHL não configurada. Defina DHL_API_KEY no servidor.');
  }
  if (Date.now() < blockedUntil) throw new DhlLimitError(limitMessage());
  await takeTurn();
  // Outra chamada pode ter levado 429 enquanto esta esperava na fila.
  if (Date.now() < blockedUntil) throw new DhlLimitError(limitMessage());
  const dia = today();
  if (usage.dia !== dia) usage = { dia, chamadas: 0 };
  usage.chamadas++;

  const url = `${config.dhl.baseUrl}/track/shipments?trackingNumber=${encodeURIComponent(
    trackingNumber,
  )}`;
  const res = await fetch(url, {
    headers: {
      'DHL-API-Key': config.dhl.apiKey,
      Accept: 'application/json',
    },
    // Timeout: sem isso um fetch pendurado deixa o card girando pra sempre.
    signal: AbortSignal.timeout(12000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    blockedUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 60_000);
    throw new DhlLimitError(limitMessage());
  }

  const json: any = await res.json().catch(() => ({}));
  // 404 = número não encontrado (não é erro de sistema) -> found:false com detalhe.
  if (res.status === 404) {
    return normalize(json, trackingNumber);
  }
  if (!res.ok) {
    const msg = json?.detail || json?.title || 'sem detalhe';
    // Visto em 18/10/2026 com a chave de produção: "Access to the resource is
    // not allowed" — a chave existe, mas não tem acesso à API de rastreio.
    if (res.status === 401 || res.status === 403) {
      throw new DhlAuthError(
        `DHL recusou a chave (HTTP ${res.status}: ${msg}). No developer.dhl.com → My Apps, confira se a API "Shipment Tracking - Unified" está no app e aprovada, e se DHL_API_KEY é a Consumer Key dela.`,
      );
    }
    throw new Error(`DHL track falhou (HTTP ${res.status}): ${msg}`);
  }
  return normalize(json, trackingNumber);
}

export type DhlSource = 'api' | 'site';

/**
 * Escolhe o caminho (DHL_SOURCE): `api` = só a API oficial; `web` = só o site;
 * `auto` (padrão) = API se houver chave e ela não tiver sido recusada; numa
 * recusa (401/403) passa a ir pelo site e só tenta a API de novo em 6 h.
 */
async function trackDhlAny(number: string): Promise<TrackingResult & { fonte: DhlSource }> {
  const mode = config.dhl.source;
  const tryApi = isDhlConfigured() && mode !== 'web' && (mode === 'api' || Date.now() >= apiRefusedUntil);
  if (tryApi) {
    try {
      return { ...(await trackNumber(number)), fonte: 'api' };
    } catch (e) {
      if (mode === 'api' || !(e instanceof DhlAuthError) || !isDhlWebAvailable()) throw e;
      apiRefusedUntil = Date.now() + API_REFUSED_RETRY_MS;
    }
  }
  if (mode === 'api') throw new Error('DHL não configurada. Defina DHL_API_KEY no servidor.');
  if (!isDhlWebAvailable()) {
    throw new Error('Rastreio DHL indisponível: sem chave da API (DHL_API_KEY) e sem navegador remoto (SCRAPE_BROWSER_WSS).');
  }
  return { ...(await trackDhlWeb(number)), fonte: 'site' };
}

/* ------------------------------------------------------------------ *
 * Cache da DHL (a cota da API é curta e o site custa crédito de navegador):
 * cada número é consultado no máximo uma vez por `cacheMin` — entregue, uma
 * vez por dia. Se a consulta nova falhar (limite, bloqueio, DHL fora), devolve
 * a última boa, marcada como `stale`.
 * ------------------------------------------------------------------ */
export type DhlCachedResult = TrackingResult & { fonte: DhlSource; cached: boolean; stale?: boolean; aviso?: string };

const DELIVERED_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; data: TrackingResult & { fonte: DhlSource } }>();
const inFlight = new Map<string, Promise<DhlCachedResult>>();

function ttlMs(r: TrackingResult): number {
  return /delivered/i.test(r.statusCode || '') ? DELIVERED_TTL_MS : config.dhl.cacheMin * 60 * 1000;
}

function remember(number: string, data: TrackingResult & { fonte: DhlSource }): void {
  cache.set(number, { at: Date.now(), data });
  if (cache.size <= 2000) return;
  for (const [k, v] of cache) if (Date.now() - v.at > DELIVERED_TTL_MS) cache.delete(k);
}

export async function trackDhlCached(number: string, opts: { refresh?: boolean } = {}): Promise<DhlCachedResult> {
  const hit = cache.get(number);
  if (hit && !opts.refresh && Date.now() - hit.at < ttlMs(hit.data)) return { ...hit.data, cached: true };
  const flying = inFlight.get(number);
  if (flying) return flying;
  const p = trackDhlAny(number)
    .then((data): DhlCachedResult => {
      remember(number, data);
      return { ...data, cached: false };
    })
    .catch((e: Error): DhlCachedResult => {
      if (!hit) throw e;
      const quando = new Date(hit.at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return { ...hit.data, cached: true, stale: true, aviso: `${e.message} Mostrando a consulta de ${quando}.` };
    })
    .finally(() => inFlight.delete(number));
  inFlight.set(number, p);
  return p;
}
