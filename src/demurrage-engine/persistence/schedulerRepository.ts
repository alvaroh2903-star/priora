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
  /**
   * D16 v1.1 — token de posse desta reivindicação (claim OU retomada de
   * claim expirado). null quando `venceu` é false. Exigido por
   * `concluirClaim`: é a prova de que quem está finalizando é quem detém a
   * posse ATUAL, nunca um worker anterior que perdeu a janela por timeout.
   */
  claimToken: string | null;
}

export type ConcluirClaimResultado =
  | { aplicado: true }
  /** Outro worker já retomou esta janela (posse perdida) — nada foi alterado. */
  | { aplicado: false; motivo: 'posse_perdida' };

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
   *
   * D16 v1.1 (fencing, R60): toda reivindicação — claim novo OU retomada de
   * claim expirado — recebe um `claimToken` (UUID) novo. É esse token, não
   * (target, janela) sozinho, que prova a posse ATUAL na hora de finalizar
   * (`concluirClaim`): um worker que perdeu a janela por timeout não detém o
   * token vigente e por isso nunca consegue finalizar a posse de quem a
   * retomou.
   */
  async claimJanela(
    trackingTargetId: string,
    janela: string,
    opts: { workerId?: string; staleInterval?: string } = {},
  ): Promise<ClaimResultado> {
    const staleInterval = opts.staleInterval ?? '30 minutes';
    const { rows } = await this.pool.query(
      `INSERT INTO tracking_schedule_claims (tracking_target_id, janela, status, tentativas, claimed_por, claimed_em, claim_token)
       VALUES ($1, $2, 'claimed', 1, $3, now(), gen_random_uuid())
       ON CONFLICT (tracking_target_id, janela) DO UPDATE
         SET claimed_em = now(),
             tentativas = tracking_schedule_claims.tentativas + 1,
             claimed_por = $3,
             status = 'claimed',
             concluido_em = NULL,
             erro = NULL,
             claim_token = gen_random_uuid()
         WHERE tracking_schedule_claims.status = 'failed'
            OR (tracking_schedule_claims.status = 'claimed'
                AND tracking_schedule_claims.claimed_em < now() - ($4::text)::interval)
       RETURNING id, claim_token`,
      [trackingTargetId, janela, opts.workerId ?? null, staleInterval],
    );
    if (rows.length === 0) return { venceu: false, claimToken: null };
    return { venceu: true, claimToken: rows[0].claim_token };
  }

  /**
   * Marca a janela como concluída (sucesso) ou falha (reprocessável) — só se
   * `claimToken` ainda for o vigente (D16 v1.1, fencing). Se outro worker já
   * retomou a janela (posse perdida), nada é alterado e o motivo explícito
   * `posse_perdida` é devolvido — nunca uma finalização silenciosa sobre o
   * claim de outro worker.
   */
  async concluirClaim(
    trackingTargetId: string,
    janela: string,
    claimToken: string,
    ok: boolean,
    erro?: string | null,
  ): Promise<ConcluirClaimResultado> {
    const { rowCount } = await this.pool.query(
      `UPDATE tracking_schedule_claims
          SET status = $4, concluido_em = now(), erro = $5, claim_token = NULL
        WHERE tracking_target_id = $1 AND janela = $2 AND status = 'claimed' AND claim_token = $3`,
      [trackingTargetId, janela, claimToken, ok ? 'done' : 'failed', ok ? null : (erro ?? 'falha')],
    );
    if (!rowCount) return { aplicado: false, motivo: 'posse_perdida' };
    return { aplicado: true };
  }
}
