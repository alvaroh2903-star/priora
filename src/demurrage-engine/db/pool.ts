import { Pool, PoolConfig, types } from 'pg';

/**
 * Conexão PostgreSQL da Demurrage Engine V2 — isolada de src/config.ts de
 * propósito (nenhum arquivo existente da V1/infra compartilhada é alterado
 * pela Fase 1). Lê DATABASE_URL diretamente; sem fallback para SQLite
 * (decisão final #2, revisão 4: Postgres é definitivo desde a Fase 1).
 *
 * Datas civis como string, nunca como Date (ponto 10, revisão 4): por
 * padrão o driver `pg` converte colunas DATE (OID 1082) em objetos
 * JavaScript `Date` (à meia-noite UTC), reintroduzindo exatamente a
 * ambiguidade de fuso horário que "datas civis para contagem de demurrage"
 * pretende evitar. Registramos um parser que devolve a string 'AAAA-MM-DD'
 * como o Postgres a envia, sem conversão.
 */
types.setTypeParser(1082 /* date */, (value: string) => value);

let pool: Pool | null = null;

function buildConfig(): PoolConfig {
  const connectionString = (process.env.DEMURRAGE_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error(
      'DEMURRAGE_DATABASE_URL (ou DATABASE_URL) não definida. A Demurrage Engine V2 exige PostgreSQL — configure a connection string antes de rodar migrations, repositórios ou testes.',
    );
  }
  return { connectionString };
}

/** Pool compartilhado (lazy — só conecta quando algo pedir uma query). */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildConfig());
  }
  return pool;
}

/** Fecha o pool — usado por testes e por scripts de curta duração (ex.: migrate). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
