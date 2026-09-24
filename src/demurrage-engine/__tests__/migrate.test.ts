import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl } from './testDb';

const url = testDatabaseUrl();

test('migrations: aplica todas as migrations pendentes em um banco novo e é idempotente ao reexecutar', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const expected = [
      '0001_organizations_and_users.sql',
      '0002_reference_data.sql',
      '0003_tenant_core.sql',
      '0004_containers_and_observations.sql',
      '0005_backfill.sql',
      '0006_responsavel_operacional_membership.sql',
    ];

    const first = await runMigrations(pool);
    assert.deepEqual(first.applied, expected, 'todas as migrations da Fase 1 (incluindo a corretiva 0006) devem ser aplicadas em ordem num banco novo');
    assert.deepEqual(first.alreadyApplied, []);

    const second = await runMigrations(pool);
    assert.deepEqual(second.applied, [], 'reexecutar não deve reaplicar nenhuma migration');
    assert.deepEqual(second.alreadyApplied, expected);

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
