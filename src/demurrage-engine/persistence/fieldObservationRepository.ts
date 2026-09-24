import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { FieldObservation, FieldObservationEntityType, FieldObservationSource } from '../domain/types';

function mapRow(row: any): FieldObservation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    entidadeTipo: row.entidade_tipo,
    entidadeId: row.entidade_id,
    campo: row.campo,
    valor: row.valor,
    fonte: row.fonte,
    observadoEm: row.observado_em,
    coletadoEm: row.coletado_em,
    evidenciaRef: row.evidencia_ref,
    criadoPor: row.criado_por,
    criadoEm: row.criado_em,
  };
}

export interface InsertFieldObservationInput {
  organizationId: string;
  entidadeTipo: FieldObservationEntityType;
  entidadeId: string;
  campo: string;
  valor: unknown;
  fonte: FieldObservationSource;
  observadoEm: Date;
  evidenciaRef?: string | null;
  criadoPor?: string | null;
}

/**
 * FieldObservation é append-only (imposto por trigger no Postgres — ver
 * migration 0004). Este repositório só sabe inserir e consultar; não existe
 * (nem pode existir) um método update/delete.
 */
export class FieldObservationRepository {
  constructor(private pool: Pool = getPool()) {}

  async insert(input: InsertFieldObservationInput): Promise<FieldObservation> {
    const { rows } = await this.pool.query(
      `INSERT INTO field_observations
         (organization_id, entidade_tipo, entidade_id, campo, valor, fonte, observado_em, evidencia_ref, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (entidade_tipo, entidade_id, campo, fonte, observado_em) DO NOTHING
       RETURNING *`,
      [
        input.organizationId,
        input.entidadeTipo,
        input.entidadeId,
        input.campo,
        JSON.stringify(input.valor),
        input.fonte,
        input.observadoEm,
        input.evidenciaRef ?? null,
        input.criadoPor ?? null,
      ],
    );
    if (rows[0]) return mapRow(rows[0]);
    // ON CONFLICT DO NOTHING: a mesma fonte já registrou este valor neste
    // instante exato (reingestão idempotente) — devolve a observação existente.
    const { rows: existing } = await this.pool.query(
      `SELECT * FROM field_observations
       WHERE entidade_tipo = $1 AND entidade_id = $2 AND campo = $3 AND fonte = $4 AND observado_em = $5`,
      [input.entidadeTipo, input.entidadeId, input.campo, input.fonte, input.observadoEm],
    );
    return mapRow(existing[0]);
  }

  async findById(id: string): Promise<FieldObservation | null> {
    const { rows } = await this.pool.query(`SELECT * FROM field_observations WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listForEntity(
    entidadeTipo: FieldObservationEntityType,
    entidadeId: string,
    campo?: string,
  ): Promise<FieldObservation[]> {
    const { rows } = campo
      ? await this.pool.query(
          `SELECT * FROM field_observations WHERE entidade_tipo = $1 AND entidade_id = $2 AND campo = $3 ORDER BY observado_em ASC`,
          [entidadeTipo, entidadeId, campo],
        )
      : await this.pool.query(
          `SELECT * FROM field_observations WHERE entidade_tipo = $1 AND entidade_id = $2 ORDER BY observado_em ASC`,
          [entidadeTipo, entidadeId],
        );
    return rows.map(mapRow);
  }
}
