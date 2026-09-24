import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { normalizarReferencia } from '../sources/armadorTrackingSource';

/**
 * TrackingTarget (global) + vínculo N:N com contêineres. Um target representa
 * uma referência rastreável e pode alimentar vários contêineres/módulos.
 */

export type ReferenceType = 'mbl' | 'hbl' | 'container' | 'booking' | 'desconhecido';

export interface TrackingTarget {
  id: string;
  referenceValue: string;
  referenceType: ReferenceType;
  armador: string | null;
}

export interface ContainerVinculado {
  containerId: string;
  numero: string;
  organizationId: string;
}

function mapTarget(row: any): TrackingTarget {
  return { id: row.id, referenceValue: row.reference_value, referenceType: row.reference_type, armador: row.armador };
}

export class TrackingTargetRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Cria (ou reaproveita) o target da referência. A identidade é a referência
   * normalizada — um target por ref, como a chave de cache da API central.
   * `reference_type`/`armador` são metadados; atualiza o armador quando detectado.
   */
  async upsert(input: { reference: string; referenceType: ReferenceType; armador?: string | null }): Promise<TrackingTarget> {
    const referenceValue = normalizarReferencia(input.reference);
    const { rows } = await this.pool.query(
      `INSERT INTO tracking_targets (reference_value, reference_type, armador)
       VALUES ($1, $2, $3)
       ON CONFLICT (reference_value) DO UPDATE SET
         armador = COALESCE(EXCLUDED.armador, tracking_targets.armador),
         atualizado_em = now()
       RETURNING *`,
      [referenceValue, input.referenceType, input.armador ?? null],
    );
    return mapTarget(rows[0]);
  }

  async findByReference(reference: string): Promise<TrackingTarget | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tracking_targets WHERE reference_value = $1`,
      [normalizarReferencia(reference)],
    );
    return rows.length ? mapTarget(rows[0]) : null;
  }

  /** Vincula um contêiner a um target (idempotente). */
  async linkContainer(containerId: string, trackingTargetId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO container_tracking_targets (container_id, tracking_target_id)
       VALUES ($1, $2) ON CONFLICT (container_id, tracking_target_id) DO NOTHING`,
      [containerId, trackingTargetId],
    );
  }

  /** Contêineres (com organização) que este target alimenta. */
  async containersForTarget(trackingTargetId: string): Promise<ContainerVinculado[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.numero, c.organization_id
         FROM container_tracking_targets ctt
         JOIN containers c ON c.id = ctt.container_id
        WHERE ctt.tracking_target_id = $1`,
      [trackingTargetId],
    );
    return rows.map((r) => ({ containerId: r.id, numero: r.numero, organizationId: r.organization_id }));
  }

  async targetsForContainer(containerId: string): Promise<TrackingTarget[]> {
    const { rows } = await this.pool.query(
      `SELECT t.* FROM container_tracking_targets ctt
         JOIN tracking_targets t ON t.id = ctt.tracking_target_id
        WHERE ctt.container_id = $1`,
      [containerId],
    );
    return rows.map(mapTarget);
  }
}
