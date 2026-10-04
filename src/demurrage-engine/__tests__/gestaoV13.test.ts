import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { novoGestor } from './responsabilidadeTestHelper';
import { montarGestaoEficiencia } from '../leitura/gestao/eficiencia';
import { buscarComposicaoIndicador } from '../leitura/gestao/drilldown';
import { listarIndicadoresRegistrados } from '../leitura/gestao/indicadorRegistry';
import {
  listarDecisoesResponsabilidade, montarGestaoResponsabilidade, VERSAO_CURSOR_DECISOES,
} from '../leitura/gestao/responsabilidade';
import { codificarCursorAssinado } from '../leitura/cursorAssinado';
import { gerarMassa } from './gestaoBenchmarkG7';
import { inserirDecisoesSinteticas, popularDecisoesEmMassa, StatusSintetico } from './responsabilidadeSinteticaHelper';

/**
 * Fase D14 v1.3 — correções sobre a v1.2 (`dbc8e01`):
 *  #1 `NAO_APLICAVEL` é decisão válida (não ausência de decisão);
 *  #2 resumo de responsabilidade limitado + detalhe paginado por keyset.
 * Cada teste é sensível a mutação.
 */

const url = testDatabaseUrl();
const PERIODO = { inicio: '2026-05-01' as any, fim: '2026-05-31' as any };
const HOJE = '2026-06-01' as any;

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-d14-v13');
}

async function novoProcessoContainer(pool: Pool, orgId: string, nome: string, fechadoEm?: string) {
  const proc = await new ProcessoRepository(pool).create({ organizationId: orgId, numeroProcesso: `V13-${nome}`, clienteId: null });
  const c = await new ContainerRepository(pool).create(orgId, proc.id, `V13${nome.padEnd(8, '0').slice(0, 8)}`.slice(0, 11));
  if (fechadoEm) await pool.query(`UPDATE processos SET apuracao_status = 'FINAL', fechado_em = $2 WHERE id = $1`, [proc.id, fechadoEm]);
  return { organizationId: orgId, processoId: proc.id, containerId: c.id };
}

function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function registrarConsultas(pool: Pool) {
  const original = pool.query.bind(pool);
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  (pool as any).query = (...args: any[]) => {
    consultas.push({ sql: String(typeof args[0] === 'string' ? args[0] : args[0]?.text), params: args[1] ?? [] });
    return (original as any)(...args);
  };
  return { consultas, restaurar: () => { (pool as any).query = original; } };
}

async function idsDaComposicao(pool: Pool, orgId: string, id: string): Promise<{ total: number; ids: string[] }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let total = -1;
  for (let i = 0; i < 20; i++) {
    const comp: Awaited<ReturnType<typeof buscarComposicaoIndicador>> = await buscarComposicaoIndicador(pool, orgId, id, { limite: 3, periodo: PERIODO, cursor });
    total = comp.total!;
    ids.push(...comp.itens.map((x) => x.containerId!));
    if (!comp.cursor) break;
    cursor = comp.cursor;
  }
  return { total, ids };
}

type Cenario = Array<{ nome: string; fechadoEm: string; decisoes: Array<{ status: StatusSintetico; substituiPor?: StatusSintetico }> }>;

/** Monta processos FINAL e as decisões (uma cadeia por contêiner: a primeira `status`; se `substituiPor`, uma v2 a substitui). */
async function montar(pool: Pool, orgId: string, cenario: Cenario) {
  const membership = await novoGestor(pool, orgId);
  const porNome = new Map<string, string>();
  const originais: Array<{ nome: string; c: Awaited<ReturnType<typeof novoProcessoContainer>>; status: StatusSintetico; substituiPor?: StatusSintetico }> = [];
  for (const item of cenario) {
    const c = await novoProcessoContainer(pool, orgId, item.nome, item.fechadoEm);
    porNome.set(item.nome, c.containerId);
    for (const d of item.decisoes) originais.push({ nome: item.nome, c, status: d.status, substituiPor: d.substituiPor });
  }
  const idsV1 = await inserirDecisoesSinteticas(pool, orgId, membership, originais.map((o) => ({ ...o.c, status: o.status })));
  const v2 = originais.map((o, i) => ({ o, id: idsV1[i] })).filter((x) => x.o.substituiPor);
  if (v2.length) {
    await inserirDecisoesSinteticas(pool, orgId, membership, v2.map((x) => ({ ...x.o.c, status: x.o.substituiPor!, versao: 2, substituiId: x.id })));
  }
  return { membership, porNome };
}

const vetor = (c: Awaited<ReturnType<typeof montarGestaoEficiencia>>['concluidos']) =>
  [c.responsabilidadeConfirmadaRocket, c.responsabilidadeConfirmadaCliente, c.responsabilidadeDividida, c.responsabilidadeNaoAplicavel, c.semResponsabilidadeAtribuida];

// ============================================================ Achado #1

test('D14 v1.3 #1 — NAO_APLICAVEL incrementa SÓ responsabilidadeNaoAplicavel; sem decisão incrementa SÓ semResponsabilidadeAtribuida; decisão substituída não é vigente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const casos: Array<{ nome: string; decisoes: Cenario[number]['decisoes']; esperado: number[]; porque: string }> = [
      // vetor = [rocket, cliente, dividida, naoAplicavel, semDecisao]
      { nome: 'NA', decisoes: [{ status: 'NAO_APLICAVEL' }], esperado: [0, 0, 0, 1, 0], porque: '(1) NAO_APLICAVEL só no seu campo, (2) nunca em sem-decisão' },
      { nome: 'SEM', decisoes: [], esperado: [0, 0, 0, 0, 1], porque: '(3) sem decisão só em semResponsabilidadeAtribuida' },
      { nome: 'ROCKET', decisoes: [{ status: 'CONFIRMADA_ROCKET' }], esperado: [1, 0, 0, 0, 0], porque: 'contador preservado' },
      { nome: 'CLIENTE', decisoes: [{ status: 'CONFIRMADA_CLIENTE' }], esperado: [0, 1, 0, 0, 0], porque: 'contador preservado' },
      { nome: 'DIV', decisoes: [{ status: 'DIVIDIDA' }], esperado: [0, 0, 1, 0, 0], porque: 'contador preservado' },
      { nome: 'ROCKETNA', decisoes: [{ status: 'CONFIRMADA_ROCKET', substituiPor: 'NAO_APLICAVEL' }], esperado: [0, 0, 0, 1, 0], porque: '(4) a v1 CONFIRMADA_ROCKET foi substituída: só a v2 NAO_APLICAVEL é vigente' },
      { nome: 'NACLI', decisoes: [{ status: 'NAO_APLICAVEL', substituiPor: 'CONFIRMADA_CLIENTE' }], esperado: [0, 1, 0, 0, 0], porque: '(4) a v1 NAO_APLICAVEL foi substituída: só a v2 é vigente' },
    ];
    for (const caso of casos) {
      const org = await setup(pool);
      await montar(pool, org.id, [{ nome: caso.nome, fechadoEm: '2026-05-15T12:00:00Z', decisoes: caso.decisoes }]);
      const { concluidos } = await montarGestaoEficiencia(pool, org.id, PERIODO, HOJE);
      assert.deepEqual(vetor(concluidos), caso.esperado, `${caso.nome}: ${caso.porque}`);
      assert.equal(concluidos.totalContaineresFinal, 1);
    }
  } finally { await pool.end(); }
});

async function cenarioCompleto(pool: Pool) {
  const org = await setup(pool);
  const ctx = await montar(pool, org.id, [
    { nome: 'C1NA', fechadoEm: '2026-05-10T12:00:00Z', decisoes: [{ status: 'NAO_APLICAVEL' }] },
    { nome: 'C2ROCK', fechadoEm: '2026-05-11T12:00:00Z', decisoes: [{ status: 'CONFIRMADA_ROCKET' }] },
    { nome: 'C3CLI', fechadoEm: '2026-05-12T12:00:00Z', decisoes: [{ status: 'CONFIRMADA_CLIENTE' }] },
    { nome: 'C4DIV', fechadoEm: '2026-05-13T12:00:00Z', decisoes: [{ status: 'DIVIDIDA' }] },
    { nome: 'C5SEM', fechadoEm: '2026-05-14T12:00:00Z', decisoes: [] },
    { nome: 'C6ROCKNA', fechadoEm: '2026-05-15T12:00:00Z', decisoes: [{ status: 'CONFIRMADA_ROCKET', substituiPor: 'NAO_APLICAVEL' }] },
    { nome: 'C7NACLI', fechadoEm: '2026-05-16T12:00:00Z', decisoes: [{ status: 'NAO_APLICAVEL', substituiPor: 'CONFIRMADA_CLIENTE' }] },
    { nome: 'C8FORA', fechadoEm: '2026-08-15T12:00:00Z', decisoes: [{ status: 'CONFIRMADA_ROCKET' }] }, // fora do período
  ]);
  return { org, ...ctx };
}

test('D14 v1.3 #1 — as 5 categorias são exclusivas e SOMAM o total FINAL do período', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { org } = await cenarioCompleto(pool);
    const { concluidos } = await montarGestaoEficiencia(pool, org.id, PERIODO, HOJE);
    assert.deepEqual(vetor(concluidos), [1, 2, 1, 2, 1], 'Rocket=C2, cliente=C3+C7, dividida=C4, não aplicável=C1+C6, sem decisão=C5');
    assert.equal(concluidos.totalContaineresFinal, 7, 'C8 está fora do período');
    assert.equal(vetor(concluidos).reduce((a, b) => a + b, 0), concluidos.totalContaineresFinal, '(5) soma das 5 categorias = total do período');
  } finally { await pool.end(); }
});

test('D14 v1.3 #1 — as composições reconciliam com os indicadores e particionam o total (G-D-RESP-NAO-APLICAVEL e G-D-SEM-RESPONSABILIDADE)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { org, porNome } = await cenarioCompleto(pool);
    const { concluidos } = await montarGestaoEficiencia(pool, org.id, PERIODO, HOJE);
    const id = (n: string) => porNome.get(n)!;
    const esperado: Array<[string, number, string[]]> = [
      ['G-D-RESP-CONFIRMADA-ROCKET', concluidos.responsabilidadeConfirmadaRocket, ['C2ROCK']],
      ['G-D-RESP-CONFIRMADA-CLIENTE', concluidos.responsabilidadeConfirmadaCliente, ['C3CLI', 'C7NACLI']],
      ['G-D-RESP-DIVIDIDA', concluidos.responsabilidadeDividida, ['C4DIV']],
      ['G-D-RESP-NAO-APLICAVEL', concluidos.responsabilidadeNaoAplicavel, ['C1NA', 'C6ROCKNA']],
      ['G-D-SEM-RESPONSABILIDADE', concluidos.semResponsabilidadeAtribuida, ['C5SEM']],
    ];
    const todos: string[] = [];
    for (const [indicador, valor, nomes] of esperado) {
      const comp = await idsDaComposicao(pool, org.id, indicador);
      assert.equal(comp.total, valor, `${indicador}: composição reconcilia com o indicador`);
      assert.deepEqual([...comp.ids].sort(), nomes.map(id).sort(), `${indicador}: contêineres exatos`);
      todos.push(...comp.ids);
    }
    assert.equal(new Set(todos).size, todos.length, 'nenhum contêiner em duas categorias');
    const total = await idsDaComposicao(pool, org.id, 'G-D-TOTAL-FINAL');
    assert.equal(todos.length, total.total, 'as 5 composições particionam G-D-TOTAL-FINAL');
    assert.equal(total.total, concluidos.totalContaineresFinal);
  } finally { await pool.end(); }
});

test('D14 v1.3 #1 — registro: G-D-RESP-NAO-APLICAVEL é indicador de composição por período no grão contêiner', async () => {
  const d = listarIndicadoresRegistrados().find((x) => x.id === 'G-D-RESP-NAO-APLICAVEL');
  assert.ok(d);
  assert.equal(d!.drilldownDisponivel, true);
  assert.equal(d!.requerPeriodo, true);
  assert.equal(d!.grao, 'container');
  const sem = listarIndicadoresRegistrados().find((x) => x.id === 'G-D-SEM-RESPONSABILIDADE')!;
  assert.match(sem.estrategiaComposicao, /NENHUMA decisão vigente, de qualquer status/);
  const fonte = semComentarios(readFileSync(join(__dirname, '../leitura/gestao/drilldown.ts'), 'utf8'));
  const bloco = fonte.slice(fonte.indexOf("case 'G-D-SEM-RESPONSABILIDADE'"), fonte.indexOf("case 'G-D-RESP-CONFIRMADA-ROCKET'"));
  assert.doesNotMatch(bloco, /d\.status\s+IN/, 'sem decisão = NOT EXISTS de QUALQUER decisão vigente, sem filtro de status');
});

// ============================================================ Achado #2 — resumo

test('D14 v1.3 #2 — o resumo é limitado: sem a coleção `decisoes`; NAO_APLICAVEL aparece nos totais; reconcilia com o detalhe', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { org } = await cenarioCompleto(pool);
    const resumo = await montarGestaoResponsabilidade(pool, org.id);
    assert.deepEqual(Object.keys(resumo).sort(), ['contrato', 'diariasConfirmadasRocket', 'porStatus']);
    assert.ok(!('decisoes' in resumo), 'nenhuma coleção ilimitada no resumo');
    assert.ok(resumo.porStatus.length <= 4, 'no máximo um grupo por status');
    const porStatus = Object.fromEntries(resumo.porStatus.map((x) => [x.status, x.total]));
    // vigentes da organização (inclui C8, org-wide): ROCKET C2+C8, CLIENTE C3+C7, DIVIDIDA C4, NA C1+C6
    assert.deepEqual(porStatus, { CONFIRMADA_ROCKET: 2, CONFIRMADA_CLIENTE: 2, DIVIDIDA: 1, NAO_APLICAVEL: 2 });
    assert.equal(resumo.diariasConfirmadasRocket, 2 * 3 + 1 * 2, 'dias Rocket: 2 CONFIRMADA_ROCKET×3 + 1 DIVIDIDA×2');

    const detalhe = await listarDecisoesResponsabilidade(pool, org.id, { limite: 200 });
    assert.equal(detalhe.total, resumo.porStatus.reduce((a, x) => a + x.total, 0), 'detalhe.total = soma do resumo');
    const contagem: Record<string, number> = {};
    let dias = 0;
    for (const i of detalhe.itens) {
      contagem[i.status] = (contagem[i.status] ?? 0) + 1;
      if (i.status === 'CONFIRMADA_ROCKET' || i.status === 'DIVIDIDA') dias += i.diasRocket;
    }
    assert.deepEqual(contagem, porStatus, 'o detalhe paginado reconcilia com os totais por status');
    assert.equal(dias, resumo.diariasConfirmadasRocket);
    const na = detalhe.itens.filter((i) => i.status === 'NAO_APLICAVEL');
    assert.equal(na.length, 2, 'NAO_APLICAVEL é uma decisão vigente real no detalhe');
    assert.ok(na.every((i) => i.justificativa && i.evidenciaRef && i.decididoEm && i.containerId && i.processoId && i.numeroProcesso));
  } finally { await pool.end(); }
});

test('D14 v1.3 #2 — asserção estática: o detalhe usa LIMIT + keyset (decidido_em DESC, id DESC), sem OFFSET; o resumo não materializa decisões', async () => {
  const codigo = semComentarios(readFileSync(join(__dirname, '../leitura/gestao/responsabilidade.ts'), 'utf8'));
  assert.doesNotMatch(codigo, /OFFSET/i);
  assert.match(codigo, /ORDER BY d\.decidido_em DESC, d\.id DESC\s+LIMIT \$/);
  assert.match(codigo, /\(d\.decidido_em, d\.id\) < \(/);
  assert.match(codigo, /limite \+ 1/);
  const resumo = codigo.slice(codigo.indexOf('export async function montarGestaoResponsabilidade'), codigo.indexOf('export const VERSAO_CURSOR_DECISOES'));
  assert.match(resumo, /GROUP BY d\.status/);
  assert.doesNotMatch(resumo, /DecisaoVigenteLeitura|justificativa|evidencia_ref/);
});

// ============================================================ Achado #2 — detalhe

test('D14 v1.3 #2 — chave completa: timestamps IDÊNTICOS (desempate por id) e timestamps a 1 microssegundo (sem truncar para ms) — nenhuma linha repetida ou perdida', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const membership = await novoGestor(pool, org.id);
    const idsIguais: string[] = [];
    const linhas = [] as Parameters<typeof inserirDecisoesSinteticas>[3];
    for (let i = 0; i < 10; i++) {
      const c = await novoProcessoContainer(pool, org.id, `IGUAL${i}`);
      linhas.push({ ...c, status: 'CONFIRMADA_CLIENTE', decididoEm: '2026-03-01T10:00:00.000000Z' });
    }
    for (let i = 1; i <= 5; i++) {
      const c = await novoProcessoContainer(pool, org.id, `MICRO${i}`);
      linhas.push({ ...c, status: 'DIVIDIDA', decididoEm: `2026-03-01T11:00:00.00000${i}Z` });
    }
    const ids = await inserirDecisoesSinteticas(pool, org.id, membership, linhas);
    idsIguais.push(...ids.slice(0, 10));
    const esperado = [
      ...ids.slice(10).reverse(), // micro: 5,4,3,2,1 (mais recente primeiro)
      ...[...idsIguais].sort().reverse(), // iguais: id DESC
    ];
    for (const limite of [1, 3, 4]) {
      const vistos: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 40; i++) {
        const r: Awaited<ReturnType<typeof listarDecisoesResponsabilidade>> = await listarDecisoesResponsabilidade(pool, org.id, { limite, cursor });
        assert.ok(r.itens.length <= limite);
        vistos.push(...r.itens.map((x) => x.decisaoId));
        if (!r.cursor) break;
        cursor = r.cursor;
      }
      assert.deepEqual(vistos, esperado, `limite ${limite}: ordem (decidido_em DESC, id DESC) exata, sem repetir nem perder`);
    }
  } finally { await pool.end(); }
});

test('D14 v1.3 #2 — cursores adulterado, de outra organização, de outra versão de ordenação e de outros filtros são rejeitados; limite inválido/máximo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const orgB = await new OrganizationRepository(pool).create('Outra', 'outra-d14-v13');
    const membership = await novoGestor(pool, org.id);
    const cs = [];
    for (let i = 0; i < 4; i++) cs.push({ ...(await novoProcessoContainer(pool, org.id, `CUR${i}`)), status: 'CONFIRMADA_CLIENTE' as const });
    await inserirDecisoesSinteticas(pool, org.id, membership, cs);

    const p1 = await listarDecisoesResponsabilidade(pool, org.id, { limite: 1 });
    assert.ok(p1.cursor);
    const rejeita = (opts: Parameters<typeof listarDecisoesResponsabilidade>[2], orgId = org.id) => assert.rejects(
      () => listarDecisoesResponsabilidade(pool, orgId, opts),
      (e: any) => e.status === 400 && e.codigo === 'cursor_invalido',
    );
    await rejeita({ cursor: 'lixo-adulterado' });
    const [corpo, assinatura] = p1.cursor!.split('.');
    await rejeita({ cursor: `${corpo}.${assinatura.slice(0, -2)}AA` }); // assinatura adulterada
    const outroCorpo = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(corpo, 'base64url').toString()), id: '00000000-0000-0000-0000-000000000000' })).toString('base64url');
    await rejeita({ cursor: `${outroCorpo}.${assinatura}` }); // corpo adulterado, assinatura antiga
    await rejeita({ cursor: p1.cursor }, orgB.id); // outra organização
    await rejeita({ cursor: p1.cursor, status: 'DIVIDIDA' }); // outros filtros
    const base = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    await rejeita({ cursor: codificarCursorAssinado({ ...base, v: 'versao-de-ordenacao-antiga' }) });
    await rejeita({ cursor: codificarCursorAssinado({ ...base, id: 'nao-e-uuid' }) });
    await rejeita({ cursor: codificarCursorAssinado({ ...base, ts: 'nao-e-data' }) });
    // cursor válido continua aceito, e o tamanho da página pode mudar entre requisições
    const p2 = await listarDecisoesResponsabilidade(pool, org.id, { limite: 2, cursor: p1.cursor });
    assert.equal(p2.itens.length, 2);
    assert.ok(!p2.itens.some((x) => x.decisaoId === p1.itens[0].decisaoId));
    void VERSAO_CURSOR_DECISOES;
    // limite máximo fixo
    const grande = await listarDecisoesResponsabilidade(pool, org.id, { limite: 1_000_000 });
    assert.ok(grande.itens.length <= 200);
  } finally { await pool.end(); }
});

test('D14 v1.3 #2 — filtros (status/processo/contêiner) e isolamento: recurso de outra organização é indistinguível de um inexistente; valores inválidos são 400', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const orgB = await new OrganizationRepository(pool).create('Outra', 'outra-d14-v13-f');
    const mA = await novoGestor(pool, org.id);
    const mB = await novoGestor(pool, orgB.id);
    const a1 = await novoProcessoContainer(pool, org.id, 'FA1');
    const a2 = await novoProcessoContainer(pool, org.id, 'FA2');
    const b1 = await novoProcessoContainer(pool, orgB.id, 'FB1');
    await inserirDecisoesSinteticas(pool, org.id, mA, [{ ...a1, status: 'NAO_APLICAVEL' }, { ...a2, status: 'DIVIDIDA' }]);
    await inserirDecisoesSinteticas(pool, orgB.id, mB, [{ ...b1, status: 'NAO_APLICAVEL' }]);

    assert.deepEqual((await listarDecisoesResponsabilidade(pool, org.id, { status: 'NAO_APLICAVEL' })).itens.map((i) => i.containerId), [a1.containerId]);
    assert.deepEqual((await listarDecisoesResponsabilidade(pool, org.id, { processoId: a2.processoId })).itens.map((i) => i.containerId), [a2.containerId]);
    assert.deepEqual((await listarDecisoesResponsabilidade(pool, org.id, { containerId: a1.containerId })).itens.map((i) => i.containerId), [a1.containerId]);
    assert.equal((await listarDecisoesResponsabilidade(pool, org.id, { status: 'NAO_APLICAVEL', processoId: a2.processoId })).total, 0, 'filtros combinam com AND');

    const doOutro = await listarDecisoesResponsabilidade(pool, org.id, { processoId: b1.processoId });
    const inexistente = await listarDecisoesResponsabilidade(pool, org.id, { processoId: '11111111-1111-4111-8111-111111111111' });
    assert.deepEqual(doOutro, inexistente, 'processo de outra organização: resposta idêntica à de um id inexistente (nada vaza)');
    assert.deepEqual((await listarDecisoesResponsabilidade(pool, org.id, { containerId: b1.containerId })).itens, []);
    const todas = await listarDecisoesResponsabilidade(pool, org.id);
    assert.ok(todas.itens.every((i) => i.processoId !== b1.processoId), 'nenhuma decisão da outra organização no resultado');

    for (const opts of [{ status: 'QUALQUER' }, { processoId: 'nao-uuid' }, { containerId: '1; DROP TABLE x' }]) {
      await assert.rejects(() => listarDecisoesResponsabilidade(pool, org.id, opts), (e: any) => e.status === 400 && e.codigo === 'valor_invalido');
    }
  } finally { await pool.end(); }
});

test('D14 v1.3 #2 — benchmark: 100 vs 12.000 decisões vigentes — mesma contagem de consultas, página limitada, troca de tamanho de página sem duplicar/perder, resumo reconcilia', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgP = await new OrganizationRepository(pool).create('P', 'v13-bench-p');
    const orgG = await new OrganizationRepository(pool).create('G', 'v13-bench-g');
    await gerarMassa(pool, orgP.id, 100);
    await gerarMassa(pool, orgG.id, 12000);
    const nP = await popularDecisoesEmMassa(pool, orgP.id);
    const nG = await popularDecisoesEmMassa(pool, orgG.id);
    assert.equal(nP, 100);
    assert.ok(nG >= 10000, `pré-condição: ${nG} decisões vigentes (>= 10.000)`);

    // (a) mesma contagem de consultas, todas limitadas
    const LIMITE = 50;
    const medir = async (orgId: string) => {
      const out: Array<{ n: number; itens: number; ms: number }> = [];
      let cursor: string | null = null;
      for (let pagina = 0; pagina < 2; pagina++) {
        const { consultas, restaurar } = registrarConsultas(pool);
        const t0 = Date.now();
        try {
          const r: Awaited<ReturnType<typeof listarDecisoesResponsabilidade>> = await listarDecisoesResponsabilidade(pool, orgId, { limite: LIMITE, cursor });
          out.push({ n: consultas.length, itens: r.itens.length, ms: Date.now() - t0 });
          for (const q of consultas) assert.ok(/count\(\*\)/i.test(q.sql) || /LIMIT \$\d+/.test(q.sql), `consulta sem limite: ${q.sql.replace(/\s+/g, ' ').slice(0, 100)}`);
          cursor = r.cursor;
        } finally { restaurar(); }
      }
      return out;
    };
    const mP = await medir(orgP.id);
    const mG = await medir(orgG.id);
    assert.deepEqual(mG.map((x) => x.n), mP.map((x) => x.n), 'mesma contagem de consultas com 120x mais decisões');
    assert.ok(mG.every((x) => x.itens <= LIMITE), 'nunca mais linhas que o limite da página');

    // (b) percorre TODAS as decisões alternando o tamanho da página; compara com a ordem de referência do PostgreSQL
    const { rows: ref } = await pool.query(
      `SELECT d.id FROM responsabilidade_decisoes d
        WHERE d.organization_id = $1 AND NOT EXISTS (SELECT 1 FROM responsabilidade_decisoes d2 WHERE d2.substitui_decisao_id = d.id)
        ORDER BY d.decidido_em DESC, d.id DESC`, [orgG.id]);
    const tamanhos = [200, 137, 50, 199, 1000];
    const vistos: string[] = [];
    const status: Record<string, number> = {};
    let dias = 0;
    let cursor: string | null = null;
    let paginas = 0;
    let cursorMeio: string | null = null;
    let msUltima = 0;
    while (true) {
      const limite = tamanhos[paginas % tamanhos.length];
      const t0 = Date.now();
      const r: Awaited<ReturnType<typeof listarDecisoesResponsabilidade>> = await listarDecisoesResponsabilidade(pool, orgG.id, { limite, cursor });
      msUltima = Date.now() - t0;
      assert.ok(r.itens.length <= Math.min(limite, 200));
      for (const i of r.itens) {
        vistos.push(i.decisaoId);
        status[i.status] = (status[i.status] ?? 0) + 1;
        if (i.status === 'CONFIRMADA_ROCKET' || i.status === 'DIVIDIDA') dias += i.diasRocket;
      }
      paginas++;
      if (paginas === 20) cursorMeio = r.cursor;
      if (!r.cursor) break;
      cursor = r.cursor;
    }
    assert.equal(vistos.length, nG, 'nenhuma linha perdida');
    assert.equal(new Set(vistos).size, nG, 'nenhuma linha repetida');
    assert.deepEqual(vistos, ref.map((r) => r.id), 'ordem idêntica a (decidido_em DESC, id DESC) do PostgreSQL');

    // (c) o resumo reconcilia com o detalhe; NAO_APLICAVEL é real
    const resumo = await montarGestaoResponsabilidade(pool, orgG.id);
    assert.deepEqual(Object.fromEntries(resumo.porStatus.map((x) => [x.status, x.total])), status);
    assert.equal(resumo.diariasConfirmadasRocket, dias);
    assert.ok((status.NAO_APLICAVEL ?? 0) >= 2500, 'NAO_APLICAVEL presente em escala como decisão vigente');

    // (d) tempos (relatório): primeira, página 21 (meio) e última página
    const t1 = Date.now(); await listarDecisoesResponsabilidade(pool, orgG.id, { limite: 50 }); const msPrimeira = Date.now() - t1;
    const t2 = Date.now(); await listarDecisoesResponsabilidade(pool, orgG.id, { limite: 50, cursor: cursorMeio }); const msMeio = Date.now() - t2;
    console.log(`\n| Decisões vigentes | Consultas/página (100 → ${nG}) | Itens/página | 1ª pág (ms) | pág. do meio (ms) | última pág (ms) | Páginas (tamanhos alternados) |\n|---|---|---|---|---|---|---|\n| ${nG} | ${mP[0].n} → ${mG[0].n} | ${mG[0].itens} | ${msPrimeira} | ${msMeio} | ${msUltima} | ${paginas} |\n`);
  } finally { await pool.end(); }
});
