import { Pool } from 'pg';

/**
 * Produção P1 (Entrega 2) — leituras ESTREITAS usadas só para traduzir um
 * retry seguro do serviço congelado (`ja_final`, `reabertura_ja_aberta`,
 * `reabertura_ja_autorizada`) num resultado idempotente coerente na rota,
 * sem chamar o serviço de novo e sem reimplementar nenhuma regra — só
 * devolve o que já está persistido.
 */

export async function buscarFechamentoMaisRecente(pool: Pool, processoId: string): Promise<{ id: string; criadoEm: Date } | null> {
  const { rows } = await pool.query(
    `SELECT id, criado_em AS "criadoEm" FROM fechamentos WHERE processo_id = $1 ORDER BY criado_em DESC LIMIT 1`,
    [processoId],
  );
  return rows[0] ?? null;
}

export async function buscarReaberturaPorId(pool: Pool, reaberturaId: string): Promise<{ id: string; estado: string } | null> {
  const { rows } = await pool.query(`SELECT id, estado FROM reaberturas WHERE id = $1`, [reaberturaId]);
  return rows[0] ?? null;
}
