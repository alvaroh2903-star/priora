import { Pool } from 'pg';

/**
 * Helper compartilhado pelos testes de integração da Demurrage Engine V2.
 * Exige DEMURRAGE_TEST_DATABASE_URL (ou DEMURRAGE_DATABASE_URL/DATABASE_URL)
 * apontando para um Postgres real — sem esta variável, os testes de
 * integração são pulados (não falham o build em ambientes sem Postgres).
 */
export function testDatabaseUrl(): string | null {
  return (
    process.env.DEMURRAGE_TEST_DATABASE_URL ||
    process.env.DEMURRAGE_DATABASE_URL ||
    process.env.DATABASE_URL ||
    null
  );
}

export function testPool(): Pool {
  const url = testDatabaseUrl();
  if (!url) {
    throw new Error('DEMURRAGE_TEST_DATABASE_URL não definida.');
  }
  return new Pool({ connectionString: url });
}

/** Limpa todas as tabelas da Demurrage Engine V2, preservando o schema (usado entre suítes de teste). */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      closing_events, reaberturas, fechamentos, documentos, minutas,
      tracking_schedule_claims,
      tracking_alert_deliveries, tracking_incidents,
      tracking_events, tracking_fetches, container_tracking_targets, tracking_targets,
      valores_apurados, tariff_brackets, tariff_tables,
      relogios,
      backfill_items, backfill_runs,
      snapshots, field_observations,
      containers, processos, condicoes_comerciais, clientes,
      container_type_mappings, armadores,
      organization_memberships, usuarios, organizations
    RESTART IDENTITY CASCADE;
  `);
}
