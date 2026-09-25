import { Pool } from 'pg';
import { getPool } from '../db/pool';

/**
 * Log append-only (timeline) do ciclo de fechamento (Fase 8). NÃO é
 * field_observations — não são observações de campo. Diferencia evento
 * automático de ação humana e preserva ator/data-hora/evidência.
 */

export type TipoEventoFechamento =
  | 'EMPTY_RETURN' | 'MINUTA_RECEBIDA' | 'MINUTA_VALIDADA' | 'MINUTA_REJEITADA'
  | 'DIVERGENCIA_TRACKING_MINUTA' | 'RECALCULO' | 'FECHAMENTO_FINAL'
  | 'REABERTURA_SOLICITADA' | 'REABERTURA_AUTORIZADA' | 'REABERTURA' | 'REFECHAMENTO';

export interface ClosingEvent {
  id: string;
  processoId: string | null;
  containerId: string | null;
  tipoEvento: TipoEventoFechamento;
  origem: 'automatico' | 'humano';
  atorUsuarioId: string | null;
  evidenciaRef: string | null;
  payload: unknown;
  criadoEm: Date;
}

export class ClosingEventRepository {
  constructor(private pool: Pool = getPool()) {}

  async registrar(input: {
    processoId?: string | null; containerId?: string | null;
    tipoEvento: TipoEventoFechamento; origem: 'automatico' | 'humano';
    atorUsuarioId?: string | null; evidenciaRef?: string | null; payload?: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO closing_events (processo_id, container_id, tipo_evento, origem, ator_usuario_id, evidencia_ref, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.processoId ?? null, input.containerId ?? null, input.tipoEvento, input.origem,
        input.atorUsuarioId ?? null, input.evidenciaRef ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload),
      ],
    );
  }

  async listByProcesso(processoId: string): Promise<ClosingEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM closing_events WHERE processo_id = $1 ORDER BY criado_em, id`,
      [processoId],
    );
    return rows.map((r) => ({
      id: r.id, processoId: r.processo_id, containerId: r.container_id, tipoEvento: r.tipo_evento,
      origem: r.origem, atorUsuarioId: r.ator_usuario_id, evidenciaRef: r.evidencia_ref,
      payload: r.payload, criadoEm: r.criado_em,
    }));
  }
}
