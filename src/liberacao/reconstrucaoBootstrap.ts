import { Pool } from 'pg';
import { getPool } from '../demurrage-engine/db/pool';
import { SchedulerLoopHandle, startSchedulerLoop } from '../demurrage-engine/scheduler/schedulerLoop';
import { fatosDuraveisHabilitados } from '../operacional/contexto';
import { RECONSTRUCAO_PADRAO, erroSaneado, executarPassoReconstrucao, reconstrucaoHabilitada } from './aplicacao';

/**
 * G-3c — laço PRÓPRIO da reconstrução das projeções legadas da Liberação, separado do scheduler da Demurrage e da
 * captura do pré-alerta. Só liga com o interruptor dedicado (`PRIORA_LIBERACAO_RECONSTRUCAO=on`), com a Liberação
 * ligada (`PRIORA_FATOS_DURAVEIS`) e com banco configurado; o interruptor é relido a cada tick (desligar para só a
 * reconstrução). Cada tick é limitado (descoberta e lote); a posse em PostgreSQL protege contra duplicidade entre
 * instâncias. Logs: só contagens (nenhum processo, organização ou evidência).
 */
export function iniciarReconstrucaoLiberacao(opts: { intervalMs?: number; pool?: Pool } = {}): SchedulerLoopHandle | null {
  if (!reconstrucaoHabilitada()) {
    console.log('[liberacao-reconstrucao] desligada (PRIORA_LIBERACAO_RECONSTRUCAO≠on) — laço não iniciado.');
    return null;
  }
  if (!fatosDuraveisHabilitados()) {
    console.log('[liberacao-reconstrucao] Liberação desligada (PRIORA_FATOS_DURAVEIS) — laço não iniciado.');
    return null;
  }
  const temBanco = Boolean(opts.pool || (process.env.DEMURRAGE_DATABASE_URL || process.env.DATABASE_URL || '').trim());
  if (!temBanco) {
    console.warn('[liberacao-reconstrucao] DEMURRAGE_DATABASE_URL/DATABASE_URL ausente — laço não iniciado.');
    return null;
  }
  const pool = opts.pool ?? getPool();
  const dono = `reconstrucao-${process.pid}`;
  const tick = async (): Promise<void> => {
    const r = await executarPassoReconstrucao(pool, { dono });
    if (r.desligada) {
      console.log('[liberacao-reconstrucao] tick ignorado: interruptor desligado.');
      return;
    }
    console.log(
      `[liberacao-reconstrucao] tick: descobertos=${r.descobertos} reivindicados=${r.reivindicados} concluidos=${r.concluidos} ` +
      `ja_atuais=${r.jaAtuais} falhas=${r.falhas} esgotados=${r.esgotados} posses_perdidas=${r.possesPerdidas}`,
    );
  };
  return startSchedulerLoop({
    tick,
    intervalMs: opts.intervalMs ?? RECONSTRUCAO_PADRAO.intervaloMs,
    runOnStart: true,
    onError: (err) => console.error('[liberacao-reconstrucao] erro no tick (isolado; recálculo normal não afetado):', erroSaneado(err)),
  });
}
