import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { montarGestaoOperacional } from '../leitura/gestao/operacional';
import { montarGestaoQualidade } from '../leitura/gestao/qualidade';
import { montarGestaoEficiencia } from '../leitura/gestao/eficiencia';
import { montarGestaoResponsabilidade } from '../leitura/gestao/responsabilidade';
import { novoGestor } from './responsabilidadeTestHelper';
import { buscarComposicaoIndicador } from '../leitura/gestao/drilldown';
import { listarIndicadoresRegistrados } from '../leitura/gestao/indicadorRegistry';
import { gerarMassa } from './gestaoBenchmarkG7';

/**
 * Fase D14 v1.2 — testes corretivos sobre a v1.1 (`6462c0e`). Cada teste é
 * sensível a mutação: reintroduzir o defeito correspondente o faz falhar.
 */

const url = testDatabaseUrl();

const INDICADORES_FINANCEIROS_SEM_COMPOSICAO = [
  'G-D-SEM-CUSTO-CLIENTE', 'G-D-COM-CUSTO-CLIENTE', 'G-D-SEM-EXPOSICAO-ROCKET',
  'G-D-COM-EXPOSICAO-ROCKET', 'G-D-SEM-VALOR-NENHUM-LADO', 'G-D-INTEGRIDADE',
];

/** Conjunto EXATO de indicadores com composição — qualquer indicador novo com `drilldownDisponivel: true` precisa de uma decisão consciente aqui. */
const INDICADORES_COM_COMPOSICAO_SQL = [
  'G-A1', 'G-A2', 'G-A3', 'G-A4', 'G-A5', 'G-A6', 'G-A7', 'G-A8', 'G-A9', 'G-A10',
  'G-C-CONFIRMADA_ROCKET', 'G-C-CONFIRMADA_CLIENTE', 'G-C-DIVIDIDA', 'G-C-NAO_APLICAVEL',
  'G-D-TOTAL-FINAL', 'G-D-SEM-RESPONSABILIDADE',
  'G-D-RESP-CONFIRMADA-ROCKET', 'G-D-RESP-CONFIRMADA-CLIENTE', 'G-D-RESP-DIVIDIDA',
  'G-E7', 'G-E8',
];

const PERIODO_LARGO = { inicio: '2000-01-01' as any, fim: '2100-12-31' as any };

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-d14-v12');
}

async function novoProcessoContainer(pool: Pool, orgId: string, numeroProcesso: string, numeroContainer: string) {
  const proc = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso, clienteId: null });
  const c = await new ContainerRepository(pool).create(orgId, proc.id, numeroContainer);
  return { processoId: proc.id, containerId: c.id };
}

/**
 * Massa SINTÉTICA de decisões (só benchmark, banco de teste isolado): as decisões reais exigem devolução, relógio OK e
 * cobertura de dias (triggers de D11, congelados). Aqui os triggers de USUÁRIO da tabela são desligados e religados DENTRO
 * da mesma transação (atômico; nenhum trigger fica desligado) apenas para popular as 4 categorias de status em escala.
 */
async function popularDecisoesSinteticas(pool: Pool, orgId: string): Promise<void> {
  const membershipId = await novoGestor(pool, orgId);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('ALTER TABLE responsabilidade_decisoes DISABLE TRIGGER USER');
    await cliente.query(
      `INSERT INTO responsabilidade_decisoes (
         organization_id, processo_id, container_id, versao, status, base_relogio, dias_rocket, dias_cliente, motivo_estruturado,
         valor_status, valor_rocket, valor_cliente, moeda, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel)
       SELECT c.organization_id, c.processo_id, c.id, 1, m.status, m.base, m.dr, m.dc, m.motivo,
              m.vstatus, m.vr, m.vc, m.moeda, '{}'::jsonb, 'bench', 'bench', 'bench://evid', $2, 'MANAGER'
         FROM containers c
         JOIN (VALUES
           (1, 'CONFIRMADA_ROCKET', 'RELOGIO_ROCKET', 3, 0, NULL, 'NAO_APLICAVEL', NULL::numeric, NULL::numeric, NULL),
           (2, 'CONFIRMADA_CLIENTE', 'RELOGIO_CLIENTE', 0, 5, NULL, 'CALCULADO', 0::numeric, 500::numeric, 'USD'),
           (3, 'DIVIDIDA', 'RELOGIO_CLIENTE', 2, 3, NULL, 'CALCULADO', 200::numeric, 300::numeric, 'USD'),
           (4, 'NAO_APLICAVEL', 'NAO_APLICAVEL', 0, 0, 'DIFERENCA_COMERCIAL_FREE_TIME', 'NAO_APLICAVEL', NULL::numeric, NULL::numeric, NULL)
         ) AS m(digito, status, base, dr, dc, motivo, vstatus, vr, vc, moeda) ON m.digito = right(c.numero, 1)::int
        WHERE c.organization_id = $1`,
      [orgId, membershipId],
    );
    await cliente.query('ALTER TABLE responsabilidade_decisoes ENABLE TRIGGER USER');
    await cliente.query('COMMIT');
  } catch (e) {
    await cliente.query('ROLLBACK');
    throw e;
  } finally {
    cliente.release();
  }
}

function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------- Achado #1

test('D14 v1.2 #1 — os 6 indicadores financeiros de conclusão e G-E9 são drilldownDisponivel:false com motivo explícito; a rota devolve 200 explícito, nunca 404 nem composição em memória', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const registrados = new Map(listarIndicadoresRegistrados().map((d) => [d.id, d]));
    for (const id of [...INDICADORES_FINANCEIROS_SEM_COMPOSICAO, 'G-E9']) {
      const d = registrados.get(id);
      assert.ok(d, `${id} continua registrado (publicado)`);
      assert.equal(d!.drilldownDisponivel, false, `${id}: sem composição paginável nesta versão`);
      assert.match(d!.estrategiaComposicao, /pagin|mem[óo]ria|limite t[ée]cnico/i, `${id}: o motivo explica a limitação de paginação`);
      // Sem período e sem opções: a rota NÃO cobra período (nem 404) de quem não tem composição.
      const comp = await buscarComposicaoIndicador(pool, org.id, id, {});
      assert.equal(comp.drilldownDisponivel, false);
      assert.equal(comp.total, null);
      assert.deepEqual(comp.itens, []);
      assert.equal(comp.cursor, null);
      assert.ok(comp.motivo && comp.motivo.length > 40, `${id}: motivo explícito presente na resposta`);
    }
  } finally { await pool.end(); }
});

test('D14 v1.2 #1 — contrato: o conjunto de indicadores com composição é EXATAMENTE o esperado e todos são SQL (nenhum por população em memória)', async () => {
  const comComposicao = listarIndicadoresRegistrados().filter((d) => d.drilldownDisponivel).map((d) => d.id).sort();
  assert.deepEqual(comComposicao, [...INDICADORES_COM_COMPOSICAO_SQL].sort(), 'um indicador novo com drilldownDisponivel:true exige decisão explícita de limite de memória');
});

test('D14 v1.2 #1 — asserção estática: drilldown.ts não contém caminho de população em memória, seleção financeira nem reexecução de cadência', async () => {
  const codigo = semComentarios(readFileSync(join(__dirname, '../leitura/gestao/drilldown.ts'), 'utf8'));
  assert.doesNotMatch(codigo, /memoria/i, "nenhum modo 'memoria' / paginarMemoria no código");
  assert.doesNotMatch(codigo, /selecaoFinanceira|buscarEnvelopesSelecionados|envelopeDoRelogio/, 'composição nunca reconstrói envelopes financeiros em memória');
  assert.doesNotMatch(codigo, /avaliarCadencia|cadencePolicy/, 'composição nunca reexecuta a cadência sobre a população inteira');
  assert.doesNotMatch(codigo, /\.sort\(\)|\.slice\(\s*(inicio|offset)/, 'nenhuma ordenação/fatiamento de lista completa de IDs');
  assert.match(codigo, /LIMIT \$/, 'a página é limitada dentro do PostgreSQL');
});

test('D14 v1.2 #1 — cada consulta de composição é limitada: contagem, LIMIT $n ou busca de exibição restrita aos ≤ limite IDs da página (100 vs 3.000 processos, todos os indicadores disponíveis)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgPequena = await new OrganizationRepository(pool).create('P', 'v12-shape-p');
    const orgGrande = await new OrganizationRepository(pool).create('G', 'v12-shape-g');
    await gerarMassa(pool, orgPequena.id, 100);
    await gerarMassa(pool, orgGrande.id, 3000);
    const LIMITE = 20;
    const original = pool.query.bind(pool);
    const capturar = async (orgId: string, id: string, requerPeriodo: boolean) => {
      const consultas: Array<{ sql: string; params: unknown[] }> = [];
      (pool as any).query = (...args: any[]) => {
        consultas.push({ sql: String(typeof args[0] === 'string' ? args[0] : args[0]?.text), params: args[1] ?? [] });
        return (original as any)(...args);
      };
      try {
        const comp = await buscarComposicaoIndicador(pool, orgId, id, { limite: LIMITE, periodo: requerPeriodo ? PERIODO_LARGO : undefined });
        return { comp, consultas };
      } finally { (pool as any).query = original; }
    };
    for (const d of listarIndicadoresRegistrados().filter((x) => x.drilldownDisponivel)) {
      const p = await capturar(orgPequena.id, d.id, d.requerPeriodo);
      const g = await capturar(orgGrande.id, d.id, d.requerPeriodo);
      assert.equal(g.consultas.length, p.consultas.length, `${d.id}: mesma contagem de consultas com 30x mais linhas`);
      assert.ok(g.comp.itens.length <= LIMITE, `${d.id}: linhas devolvidas limitadas à página`);
      for (const q of g.consultas) {
        const ehContagem = /count\(\*\)/i.test(q.sql);
        const ehPagina = /LIMIT \$\d+/.test(q.sql);
        const ehExibicao = /= ANY\(\$1\)/.test(q.sql) && Array.isArray(q.params[0]) && (q.params[0] as unknown[]).length <= LIMITE;
        assert.ok(ehContagem || ehPagina || ehExibicao, `${d.id}: consulta sem limite detectada: ${q.sql.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  } finally { await pool.end(); }
});

test('D14 v1.2 #1 — benchmark PostgreSQL por estratégia disponível: 100 vs 10.000 processos — consultas constantes, página limitada, totais reconciliam com os indicadores', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgPequena = await new OrganizationRepository(pool).create('P', 'v12-bench-p');
    const orgGrande = await new OrganizationRepository(pool).create('G', 'v12-bench-g');
    await gerarMassa(pool, orgPequena.id, 100);
    await gerarMassa(pool, orgGrande.id, 10000);
    // População UNAVAILABLE para G-E8 (a massa padrão não tem): 1 em cada 3 contêineres de processo ainda OPEN, com DOIS lados/motores (prova DISTINCT em escala).
    for (const org of [orgPequena, orgGrande]) {
      await pool.query(
        `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, engine_version, input_hash)
         SELECT c.id, lado.tipo, lado.motor::valor_motor_comercial, 'UNAVAILABLE', 'bench', md5(c.id::text || lado.tipo)
           FROM containers c JOIN processos p ON p.id = c.processo_id,
                (VALUES ('cliente', 'termo_unico'), ('rocket', 'exposicao_armador')) AS lado(tipo, motor)
          WHERE c.organization_id = $1 AND p.apuracao_status <> 'FINAL' AND right(c.numero, 1)::int % 3 = 0
            AND NOT EXISTS (SELECT 1 FROM valores_apurados v WHERE v.container_id = c.id AND v.relogio_tipo = lado.tipo
                              AND v.motor_comercial = lado.motor::valor_motor_comercial AND v.calculation_status IN ('OPEN','FINAL'))`,
        [org.id],
      );
    }
    for (const org of [orgPequena, orgGrande]) await popularDecisoesSinteticas(pool, org.id);
    const operacional = await montarGestaoOperacional(pool, orgGrande.id, {}, '2026-09-20' as any);
    const qualidade = await montarGestaoQualidade(pool, orgGrande.id, undefined, '2026-09-20' as any);
    const eficiencia = await montarGestaoEficiencia(pool, orgGrande.id, PERIODO_LARGO, '2026-09-20' as any);
    const esperado = new Map<string, number>(operacional.indicadores.map((i) => [i.id, i.valor]));
    esperado.set('G-E7', qualidade.tiposContainerNaoReconhecidos);
    esperado.set('G-E8', qualidade.tabelasOuFaixasIndisponiveis);
    esperado.set('G-D-TOTAL-FINAL', eficiencia.concluidos.totalContaineresFinal);
    esperado.set('G-D-SEM-RESPONSABILIDADE', eficiencia.concluidos.semResponsabilidadeAtribuida);
    esperado.set('G-D-RESP-CONFIRMADA-ROCKET', eficiencia.concluidos.responsabilidadeConfirmadaRocket);
    esperado.set('G-D-RESP-CONFIRMADA-CLIENTE', eficiencia.concluidos.responsabilidadeConfirmadaCliente);
    esperado.set('G-D-RESP-DIVIDIDA', eficiencia.concluidos.responsabilidadeDividida);
    const resp = await montarGestaoResponsabilidade(pool, orgGrande.id);
    for (const st of ['CONFIRMADA_ROCKET', 'CONFIRMADA_CLIENTE', 'DIVIDIDA', 'NAO_APLICAVEL']) {
      esperado.set(`G-C-${st}`, resp.porStatus.find((x) => x.status === st)?.total ?? 0);
    }

    const original = pool.query.bind(pool);
    const medir = async (orgId: string, id: string, requerPeriodo: boolean) => {
      let n = 0;
      (pool as any).query = (...args: any[]) => { n++; return (original as any)(...args); };
      const t0 = Date.now();
      try {
        const comp = await buscarComposicaoIndicador(pool, orgId, id, { limite: 20, periodo: requerPeriodo ? PERIODO_LARGO : undefined });
        return { comp, consultas: n, ms: Date.now() - t0 };
      } finally { (pool as any).query = original; }
    };

    const linhas: string[] = ['| Indicador | Total (10k) | Consultas 100 → 10k | Itens/página | Tempo 10k (ms) |', '|---|---|---|---|---|'];
    for (const d of listarIndicadoresRegistrados().filter((x) => x.drilldownDisponivel)) {
      const p = await medir(orgPequena.id, d.id, d.requerPeriodo);
      const g = await medir(orgGrande.id, d.id, d.requerPeriodo);
      assert.equal(g.consultas, p.consultas, `${d.id}: consultas constantes`);
      assert.ok(g.comp.itens.length <= 20, `${d.id}: página limitada`);
      if (esperado.has(d.id)) assert.equal(g.comp.total, esperado.get(d.id), `${d.id}: composição reconcilia com o indicador a 10.000 processos`);
      assert.ok((g.comp.total ?? 0) > 0, `${d.id}: pré-condição — a estratégia precisa ter população NÃO vazia no benchmark`);
      linhas.push(`| ${d.id} | ${g.comp.total} | ${p.consultas} → ${g.consultas} | ${g.comp.itens.length} | ${g.ms} |`);
    }
    assert.ok((esperado.get('G-E8') ?? 0) > 1000, 'pré-condição: população de G-E8 relevante a 10.000');
    assert.ok((esperado.get('G-A1') ?? 0) >= 10000);
    console.log(`\n${linhas.join('\n')}\n`);
  } finally { await pool.end(); }
});

// ---------------------------------------------------------------- Achado #2

test('D14 v1.2 #2 — G-E7 (grão processo): um processo com 2 pendências qualificadas + outro com 1 = 2 processos, no indicador E na composição; sem repetição entre páginas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const p1 = await novoProcessoContainer(pool, org.id, 'V12-E7-P1', 'VETA0000001');
    const p2 = await novoProcessoContainer(pool, org.id, 'V12-E7-P2', 'VETB0000001');
    const p3 = await novoProcessoContainer(pool, org.id, 'V12-E7-P3', 'VETC0000001');
    const ins = (proc: { processoId: string; containerId: string }, tipo: string, estado = 'aberta') => pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, estado, resolvido_em)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'resolvida' THEN now() END)`,
      [org.id, proc.processoId, proc.containerId, tipo, estado],
    );
    await ins(p1, 'tipo_ausente');
    await ins(p1, 'tipo_nao_reconhecido'); // mesmo processo, 2ª linha qualificada
    await ins(p2, 'tipo_nao_reconhecido');
    await ins(p3, 'tipo_ausente', 'resolvida'); // resolvida: nunca conta
    await ins(p3, 'mbl_ausente'); // outro tipo: nunca conta

    const q = await montarGestaoQualidade(pool, org.id, undefined, '2026-09-20' as any);
    assert.equal(q.tiposContainerNaoReconhecidos, 2, 'indicador: 2 PROCESSOS (contar linhas daria 3)');

    const vistos = new Set<string>();
    let cursor: string | null = null;
    let total = -1;
    for (let i = 0; i < 5; i++) {
      const comp: Awaited<ReturnType<typeof buscarComposicaoIndicador>> = await buscarComposicaoIndicador(pool, org.id, 'G-E7', { limite: 1, cursor });
      total = comp.total!;
      for (const item of comp.itens) { assert.ok(!vistos.has(item.processoId), 'processo repetido entre páginas'); vistos.add(item.processoId); }
      if (!comp.cursor) break;
      cursor = comp.cursor;
    }
    assert.equal(total, 2, 'composição: 2 processos');
    assert.deepEqual([...vistos].sort(), [p1.processoId, p2.processoId].sort());
  } finally { await pool.end(); }
});

test('D14 v1.2 #2 — pendência sem processo: processo_id é NOT NULL no esquema (decisão: nunca existe linha com processo nulo), e a predicate ainda o exclui explicitamente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await assert.rejects(
      () => pool.query(`INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo) VALUES ($1, NULL, 'tipo_ausente')`, [org.id]),
      (e: any) => e.code === '23502',
      'o banco já impede processo_id nulo; nenhum processo "nulo" pode ser contado',
    );
    const fonte = semComentarios(readFileSync(join(__dirname, '../leitura/gestao/qualidade.ts'), 'utf8'));
    assert.match(fonte, /count\(DISTINCT processo_id\)[\s\S]*?processo_id IS NOT NULL/, 'métrica: DISTINCT + exclusão explícita de null');
    const drill = semComentarios(readFileSync(join(__dirname, '../leitura/gestao/drilldown.ts'), 'utf8'));
    assert.match(drill, /SELECT DISTINCT dp\.processo_id[\s\S]*?dp\.processo_id IS NOT NULL/, 'composição: mesma predicate');
  } finally { await pool.end(); }
});

// ---------------------------------------------------------------- Achado #3

test('D14 v1.2 #3 — G-E8 (grão contêiner): contêiner UNAVAILABLE nos dois lados e com mais de um motor ativo + outro com 1 valor = 2 contêineres, no indicador E na composição; sem repetição entre páginas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const c1 = await novoProcessoContainer(pool, org.id, 'V12-E8-P1', 'VEUA0000001');
    const c2 = await novoProcessoContainer(pool, org.id, 'V12-E8-P2', 'VEUB0000001');
    const c3 = await novoProcessoContainer(pool, org.id, 'V12-E8-P3', 'VEUC0000001');
    const c4 = await novoProcessoContainer(pool, org.id, 'V12-E8-P4', 'VEUD0000001');
    const unavailable = (containerId: string, lado: 'cliente' | 'rocket', motor: string, status = 'OPEN') => pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, calculation_status, engine_version, input_hash)
       VALUES ($1, $2, $3::valor_motor_comercial, 'UNAVAILABLE', $4::valor_calculation_status, 'v12', $5)`,
      [containerId, lado, motor, status, randomUUID()],
    );
    // C1: cliente (2 motores comerciais ativos) + rocket = 3 linhas UNAVAILABLE, 1 contêiner.
    await unavailable(c1.containerId, 'cliente', 'termo_embarque');
    await unavailable(c1.containerId, 'cliente', 'termo_unico');
    await unavailable(c1.containerId, 'rocket', 'exposicao_armador');
    // C2: 1 linha UNAVAILABLE.
    await unavailable(c2.containerId, 'cliente', 'termo_embarque');
    // C3: UNAVAILABLE já SUPERSEDED — nunca conta. C4: valor ESTIMATED — nunca conta.
    await unavailable(c3.containerId, 'cliente', 'termo_embarque', 'SUPERSEDED');
    await pool.query(
      `INSERT INTO valores_apurados (container_id, relogio_tipo, motor_comercial, confirmation_status, total, moeda, dias_cobrados, engine_version, input_hash)
       VALUES ($1, 'cliente', 'termo_embarque', 'ESTIMATED', 10, 'USD', 1, 'v12', 'h-est')`,
      [c4.containerId],
    );
    const { rows: linhas } = await pool.query(
      `SELECT count(*)::int AS n FROM valores_apurados va JOIN containers c ON c.id = va.container_id
        WHERE c.organization_id = $1 AND va.confirmation_status = 'UNAVAILABLE' AND va.calculation_status IN ('OPEN','FINAL')`, [org.id]);
    assert.equal(linhas[0].n, 4, 'pré-condição: 4 LINHAS ativas UNAVAILABLE (contar linhas daria 4)');

    const q = await montarGestaoQualidade(pool, org.id, undefined, '2026-09-20' as any);
    assert.equal(q.tabelasOuFaixasIndisponiveis, 2, 'indicador: 2 CONTÊINERES distintos');

    const vistos = new Set<string>();
    let cursor: string | null = null;
    let total = -1;
    for (let i = 0; i < 5; i++) {
      const comp: Awaited<ReturnType<typeof buscarComposicaoIndicador>> = await buscarComposicaoIndicador(pool, org.id, 'G-E8', { limite: 1, cursor });
      total = comp.total!;
      for (const item of comp.itens) { assert.ok(!vistos.has(item.containerId!), 'contêiner repetido entre páginas'); vistos.add(item.containerId!); }
      if (!comp.cursor) break;
      cursor = comp.cursor;
    }
    assert.equal(total, 2, 'composição: 2 contêineres');
    assert.deepEqual([...vistos].sort(), [c1.containerId, c2.containerId].sort());
  } finally { await pool.end(); }
});

// ---------------------------------------------------------------- Achado #4

test('D14 v1.2 #4 — G-A7 é grão contêiner: rótulo "Contêineres com tracking desatualizado", cálculo e grão inalterados (2 contêineres do MESMO processo contam 2)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'V12-A7', clienteId: null });
    const repo = new ContainerRepository(pool);
    const a = await repo.create(org.id, proc.id, 'VAAA0000001');
    const b = await repo.create(org.id, proc.id, 'VAAB0000001');
    await pool.query(`UPDATE containers SET estado = 'MONITORAMENTO_SILENCIOSO', estado_badges = ARRAY['trackingDesatualizado'] WHERE id = ANY($1)`, [[a.id, b.id]]);

    const resp = await montarGestaoOperacional(pool, org.id, {}, '2026-09-20' as any);
    const a7 = resp.indicadores.find((i) => i.id === 'G-A7')!;
    assert.equal(a7.rotulo, 'Contêineres com tracking desatualizado');
    assert.equal(a7.grao, 'container');
    assert.equal(a7.valor, 2, 'conta contêineres (2), nunca o processo (1)');
    assert.ok(resp.indicadores.every((i) => !/Processos com tracking/.test(i.rotulo)), 'nenhum rótulo diz "Processos com tracking"');
  } finally { await pool.end(); }
});
