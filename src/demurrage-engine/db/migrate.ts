import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { getPool, closePool } from './pool';

/**
 * Runner de migrations minimalista — só o necessário para aplicar os `.sql`
 * de `migrations/` em ordem, uma vez cada, dentro de uma transação por
 * arquivo. Sem ORM (decisão final #2: nenhuma dependência de fornecedor além
 * do próprio PostgreSQL) — cada `.sql` é DDL real, com FKs/constraints/
 * triggers escritos à mão para controle total sobre a integridade do modelo.
 */

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Aplica as migrations pendentes, em ordem lexical, cada uma em sua própria transação. Idempotente: reexecutar não reaplica o que já está em `schema_migrations`. */
export async function runMigrations(pool: Pool = getPool()): Promise<MigrationResult> {
  await ensureMigrationsTable(pool);

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const filename of listMigrationFiles()) {
    if (applied.has(filename)) {
      result.alreadyApplied.push(filename);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      result.applied.push(filename);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Falha ao aplicar migration ${filename}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return result;
}

/* istanbul ignore next -- entrada de CLI, coberta por teste de integração via runMigrations() */
if (require.main === module) {
  runMigrations()
    .then((result) => {
      console.log(`Migrations aplicadas: ${result.applied.length}`, result.applied);
      console.log(`Já estavam aplicadas: ${result.alreadyApplied.length}`);
      return closePool();
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closePool();
    });
}
