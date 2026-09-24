import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { CivilDate } from '../temporal/civilDate';

/**
 * Persistência do worker do scheduler (revisão da Fase 6):
 *
 *  - CLAIM de janela: idempotência/concorrência em PostgreSQL. O primeiro worker
 *    a reivindicar (target, janela) executa; os demais desistem. Um claim
 *    'claimed' antigo (worker que morreu no meio) ou 'failed' pode ser
 *    reaproveitado — assim uma falha de processo não trava a janela para sempre.
 *
 *  - Carga dos contêineres rastreáveis: os dados de cadência (descarga, free
 *    times, devolução) + a data da última consulta do(s) target(s) do contêiner.
 *    A decisão de "está na janela?" é da política PURA (cadencePolicy); aqui só
 *    entregamos os fatos do banco.
 */

export interface ContainerCadenciaRow {
  containerId: string;
  dischargeDate: CivilDate | null;
  houseFreeTimeDays: number | null;
  masterFreeTimeDays: number | null;
  /** Devolução do vazio (efetiva > tracking): encerra o tracking automático. */
  emptyReturn: CivilDate | null;
  /** Data civil da última consulta de qualquer target vinculado ao contêiner. */
  ultimaConsulta: CivilDate | null;
}

export interface ClaimResultado {
  /** true se ESTE worker venceu o claim (deve consultar). */
  venceu: boolean;
}

export class SchedulerRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Contêineres com pelo menos um vínculo de tracking executável (MBL/CONTAINER),
   * com os fatos de cadência e a data da última consulta (max fetch) entre os
   * targets do contêiner. HBL não entra (não é target executável).
   */
  async carregarContainersRastreaveis(): Promise<ContainerCadenciaRow[]> {
    const { rows } = await this.pool.query(
      `SELECT
         c.id AS container_id,
         c.discharge_date,
         c.house_free_time_days,
         c.master_free_time_days,
         COALESCE(c.effective_return_date, c.tracking_return_date) AS empty_return,
         -- Última consulta AUTOMÁTICA = maior janela concluída (data civil do tick
         -- em que o worker consultou). Ancorada no claim, nao no timestamp "at"
         -- do armador, para a cadencia nao depender do relogio da API central.
         (SELECT max(sc.janela)
            FROM container_tracking_targets ctt2
            JOIN tracking_schedule_claims sc ON sc.tracking_target_id = ctt2.tracking_target_id
           WHERE ctt2.container_id = c.id AND sc.status = 'done') AS ultima_consulta
       FROM containers c
      WHERE EXISTS (
        SELECT 1 FROM container_tracking_targets ctt
         WHERE ctt.container_id = c.id
           AND ctt.reference_type IN ('mbl', 'container')
      )
      ORDER BY c.id`,
    );
    return rows.map((r) => ({
      containerId: r.container_id,
      dischargeDate: r.discharge_date,
      houseFreeTimeDays: r.house_free_time_days,
      masterFreeTimeDays: r.master_free_time_days,
      emptyReturn: r.empty_return,
      ultimaConsulta: r.ultima_consulta,
    }));
  }

  /**
   * Reivindica (target, janela). Retorna venceu=true só para UM chamador
   * concorrente. Um claim 'claimed' mais velho que `staleInterval` (worker que
   * morreu) ou 'failed' é reaproveitado. Barreira principal contra worker
   * duplicado (dois processos, ou reinício no meio da janela).
   */
  async claimJanela(
    trackingTargetId: string,
    janela: string,
    opts: { workerId?: string; staleInterval?: string } = {},
  ): Promise<ClaimResultado> {
    const staleInterval = opts.staleInterval ?? '30 minutes';
    const { rows } = await this.pool.query(
      `INSERT INTO tracking_schedule_claims (tracking_target_id, janela, status, tentativas, claimed_por, claimed_em)
       VALUES ($1, $2, 'claimed', 1, $3, now())
       ON CONFLICT (tracking_target_id, janela) DO UPDATE
         SET claimed_em = now(),
             tentativas = tracking_schedule_claims.tentativas + 1,
             claimed_por = $3,
             status = 'claimed',
             concluido_em = NULL,
             erro = NULL
         WHERE tracking_schedule_claims.status = 'failed'
            OR (tracking_schedule_claims.status = 'claimed'
                AND tracking_schedule_claims.claimed_em < now() - ($4::text)::interval)
       RETURNING id`,
      [trackingTargetId, janela, opts.workerId ?? null, staleInterval],
    );
    return { venceu: rows.length > 0 };
  }

  /** Marca a janela como concluída (sucesso) ou falha (reprocessável). */
  async concluirClaim(trackingTargetId: string, janela: string, ok: boolean, erro?: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE tracking_schedule_claims
          SET status = $3, concluido_em = now(), erro = $4
        WHERE tracking_target_id = $1 AND janela = $2`,
      [trackingTargetId, janela, ok ? 'done' : 'failed', ok ? null : (erro ?? 'falha')],
    );
  }
}
