import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testDatabaseUrl } from './testDb';

/**
 * Produção P1 (Entrega 3) — investigação de plano de consulta (EXPLAIN
 * ANALYZE) para decidir se alguma migration de índice é necessária.
 *
 * Script standalone (NÃO é `*.test.ts` — não entra na suíte automática,
 * mesmo padrão de `gestaoBenchmarkG7.ts`, D14 Gate G7).
 *
 * ATENÇÃO (documentação corrigida na Entrega 3 v1.1): o script começa com
 * `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` — APAGA todo o banco
 * apontado por `DEMURRAGE_TEST_DATABASE_URL` (ou `DEMURRAGE_DATABASE_URL`/
 * `DATABASE_URL`). Use sempre um banco descartável. O projeto não tem `tsx`
 * como dependência; execute com o `ts-node` já instalado:
 *   DEMURRAGE_TEST_DATABASE_URL=postgres://.../banco_descartavel \
 *   node -r ts-node/register src/demurrage-engine/__tests__/leituraOperacionalBenchmarkEntrega3.ts
 * Aplica TODAS as migrations existentes antes de medir (a partir da v1.1,
 * inclusive a 0046) — mede só o estado "depois"; os números "antes" do
 * relatório da Entrega 3 não são reproduzíveis por este script. A evidência
 * antes/depois da 0046 está em `leituraOperacionalPlanoEntrega3V11.ts`.
 *
 * Cenário de pior caso para cada rota: 10.000 linhas na tabela relevante,
 * no MESMO padrão que a rota realmente consulta — uma organização com
 * 10.000 processos (para `/reaberturas`/`/minutas`, que varrem a
 * organização inteira) e, dentro de UM desses processos, 10.000 pendências
 * (para `/processos/:id/pendencias`, que já filtra por `processo_id`).
 */

async function main() {
  const url = testDatabaseUrl();
  if (!url) { console.error('DEMURRAGE_TEST_DATABASE_URL não definido.'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);

  const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Bench', 'bench-e3') RETURNING id`);
  const orgId = org.id;

  await pool.query(
    `INSERT INTO processos (organization_id, numero_processo) SELECT $1, 'PROC-' || i FROM generate_series(1, 10000) AS i`,
    [orgId],
  );
  const { rows: procs } = await pool.query(`SELECT id FROM processos WHERE organization_id = $1 ORDER BY numero_processo LIMIT 1`, [orgId]);
  const oneProcesso = procs[0].id;

  await pool.query(
    `INSERT INTO containers (organization_id, processo_id, numero)
     SELECT p.organization_id, p.id, 'CT' || substr(md5(p.id::text), 1, 10) FROM processos p WHERE p.organization_id = $1`,
    [orgId],
  );

  await pool.query(
    `WITH cc AS (
       INSERT INTO containers (organization_id, processo_id, numero)
       SELECT $1, $2, 'PCT' || lpad(i::text, 6, '0') FROM generate_series(1, 10000) AS i
       RETURNING id
     )
     INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, estado, criado_em, resolvido_em)
     SELECT $1, $2, cc.id, (ARRAY['armador_ausente','mbl_ausente','tipo_ausente'])[(row_number() OVER () % 3) + 1], '{}'::jsonb,
            CASE WHEN row_number() OVER () % 5 = 0 THEN 'resolvida' ELSE 'aberta' END,
            now() - (row_number() OVER () || ' seconds')::interval,
            CASE WHEN row_number() OVER () % 5 = 0 THEN now() ELSE NULL END
       FROM cc`,
    [orgId, oneProcesso],
  );

  const { rows: [u] } = await pool.query(`INSERT INTO usuarios (nome, email) VALUES ('Bench','bench@x.example') RETURNING id`);
  await pool.query(
    `INSERT INTO reaberturas (processo_id, estado, solicitada_por, autorizada_por, justificativa, criado_em)
     SELECT p.id,
            CASE WHEN row_number() OVER (ORDER BY p.id) % 50 = 0 THEN 'SOLICITADA' ELSE 'REFECHADA' END,
            $2::uuid,
            CASE WHEN row_number() OVER (ORDER BY p.id) % 50 = 0 THEN NULL::uuid ELSE $2::uuid END,
            'motivo', now() - (row_number() OVER (ORDER BY p.id) || ' seconds')::interval
       FROM processos p WHERE p.organization_id = $1`,
    [orgId, u.id],
  );

  await pool.query(
    `INSERT INTO minutas (container_id, estado_minuta, criado_em)
     SELECT c.id,
            CASE WHEN row_number() OVER (ORDER BY c.id) % 50 = 0 THEN 'RECEBIDA' ELSE 'VALIDADA' END,
            now() - (row_number() OVER (ORDER BY c.id) || ' seconds')::interval
       FROM containers c WHERE c.organization_id = $1 AND c.numero LIKE 'CT%'`,
    [orgId],
  );

  // ANALYZE explícito: estatísticas atualizadas são o que faz o planejador
  // escolher o novo índice em vez do antigo caminho — em produção isso
  // acontece via autovacuum; aqui, imediatamente após a carga em lote.
  await pool.query('ANALYZE demurrage_pendencias, processos, containers, reaberturas, minutas');

  console.log('--- PENDENCIAS (um processo, 10.000 linhas, padrão estado=aberta) ---');
  const p1 = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT dp.id, dp.tipo, dp.estado, dp.criado_em, dp.resolvido_em, dp.contexto,
            dp.processo_id, p.numero_processo, dp.container_id, c.numero AS container_numero
       FROM demurrage_pendencias dp
       JOIN processos p ON p.id = dp.processo_id
       LEFT JOIN containers c ON c.id = dp.container_id
      WHERE dp.organization_id = $1 AND dp.processo_id = $2 AND dp.estado = 'aberta'
      ORDER BY dp.criado_em DESC, dp.id DESC
      LIMIT 51`,
    [orgId, oneProcesso],
  );
  console.log(p1.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n--- REABERTURAS (organização inteira, 10.000 linhas, padrão estado=SOLICITADA) ---');
  const p2 = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT r.id, r.processo_id, p.numero_processo, r.estado, r.justificativa, r.criado_em, r.atualizado_em, r.autorizada_por
       FROM reaberturas r
       JOIN processos p ON p.id = r.processo_id
      WHERE p.organization_id = $1 AND r.estado = 'SOLICITADA'
      ORDER BY r.criado_em ASC, r.id ASC
      LIMIT 51`,
    [orgId],
  );
  console.log(p2.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  console.log('\n--- MINUTAS (organização inteira, 10.000 linhas, padrão estado=RECEBIDA) ---');
  const p3 = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS) SELECT m.id, m.estado_minuta, c.processo_id, p.numero_processo, m.container_id, c.numero AS container_numero, m.criado_em
       FROM minutas m
       JOIN containers c ON c.id = m.container_id
       JOIN processos p ON p.id = c.processo_id
      WHERE c.organization_id = $1 AND m.estado_minuta = 'RECEBIDA'
      ORDER BY m.criado_em ASC, m.id ASC
      LIMIT 51`,
    [orgId],
  );
  console.log(p3.rows.map((r: any) => r['QUERY PLAN']).join('\n'));

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
