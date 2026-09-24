import { Pool } from 'pg';
import { getPool } from '../db/pool';

/**
 * Persistência de TrackingFetch (auditoria de consumo) e TrackingEvent (eventos
 * normalizados, deduplicados no banco). Ambos append-only (trigger). O
 * `insertEvent` é idempotente pela UNIQUE(dedupe_hash) — seguro concorrente.
 */

export type FetchStatus = 'ok' | 'parcial' | 'falha';
export type TipoEvento = 'berth' | 'discharge' | 'available' | 'gate_out' | 'empty_return' | 'other';

export interface TrackingFetch {
  id: string;
  trackingTargetId: string;
  status: FetchStatus;
  cached: boolean;
  resolved: boolean;
  carrier: string | null;
  eventsCount: number;
  iniciadoEm: Date;
  finalizadoEm: Date;
  erro: string | null;
}

export interface RecordFetchInput {
  trackingTargetId: string;
  status: FetchStatus;
  cached: boolean;
  resolved: boolean;
  carrier?: string | null;
  eventsCount: number;
  iniciadoEm: Date;
  finalizadoEm: Date;
  erro?: string | null;
}

export interface InsertEventInput {
  trackingTargetId: string;
  trackingFetchId: string | null;
  containerNumero: string | null;
  tipoEvento: TipoEvento;
  dataEvento: string | null;
  statusDesc: string | null;
  location: string | null;
  vessel?: string | null;
  voyage?: string | null;
  dedupeHash: string;
  coletadoEm: Date;
}

function mapFetch(row: any): TrackingFetch {
  return {
    id: row.id,
    trackingTargetId: row.tracking_target_id,
    status: row.status,
    cached: row.cached,
    resolved: row.resolved,
    carrier: row.carrier,
    eventsCount: row.events_count,
    iniciadoEm: row.iniciado_em,
    finalizadoEm: row.finalizado_em,
    erro: row.erro,
  };
}

export class TrackingRepository {
  constructor(private pool: Pool = getPool()) {}

  async recordFetch(input: RecordFetchInput): Promise<TrackingFetch> {
    const { rows } = await this.pool.query(
      `INSERT INTO tracking_fetches
         (tracking_target_id, status, cached, resolved, carrier, events_count, iniciado_em, finalizado_em, erro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        input.trackingTargetId, input.status, input.cached, input.resolved, input.carrier ?? null,
        input.eventsCount, input.iniciadoEm, input.finalizadoEm, input.erro ?? null,
      ],
    );
    return mapFetch(rows[0]);
  }

  /** Insere um evento; no-op idempotente se o dedupe_hash já existe. */
  async insertEvent(input: InsertEventInput): Promise<{ inserted: boolean; id: string | null }> {
    const { rows } = await this.pool.query(
      `INSERT INTO tracking_events
         (tracking_target_id, tracking_fetch_id, container_numero, tipo_evento, data_evento,
          status_desc, location, vessel, voyage, external_event_id, raw_ref, dedupe_hash, coletado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NULL, NULL, $10, $11)
       ON CONFLICT (dedupe_hash) DO NOTHING
       RETURNING id`,
      [
        input.trackingTargetId, input.trackingFetchId, input.containerNumero, input.tipoEvento,
        input.dataEvento, input.statusDesc, input.location, input.vessel ?? null, input.voyage ?? null,
        input.dedupeHash, input.coletadoEm,
      ],
    );
    return rows.length ? { inserted: true, id: rows[0].id } : { inserted: false, id: null };
  }

  async listEvents(trackingTargetId: string): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tracking_events WHERE tracking_target_id = $1 ORDER BY data_evento NULLS LAST, criado_em`,
      [trackingTargetId],
    );
    return rows;
  }

  async listFetches(trackingTargetId: string): Promise<TrackingFetch[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM tracking_fetches WHERE tracking_target_id = $1 ORDER BY criado_em`,
      [trackingTargetId],
    );
    return rows.map(mapFetch);
  }
}
