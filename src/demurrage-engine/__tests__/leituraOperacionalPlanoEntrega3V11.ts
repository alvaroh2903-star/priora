import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testDatabaseUrl } from './testDb';
import { buscarPendenciasProcesso } from '../leitura/pendenciasOperacionais';
import { buscarReaberturas } from '../leitura/reaberturasOperacionais';

/**
 * Produção P1 (Entrega 3 v1.1) — evidência de plano de consulta ANTES/DEPOIS
 * da migration 0046 para `GET /processos/:processoId/pendencias?estado=resolvida`.
 *
 * Script standalone (NÃO é `*.test.ts` — não entra na suíte automática; a
 * prova estrutural automatizada está em `leituraOperacionalEntrega3V11.test.ts`,
 * "V11 #M2"). Captura o SQL EXATO que `buscarPendenciasProcesso` envia ao
 * banco (página 1 e página 2 com cursor), roda `EXPLAIN (ANALYZE, BUFFERS)`
 * com os mesmos parâmetros no schema até 0045, aplica SÓ a 0046, e repete.
 * Também imprime a impressão digital (MD5 por tabela) antes/depois da 0046
 * e o resultado da reexecução das migrations (deve ser vazio). Por fim,
 * captura e explica o SQL exato de `buscarReaberturas` (que na v1.1 ganhou
 * o `LEFT JOIN LATERAL` em `closing_events` para `autorizadaEm`).
 *
 * ATENÇÃO — APAGA O BANCO: faz `DROP SCHEMA public CASCADE` no banco de
 * `DEMURRAGE_TEST_DATABASE_URL` (ou `DEMURRAGE_DATABASE_URL`/`DATABASE_URL`).
 * Por isso exige, além da URL, `DEMURRAGE_PLANO_PERMITE_RESET=1`. Use um
 * banco descartável. Execução (o projeto não tem `tsx`; usa o `ts-node` já
 * instalado):
 *   DEMURRAGE_TEST_DATABASE_URL=postgres://.../banco_descartavel \
 *   DEMURRAGE_PLANO_PERMITE_RESET=1 \
 *   node -r ts-node/register src/demurrage-engine/__tests__/leituraOperacionalPlanoEntrega3V11.ts
 */

const ATE_0045 = '0045_leitura_operacional_indices.sql';

async function semear(pool: Pool): Promise<{ orgId: string; processoAlvo: string }> {
  // 5 organizações × 1.000 processos × 20 pendências RESOLVIDAS = 100.000
  // linhas resolvidas no total (todas as organizações), mais 5 abertas por
  // processo — o processo-alvo tem só as SUAS 20 resolvidas.
  await pool.query(`INSERT INTO organizations (nome, slug) SELECT 'Org ' || o, 'plano-e3v11-' || o FROM generate_series(1, 5) o`);
  await pool.query(
    `INSERT INTO processos (organization_id, numero_processo)
     SELECT org.id, 'PV11-' || org.slug || '-' || i FROM organizations org, generate_series(1, 1000) i`,
  );
  await pool.query(
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, estado, criado_em, resolvido_em)
     SELECT p.organization_id, p.id, NULL,
            (ARRAY['armador_ausente','mbl_ausente','tipo_ausente','armador_nao_cadastrado'])[(k % 4) + 1], '{}'::jsonb,
            'resolvida',
            timestamptz '2026-01-01 00:00:00+00' + (k || ' hours')::interval + (random() * 3600 || ' seconds')::interval,
            timestamptz '2026-06-01 00:00:00+00' + (k || ' hours')::interval
       FROM processos p, generate_series(1, 20) k`,
  );
  await pool.query(
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto)
     SELECT p.organization_id, p.id, NULL, t, '{}'::jsonb
       FROM processos p, unnest(ARRAY['armador_ausente','mbl_ausente','tipo_ausente','armador_nao_cadastrado','armador_sem_tracking']) t`,
  );
  const { rows: [alvo] } = await pool.query(`SELECT id, organization_id FROM processos ORDER BY numero_processo LIMIT 1`);
  await pool.query('ANALYZE');
  return { orgId: alvo.organization_id, processoAlvo: alvo.id };
}

/** Executa `fn` capturando o SQL e os parâmetros de cada `pool.query` emitido. */
async function capturarConsultas(pool: Pool, fn: () => Promise<unknown>): Promise<Array<{ sql: string; params: unknown[] }>> {
  const capturadas: Array<{ sql: string; params: unknown[] }> = [];
  const original = pool.query.bind(pool);
  (pool as any).query = (sql: any, params?: any) => {
    capturadas.push({ sql: typeof sql === 'string' ? sql : sql.text, params: params ?? [] });
    return (original as any)(sql, params);
  };
  try { await fn(); } finally { (pool as any).query = original; }
  return capturadas;
}

async function explicar(pool: Pool, consulta: { sql: string; params: unknown[] }): Promise<string> {
  const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${consulta.sql}`, consulta.params);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function impressaoDigital(pool: Pool): Promise<string> {
  const { rows: tabelas } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations' ORDER BY table_name`,
  );
  const partes: string[] = [];
  for (const { table_name: t } of tabelas) {
    const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h, count(*)::int AS n FROM "${t}" t`);
    partes.push(`${t}:${rows[0].n}:${rows[0].h}`);
  }
  return partes.join('|');
}

async function main() {
  const url = testDatabaseUrl();
  if (!url) { console.error('DEMURRAGE_TEST_DATABASE_URL não definida.'); process.exit(1); }
  if (process.env.DEMURRAGE_PLANO_PERMITE_RESET !== '1') {
    console.error('Recusado: este script APAGA o schema public do banco alvo. Defina DEMURRAGE_PLANO_PERMITE_RESET=1 e use um banco descartável.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const ate45 = await runMigrations(pool, { until: ATE_0045 });
    console.log(`Schema até ${ATE_0045}: ${ate45.applied.length} migrations aplicadas.`);
    const { orgId, processoAlvo } = await semear(pool);
    const { rows: [tot] } = await pool.query(
      `SELECT count(*) FILTER (WHERE estado = 'resolvida')::int AS resolvidas, count(*)::int AS total,
              count(*) FILTER (WHERE processo_id = $1 AND estado = 'resolvida')::int AS resolvidas_alvo
         FROM demurrage_pendencias`, [processoAlvo],
    );
    console.log(`Dados: ${tot.total} pendências (${tot.resolvidas} resolvidas no total; ${tot.resolvidas_alvo} resolvidas no processo-alvo).`);

    const filtros = { estado: 'resolvida' as const };
    let cursor: string | null = null;
    const [pagina1] = await capturarConsultas(pool, async () => {
      cursor = (await buscarPendenciasProcesso(pool, { organizationId: orgId, processoId: processoAlvo, filtros, limite: 10, papel: 'ANALYST' })).cursor;
    });
    const [pagina2] = await capturarConsultas(pool, () =>
      buscarPendenciasProcesso(pool, { organizationId: orgId, processoId: processoAlvo, filtros, limite: 10, cursor, papel: 'ANALYST' }));

    console.log('\n===== ANTES (schema até 0045) — página 1, estado=resolvida =====');
    console.log(await explicar(pool, pagina1));
    console.log('\n===== ANTES (schema até 0045) — página 2 (cursor), estado=resolvida =====');
    console.log(await explicar(pool, pagina2));

    const antes = await impressaoDigital(pool);
    const r46 = await runMigrations(pool);
    await pool.query('ANALYZE demurrage_pendencias');
    const depois = await impressaoDigital(pool);
    console.log(`\nMigrations aplicadas agora: ${JSON.stringify(r46.applied)}`);
    console.log(`Impressão digital de TODAS as tabelas idêntica antes/depois da 0046: ${antes === depois}`);

    console.log('\n===== DEPOIS (0046) — página 1, estado=resolvida =====');
    console.log(await explicar(pool, pagina1));
    console.log('\n===== DEPOIS (0046) — página 2 (cursor), estado=resolvida =====');
    console.log(await explicar(pool, pagina2));

    const [abertas] = await capturarConsultas(pool, () =>
      buscarPendenciasProcesso(pool, { organizationId: orgId, processoId: processoAlvo, filtros: {}, limite: 10, papel: 'ANALYST' }));
    console.log('\n===== DEPOIS (0046) — padrão estado=aberta (informativo) =====');
    console.log(await explicar(pool, abertas));

    const rerun = await runMigrations(pool);
    console.log(`\nReexecução das migrations: aplicadas=${JSON.stringify(rerun.applied)} (já aplicadas: ${rerun.alreadyApplied.length})`);

    // /reaberturas (v1.1 acrescentou o LEFT JOIN LATERAL em closing_events
    // para `autorizadaEm`): uma reabertura RECALCULADA por processo da
    // organização-alvo (1.000), cada uma com seu evento REABERTURA_AUTORIZADA
    // e mais 5 eventos RECALCULO no mesmo processo.
    const { rows: [usuario] } = await pool.query(`INSERT INTO usuarios (nome, email) VALUES ('Gestor plano', 'gestor-plano@e3v11.example') RETURNING id`);
    await pool.query(
      `INSERT INTO reaberturas (processo_id, estado, solicitada_por, autorizada_por, justificativa, criado_em)
       SELECT p.id, 'RECALCULADA', $2, $2, 'plano', timestamptz '2026-02-01 00:00:00+00' + (random() * 86400 * 30 || ' seconds')::interval
         FROM processos p WHERE p.organization_id = $1`, [orgId, usuario.id],
    );
    await pool.query(
      `INSERT INTO closing_events (processo_id, tipo_evento, origem, ator_usuario_id, payload)
       SELECT r.processo_id, 'REABERTURA_AUTORIZADA', 'humano', $1, jsonb_build_object('reaberturaId', r.id::text) FROM reaberturas r`, [usuario.id],
    );
    await pool.query(
      `INSERT INTO closing_events (processo_id, tipo_evento, origem, payload)
       SELECT r.processo_id, 'RECALCULO', 'automatico', '{}'::jsonb FROM reaberturas r, generate_series(1, 5)`,
    );
    await pool.query('ANALYZE');
    const { rows: [totRe] } = await pool.query(`SELECT (SELECT count(*) FROM reaberturas)::int AS r, (SELECT count(*) FROM closing_events)::int AS e`);
    console.log(`\nDados /reaberturas: ${totRe.r} reaberturas RECALCULADA (organização-alvo), ${totRe.e} closing_events.`);
    let cursorRe: string | null = null;
    const [re1] = await capturarConsultas(pool, async () => {
      cursorRe = (await buscarReaberturas(pool, { organizationId: orgId, filtros: { estado: 'RECALCULADA' }, limite: 50, papel: 'MANAGER' })).cursor;
    });
    const [re2] = await capturarConsultas(pool, () =>
      buscarReaberturas(pool, { organizationId: orgId, filtros: { estado: 'RECALCULADA' }, limite: 50, cursor: cursorRe, papel: 'MANAGER' }));
    console.log('\n===== /reaberturas?estado=RECALCULADA (v1.1, com LATERAL de autorizadaEm) — página 1 =====');
    console.log(await explicar(pool, re1));
    console.log('\n===== /reaberturas?estado=RECALCULADA (v1.1) — página 2 (cursor) =====');
    console.log(await explicar(pool, re2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
