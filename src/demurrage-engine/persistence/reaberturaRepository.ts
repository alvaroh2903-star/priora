import { Pool } from 'pg';
import { getPool } from '../db/pool';

/**
 * Persistência da Reabertura (Fase 8, Cap. 31.12). Preserva os valores
 * anteriores em `valores_anteriores` (snapshot, nunca sobrescrito) para
 * comparação. A autorização é do closingService (RBAC MANAGER/ADMIN).
 */

export type EstadoReabertura = 'SOLICITADA' | 'AUTORIZADA' | 'RECALCULADA' | 'REFECHADA';

export interface Reabertura {
  id: string;
  processoId: string;
  estado: EstadoReabertura;
  solicitadaPor: string | null;
  autorizadaPor: string | null;
  justificativa: string | null;
  valoresAnteriores: unknown;
}

function mapRow(r: any): Reabertura {
  return {
    id: r.id, processoId: r.processo_id, estado: r.estado,
    solicitadaPor: r.solicitada_por, autorizadaPor: r.autorizada_por,
    justificativa: r.justificativa, valoresAnteriores: r.valores_anteriores,
  };
}

export class ReaberturaRepository {
  constructor(private pool: Pool = getPool()) {}

  async criarSolicitada(processoId: string, solicitadaPor: string | null, justificativa: string): Promise<Reabertura> {
    const { rows } = await this.pool.query(
      `INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa)
       VALUES ($1, 'SOLICITADA', $2, $3) RETURNING *`,
      [processoId, solicitadaPor, justificativa],
    );
    return mapRow(rows[0]);
  }

  async autorizar(id: string, autorizadaPor: string | null, valoresAnteriores: unknown): Promise<Reabertura> {
    const { rows } = await this.pool.query(
      `UPDATE reaberturas SET estado = 'AUTORIZADA', autorizada_por = $2, valores_anteriores = $3, atualizado_em = now()
       WHERE id = $1 RETURNING *`,
      [id, autorizadaPor, valoresAnteriores === undefined ? null : JSON.stringify(valoresAnteriores)],
    );
    return mapRow(rows[0]);
  }

  async marcarEstado(id: string, estado: EstadoReabertura): Promise<void> {
    await this.pool.query(`UPDATE reaberturas SET estado = $2, atualizado_em = now() WHERE id = $1`, [id, estado]);
  }

  async abertaDoProcesso(processoId: string): Promise<Reabertura | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM reaberturas WHERE processo_id = $1 AND estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA')
        ORDER BY criado_em DESC LIMIT 1`,
      [processoId],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }
}
