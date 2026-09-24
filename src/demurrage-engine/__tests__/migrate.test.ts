import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl } from './testDb';

const url = testDatabaseUrl();

test('migrations: aplica todas as migrations pendentes em um banco novo e é idempotente ao reexecutar', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const first = await runMigrations(pool);
    assert.equal(first.applied.length, 5, 'as 5 migrations da Fase 1 devem ser aplicadas em um banco novo');
    assert.deepEqual(first.alreadyApplied, []);

    const second = await runMigrations(pool);
    assert.deepEqual(second.applied, [], 'reexecutar não deve reaplicar nenhuma migration');
    assert.equal(second.alreadyApplied.length, 5);

    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      'organizations',
      'usuarios',
      'organization_memberships',
      'armadores',
      'container_types',
      'container_type_mappings',
      'clientes',
      'condicoes_comerciais',
      'processos',
      'containers',
      'field_observations',
      'snapshots',
      'backfill_runs',
      'backfill_items',
    ]) {
      assert.ok(tables.includes(expected), `tabela ${expected} deveria existir após a Fase 1`);
    }
  } finally {
    await pool.end();
  }
});
