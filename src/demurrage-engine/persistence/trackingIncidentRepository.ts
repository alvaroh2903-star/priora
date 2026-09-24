import { Pool } from 'pg';
import { getPool } from '../db/pool';

/**
 * Incidente técnico (global por TrackingTarget) e suas entregas de alerta.
 * O incidente técnico é ÚNICO; a entrega técnica é global (uma por incidente),
 * e as entregas operacionais são segregadas por organização (uma por incidente
 * + organização) — nunca misturam organizações. Idempotente por constraints.
 */

export interface TrackingIncident {
  id: string;
  trackingTargetId: string;
  seq: number;
  abertoEm: Date;
  fechadoEm: Date | null;
  motivo: string | null;
}

export type EscopoEntrega = 'tecnico_global' | 'operacional_org';

export interface AlertDelivery {
  id: string;
  incidentId: string;
  escopo: EscopoEntrega;
  organizationId: string | null;
}

function mapIncident(row: any): TrackingIncident {
  return {
    id: row.id,
    trackingTargetId: row.tracking_target_id,
    seq: row.seq,
    abertoEm: row.aberto_em,
    fechadoEm: row.fechado_em,
    motivo: row.motivo,
  };
}

export class TrackingIncidentRepository {
  constructor(private pool: Pool = getPool()) {}

  async incidenteAberto(trackingTargetId: string): Promise<TrackingIncident | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tracking_incidents WHERE tracking_target_id = $1 AND fechado_em IS NULL`,
      [trackingTargetId],
    );
    return rows.length ? mapIncident(rows[0]) : null;
  }

  /** Abre um incidente (idempotente pelo índice parcial de "aberto único"). */
  async abrir(trackingTargetId: string, motivo: string): Promise<TrackingIncident> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jaAberto = await client.query(
        `SELECT * FROM tracking_incidents WHERE tracking_target_id = $1 AND fechado_em IS NULL FOR UPDATE`,
        [trackingTargetId],
      );
      if (jaAberto.rows.length) {
        await client.query('COMMIT');
        return mapIncident(jaAberto.rows[0]);
      }
      const { rows: [{ prox }] } = await client.query(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS prox FROM tracking_incidents WHERE tracking_target_id = $1`,
        [trackingTargetId],
      );
      const { rows } = await client.query(
        `INSERT INTO tracking_incidents (tracking_target_id, seq, motivo) VALUES ($1, $2, $3) RETURNING *`,
        [trackingTargetId, prox, motivo],
      );
      await client.query('COMMIT');
      return mapIncident(rows[0]);
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    } finally {
      client.release();
    }
  }

  /** Fecha o incidente aberto do target (sucesso reseta a sequência). */
  async fecharPorSucesso(trackingTargetId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE tracking_incidents SET fechado_em = now() WHERE tracking_target_id = $1 AND fechado_em IS NULL`,
      [trackingTargetId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Entrega técnica global (uma por incidente). */
  async registrarEntregaTecnica(incidentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO tracking_alert_deliveries (incident_id, escopo, organization_id)
       VALUES ($1, 'tecnico_global', NULL)
       ON CONFLICT DO NOTHING`,
      [incidentId],
    );
  }

  /** Entrega operacional de UMA organização (uma por incidente + org). */
  async registrarEntregaOrg(incidentId: string, organizationId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO tracking_alert_deliveries (incident_id, escopo, organization_id)
       VALUES ($1, 'operacional_org', $2)
       ON CONFLICT (incident_id, organization_id) DO NOTHING`,
      [incidentId, organizationId],
    );
  }

  async entregas(incidentId: string): Promise<AlertDelivery[]> {
    const { rows } = await this.pool.query(
      `SELECT id, incident_id, escopo, organization_id FROM tracking_alert_deliveries WHERE incident_id = $1
        ORDER BY escopo, organization_id NULLS FIRST`,
      [incidentId],
    );
    return rows.map((r) => ({ id: r.id, incidentId: r.incident_id, escopo: r.escopo, organizationId: r.organization_id }));
  }
}
