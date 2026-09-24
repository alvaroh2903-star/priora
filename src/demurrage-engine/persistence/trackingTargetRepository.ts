import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { canonicalizarReferencia, CanonResult } from '../tracking/referenceCanonical';

/**
 * TrackingTarget (global) + vínculo N:N com contêineres. Identidade (revisão 10):
 * `armador + reference_value_canonical`. Grafias equivalentes da mesma referência
 * apontam para o MESMO target real (uma consulta reutilizável). A grafia bruta e
 * o `reference_type` de cada origem vivem no vínculo, não no target.
 */

export type ReferenceType = 'mbl' | 'hbl' | 'container' | 'booking' | 'desconhecido';

export interface TrackingTarget {
  id: string;
  armador: string;
  referenceValueCanonical: string;
}

export interface ContainerVinculado {
  containerId: string;
  numero: string;
  organizationId: string;
}

export interface UpsertResultado {
  target: TrackingTarget;
  canon: CanonResult;
}

function mapTarget(row: any): TrackingTarget {
  return { id: row.id, armador: row.armador, referenceValueCanonical: row.reference_value_canonical };
}

export class TrackingTargetRepository {
  constructor(private pool: Pool = getPool()) {}

  /**
   * Cria/reaproveita o target de (armador, referência canônica). Retorna também
   * o resultado da canonicalização (regra aplicada, `precisaMapping`,
   * `mismatchCarrier`) — o chamador decide sinalizar CARRIER_REFERENCE_MISMATCH,
   * mas NUNCA troca o armador automaticamente.
   */
  async upsert(input: { carrier: string; reference: string }): Promise<UpsertResultado> {
    const canon = canonicalizarReferencia(input.carrier, input.reference);
    const armador = (input.carrier || '').toLowerCase();
    const { rows } = await this.pool.query(
      `INSERT INTO tracking_targets (armador, reference_value_canonical)
       VALUES ($1, $2)
       ON CONFLICT (armador, reference_value_canonical) DO UPDATE SET atualizado_em = now()
       RETURNING *`,
      [armador, canon.canonical],
    );
    return { target: mapTarget(rows[0]), canon };
  }

  async findByCanonical(carrier: string, referenceCanonical: string): Promise<TrackingTarget | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tracking_targets WHERE armador = $1 AND reference_value_canonical = $2`,
      [(carrier || '').toLowerCase(), referenceCanonical],
    );
    return rows.length ? mapTarget(rows[0]) : null;
  }

  /** Vincula um contêiner a um target (idempotente), guardando o contexto de origem. */
  async linkContainer(
    containerId: string,
    trackingTargetId: string,
    ctx: { referenceType?: ReferenceType; referenceRaw?: string } = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO container_tracking_targets (container_id, tracking_target_id, reference_type, reference_raw)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (container_id, tracking_target_id) DO NOTHING`,
      [containerId, trackingTargetId, ctx.referenceType ?? null, ctx.referenceRaw ?? null],
    );
  }

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

  /** Vínculos de tracking de um contêiner, com o contexto (mbl/container + grafia bruta). */
  async linksForContainer(
    containerId: string,
  ): Promise<Array<{ target: TrackingTarget; referenceType: ReferenceType | null; referenceRaw: string | null }>> {
    const { rows } = await this.pool.query(
      `SELECT t.*, ctt.reference_type, ctt.reference_raw
         FROM container_tracking_targets ctt
         JOIN tracking_targets t ON t.id = ctt.tracking_target_id
        WHERE ctt.container_id = $1`,
      [containerId],
    );
    return rows.map((r) => ({ target: mapTarget(r), referenceType: r.reference_type, referenceRaw: r.reference_raw }));
  }

  /** Organizações afetadas por um target (via contêineres vinculados). */
  async orgsForTarget(trackingTargetId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT c.organization_id
         FROM container_tracking_targets ctt
         JOIN containers c ON c.id = ctt.container_id
        WHERE ctt.tracking_target_id = $1
        ORDER BY c.organization_id`,
      [trackingTargetId],
    );
    return rows.map((r) => r.organization_id);
  }

  /** Contêineres de UMA organização vinculados a um target (entrega segregada). */
  async containersForTargetAndOrg(trackingTargetId: string, organizationId: string): Promise<ContainerVinculado[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.numero, c.organization_id
         FROM container_tracking_targets ctt
         JOIN containers c ON c.id = ctt.container_id
        WHERE ctt.tracking_target_id = $1 AND c.organization_id = $2`,
      [trackingTargetId, organizationId],
    );
    return rows.map((r) => ({ containerId: r.id, numero: r.numero, organizationId: r.organization_id }));
  }

  async marcarConsultaManual(trackingTargetId: string, agora: Date): Promise<void> {
    await this.pool.query(`UPDATE tracking_targets SET ultima_consulta_manual_em = $2 WHERE id = $1`, [trackingTargetId, agora]);
  }

  async ultimaConsultaManual(trackingTargetId: string): Promise<Date | null> {
    const { rows } = await this.pool.query(`SELECT ultima_consulta_manual_em FROM tracking_targets WHERE id = $1`, [trackingTargetId]);
    return rows[0]?.ultima_consulta_manual_em ?? null;
  }
}
