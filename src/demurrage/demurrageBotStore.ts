import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { TrackingResult } from '../browser/carriers';
import { TrackingEvent } from '../browser/carriers/types';
import { deriveContainers } from '../browser/carriers/scrapers/hapag';

/**
 * Priora — Cache dos resultados do bot de rastreio, por referência (BL/contêiner).
 *
 * Scraping é lento e os portais limitam acesso; guardamos o último resultado em
 * disco (sobrevive a reinícios do Render) para não raspar de novo a cada
 * abertura da aba. A "frescura" é controlada por config.bot.resultTtlMs.
 */

export interface StoredBotResult {
  result: TrackingResult;
  at: string;
}

const PATH = path.join(config.dataDir, 'demurrage-bot-results.json');

let cache: Record<string, StoredBotResult> | null = null;

/** Chave normalizada da referência (sem espaços/hífens, maiúscula). */
export function refKey(ref: string): string {
  return String(ref || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

function load(): Record<string, StoredBotResult> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(PATH, 'utf8'));
  } catch {
    cache = {};
  }
  return cache!;
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(PATH), { recursive: true });
    fs.writeFileSync(PATH, JSON.stringify(cache || {}, null, 2));
  } catch (err) {
    console.error('[demurrageBotStore] falha ao gravar resultados:', err);
  }
}

export function getBotResult(ref: string): StoredBotResult | null {
  return load()[refKey(ref)] || null;
}

/** Chave de dedupe de um evento (contêiner + data + tipo + status normalizado). */
function eventKey(e: TrackingEvent): string {
  const status = (e.status || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${e.container || ''}|${e.date || ''}|${e.type}|${status}`;
}

/**
 * Une os eventos de raspagens sucessivas (histórico não "desacontece"): dedupe por
 * contêiner+data+tipo+status. É o que permite reconstruir o histórico completo dos
 * armadores que só mostram o ÚLTIMO evento (Evergreen/Yang Ming) ao longo do tempo,
 * sem depender de páginas de detalhe protegidas por anti-bot.
 */
export function mergeEvents(oldEvents: TrackingEvent[], newEvents: TrackingEvent[]): TrackingEvent[] {
  const byKey = new Map<string, TrackingEvent>();
  for (const e of [...(oldEvents || []), ...(newEvents || [])]) {
    if (e && (e.date || e.status)) byKey.set(eventKey(e), e);
  }
  // Ordena por data (ISO) quando houver, mantendo estável o resto.
  return [...byKey.values()].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

/**
 * Salva o resultado, ACUMULANDO os eventos sobre o que já havia para a mesma
 * referência (mesmo armador). Re-deriva os contêineres do conjunto acumulado, de
 * modo que descarga+retirada+devolução apareçam mesmo que cada raspagem só tenha
 * mostrado um evento. Se a nova raspagem falhou mas há histórico, preserva-o.
 */
export function saveBotResult(ref: string, result: TrackingResult): StoredBotResult {
  const store = load();
  const key = refKey(ref);
  const prev = store[key]?.result;

  let toStore = result;
  const prevEvents = prev?.events ?? [];
  const newEvents = result.events ?? [];
  const sameCarrier = !prev?.carrierId || prev.carrierId === result.carrierId;
  if (sameCarrier && (prevEvents.length > 0 || newEvents.length > 0)) {
    const events = mergeEvents(prevEvents, newEvents);
    // Store é autoritativo: sempre re-deriva os contêineres do conjunto acumulado
    // (na 1ª raspagem dá o mesmo que o scraper; nas seguintes, soma o histórico).
    const hint = result.containers?.[0]?.numero ?? prev?.containers?.[0]?.numero ?? null;
    toStore = { ...result, events, containers: deriveContainers(events, hint) };
    // Nova raspagem falhou porém temos histórico acumulado → reporta pelo histórico.
    if (!result.ok && events.length > 0) {
      toStore.ok = true;
      toStore.message = 'Histórico acumulado de raspagens anteriores (nova consulta sem novidade).';
    }
  }

  const rec: StoredBotResult = { result: toStore, at: new Date().toISOString() };
  store[key] = rec;
  persist();
  return rec;
}

export function getAllBotResults(): Record<string, StoredBotResult> {
  return { ...load() };
}

/** Um registro é "fresco" se salvo há menos de maxAgeMs. */
export function isFresh(rec: StoredBotResult, maxAgeMs: number): boolean {
  const t = Date.parse(rec.at);
  return Number.isFinite(t) && Date.now() - t < maxAgeMs;
}

/**
 * Apaga TODO o cache de rastreio (memória + disco). Usado no reset de troca de
 * conta Microsoft — os resultados vieram dos BLs da conta anterior.
 */
export function clearAll(): void {
  cache = {};
  try {
    fs.rmSync(PATH, { force: true });
  } catch {
    /* arquivo pode não existir */
  }
}
