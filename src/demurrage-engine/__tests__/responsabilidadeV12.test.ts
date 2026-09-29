import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, PoolClient } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { PeriodoInput } from '../responsabilidade/contrato';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Fase D11 v1.2 (corretiva final, NÃO congelada) sobre `642e3a6`:
 *  1. o agregado (decisão + dias) é revalidado no COMMIT também quando um dia
 *     é acrescentado depois — mesma função de validação da decisão;
 *  2. os períodos declarados são protegidos pelo mesmo agregado;
 *  3. nenhuma decisão sobre relógio obsoleto (RELOGIO_OBSOLETO).
 * Os testes de integridade usam SQL direto, sem o serviço TypeScript.
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-12-01' };

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

interface Cenario { orgId: string; processoId: string; containerId: string }

/** Contêiner com descarga, Free Times e devolução; relógios (e valores) recalculados. */
async function cenario(
  pool: Pool, numero: string,
  f: { discharge: string; houseFT: number; masterFT: number; effective: string; diaria?: number },
): Promise<Cenario> {
  const slug = `org-${numero.toLowerCase()}`;
  const org = await new OrganizationRepository(pool).create(slug, slug);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  if (f.diaria !== undefined) {
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id, diarias: [{ equipamento: '20DV', valorDia: f.diaria }] });
    const { rows } = await pool.query(
      `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1,'embarque',$2,'teste') RETURNING id`,
      [org.id, tabela],
    );
    await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [p.id, rows[0].id]);
  }
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, p.id, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = '20DV'), effective_return_date = $2 WHERE id = $1`, [c.id, f.effective]);
  await recalcularApuracaoContainer(pool, c.id, { dataReferencia: cfg.hoje });
  return { orgId: org.id, processoId: p.id, containerId: c.id };
}

const relogio = (pool: Pool, id: string, tipo: string) => pool.query(`SELECT * FROM relogios WHERE container_id=$1 AND tipo=$2`, [id, tipo]).then((r) => r.rows[0]);

async function decidir(
  pool: Pool, c: Cenario,
  d: { status: 'CONFIRMADA_ROCKET' | 'CONFIRMADA_CLIENTE' | 'DIVIDIDA' | 'NAO_APLICAVEL'; base: 'RELOGIO_CLIENTE' | 'RELOGIO_ROCKET' | 'NAO_APLICAVEL'; periodos: PeriodoInput[] },
) {
  const autorMembershipId = await novoGestor(pool, c.orgId);
  return decidirResponsabilidade(pool, {
    organizationId: c.orgId, containerId: c.containerId, autorMembershipId, status: d.status, baseRelogio: d.base,
    motivoEstruturado: d.status === 'NAO_APLICAVEL' ? 'DIFERENCA_COMERCIAL_FREE_TIME' : null,
    periodos: d.periodos, justificativa: 'justificativa v1.2', evidenciaRef: 'evid://v12', hojeReferencia: cfg.hoje,
  });
}

/**
 * Executa `corpo` numa transação própria e informa ONDE falhou: `'corpo'`
 * (algum INSERT recusado na hora), `'commit'` (restrição ADIADA) ou `null`
 * (confirmou). A mensagem do erro vem junto.
 */
async function transacao(pool: Pool, corpo: (client: PoolClient) => Promise<void>): Promise<{ falhou: 'corpo' | 'commit' | null; erro: string | null }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await corpo(client);
    } catch (e) {
      await client.query('ROLLBACK');
      return { falhou: 'corpo', erro: (e as Error).message };
    }
    try {
      await client.query('COMMIT');
      return { falhou: null, erro: null };
    } catch (e) {
      return { falhou: 'commit', erro: (e as Error).message };
    }
  } finally {
    client.release();
  }
}

const insDia = (client: PoolClient, orgId: string, decisaoId: string, dia: string, lado: string, posicao: number, valor: number | null = null, moeda: string | null = null) =>
  client.query(
    `INSERT INTO responsabilidade_decisao_dias (organization_id, decisao_id, dia, lado, posicao, valor_dia, moeda) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, decisaoId, dia, lado, posicao, valor, moeda],
  );
const insPeriodo = (client: PoolClient, orgId: string, decisaoId: string, lado: string, inicio: string, fim: string) =>
  client.query(
    `INSERT INTO responsabilidade_decisao_periodos (organization_id, decisao_id, lado, inicio, fim) VALUES ($1,$2,$3,$4,$5)`,
    [orgId, decisaoId, lado, inicio, fim],
  );

async function insDecisao(
  client: PoolClient, c: Cenario, autor: string,
  d: { status: string; base: string; diasRocket: number; diasCliente: number; valorStatus: string; valorRocket?: number | null; valorCliente?: number | null; moeda?: string | null; motivo?: string | null },
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO responsabilidade_decisoes
       (organization_id, processo_id, container_id, versao, status, motivo_estruturado, base_relogio, dias_rocket, dias_cliente,
        valor_status, valor_rocket, valor_cliente, moeda, base, base_hash, justificativa, evidencia_ref, autor_membership_id, autor_papel)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,'{}','h','justificativa sql','evid://sql',$13,'MANAGER') RETURNING id`,
    [c.orgId, c.processoId, c.containerId, d.status, d.motivo ?? null, d.base, d.diasRocket, d.diasCliente,
      d.valorStatus, d.valorRocket ?? null, d.valorCliente ?? null, d.moeda ?? null, autor],
  );
  return rows[0].id;
}

const contagem = async (pool: Pool, decisaoId: string) => ({
  dias: (await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisao_dias WHERE decisao_id=$1`, [decisaoId])).rows[0].n,
  periodos: (await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisao_periodos WHERE decisao_id=$1`, [decisaoId])).rows[0].n,
});

/* ================================================================== *
 * Corretiva 1 — o agregado é revalidado quando um dia é acrescentado
 * ================================================================== */

test('v1.2 #1: decisão completa confirmada; dia extra ou de lado diferente em NOVA transação → o COMMIT falha', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Rocket: 03-04 e 03-05. Decisão legítima (serviço) atribui só 03-04 à Rocket.
    const c = await cenario(pool, 'AGRDIA', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const r = await decidir(pool, c, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', periodos: [{ lado: 'ROCKET', inicio: '2026-03-04', fim: '2026-03-04' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    const antes = await contagem(pool, r.decisaoId);
    assert.deepEqual(antes, { dias: 1, periodos: 1 });

    // 2-3) dia extra (dentro do relógio Rocket, posição correta): o INSERT passa; o COMMIT falha.
    const extra = await transacao(pool, (cl) => insDia(cl, c.orgId, r.decisaoId, '2026-03-05', 'ROCKET', 2).then(() => undefined));
    assert.equal(extra.falhou, 'commit', extra.erro ?? '');
    assert.match(extra.erro!, /LACUNA/);

    // Mesmo acompanhado do período correspondente, o dia extra não fecha o agregado.
    const extraComPeriodo = await transacao(pool, async (cl) => {
      await insPeriodo(cl, c.orgId, r.decisaoId, 'ROCKET', '2026-03-05', '2026-03-05');
      await insDia(cl, c.orgId, r.decisaoId, '2026-03-05', 'ROCKET', 2);
    });
    assert.equal(extraComPeriodo.falhou, 'commit', extraComPeriodo.erro ?? '');

    // 4) dia com lado diferente.
    const outroLado = await transacao(pool, (cl) => insDia(cl, c.orgId, r.decisaoId, '2026-03-05', 'CLIENTE', 2).then(() => undefined));
    assert.equal(outroLado.falhou, 'commit', outroLado.erro ?? '');
    assert.match(outroLado.erro!, /LACUNA/);

    // Nada foi acrescentado.
    assert.deepEqual(await contagem(pool, r.decisaoId), antes);
  } finally { await pool.end(); }
});

test('v1.2 #1: dia com valor, moeda ou posição divergentes → o COMMIT falha; agregado coerente confirma (SQL direto)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Cliente: 6 dias (02-06..02-11) a US$100. Divisão 3 Rocket / 3 cliente = 300 + 300.
    const c = await cenario(pool, 'AGRVAL', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const autor = await novoGestor(pool, c.orgId);
    const dias = ['2026-02-06', '2026-02-07', '2026-02-08', '2026-02-09', '2026-02-10', '2026-02-11'];
    const montar = (mut: { valorDia?: (i: number) => number | null; moeda?: (i: number) => string | null; posicao?: (i: number) => number; valorStatus?: string }) =>
      async (cl: PoolClient) => {
        const calculado = (mut.valorStatus ?? 'CALCULADO') === 'CALCULADO';
        const id = await insDecisao(cl, c, autor, {
          status: 'DIVIDIDA', base: 'RELOGIO_CLIENTE', diasRocket: 3, diasCliente: 3, valorStatus: mut.valorStatus ?? 'CALCULADO',
          valorRocket: calculado ? 300 : null, valorCliente: calculado ? 300 : null, moeda: calculado ? 'USD' : null,
        });
        await insPeriodo(cl, c.orgId, id, 'ROCKET', '2026-02-06', '2026-02-08');
        await insPeriodo(cl, c.orgId, id, 'CLIENTE', '2026-02-09', '2026-02-11');
        for (let i = 0; i < 6; i++) {
          await insDia(cl, c.orgId, id, dias[i], i < 3 ? 'ROCKET' : 'CLIENTE',
            mut.posicao ? mut.posicao(i) : i + 1,
            mut.valorDia ? mut.valorDia(i) : 100,
            mut.moeda ? mut.moeda(i) : 'USD');
        }
      };

    const valor = await transacao(pool, montar({ valorDia: (i) => (i === 0 ? 150 : 100) }));
    assert.equal(valor.falhou, 'commit');
    assert.match(valor.erro!, /VALOR_DIVERGENTE/);

    const semDiaria = await transacao(pool, montar({ valorDia: (i) => (i === 5 ? null : 100) }));
    assert.equal(semDiaria.falhou, 'commit');
    assert.match(semDiaria.erro!, /VALOR_DIVERGENTE/);

    const moeda = await transacao(pool, montar({ moeda: (i) => (i === 4 ? 'BRL' : 'USD') }));
    assert.equal(moeda.falhou, 'commit');
    assert.match(moeda.erro!, /MOEDA_DIVERGENTE/);

    const posDup = await transacao(pool, montar({ posicao: (i) => (i === 1 ? 1 : i + 1) }));
    assert.equal(posDup.falhou, 'commit');
    assert.match(posDup.erro!, /POSICAO_INVALIDA/);

    const posFora = await transacao(pool, montar({ posicao: (i) => 6 - i }));
    assert.equal(posFora.falhou, 'commit');
    assert.match(posFora.erro!, /POSICAO_INVALIDA/);

    const diariaSemCalculo = await transacao(pool, montar({ valorStatus: 'INDISPONIVEL', moeda: () => null }));
    assert.equal(diariaSemCalculo.falhou, 'commit');
    assert.match(diariaSemCalculo.erro!, /VALOR_DIVERGENTE/);

    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 0);

    // Agregado coerente confirma.
    const ok = await transacao(pool, montar({}));
    assert.equal(ok.falhou, null, ok.erro ?? '');
  } finally { await pool.end(); }
});

test('v1.2 #1: decisão legítima do serviço (DIVIDIDA, períodos descontínuos, valor CALCULADO) continua funcionando', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'AGRSRV', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const r = await decidir(pool, c, {
      status: 'DIVIDIDA', base: 'RELOGIO_CLIENTE',
      periodos: [
        { lado: 'ROCKET', inicio: '2026-02-06', fim: '2026-02-07' },
        { lado: 'CLIENTE', inicio: '2026-02-08', fim: '2026-02-09' },
        { lado: 'ROCKET', inicio: '2026-02-10', fim: '2026-02-11' },
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    const { rows: [d] } = await pool.query(`SELECT * FROM responsabilidade_decisoes WHERE id=$1`, [r.decisaoId]);
    assert.equal(d.valor_status, 'CALCULADO');
    assert.equal(Number(d.valor_rocket), 400);
    assert.equal(Number(d.valor_cliente), 200);
    assert.deepEqual(await contagem(pool, r.decisaoId), { dias: 6, periodos: 3 });
    assert.equal((await pool.query(`SELECT responsabilidade FROM containers WHERE id=$1`, [c.containerId])).rows[0].responsabilidade, 'DIVIDIDA');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Corretiva 2 — períodos declarados protegidos pelo agregado
 * ================================================================== */

test('v1.2 #2: períodos incompatíveis com os dias → o COMMIT falha (SQL direto)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // Cliente: 5 dias (01-06..01-10); decisão INDISPONIVEL (sem diária) para isolar os períodos.
    const c = await cenario(pool, 'PERINV', { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10' });
    const autor = await novoGestor(pool, c.orgId);
    const dias5 = ['2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'];
    const comPeriodos = (periodos: Array<[string, string, string]>, ladoDoDia: (i: number) => string = () => 'CLIENTE') => async (cl: PoolClient) => {
      const rocket = dias5.filter((_, i) => ladoDoDia(i) === 'ROCKET').length;
      const id = await insDecisao(cl, c, autor, {
        status: rocket === 0 ? 'CONFIRMADA_CLIENTE' : 'DIVIDIDA', base: 'RELOGIO_CLIENTE',
        diasRocket: rocket, diasCliente: 5 - rocket, valorStatus: 'INDISPONIVEL',
      });
      for (const [lado, ini, fim] of periodos) await insPeriodo(cl, c.orgId, id, lado, ini, fim);
      for (let i = 0; i < 5; i++) await insDia(cl, c.orgId, id, dias5[i], ladoDoDia(i), i + 1);
    };

    const casos: Array<[string, ReturnType<typeof comPeriodos>]> = [
      ['dia sem período', comPeriodos([['CLIENTE', '2026-01-06', '2026-01-09']])],
      ['nenhum período', comPeriodos([])],
      ['lado do período diferente do dia', comPeriodos([['ROCKET', '2026-01-06', '2026-01-10']])],
      ['período sem os respectivos dias', comPeriodos([['CLIENTE', '2026-01-06', '2026-01-11']])],
      ['períodos sobrepostos (mesmo lado)', comPeriodos([['CLIENTE', '2026-01-06', '2026-01-08'], ['CLIENTE', '2026-01-08', '2026-01-10']])],
      ['lado trocado num trecho', comPeriodos([['ROCKET', '2026-01-06', '2026-01-07'], ['CLIENTE', '2026-01-08', '2026-01-10']], (i) => (i < 3 ? 'ROCKET' : 'CLIENTE'))],
    ];
    for (const [nome, corpo] of casos) {
      const r = await transacao(pool, corpo);
      assert.equal(r.falhou, 'commit', `${nome}: ${r.erro}`);
      assert.match(r.erro!, /PERIODO_INCOMPATIVEL/, nome);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 0);

    // Períodos descontínuos VÁLIDOS: Rocket 06-07, cliente 08, Rocket 09-10.
    const valido = await transacao(pool, comPeriodos(
      [['ROCKET', '2026-01-06', '2026-01-07'], ['CLIENTE', '2026-01-08', '2026-01-08'], ['ROCKET', '2026-01-09', '2026-01-10']],
      (i) => (i === 2 ? 'CLIENTE' : 'ROCKET'),
    ));
    assert.equal(valido.falhou, null, valido.erro ?? '');
  } finally { await pool.end(); }
});

test('v1.2 #2: período acrescentado depois da decisão concluída → o COMMIT falha', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'PERPOS', { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10', diaria: 150 });
    const rel = await relogio(pool, c.containerId, 'cliente');
    const r = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;

    for (const [lado, ini, fim] of [['CLIENTE', '2026-01-08', '2026-01-08'], ['ROCKET', '2026-01-11', '2026-01-12'], ['CLIENTE', '2026-01-10', '2026-01-10']]) {
      const t = await transacao(pool, (cl) => insPeriodo(cl, c.orgId, r.decisaoId, lado, ini, fim).then(() => undefined));
      assert.equal(t.falhou, 'commit', `${lado} ${ini}..${fim}: ${t.erro}`);
      assert.match(t.erro!, /PERIODO_INCOMPATIVEL/);
    }
    // Dia fora do relógio: recusado já no INSERT (gatilho da 0031).
    const fora = await transacao(pool, (cl) => insDia(cl, c.orgId, r.decisaoId, '2026-01-11', 'CLIENTE', 6).then(() => undefined));
    assert.equal(fora.falhou, 'corpo');
    assert.match(fora.erro!, /DIA_FORA_DA_BASE/);
    assert.deepEqual(await contagem(pool, r.decisaoId), { dias: 5, periodos: 1 });
  } finally { await pool.end(); }
});

test('v1.2 #2: NAO_APLICAVEL não aceita período — nem na criação nem depois; sem períodos confirma', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'PERNA', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const autor = await novoGestor(pool, c.orgId);
    const naDecisao = (cl: PoolClient) => insDecisao(cl, c, autor, {
      status: 'NAO_APLICAVEL', base: 'NAO_APLICAVEL', diasRocket: 0, diasCliente: 0, valorStatus: 'NAO_APLICAVEL', motivo: 'DIFERENCA_COMERCIAL_FREE_TIME',
    });
    const comPeriodo = await transacao(pool, async (cl) => {
      const id = await naDecisao(cl);
      await insPeriodo(cl, c.orgId, id, 'ROCKET', '2026-03-04', '2026-03-05');
    });
    assert.equal(comPeriodo.falhou, 'commit');
    assert.match(comPeriodo.erro!, /PERIODO_INCOMPATIVEL/);

    let id = '';
    const semPeriodo = await transacao(pool, async (cl) => { id = await naDecisao(cl); });
    assert.equal(semPeriodo.falhou, null, semPeriodo.erro ?? '');

    const depois = await transacao(pool, (cl) => insPeriodo(cl, c.orgId, id, 'ROCKET', '2026-03-04', '2026-03-04').then(() => undefined));
    assert.equal(depois.falhou, 'commit');
    assert.match(depois.erro!, /PERIODO_INCOMPATIVEL/);
    assert.deepEqual(await contagem(pool, id), { dias: 0, periodos: 0 });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Corretiva 3 — nunca decidir com relógio obsoleto
 * ================================================================== */

const obs = (pool: Pool, c: Cenario, campo: string, valor: unknown, fonte: string, em: string) =>
  new ContainerRepository(pool).applyObservation({ containerId: c.containerId, organizationId: c.orgId, campo: campo as any, valor, fonte: fonte as any, observadoEm: new Date(em) });

test('v1.2 #3 (obrigatório): House Free Time alterado sem recálculo → RELOGIO_OBSOLETO; após recálculo a decisão passa com os fatos novos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    // 1) relógios calculados: House 5 → cliente 02-06..02-11 (6 dias).
    const c = await cenario(pool, 'OBSHFT', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const antes = await relogio(pool, c.containerId, 'cliente');
    assert.equal(antes.dias_demurrage, 6);

    // 2) House passa a 7 (observação posterior da mesma fonte), SEM recálculo.
    await obs(pool, c, 'houseFreeTimeDays', 7, 'house_document', '2026-02-12T00:00:00Z');
    assert.equal((await pool.query(`SELECT house_free_time_days FROM containers WHERE id=$1`, [c.containerId])).rows[0].house_free_time_days, 7);

    // 3-4) decidir com o relógio antigo → recusado, e nada é recalculado em silêncio.
    const r1 = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }] });
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.equal(r1.codigo, 'RELOGIO_OBSOLETO');
    assert.deepEqual(r1.detalhe, { relogio: 'cliente', validade: 'OBSOLETO' });
    const aindaAntigo = await relogio(pool, c.containerId, 'cliente');
    assert.equal(aindaAntigo.input_hash, antes.input_hash, 'o serviço não recalculou');
    assert.equal(aindaAntigo.dias_demurrage, 6);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes WHERE container_id=$1`, [c.containerId])).rows[0].n, 0);

    // 5) pipeline recalcula → cliente 02-08..02-11 (4 dias).
    await recalcularApuracaoContainer(pool, c.containerId, { dataReferencia: cfg.hoje });
    const novo = await relogio(pool, c.containerId, 'cliente');
    assert.equal(novo.dias_demurrage, 4);
    assert.equal(novo.primeiro_dia_demurrage, '2026-02-08');

    // 6) decisão com os fatos novos passa (valor 4 × US$100).
    const r2 = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-08', fim: '2026-02-11' }] });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    if (!r2.ok) return;
    const { rows: [d] } = await pool.query(`SELECT dias_cliente, valor_cliente, base FROM responsabilidade_decisoes WHERE id=$1`, [r2.decisaoId]);
    assert.equal(d.dias_cliente, 4);
    assert.equal(Number(d.valor_cliente), 400);
    assert.equal(d.base.clienteInputHash, novo.input_hash);
  } finally { await pool.end(); }
});

test('v1.2 #3: descarga alterada sem recálculo → RELOGIO_OBSOLETO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'OBSDSC', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11' });
    await obs(pool, c, 'dischargeDate', '2026-02-02', 'master_bl', '2026-02-12T00:00:00Z');
    assert.equal((await pool.query(`SELECT discharge_date FROM containers WHERE id=$1`, [c.containerId])).rows[0].discharge_date, '2026-02-02');
    const r = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'RELOGIO_OBSOLETO');
  } finally { await pool.end(); }
});

test('v1.2 #3: data final (devolução efetiva) alterada sem recálculo → RELOGIO_OBSOLETO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'OBSFIM', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11' });
    await pool.query(`UPDATE containers SET effective_return_date = '2026-02-13' WHERE id = $1`, [c.containerId]);
    const r = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.codigo, 'RELOGIO_OBSOLETO');
    assert.deepEqual(r.detalhe, { relogio: 'cliente', validade: 'OBSOLETO' });
  } finally { await pool.end(); }
});

test('v1.2 #3: RELOGIO_ROCKET exige Rocket VÁLIDO e também o relógio do cliente que prova o zero', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const periodos: PeriodoInput[] = [{ lado: 'ROCKET', inicio: '2026-03-04', fim: '2026-03-05' }];

    // Master alterado → Rocket obsoleto.
    const a = await cenario(pool, 'OBSRKM', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    await obs(pool, a, 'masterFreeTimeDays', 2, 'master_bl', '2026-03-06T00:00:00Z');
    const ra = await decidir(pool, a, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', periodos });
    assert.equal(ra.ok, false);
    if (ra.ok) return;
    assert.equal(ra.codigo, 'RELOGIO_OBSOLETO');
    assert.deepEqual(ra.detalhe, { relogio: 'rocket', validade: 'OBSOLETO' });

    // Só o House alterado → o relógio do cliente (prova do zero) está obsoleto.
    const b = await cenario(pool, 'OBSRKH', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    await obs(pool, b, 'houseFreeTimeDays', 12, 'house_document', '2026-03-06T00:00:00Z');
    const rb = await decidir(pool, b, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', periodos });
    assert.equal(rb.ok, false);
    if (rb.ok) return;
    assert.equal(rb.codigo, 'RELOGIO_OBSOLETO');
    assert.deepEqual(rb.detalhe, { relogio: 'cliente', validade: 'OBSOLETO' });

    // Após recálculo, a decisão Rocket passa.
    await recalcularApuracaoContainer(pool, b.containerId, { dataReferencia: cfg.hoje });
    const rb2 = await decidir(pool, b, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', periodos });
    assert.equal(rb2.ok, true, JSON.stringify(rb2));
  } finally { await pool.end(); }
});

test('v1.2 #3: NAO_APLICAVEL exige os dois relógios VÁLIDOS; relógio AUSENTE também é RELOGIO_OBSOLETO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const a = await cenario(pool, 'OBSNA', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    await obs(pool, a, 'masterFreeTimeDays', 4, 'master_bl', '2026-03-06T00:00:00Z');
    const ra = await decidir(pool, a, { status: 'NAO_APLICAVEL', base: 'NAO_APLICAVEL', periodos: [] });
    assert.equal(ra.ok, false);
    if (ra.ok) return;
    assert.equal(ra.codigo, 'RELOGIO_OBSOLETO');
    assert.deepEqual(ra.detalhe, { relogio: 'rocket', validade: 'OBSOLETO' });

    const b = await cenario(pool, 'OBSAUS', { discharge: '2026-01-01', houseFT: 5, masterFT: 100, effective: '2026-01-10' });
    await pool.query(`DELETE FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [b.containerId]);
    const rb = await decidir(pool, b, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-01-06', fim: '2026-01-10' }] });
    assert.equal(rb.ok, false);
    if (rb.ok) return;
    assert.equal(rb.codigo, 'RELOGIO_OBSOLETO');
    assert.deepEqual(rb.detalhe, { relogio: 'cliente', validade: 'AUSENTE' });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM relogios WHERE container_id=$1 AND tipo='cliente'`, [b.containerId])).rows[0].n, 0, 'nenhum recálculo silencioso');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Caminho 0033 → 0034 com decisões JÁ existentes
 * ================================================================== */

test('v1.2 migração 0033 → 0034: decisões existentes preservadas; dias/períodos acrescentados depois passam a ser revalidados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0033_responsabilidade_v1_1_corretiva.sql' });

    const rk = await cenario(pool, 'MIGRK', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const dRk = await decidir(pool, rk, { status: 'CONFIRMADA_ROCKET', base: 'RELOGIO_ROCKET', periodos: [{ lado: 'ROCKET', inicio: '2026-03-04', fim: '2026-03-04' }] });
    const div = await cenario(pool, 'MIGDIV', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11', diaria: 100 });
    const dDiv = await decidir(pool, div, {
      status: 'DIVIDIDA', base: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'ROCKET', inicio: '2026-02-06', fim: '2026-02-08' }, { lado: 'CLIENTE', inicio: '2026-02-09', fim: '2026-02-11' }],
    });
    const na = await cenario(pool, 'MIGNA', { discharge: '2026-03-01', houseFT: 10, masterFT: 3, effective: '2026-03-05' });
    const dNa = await decidir(pool, na, { status: 'NAO_APLICAVEL', base: 'NAO_APLICAVEL', periodos: [] });
    assert.ok(dRk.ok && dDiv.ok && dNa.ok, JSON.stringify([dRk, dDiv, dNa]));
    if (!dRk.ok || !dDiv.ok || !dNa.ok) return;

    // Na 0033 o buraco existe: um dia extra acrescentado depois é aceito.
    const antesDaCorrecao = await transacao(pool, async (cl) => {
      await insPeriodo(cl, rk.orgId, dRk.decisaoId, 'ROCKET', '2026-03-05', '2026-03-05');
      await insDia(cl, rk.orgId, dRk.decisaoId, '2026-03-05', 'ROCKET', 2);
    });
    assert.equal(antesDaCorrecao.falhou, null, 'na 0033 o dia extra passava (o defeito corrigido pela 0034)');

    const snapshot = async () => ({
      decisoes: (await pool.query(`SELECT id, versao, status, dias_rocket, dias_cliente, valor_rocket, valor_cliente, base FROM responsabilidade_decisoes ORDER BY id`)).rows,
      dias: (await pool.query(`SELECT decisao_id, dia, lado, posicao, valor_dia, moeda FROM responsabilidade_decisao_dias ORDER BY decisao_id, dia`)).rows,
      periodos: (await pool.query(`SELECT decisao_id, lado, inicio, fim FROM responsabilidade_decisao_periodos ORDER BY decisao_id, inicio`)).rows,
      projecao: (await pool.query(`SELECT id, responsabilidade, responsabilidade_decisao_id FROM containers ORDER BY id`)).rows,
    });
    const antes = await snapshot();

    const r = await runMigrations(pool);
    assert.deepEqual(r.applied, ['0034_responsabilidade_v1_2_agregado.sql']);
    // A migração não reescreve nem revalida retroativamente nada existente.
    assert.deepEqual(await snapshot(), antes);

    const { rows: tg } = await pool.query(
      `SELECT tgname, tgrelid::regclass::text AS tabela, tgdeferrable AS adiavel FROM pg_trigger
        WHERE tgname IN ('responsabilidade_decisoes_cobertura', 'responsabilidade_decisao_dias_cobertura', 'responsabilidade_decisao_periodos_cobertura')
        ORDER BY tgname`);
    assert.deepEqual(tg, [
      { tgname: 'responsabilidade_decisao_dias_cobertura', tabela: 'responsabilidade_decisao_dias', adiavel: true },
      { tgname: 'responsabilidade_decisao_periodos_cobertura', tabela: 'responsabilidade_decisao_periodos', adiavel: true },
      { tgname: 'responsabilidade_decisoes_cobertura', tabela: 'responsabilidade_decisoes', adiavel: true },
    ]);

    // Depois da 0034: acrescentar dia ou período a uma decisão existente falha no COMMIT.
    const diaDiv = await transacao(pool, (cl) => insPeriodo(cl, div.orgId, dDiv.decisaoId, 'CLIENTE', '2026-02-11', '2026-02-11').then(() => undefined));
    assert.equal(diaDiv.falhou, 'commit');
    assert.match(diaDiv.erro!, /PERIODO_INCOMPATIVEL/);
    const naPer = await transacao(pool, (cl) => insPeriodo(cl, na.orgId, dNa.decisaoId, 'ROCKET', '2026-03-04', '2026-03-04').then(() => undefined));
    assert.equal(naPer.falhou, 'commit');
    assert.match(naPer.erro!, /PERIODO_INCOMPATIVEL/);
    assert.deepEqual(await snapshot(), antes);

    // O serviço segue funcionando: nova decisão (correção) sobre o contêiner dividido.
    const autor = await novoGestor(pool, div.orgId);
    const corr = await decidirResponsabilidade(pool, {
      organizationId: div.orgId, containerId: div.containerId, autorMembershipId: autor, status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }],
      justificativa: 'correção pós-0034', evidenciaRef: 'evid://pos', substituiDecisaoId: dDiv.decisaoId, motivoCorrecao: 'revisão',
      hojeReferencia: cfg.hoje,
    });
    assert.equal(corr.ok, true, JSON.stringify(corr));
  } finally {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    await pool.end();
  }
});

/* ================================================================== *
 * Precedência validada (2a): VERSAO_DESATUALIZADA antes de RELOGIO_OBSOLETO;
 * com relógio válido, a ordem da v1.1 é preservada.
 * ================================================================== */

test('v1.2 precedência: relógio obsoleto + versão desatualizada → VERSAO_DESATUALIZADA; versão correta → RELOGIO_OBSOLETO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'PREC1', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11' });
    const v1 = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }] });
    assert.equal(v1.ok, true, JSON.stringify(v1));
    if (!v1.ok) return;
    await obs(pool, c, 'houseFreeTimeDays', 7, 'house_document', '2026-02-12T00:00:00Z'); // relógio do cliente fica obsoleto
    const autorMembershipId = await novoGestor(pool, c.orgId);
    const base = {
      organizationId: c.orgId, containerId: c.containerId, autorMembershipId, status: 'CONFIRMADA_CLIENTE' as const, baseRelogio: 'RELOGIO_CLIENTE' as const,
      periodos: [{ lado: 'CLIENTE' as const, inicio: '2026-02-06', fim: '2026-02-11' }], justificativa: 'j', evidenciaRef: 'e', hojeReferencia: cfg.hoje,
    };

    // Sem `substitui` (versão desatualizada) e relógio obsoleto → VERSAO_DESATUALIZADA.
    const semSubstitui = await decidirResponsabilidade(pool, base);
    assert.equal(semSubstitui.ok, false);
    if (semSubstitui.ok) return;
    assert.equal(semSubstitui.codigo, 'VERSAO_DESATUALIZADA');

    // `substitui` apontando para versão inexistente e relógio obsoleto → VERSAO_DESATUALIZADA.
    const substituiErrado = await decidirResponsabilidade(pool, { ...base, substituiDecisaoId: c.containerId, motivoCorrecao: 'm' });
    assert.equal(substituiErrado.ok, false);
    if (substituiErrado.ok) return;
    assert.equal(substituiErrado.codigo, 'VERSAO_DESATUALIZADA');

    // Versão correta e relógio obsoleto → RELOGIO_OBSOLETO.
    const versaoCorreta = await decidirResponsabilidade(pool, { ...base, substituiDecisaoId: v1.decisaoId, motivoCorrecao: 'm' });
    assert.equal(versaoCorreta.ok, false);
    if (versaoCorreta.ok) return;
    assert.equal(versaoCorreta.codigo, 'RELOGIO_OBSOLETO');
  } finally { await pool.end(); }
});

test('v1.2 precedência: com relógio VÁLIDO, a ordem da v1.1 é preservada — validação de relógio antes de VERSAO_DESATUALIZADA', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const c = await cenario(pool, 'PREC2', { discharge: '2026-02-01', houseFT: 5, masterFT: 100, effective: '2026-02-11' });
    const v1 = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }] });
    assert.equal(v1.ok, true, JSON.stringify(v1));

    // Versão desatualizada (sem `substitui`) E cliente com dias (NAO_APLICAVEL inválido): como na v1.1, vence a validação de relógio.
    const na = await decidir(pool, c, { status: 'NAO_APLICAVEL', base: 'NAO_APLICAVEL', periodos: [] });
    assert.equal(na.ok, false);
    if (na.ok) return;
    assert.equal(na.codigo, 'BASE_RELOGIO_INVALIDA');

    // Versão desatualizada e relógio válido sem outra falha → VERSAO_DESATUALIZADA.
    const cli = await decidir(pool, c, { status: 'CONFIRMADA_CLIENTE', base: 'RELOGIO_CLIENTE', periodos: [{ lado: 'CLIENTE', inicio: '2026-02-06', fim: '2026-02-11' }] });
    assert.equal(cli.ok, false);
    if (cli.ok) return;
    assert.equal(cli.codigo, 'VERSAO_DESATUALIZADA');
  } finally { await pool.end(); }
});
