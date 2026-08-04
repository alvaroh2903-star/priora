import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { TrackingResult } from '../browser/carriers';

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

export function saveBotResult(ref: string, result: TrackingResult): StoredBotResult {
  const store = load();
  const rec: StoredBotResult = { result, at: new Date().toISOString() };
  store[refKey(ref)] = rec;
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
