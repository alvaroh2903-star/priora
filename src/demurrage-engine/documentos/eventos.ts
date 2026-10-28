import { Pool, PoolClient } from 'pg';

/**
 * Produção P1 (arquivos de minuta) — eventos de auditoria do documento
 * armazenado (`documentos_armazenados_eventos`, append-only). Módulo próprio,
 * sem dependências, para o registro de minuta (`closing/minutaTecnica.ts`)
 * gravar o vínculo/substituição na MESMA transação sem ciclo de importação.
 */

export interface EventoDocumento {
  organizationId: string;
  documentoId: string;
  tipo: string;
  ator?: { membershipId: string; usuarioId: string } | null;
  operador?: string | null;
  detalhes?: Record<string, unknown>;
  correlacaoId?: string | null;
}

/** Evento de auditoria append-only. NUNCA leva chave do objeto, URL, credencial ou corpo do provedor. */
export async function registrarEventoDocumento(db: Pool | PoolClient, e: EventoDocumento): Promise<void> {
  await db.query(
    `INSERT INTO documentos_armazenados_eventos
       (organization_id, documento_id, tipo, ator_membership_id, ator_usuario_id, automatico, operador, detalhes, correlacao_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [e.organizationId, e.documentoId, e.tipo, e.ator?.membershipId ?? null, e.ator?.usuarioId ?? null, !e.ator,
      e.operador ?? null, JSON.stringify(e.detalhes ?? {}), e.correlacaoId ?? null],
  );
}
