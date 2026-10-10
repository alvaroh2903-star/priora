import { CARRIERS, getCarrier } from './registry';
import { CarrierMeta, TrackingResult } from './types';
import { trackShipment } from './index';
import { mapLimit } from './concurrency';
import { getAllBotResults, isResolved } from '../../demurrage/demurrageBotStore';

/**
 * Priora — Camada 3: VIGILÂNCIA (watchdog) do pipeline de rastreio.
 *
 * O norte do usuário: "o fluxo tem que se manter constante; daqui a 10 dias
 * puxa, verifica e o código se molda". As camadas 1 (parser dedicado) e 2
 * (IA/Clara como resiliência) já mantêm a API ENTREGANDO mesmo quando um portal
 * muda de layout — o cliente não sente a quebra. Falta a camada que AVISA:
 * esta. O watchdog puxa um BL-canário por armador, roda o MESMO `trackShipment`
 * da produção e classifica a SAÚDE de cada armador, para a gente cravar/ajustar
 * o parser ANTES de um problema real — sem depender de o cliente reclamar.
 *
 * Não existe "código que se molda sozinho" de forma segura; o que se molda é o
 * RESULTADO (a IA cobre o layout novo). O watchdog transforma essa cobertura em
 * um SINAL acionável: "armador X caiu pra IA → cravar parser"; "render magro →
 * infra"; "BL canário expirou → renovar"; "nem parser nem IA → investigar".
 *
 * Fonte dos canários (NÃO apodrece): o cache de resultados reais
 * (`demurrageBotStore`). Como BLs expiram no portal depois do ciclo, o watchdog
 * escolhe, por armador, o registro MAIS RECENTE que já extraiu eventos,
 * preferindo os AINDA VIVOS (não resolvidos). Conforme embarques reais fluem, os
 * canários se renovam sozinhos. Seed por env (`WATCHDOG_SEED_REFS`) cobre
 * armador sem cache; override por query tem prioridade.
 */

/** Diagnóstico de saúde de um armador no pipeline. */
export type CarrierHealth =
  | 'healthy' // parser dedicado extraiu eventos — tudo certo
  | 'degraded_ai' // extraiu, mas via IA (parser dedicado não reconheceu) → cravar parser
  | 'stale_ref' // portal respondeu SEM dados p/ o canário (BL expirado) → renovar ref
  | 'captcha' // parede de CAPTCHA
  | 'thin' // render "magro" (página voltou quase vazia) — transitório de infra
  | 'broken' // renderizou mas NEM parser NEM IA extraíram → INVESTIGAR layout
  | 'blocked_by_design' // scrapeBlocked (anti-bot; produção não abre sessão) → API oficial
  | 'no_ref' // sem canário disponível (rodar um enrich real alimenta o watchdog)
  | 'error'; // exceção ao consultar (Scrapfly/rede)

/** Gravidade para alertas: ok (silêncio), warn (olhar), fail (agir já). */
export type Severity = 'ok' | 'warn' | 'fail';

const SEVERITY_OF: Record<CarrierHealth, Severity> = {
  healthy: 'ok',
  blocked_by_design: 'ok', // esperado e estável — não é regressão
  degraded_ai: 'warn',
  stale_ref: 'warn',
  captcha: 'warn',
  thin: 'warn',
  no_ref: 'warn',
  broken: 'fail',
  error: 'fail',
};

// Abaixo disto, SEM evento e SEM captcha, a página não renderizou de verdade
// (mesmo limiar do scraper). Um rastreio real rende MUITO mais que isto.
const THIN_RENDER_CHARS = 3000;

/** Referência-canário escolhida para um armador e de onde veio. */
export interface CanaryRef {
  ref: string;
  source: 'query' | 'cache' | 'seed';
  /** Veio do cache como BL já RESOLVIDO (pode ter sido purgado do portal)? */
  resolved?: boolean;
}

/**
 * Escolhe um canário por armador. Prioridade: override (query) > cache > seed.
 * No cache, por armador, o registro MAIS RECENTE que já produziu eventos,
 * preferindo BL ainda VIVO (não resolvido) ao resolvido.
 */
export function pickCanaryRefs(
  opts: { overrides?: Record<string, string>; seed?: Record<string, string> } = {},
): Record<string, CanaryRef> {
  const out: Record<string, CanaryRef> = {};

  // 1) Cache de resultados reais.
  const best: Record<string, { ref: string; score: number; resolved: boolean }> = {};
  for (const rec of Object.values(getAllBotResults())) {
    const r = rec.result;
    const cid = r?.carrierId;
    if (!cid) continue;
    if ((r.events?.length || 0) === 0) continue; // só serve de canário quem já extraiu
    const at = Date.parse(rec.at) || 0;
    const resolved = isResolved(r);
    // Vivo pesa MUITO mais que resolvido; entre iguais, o mais recente.
    const score = (resolved ? 0 : 1e12) + at;
    if (!best[cid] || score > best[cid].score) best[cid] = { ref: r.reference, score, resolved };
  }
  for (const [cid, b] of Object.entries(best)) {
    out[cid] = { ref: b.ref, source: 'cache', resolved: b.resolved };
  }

  // 2) Seed (env) para armador sem cache.
  for (const [cid, ref] of Object.entries(opts.seed || {})) {
    if (!out[cid] && ref) out[cid] = { ref, source: 'seed' };
  }

  // 3) Override (query) tem prioridade máxima.
  for (const [cid, ref] of Object.entries(opts.overrides || {})) {
    if (ref) out[cid] = { ref, source: 'query' };
  }

  return out;
}

/** Lê o seed de canários do ambiente (JSON `{"maersk":"...","msc":"..."}`). */
export function parseSeedEnv(raw = process.env.WATCHDOG_SEED_REFS): Record<string, string> {
  const txt = (raw || '').trim();
  if (!txt) return {};
  try {
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    }
  } catch {
    /* JSON inválido → sem seed */
  }
  return {};
}

/**
 * Classifica a SAÚDE de um armador a partir do resultado do `trackShipment`
 * (ou de uma condição sem resultado: bloqueado, sem ref, exceção). Lógica PURA —
 * é o que o self-test offline cobre.
 */
export function classifyHealth(
  carrier: CarrierMeta,
  result: TrackingResult | null,
  opts: { error?: string; blocked?: boolean } = {},
): { health: CarrierHealth; action: string } {
  if (opts.blocked || carrier.scrapeBlocked) {
    return {
      health: 'blocked_by_design',
      action:
        'Anti-bot comportamental (DataDome/slider/hCaptcha) — produção NÃO abre sessão (economia). Caminho: API oficial.',
    };
  }
  if (opts.error) {
    return { health: 'error', action: `Exceção ao consultar: ${opts.error}. Checar Scrapfly/credenciais/rede.` };
  }
  if (!result) {
    return {
      health: 'no_ref',
      action: 'Sem referência canário (cache/seed/query) — rode um enrich real deste armador para alimentar o watchdog.',
    };
  }

  const events = result.events?.length || 0;
  if (result.ok && events > 0) {
    if (result.organizedByAI) {
      return {
        health: 'degraded_ai',
        action:
          'Portal mudou de layout: a IA está cobrindo (o cliente NÃO sente), mas crave o parser dedicado para voltar a extrair sem custo de IA.',
      };
    }
    return { health: 'healthy', action: 'Parser dedicado extraindo normalmente.' };
  }

  // A partir daqui ok=false (sem eventos úteis).
  if (result.needsCaptcha) {
    return {
      health: 'captcha',
      action: 'Portal apresentou CAPTCHA. Se recorrente: avaliar Unblock/anti-captcha ou API oficial.',
    };
  }

  const msg = (result.message || '').toLowerCase();
  const stale =
    /\bis invalid\b|invalid (booking|b\/l|bl|reference|number)|inv[aá]lid|not found|no (results?|data|matching|shipment|records?)|nenhum resultado|n[aã]o encontrad|currently not available|temporarily unavailable|under maintenance|em manuten/.test(
      msg,
    );
  if (stale) {
    return {
      health: 'stale_ref',
      action:
        'Portal respondeu SEM dados para o canário (provável BL expirado) — renove a referência. NÃO é defeito do parser.',
    };
  }

  const ai = result.aiDiag;
  const rawLen = ai?.rawLen ?? 0;
  if (ai?.tried && rawLen > 0 && rawLen < THIN_RENDER_CHARS) {
    return {
      health: 'thin',
      action: 'Render magro (página voltou quase vazia) — transitório de infra; retry/estabilização cobre. Recorrente → checar pool/IP.',
    };
  }

  // Renderizou cheio (ou sem aiDiag) mas sem evento e sem IA → investigar de fato.
  return {
    health: 'broken',
    action: ai?.tried
      ? `Página renderizou (${rawLen} chars) mas NEM parser NEM IA extraíram — investigar layout/seletores (IA: ${ai?.error || 'sem erro'}).`
      : 'Sem eventos — investigar (rode /health/track?ai=1 para ver o texto cru que a IA recebeu).',
  };
}

/** Linha de relatório por armador. */
export interface WatchdogCarrierReport {
  carrierId: string;
  carrierName: string;
  ref: string | null;
  refSource: CanaryRef['source'] | null;
  health: CarrierHealth;
  severity: Severity;
  ok: boolean;
  eventsCount: number;
  organizedByAI: boolean;
  rawLen: number | null;
  ms: number;
  message: string | null;
  action: string;
}

export interface WatchdogReport {
  mode: 'watchdog';
  ranAt: string;
  ms: number;
  severity: Severity; // pior gravidade encontrada
  summary: Record<string, number>; // contagem por health + total
  carriers: WatchdogCarrierReport[];
}

export interface WatchdogOptions {
  /** Subconjunto de armadores (ids); default: todos. */
  carrierIds?: string[];
  /** Override de canário por armador (ex.: vindo da query). */
  overrides?: Record<string, string>;
  /** Concorrência das consultas (default 1 — residential não gosta de paralelismo). */
  concurrency?: number;
  /** Camada de IA ligada (paridade com produção). Default true. */
  aiFallback?: boolean;
}

function buildRow(
  carrier: CarrierMeta,
  canary: CanaryRef | null,
  result: TrackingResult | null,
  ms: number,
  health: CarrierHealth,
  action: string,
): WatchdogCarrierReport {
  return {
    carrierId: carrier.id,
    carrierName: carrier.name,
    ref: canary?.ref ?? null,
    refSource: canary?.source ?? null,
    health,
    severity: SEVERITY_OF[health],
    ok: result?.ok ?? false,
    eventsCount: result?.events?.length ?? 0,
    organizedByAI: result?.organizedByAI === true,
    rawLen: result?.aiDiag?.rawLen ?? null,
    ms,
    message: result?.message ?? null,
    action,
  };
}

async function checkCarrier(
  carrier: CarrierMeta,
  canary: CanaryRef | null,
  aiFallback: boolean,
): Promise<WatchdogCarrierReport> {
  const t0 = Date.now();
  // Bloqueado por design: não abre sessão (economia de crédito) — classifica direto.
  if (carrier.scrapeBlocked) {
    const { health, action } = classifyHealth(carrier, null, { blocked: true });
    return buildRow(carrier, canary, null, Date.now() - t0, health, action);
  }
  if (!canary) {
    const { health, action } = classifyHealth(carrier, null);
    return buildRow(carrier, canary, null, Date.now() - t0, health, action);
  }
  try {
    const result = await trackShipment(canary.ref, { carrierId: carrier.id, aiFallback });
    const { health, action } = classifyHealth(carrier, result);
    return buildRow(carrier, canary, result, Date.now() - t0, health, action);
  } catch (e) {
    const { health, action } = classifyHealth(carrier, null, { error: (e as Error).message });
    return buildRow(carrier, canary, null, Date.now() - t0, health, action);
  }
}

/** Pior gravidade entre as linhas. */
export function overallSeverity(rows: Pick<WatchdogCarrierReport, 'severity'>[]): Severity {
  if (rows.some((r) => r.severity === 'fail')) return 'fail';
  if (rows.some((r) => r.severity === 'warn')) return 'warn';
  return 'ok';
}

/**
 * Roda o watchdog: escolhe canários, puxa cada armador com o pipeline REAL e
 * classifica a saúde. Sequencial por padrão (residential), para não degradar as
 * sessões como acontecia no lote concorrente.
 */
export async function runWatchdog(opts: WatchdogOptions = {}): Promise<WatchdogReport> {
  const started = Date.now();
  const refs = pickCanaryRefs({ overrides: opts.overrides, seed: parseSeedEnv() });
  const carriers = opts.carrierIds?.length
    ? (opts.carrierIds.map((id) => getCarrier(id)).filter(Boolean) as CarrierMeta[])
    : CARRIERS;
  const c = Math.min(Math.max(opts.concurrency ?? 1, 1), 4);
  const aiFallback = opts.aiFallback !== false;

  const rows = await mapLimit(carriers, c, (carrier) =>
    checkCarrier(carrier, refs[carrier.id] || null, aiFallback),
  );

  const summary: Record<string, number> = { total: rows.length };
  for (const r of rows) summary[r.health] = (summary[r.health] || 0) + 1;

  return {
    mode: 'watchdog',
    ranAt: new Date(started).toISOString(),
    ms: Date.now() - started,
    severity: overallSeverity(rows),
    summary,
    carriers: rows,
  };
}
