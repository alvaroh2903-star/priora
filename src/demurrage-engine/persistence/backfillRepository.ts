import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { BackfillItem, BackfillItemResultado, BackfillRun, BackfillRunStatus } from '../domain/types';

function mapRun(row: any): BackfillRun {
  return {
    id: row.id,
    organizationId: row.organization_id,
    executadoEm: row.executado_em,
    status: row.status,
    processosProcessados: row.processos_processados,
    camposMarcadosPendentes: row.campos_marcados_pendentes,
    erros: row.erros,
  };
}

function mapItem(row: any): BackfillItem {
  return {
    id: row.id,
    backfillRunId: row.backfill_run_id,
    entidadeTipo: row.entidade_tipo,
    entidadeId: row.entidade_id,
    resultado: row.resultado,
    detalhe: row.detalhe,
    criadoEm: row.criado_em,
  };
}

/**
 * BackfillRun é OPERACIONAL (mutável in-place — reclassificado na revisão 4,
 * ver plano de migração); BackfillItem é append-only (trigger no Postgres).
 */
export class BackfillRepository {
  constructor(private pool: Pool = getPool()) {}

  async startRun(organizationId: string): Promise<BackfillRun> {
    const { rows } = await this.pool.query(
      `INSERT INTO backfill_runs (organization_id) VALUES ($1) RETURNING *`,
      [organizationId],
    );
    return mapRun(rows[0]);
  }

  async finishRun(
    runId: string,
    counters: { processosProcessados: number; camposMarcadosPendentes: number; erros: unknown[] },
  ): Promise<BackfillRun> {
    const { rows } = await this.pool.query(
      `UPDATE backfill_runs
       SET status = 'concluido', processos_processados = $2, campos_marcados_pendentes = $3, erros = $4
       WHERE id = $1 RETURNING *`,
      [runId, counters.processosProcessados, counters.camposMarcadosPendentes, JSON.stringify(counters.erros)],
    );
    return mapRun(rows[0]);
  }

  async findRunById(id: string): Promise<BackfillRun | null> {
    const { rows } = await this.pool.query(`SELECT * FROM backfill_runs WHERE id = $1`, [id]);
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async addItem(
    runId: string,
    entidadeTipo: string,
    entidadeId: string,
    resultado: BackfillItemResultado,
    detalhe: Record<string, unknown> | null = null,
  ): Promise<BackfillItem> {
    const { rows } = await this.pool.query(
      `INSERT INTO backfill_items (backfill_run_id, entidade_tipo, entidade_id, resultado, detalhe)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [runId, entidadeTipo, entidadeId, resultado, detalhe ? JSON.stringify(detalhe) : null],
    );
    return mapItem(rows[0]);
  }

  async listItemsForRun(runId: string): Promise<BackfillItem[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM backfill_items WHERE backfill_run_id = $1 ORDER BY criado_em ASC`,
      [runId],
    );
    return rows.map(mapItem);
  }
}

export type { BackfillRunStatus };
