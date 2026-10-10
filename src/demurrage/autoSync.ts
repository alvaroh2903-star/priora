import { getMsalClient } from '../auth/msalClient';
import { getActiveHomeAccountId } from '../auth/microsoftAccount';
import { config, isAzureConfigured } from '../config';
import { collectEmailRefs } from './emailRefs';
import { enrichOne } from './enrichService';

/**
 * Priora — DISPARO AUTOMÁTICO do rastreio (autoSync).
 *
 * Hoje o "puxar" dependia de alguém clicar em "Sincronizar BLs" e deixar a aba
 * aberta: era o NAVEGADOR que fazia o laço (sync-refs → um /enrich por BL). Aqui
 * o mesmo trabalho roda DENTRO do servidor, sozinho, a cada intervalo:
 *
 *   conta Microsoft vinculada → token silencioso → BLs dos e-mails →
 *   enrichOne (cache/TTL adaptativo → raspagem → IA se preciso) → cache
 *
 * A aba Demurrage só lê o cache — ao abrir, as datas já estão lá.
 *
 * Por que não passa pelo requireAuth: não há requisição HTTP nem sessão de
 * navegador num laço de fundo. Usamos a conta ATIVA da Priora (MVP de conta
 * Microsoft única) e o cache de tokens do MSAL, que é persistido em disco — o
 * acquireTokenSilent renova sozinho pelo refresh token.
 *
 * Limites honestos:
 *  - Render free dorme sem tráfego; dormindo, o setInterval não roda. O keep-alive
 *    (.github/workflows/keepalive.yml) e o uso normal mantêm o processo acordado.
 *  - O disco do Render é efêmero: um deploy pode apagar o cache de tokens; aí o
 *    laço fica parado (status 'sem_conta') até alguém logar de novo.
 *  - Quando o multiempresa entrar, isto passa a iterar por workspace/conta.
 */

export interface AutoSyncRun {
  startedAt: string;
  finishedAt: string | null;
  /** 'ok' rodou | 'sem_conta' nenhuma conta vinculada/token | 'erro' falhou. */
  outcome: 'ok' | 'sem_conta' | 'erro' | 'rodando';
  refsFound: number;
  fromCache: number;
  scraped: number;
  failed: number;
  message: string | null;
}

let timer: NodeJS.Timeout | null = null;
let running: Promise<AutoSyncRun> | null = null;
let lastRun: AutoSyncRun | null = null;
let nextRunAt: number | null = null;

/** Token do Graph para a conta ATIVA, sem requisição HTTP. null = sem conta/token. */
async function getBackgroundGraphToken(): Promise<string | null> {
  if (!isAzureConfigured()) return null;
  const homeAccountId = getActiveHomeAccountId();
  if (!homeAccountId) return null;
  const msal = getMsalClient();
  const account = await msal.getTokenCache().getAccountByHomeId(homeAccountId);
  if (!account) return null;
  const result = await msal.acquireTokenSilent({ account, scopes: config.graphScopes });
  return result?.accessToken || null;
}

async function doRun(): Promise<AutoSyncRun> {
  const run: AutoSyncRun = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: 'rodando',
    refsFound: 0,
    fromCache: 0,
    scraped: 0,
    failed: 0,
    message: null,
  };
  lastRun = run;
  try {
    const token = await getBackgroundGraphToken().catch(() => null);
    if (!token) {
      run.outcome = 'sem_conta';
      run.message = 'Nenhuma conta Microsoft vinculada (ou o token expirou) — faça login para o disparo automático rodar.';
      return run;
    }
    const refs = await collectEmailRefs(token, config.bot.autoSync.maxRefs);
    run.refsFound = refs.length;
    // SEQUENCIAL de propósito: sessões residenciais em paralelo degradam e voltam
    // com render "magro" (mesma razão do BOT_CONCURRENCY=1).
    for (const ref of refs) {
      try {
        const r = await enrichOne(ref);
        if (r.cached) run.fromCache++;
        else run.scraped++;
        if (!r.ok) run.failed++;
      } catch {
        run.failed++;
      }
    }
    run.outcome = 'ok';
    run.message = `${refs.length} ref(s): ${run.fromCache} do cache, ${run.scraped} raspada(s), ${run.failed} sem dado.`;
    return run;
  } catch (e) {
    run.outcome = 'erro';
    run.message = (e as Error).message;
    return run;
  } finally {
    run.finishedAt = new Date().toISOString();
    console.log(`[autoSync] ${run.outcome}: ${run.message}`);
  }
}

/**
 * Roda UMA volta agora. Single-flight: se já houver uma rodando, devolve a mesma
 * (nunca duas voltas simultâneas abrindo sessões em dobro).
 */
export function runAutoSyncOnce(): Promise<AutoSyncRun> {
  if (running) return running;
  running = doRun().finally(() => {
    running = null;
  });
  return running;
}

/** Liga o laço (idempotente). Chamado uma vez no boot do servidor. */
export function startAutoSync(): void {
  const cfg = config.bot.autoSync;
  if (!cfg.enabled || timer) return;
  const tick = () => {
    nextRunAt = Date.now() + cfg.intervalMs;
    void runAutoSyncOnce();
  };
  nextRunAt = Date.now() + cfg.startDelayMs;
  setTimeout(() => {
    tick();
    timer = setInterval(tick, cfg.intervalMs);
  }, cfg.startDelayMs);
  console.log(
    `[autoSync] ligado: 1ª volta em ${Math.round(cfg.startDelayMs / 60_000)} min, depois a cada ${Math.round(cfg.intervalMs / 60_000)} min (até ${cfg.maxRefs} refs/volta).`,
  );
}

/** Estado para a UI/diagnóstico. */
export function getAutoSyncStatus() {
  const cfg = config.bot.autoSync;
  return {
    enabled: cfg.enabled,
    intervalMin: Math.round(cfg.intervalMs / 60_000),
    maxRefsPerRun: cfg.maxRefs,
    running: Boolean(running),
    nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
    lastRun,
  };
}
