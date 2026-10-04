import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { montarGestaoOperacional } from '../leitura/gestao/operacional';
import { montarGestaoFinanceiro } from '../leitura/gestao/financeiro';
import { montarGestaoResponsabilidade } from '../leitura/gestao/responsabilidade';
import { montarGestaoEficiencia } from '../leitura/gestao/eficiencia';
import { montarGestaoQualidade } from '../leitura/gestao/qualidade';
import { buscarComposicaoIndicador } from '../leitura/gestao/drilldown';

/**
 * Fase D14 (Gate G7) — benchmark de desempenho e regressão de contagem de
 * consultas, sobre massa SINTÉTICA gerada por SQL em lote (nunca pelo
 * pipeline real — inviável em escala de 10.000 processos; aqui o alvo é
 * medir a AGREGAÇÃO da Gestão sobre colunas já persistidas, não o motor que
 * as produz, que já tem sua própria suíte de regressão).
 *
 * Script standalone (NÃO É `*.test.ts` — não entra na suíte automática):
 *   DEMURRAGE_TEST_DATABASE_URL=... npx ts-node src/demurrage-engine/__tests__/gestaoBenchmarkG7.ts
 *
 * Mede, para N = 100 / 1.000 / 10.000 processos: contagem de consultas SQL
 * (via proxy em `pool.query`) e tempo de execução de cada rota. A contagem
 * de consultas deve ser CONSTANTE em relação a N (prova de ausência de N+1).
 */

const url = testDatabaseUrl();

export function contarConsultas(pool: Pool, detalhar = false): { contador: { n: number }; restaurar: () => void } {
  const original = pool.query.bind(pool);
  const contador = { n: 0 };
  (pool as any).query = (...args: any[]) => {
    contador.n++;
    if (!detalhar) return (original as any)(...args);
    const t0 = Date.now();
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    const resultado = (original as any)(...args);
    Promise.resolve(resultado).then(() => {
      console.log(`    [${Date.now() - t0}ms] ${sql.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
    });
    return resultado;
  };
  return { contador, restaurar: () => { (pool as any).query = original; } };
}

export async function gerarMassa(pool: Pool, organizationId: string, n: number): Promise<void> {
  // 1) container_type de referência (já seedado pelas migrations).
  const { rows: ct } = await pool.query(`SELECT id FROM container_types WHERE codigo = '40HC' LIMIT 1`);
  const containerTypeId: string = ct[0].id;

  // 2) processos em lote — balde/estado distribuídos deterministicamente por i. Todos OPEN
  // nesta etapa: os guards de FINAL (migration 0017) bloqueiam escrita em relogios/
  // valores_apurados depois de FINAL — a fração FINAL é marcada só DEPOIS (passo 6),
  // quando containers/relogios/valores já existem (mesma ordem real: apura, decide, fecha).
  await pool.query(
    `INSERT INTO processos (organization_id, numero_processo, prioridade_balde, estado_mais_relevante, lifecycle_calculated_at)
     SELECT
       $1, 'BENCH-' || i,
       (ARRAY['CRITICA_15','CRITICA_7_14','ATENCAO_1_6','DEVOLVIDO_TRATAMENTO','PRAZO_PREVENTIVO','SILENCIOSO'])[(i % 6) + 1],
       (ARRAY['EM_DEMURRAGE_CRITICO','EM_DEMURRAGE_CRITICO','EM_DEMURRAGE_ATENCAO','DEVOLVIDO_AGUARDANDO_TRATAMENTO','PRAZO_PROXIMO','MONITORAMENTO_SILENCIOSO'])[(i % 6) + 1],
       now() - ((i % 48) || ' hours')::interval
     FROM generate_series(1, $2) AS i`,
    [organizationId, n],
  );

  // 3) containers 1:1 com os processos acima (join por numero_processo, único por organização).
  await pool.query(
    `INSERT INTO containers (organization_id, processo_id, numero, container_type_id, estado, estado_badges, prioridade_balde, lifecycle_calculated_at, discharge_date, house_free_time_days, master_free_time_days)
     SELECT
       $1, p.id, 'BENCH' || lpad((row_number() OVER (ORDER BY p.numero_processo))::text, 10, '0'), $2,
       (ARRAY['PRAZO_PROXIMO','EM_DEMURRAGE_ATENCAO','EM_DEMURRAGE_CRITICO','DEVOLVIDO_AGUARDANDO_TRATAMENTO','TRACKING_DESATUALIZADO','MONITORAMENTO_SILENCIOSO'])[
         (abs(('x' || substr(md5(p.numero_processo), 1, 8))::bit(32)::int) % 6) + 1
       ],
       CASE
         WHEN p.numero_processo::text ~ '[0369]$' THEN ARRAY['rocketExposta']
         WHEN p.numero_processo::text ~ '[147]$' THEN ARRAY['trackingDesatualizado']
         ELSE ARRAY[]::text[]
       END,
       p.prioridade_balde,
       p.lifecycle_calculated_at,
       DATE '2026-01-01' + (abs(('x' || substr(md5(p.numero_processo), 1, 8))::bit(32)::int) % 300),
       5 + (abs(('x' || substr(md5(p.numero_processo), 1, 8))::bit(32)::int) % 10),
       5 + (abs(('x' || substr(md5(p.numero_processo), 1, 8))::bit(32)::int) % 10)
     FROM processos p WHERE p.organization_id = $1 AND p.numero_processo LIKE 'BENCH-%'`,
    [organizationId, containerTypeId],
  );

  // 4) relogios (cliente + rocket) por contêiner — a trigger `relogios_somente_recalculador`
  // (migration 0008) só aceita escrita com a GUC de sessão marcando o recalculador oficial;
  // aqui simulamos essa marca só para gerar massa sintética de BENCHMARK (nunca um bypass em
  // código de produção — `dualClockCalculator`/`LifecycleRepository` continuam intocados).
  const clienteRelogios = await pool.connect();
  try {
    await clienteRelogios.query(`BEGIN`);
    await clienteRelogios.query(`SET LOCAL demurrage.relogio_writer = 'dualClockCalculator'`);
    await clienteRelogios.query(
      `INSERT INTO relogios (container_id, tipo, estado, dias_demurrage, ultimo_dia_livre, primeiro_dia_demurrage, data_final_apuracao, engine_version, input_hash)
       SELECT c.id, lado.tipo, 'OK', 5, c.discharge_date + 5, c.discharge_date + 6, c.discharge_date + 10, 'bench', md5(c.id::text || lado.tipo)
         FROM containers c, (VALUES ('cliente'), ('rocket')) AS lado(tipo)
        WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%'`,
      [organizationId],
    );
    await clienteRelogios.query(`COMMIT`);
  } catch (e) {
    await clienteRelogios.query(`ROLLBACK`);
    throw e;
  } finally {
    clienteRelogios.release();
  }

  // 5) valores_apurados (cliente/termo_embarque + rocket/exposicao_armador) — mistura de confirmation_status.
  await pool.query(
    `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, custo_real_confirmado_ref, total, moeda, dias_cobrados, period_start, period_end, engine_version, input_hash)
     SELECT c.id, 'cliente', 'termo_embarque',
       (CASE WHEN c.numero ~ '00$' THEN 'CONFIRMED' ELSE 'ESTIMATED' END)::valor_confirmation_status,
       CASE WHEN c.numero ~ '00$' THEN 'ref-bench' ELSE NULL END,
       500.00, 'USD', 5, c.discharge_date + 6, c.discharge_date + 10, 'bench', md5(c.id::text || 'cliente')
       FROM containers c WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%'`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, total, moeda, dias_cobrados, period_start, period_end, engine_version, input_hash)
     SELECT c.id, 'rocket', 'exposicao_armador', 'ESTIMATED', 300.00, 'USD', 5, c.discharge_date + 6, c.discharge_date + 10, 'bench', md5(c.id::text || 'rocket')
       FROM containers c WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%'`,
    [organizationId],
  );

  // 5b) marca 1 em cada 5 processos como FINAL — SÓ AGORA, com relogios/valores já gravados
  // (a mesma ordem real do fechamento: apura primeiro, congela depois).
  await pool.query(
    `UPDATE processos SET apuracao_status = 'FINAL', fechado_em = now()
      WHERE organization_id = $1 AND numero_processo LIKE 'BENCH-%' AND right(numero_processo, 1) IN ('0','5')`,
    [organizationId],
  );

  // 6) responsabilidade_decisoes para 1 em cada 10 contêineres.
  await pool.query(
    `INSERT INTO responsabilidade_decisoes (
       organization_id, processo_id, container_id, versao, status, base_relogio, dias_rocket, dias_cliente,
       valor_status, valor_rocket, valor_cliente, moeda, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel
     )
     SELECT c.organization_id, c.processo_id, c.id, 1, 'CONFIRMADA_CLIENTE', 'RELOGIO_CLIENTE', 0, 5,
       'CALCULADO', 0, 500.00, 'USD', '{}'::jsonb, 'bench', 'bench', 'bench://evid',
       (SELECT id FROM organization_memberships WHERE organization_id = c.organization_id LIMIT 1), 'MANAGER'
       FROM containers c
      WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%' AND right(c.numero, 1)::int % 10 = 0
        AND EXISTS (SELECT 1 FROM organization_memberships m WHERE m.organization_id = c.organization_id)`,
    [organizationId],
  );

  // 7) demurrage_pendencias para 1 em cada 20 processos.
  await pool.query(
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, estado)
     SELECT c.organization_id, c.processo_id, c.id, 'tipo_nao_reconhecido', 'aberta'
       FROM containers c WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%' AND right(c.numero, 1)::int % 20 = 0`,
    [organizationId],
  );

  // 8) tracking: 1 target por contêiner (sem compartilhamento aqui — isolamento já tem suíte própria), com fetches/incidentes.
  await pool.query(
    `INSERT INTO tracking_targets (armador, reference_value_canonical)
     SELECT 'maersk', 'BENCH-TARGET-' || c.numero FROM containers c WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%'
     ON CONFLICT DO NOTHING`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO container_tracking_targets (container_id, tracking_target_id, reference_type, reference_raw)
     SELECT c.id, tt.id, 'mbl', tt.reference_value_canonical
       FROM containers c JOIN tracking_targets tt ON tt.reference_value_canonical = 'BENCH-TARGET-' || c.numero
      WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%'`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO tracking_fetches (tracking_target_id, status, cached, resolved, carrier, iniciado_em, finalizado_em)
     SELECT ctt.tracking_target_id, 'ok', (right(c.numero,1)::int % 2 = 0), true, 'maersk', now(), now()
       FROM container_tracking_targets ctt JOIN containers c ON c.id = ctt.container_id
      WHERE c.organization_id = $1 AND c.numero LIKE 'BENCH%'`,
    [organizationId],
  );
}

interface Medicao { rota: string; consultas: number; ms: number }

async function medir(pool: Pool, organizationId: string, hoje: string, detalhar = false): Promise<Medicao[]> {
  const medicoes: Medicao[] = [];
  const casos: Array<[string, () => Promise<unknown>]> = [
    ['/operacional', () => montarGestaoOperacional(pool, organizationId, {}, hoje as any)],
    ['/financeiro', () => montarGestaoFinanceiro(pool, organizationId, hoje as any)],
    ['/responsabilidade', () => montarGestaoResponsabilidade(pool, organizationId)],
    ['/eficiencia', () => montarGestaoEficiencia(pool, organizationId, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, hoje as any)],
    ['/qualidade', () => montarGestaoQualidade(pool, organizationId, { inicio: '2000-01-01' as any, fim: '2100-12-31' as any }, hoje as any)],
    ['/indicadores/G-A1/composicao', () => buscarComposicaoIndicador(pool, organizationId, 'G-A1', { hoje: hoje as any })],
  ];
  for (const [rota, fn] of casos) {
    if (detalhar) console.log(`  -- ${rota} --`);
    const { contador, restaurar } = contarConsultas(pool, detalhar);
    const t0 = Date.now();
    await fn();
    const ms = Date.now() - t0;
    restaurar();
    medicoes.push({ rota, consultas: contador.n, ms });
  }
  return medicoes;
}

async function explainPrincipais(pool: Pool, organizationId: string): Promise<void> {
  console.log('\n--- EXPLAIN (ANALYZE, BUFFERS) — consultas dominantes (N=10000) ---\n');
  const consultas: Array<[string, string, unknown[]]> = [
    [
      'operacional.ts — consulta 1 (grão contêiner)',
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE c.estado IS NOT NULL)::int AS a1,
              count(*) FILTER (WHERE 'rocketExposta' = ANY(c.estado_badges))::int AS a6
         FROM containers c JOIN processos p ON p.id = c.processo_id
        WHERE c.organization_id = $1`,
      [organizationId],
    ],
    [
      'operacional.ts — consulta 2 (grão processo)',
      `SELECT count(*) FILTER (WHERE p.prioridade_balde = 'CRITICA_7_14')::int AS a4
         FROM processos p WHERE p.organization_id = $1`,
      [organizationId],
    ],
    [
      'selecaoFinanceira.ts — containers+processos+condicoes_comerciais',
      `SELECT c.id FROM containers c JOIN processos p ON p.id = c.processo_id
        LEFT JOIN condicoes_comerciais cc ON cc.id = p.condicao_comercial_id
       WHERE c.organization_id = $1`,
      [organizationId],
    ],
    [
      'selecaoFinanceira.ts — valores_apurados ativos em lote',
      `SELECT va.* FROM valores_apurados va JOIN containers c ON c.id = va.container_id
        WHERE c.organization_id = $1 AND va.calculation_status IN ('OPEN','FINAL')`,
      [organizationId],
    ],
    [
      'qualidade.ts — fetches por organização (JOIN até container_tracking_targets)',
      `SELECT count(*) FILTER (WHERE NOT f.cached)::int AS realizadas
         FROM tracking_fetches f
         JOIN container_tracking_targets ctt ON ctt.tracking_target_id = f.tracking_target_id
         JOIN containers c ON c.id = ctt.container_id
        WHERE c.organization_id = $1`,
      [organizationId],
    ],
  ];
  for (const [nome, sql, params] of consultas) {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params as any[]);
    console.log(`### ${nome}\n`);
    console.log(rows.map((r: any) => r['QUERY PLAN']).join('\n'));
    console.log('');
  }
}

async function main(): Promise<void> {
  if (!url) {
    console.error('DEMURRAGE_TEST_DATABASE_URL (ou DATABASE_URL) não definida.');
    process.exit(1);
  }
  const pool = testPool();
  try {
    console.log('| N | Rota | Consultas SQL | Tempo (ms) |');
    console.log('|---|------|---------------|------------|');
    const tamanhos = [100, 1000, 10000];
    const porRota = new Map<string, number[]>();
    for (const n of tamanhos) {
      await runMigrations(pool);
      await truncateAll(pool);
      await seedArmadorTables(pool);
      const org = await new OrganizationRepository(pool).create('Rocket Bench', `rocket-bench-${n}`);
      const t0Gerar = Date.now();
      await gerarMassa(pool, org.id, n);
      const msGerar = Date.now() - t0Gerar;
      console.log(`<!-- massa sintética N=${n} gerada em ${msGerar}ms -->`);

      const medicoes = await medir(pool, org.id, '2026-09-20', n === 10000 && process.env.DETALHAR === '1');
      for (const m of medicoes) {
        console.log(`| ${n} | ${m.rota} | ${m.consultas} | ${m.ms} |`);
        if (!porRota.has(m.rota)) porRota.set(m.rota, []);
        porRota.get(m.rota)!.push(m.consultas);
      }

      if (n === 10000) await explainPrincipais(pool, org.id);
    }

    console.log('\n--- Verificação: contagem de consultas CONSTANTE em relação a N ---\n');
    let constante = true;
    for (const [rota, contagens] of porRota) {
      const unico = new Set(contagens).size === 1;
      if (!unico) constante = false;
      console.log(`${rota}: ${contagens.join(' -> ')} ${unico ? '(constante ✓)' : '(VARIOU ✗)'}`);
    }
    console.log(constante ? '\nTODAS as rotas mantiveram contagem de consultas constante — sem N+1.' : '\nATENÇÃO: alguma rota variou a contagem de consultas com N.');
  } finally {
    await pool.end();
  }
}

// D14 v1.1 #9 — guarda de execução: este módulo também é importado por
// `gestaoDrilldown.test.ts` só para reaproveitar `gerarMassa`/`contarConsultas`
// (massa sintética de 10.000+ linhas) no benchmark de paginação por keyset.
// Sem a guarda, o simples `import` disparava o script completo (3 rodadas de
// 100/1.000/10.000 processos) como efeito colateral — nunca intencional fora
// da execução standalone documentada no cabeçalho deste arquivo.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
