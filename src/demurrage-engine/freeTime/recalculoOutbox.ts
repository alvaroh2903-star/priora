import { Pool } from 'pg';
import { CivilDate } from '../temporal/civilDate';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';

/**
 * Worker do OUTBOX de recálculo. Os itens nascem na MESMA transação que
 * promoveu o fato (ex.: Master Free Time); aqui eles são consumidos chamando o
 * orquestrador transacional `recalcularApuracaoContainer` (relógio Rocket →
 * exposição ao armador → lifecycle/prioridade → valores versionados).
 *
 * Concorrência: o claim usa `FOR UPDATE SKIP LOCKED` e transiciona o item para
 * PROCESSING com `worker_id` + `epoca` (fencing) — dois workers nunca pegam o
 * mesmo item. Um PROCESSING com `expira_em` vencido (worker morto) é
 * recuperável; FAILED é retentado até `maxTentativas`. A conclusão só é aceita
 * se a posse (worker/época) ainda for a atual.
 */

export interface ProcessarRecalculosInput {
  pool: Pool;
  hoje: CivilDate;
  workerId: string;
  limite?: number;
  ttlMs?: number;
  maxTentativas?: number;
  /** Injeção para teste; default: recalcularApuracaoContainer. */
  recalcular?: (pool: Pool, containerId: string, config: { dataReferencia: CivilDate }) => Promise<unknown>;
}

export interface ProcessarRecalculosResultado {
  reivindicados: number;
  concluidos: number;
  falhados: number;
}

export async function processarRecalculosPendentes(input: ProcessarRecalculosInput): Promise<ProcessarRecalculosResultado> {
  const limite = input.limite ?? 50;
  const ttl = Math.max(1, Math.floor((input.ttlMs ?? 10 * 60_000) / 1000));
  const maxTentativas = input.maxTentativas ?? 5;
  const recalcular = input.recalcular ?? recalcularApuracaoContainer;

  const { rows: itens } = await input.pool.query(
    `UPDATE recalculo_outbox o
        SET estado = 'PROCESSING', worker_id = $1, epoca = o.epoca + 1, tentativas = o.tentativas + 1,
            expira_em = now() + ($2 || ' seconds')::interval, atualizado_em = now()
      WHERE o.id IN (
        SELECT id FROM recalculo_outbox
         WHERE estado = 'PENDING'
            OR (estado = 'FAILED' AND tentativas < $3)
            OR (estado = 'PROCESSING' AND expira_em < now() AND tentativas < $3)
         ORDER BY criado_em
         FOR UPDATE SKIP LOCKED
         LIMIT $4)
      RETURNING id, container_id, epoca`,
    [input.workerId, String(ttl), maxTentativas, limite],
  );

  const out: ProcessarRecalculosResultado = { reivindicados: itens.length, concluidos: 0, falhados: 0 };
  for (const item of itens) {
    try {
      await recalcular(input.pool, item.container_id, { dataReferencia: input.hoje });
      const { rowCount } = await input.pool.query(
        `UPDATE recalculo_outbox SET estado = 'DONE', erro = NULL, concluido_em = now(), atualizado_em = now()
          WHERE id = $1 AND estado = 'PROCESSING' AND worker_id = $2 AND epoca = $3`,
        [item.id, input.workerId, item.epoca],
      );
      if ((rowCount ?? 0) > 0) out.concluidos++;
    } catch (erro: any) {
      await input.pool.query(
        `UPDATE recalculo_outbox SET estado = 'FAILED', erro = $4, atualizado_em = now()
          WHERE id = $1 AND estado = 'PROCESSING' AND worker_id = $2 AND epoca = $3`,
        [item.id, input.workerId, item.epoca, String(erro?.message ?? erro).slice(0, 500)],
      );
      out.falhados++;
    }
  }
  return out;
}
