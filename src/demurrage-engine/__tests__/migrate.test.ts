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
      '0007_org_imutavel_e_responsavel_interno.sql',
      '0008_relogios.sql',
      '0009_tariffs.sql',
      '0010_tariff_vigencia_desconhecida.sql',
      '0011_tracking.sql',
      '0012_tracking_target_identidade.sql',
      '0013_scheduler_incidentes.sql',
    ];

    const first = await runMigrations(pool);
    assert.deepEqual(first.applied, expected, 'todas as migrations aplicadas (Fase 1 + corretivas 0006/0007 + relógios 0008) devem ser aplicadas em ordem num banco novo');
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
      'relogios',
      'tariff_tables',
      'tariff_brackets',
      'valores_apurados',
      'tracking_targets',
      'container_tracking_targets',
      'tracking_fetches',
      'tracking_events',
      'tracking_incidents',
      'tracking_alert_deliveries',
    ]) {
      assert.ok(tables.includes(expected), `tabela ${expected} deveria existir após a Fase 1`);
    }
  } finally {
    await pool.end();
  }
});
