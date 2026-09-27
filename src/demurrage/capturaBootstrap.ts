import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { startSchedulerLoop, SchedulerLoopHandle } from '../demurrage-engine/scheduler/schedulerLoop';
import {
  AbrirCaixa,
  CaixaCaptura,
  INTERVALO_CAPTURA_MS,
  capturaHabilitada,
  executarCicloCaptura,
} from '../demurrage-engine/shippingInstructions/capturaPreAlerta';
import { obterTokenGraphParaCaixa } from '../auth/backgroundToken';
import { criarPortaCaixaPostal } from './capturaPreAlertaPorts';

/** Abre a caixa em BACKGROUND: token da conta ativa (MVP: uma conta por vez) → porta real do Graph. */
const abrirCaixaPadrao: AbrirCaixa = async (caixa: CaixaCaptura) => {
  const t = await obterTokenGraphParaCaixa(caixa.home_account_id);
  if ('indisponivel' in t) return { indisponivel: t.indisponivel };
  return { porta: criarPortaCaixaPostal(t.token) };
};

/**
 * Ponto de partida do CICLO PRÓPRIO da captura automática do pré-alerta —
 * SEPARADO do scheduler da Demurrage (`schedulerBootstrap.ts`). Kill switch
 * (`PRIORA_CAPTURA_PRE_ALERTA=off`) e qualquer falha aqui nunca tocam
 * tracking, relógios, apuração ou o tick principal: o laço tem seu próprio
 * `startSchedulerLoop` (mesma guarda de overlap local; o claim/lease em
 * PostgreSQL é a proteção definitiva contra duplicidade entre instâncias).
 *
 * Só liga se o banco da engine estiver configurado — mesma regra do
 * scheduler da Demurrage. Sem isso, ou com o kill switch, retorna null e o
 * app sobe normalmente.
 */
export function iniciarCapturaPreAlerta(opts: { intervalMs?: number; pool?: Pool } = {}): SchedulerLoopHandle | null {
  if (!capturaHabilitada()) {
    console.log('[captura-pre-alerta] desligada por PRIORA_CAPTURA_PRE_ALERTA=off — laço não iniciado.');
    return null;
  }
  const temBanco = Boolean(opts.pool || (process.env.DEMURRAGE_DATABASE_URL || process.env.DATABASE_URL || '').trim());
  if (!temBanco) {
    console.warn('[captura-pre-alerta] DEMURRAGE_DATABASE_URL/DATABASE_URL ausente — laço não iniciado.');
    return null;
  }
  const pool = opts.pool ?? getPool();
  const workerId = `captura-${process.pid}`;

  const tick = async (): Promise<void> => {
    const r = await executarCicloCaptura({ pool, abrirCaixa: abrirCaixaPadrao, workerId });
    console.log(
      `[captura-pre-alerta] ciclo: caixas=${r.caixas} páginas=${r.paginas} mensagens=${r.mensagens} ` +
      `candidatas=${r.candidatas} registradas=${r.registradas} rejeitadas=${r.rejeitadas} ` +
      `ingeridas=${r.ingeridas} pendentes=${r.pendentes} falhas=${r.falhas}${r.limiteAtingido ? ' (limite atingido)' : ''}`,
    );
  };

  return startSchedulerLoop({
    tick,
    intervalMs: opts.intervalMs ?? INTERVALO_CAPTURA_MS,
    runOnStart: true, // recupera o atraso acumulado desde o boot, sem esperar o intervalo inteiro
    onError: (err) => console.error('[captura-pre-alerta] erro no ciclo (isolado; tracking/apuração não afetados):', err),
  });
}
