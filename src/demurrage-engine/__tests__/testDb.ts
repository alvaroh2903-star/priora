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
      demurrage_handoff_processo_links, demurrage_handoff_eventos, demurrage_handoff_nonces, demurrage_handoff_credenciais,
      responsabilidade_decisao_dias, responsabilidade_decisao_periodos, responsabilidade_decisoes,
      demurrage_registros, processo_campos_selecionados, container_equipamento_original, demurrage_pendencias,
      demurrage_fallback_manual_avisos, demurrage_pos_commit_outbox, demurrage_fallback_manual_justificativas,
      si_conversas_descobertas, email_sync_estado, email_caixas, msal_cache_criptografado, msal_conta_ativa,
      recalculo_outbox, ft_divergencia_entregas, ft_divergencia_eventos, ft_divergencias,
      si_pendencias, si_proveniencias, si_intencoes, si_versoes, si_conversas,
      vessel_call_rodada_tentativas, vessel_call_rodadas, vessel_call_coberturas, vessel_call_participantes,
      container_vessel_call_eventos, container_vessel_calls, vessel_call_eventos,
      vessel_call_pendencias, vessel_call_sync_incidents, vessel_calls,
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
      sessoes_humanas, processo_atribuicoes, membership_eventos, usuario_eventos,
      integracao_microsoft_vinculos,
      organization_memberships, usuarios, organizations
    RESTART IDENTITY CASCADE;
  `);
}

/**
 * Produção P1 (filas pessoais) — atribui o responsável operacional de um
 * processo nos testes (UPDATE direto da coluna, como o seed do handoff faria).
 * Ações PESSOAIS (minuta, pendência, fallback manual, solicitar reabertura) e
 * leituras de detalhe de um ANALYST exigem que ele seja o responsável; os
 * testes anteriores à entrega, que usavam um ANALYST num processo sem
 * responsável para exercitar OUTRA regra, passam a atribuí-lo antes — a regra
 * verificada por eles não muda.
 */
export async function atribuirResponsavelDeTeste(pool: Pool, processoId: string, membershipId: string | null): Promise<void> {
  await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [processoId, membershipId]);
}

/** Mesmo, a partir de um contêiner (atribui o processo do contêiner). */
export async function atribuirResponsavelDoContainerDeTeste(pool: Pool, containerId: string, membershipId: string | null): Promise<void> {
  await pool.query(
    `UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = (SELECT processo_id FROM containers WHERE id = $1)`,
    [containerId, membershipId],
  );
}
