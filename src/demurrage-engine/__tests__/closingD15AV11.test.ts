import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { ClosingService } from '../closing/closingService';
import { promoverHouseFreeTimeComClient } from '../freeTime/houseFreeTimeService';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { novoGestor } from './responsabilidadeTestHelper';

/**
 * Fase D15-A v1.1 (corretiva) — os 10 testes obrigatórios do audit sobre
 * `86461d0`: elimina a corrida do guard de FINAL (achado #1), estabelece a
 * ordem universal de lock entre os quatro escritores de fechamento/reabertura
 * e os cinco escritores materiais (achado #2), e padroniza o contrato
 * `exigeReabertura` (achado #3). NÃO reescreve `closingD15A.test.ts` — os 16
 * testes de aceitação da v1.0 continuam intactos e são executados junto
 * (ver `npm run test:demurrage-engine`).
 */

const url = testDatabaseUrl();
const cfg = { hoje: '2026-10-01' };

/** Pool com `lock_timeout` curto em TODA conexão física nova (item #6 obrigatório):
 * se uma regressão reintroduzir uma ordem de lock inconsistente, o teste falha em
 * segundos com um erro claro do Postgres (55P03) em vez de travar a suíte inteira. */
function testPoolComLockTimeout(ms: number): Pool {
  const pool = testPool();
  pool.on('connect', (client) => { client.query(`SET lock_timeout = '${ms}'`).catch(() => {}); });
  return pool;
}

async function setupBanco(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function seedZero(pool: Pool, numero: string) {
  const org = await new OrganizationRepository(pool).create('Rocket', `rocket-${numero.toLowerCase()}`);
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, processo.id, numero);
  const em = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: 20, fonte: 'master_bl', observadoEm: em });
  const tipo20dv = (await pool.query(`SELECT id FROM container_types WHERE codigo = '20DV'`)).rows[0].id;
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'containerType', valor: tipo20dv, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') });
  return { orgId: org.id, processoId: processo.id, containerId: c.id, numero, tipo20dv };
}

/** Constrói o cenário zero-custo e FINALIZA de verdade pelo serviço (gate real). */
async function cenarioFinal(pool: Pool, numero: string) {
  const base = await seedZero(pool, numero);
  const svc = new ClosingService(pool);
  const gestorId = await novoGestor(pool, base.orgId);
  const fin = await svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg });
  assert.deepEqual(fin, { ok: true }, `pré-condição: processo deveria finalizar (${JSON.stringify(fin)})`);
  return { ...base, svc, gestorId };
}

async function container(pool: Pool, id: string) {
  return (await pool.query(`SELECT * FROM containers WHERE id=$1`, [id])).rows[0];
}
async function eventosMateriais(pool: Pool, containerId: string) {
  return (await pool.query(
    `SELECT * FROM closing_events WHERE container_id=$1 AND tipo_evento='FATO_MATERIAL_POS_FINAL' ORDER BY criado_em`, [containerId],
  )).rows;
}
async function contagemObservacoes(pool: Pool, containerId: string, campo: string) {
  return Number((await pool.query(
    `SELECT count(*)::int AS n FROM field_observations WHERE entidade_id=$1 AND campo=$2`, [containerId, campo],
  )).rows[0].n);
}

/** "Portão" determinístico: dispara `hook` dentro da transação pausada, sinaliza
 * `aguardarPausado` no exato instante em que a pausa começa (o lock consultivo e
 * os `FOR UPDATE` já foram adquiridos ANTES do hook disparar), e só continua
 * quando `liberar()` é chamado. Nenhum sleep/timing — a sincronização é pela
 * própria Promise devolvida pelo hook. */
function criarPortao() {
  let liberarFn: (() => void) | null = null;
  let sinalizarPausado!: () => void;
  const aguardarPausado = new Promise<void>((resolve) => { sinalizarPausado = resolve; });
  const hook = () => new Promise<void>((resolve) => { liberarFn = resolve; sinalizarPausado(); });
  return { hook, aguardarPausado, liberar: () => { if (liberarFn) liberarFn(); } };
}

async function tentarHouseFreeTime(pool: Pool, input: { organizationId: string; containerId: string; valor: number; fonte: any; observadoEm: Date }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await promoverHouseFreeTimeComClient(client, input as any);
    await client.query('COMMIT');
    return r;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

/* ================================================================== *
 * #1/#2 (parte A) — corrida REAL sem pausa artificial: escritor material
 * concorrente com finalizarProcesso, nos cinco campos exigidos. A ordem
 * universal de lock (achado #2) garante que, qualquer que seja a ordem de
 * chegada, o resultado é sempre um dos dois estados consistentes — nunca uma
 * promoção depois de FINAL sem reabertura.
 * ================================================================== */

test('D15-A v1.1 #1/#2: descarga concorrente com finalizarProcesso nunca promove depois de FINAL sem reabertura', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE1D000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const containers = new ContainerRepository(pool);

    const [outObs, outFinal] = await Promise.all([
      containers.applyObservation({
        containerId: base.containerId, organizationId: base.orgId, campo: 'dischargeDate',
        valor: '2026-09-03', fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'),
      }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);

    assert.deepEqual(outFinal, { ok: true }, `finalizarProcesso deveria suceder em qualquer ordem (${JSON.stringify(outFinal)})`);
    const depois = await container(pool, base.containerId);
    const ev = (await eventosMateriais(pool, base.containerId)).filter((e: any) => e.payload.campo === 'dischargeDate');
    if (outObs.outcome === 'promovida') {
      assert.equal(outObs.exigeReabertura, false);
      assert.equal(depois.discharge_date, '2026-09-03', 'observação correu ANTES do fechamento — promovida e incorporada ao FINAL');
      assert.equal(ev.length, 0);
    } else {
      assert.equal(outObs.outcome, 'bloqueada_final');
      assert.equal(outObs.exigeReabertura, true);
      assert.equal(depois.discharge_date, '2026-09-01', 'fechamento venceu a corrida — projeção FINAL nunca mutada');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].payload.valorNovo, '2026-09-03');
    }
  } finally { await pool.end(); }
});

test('D15-A v1.1 #1/#2: House Free Time concorrente com finalizarProcesso nunca promove depois de FINAL sem reabertura', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE1H000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);

    const [outObs, outFinal] = await Promise.all([
      tentarHouseFreeTime(pool, { organizationId: base.orgId, containerId: base.containerId, valor: 25, fonte: 'house_document', observadoEm: new Date('2026-09-02T00:00:00Z') }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);

    assert.deepEqual(outFinal, { ok: true });
    const depois = await container(pool, base.containerId);
    const ev = (await eventosMateriais(pool, base.containerId)).filter((e: any) => e.payload.campo === 'houseFreeTimeDays');
    if (outObs.outcome === 'promovida') {
      assert.equal(outObs.exigeReabertura, false);
      assert.equal(depois.house_free_time_days, 25);
      assert.equal(ev.length, 0);
    } else {
      assert.equal(outObs.outcome, 'bloqueada_final');
      assert.equal(outObs.exigeReabertura, true);
      assert.equal(depois.house_free_time_days, 20);
      assert.equal(ev.length, 1);
    }
  } finally { await pool.end(); }
});

test('D15-A v1.1 #1/#2: Master Free Time concorrente com finalizarProcesso nunca promove depois de FINAL sem reabertura', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE1M000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);

    const [outObs, outFinal] = await Promise.all([
      promoverMasterFreeTime(pool, { organizationId: base.orgId, containerId: base.containerId, valor: 25, fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'), autor: 'teste:D15A-v1.1' }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);

    assert.deepEqual(outFinal, { ok: true });
    const depois = await container(pool, base.containerId);
    const ev = (await eventosMateriais(pool, base.containerId)).filter((e: any) => e.payload.campo === 'masterFreeTimeDays');
    if (outObs.outcome === 'promovida') {
      assert.equal(outObs.exigeReabertura, false);
      assert.equal(depois.master_free_time_days, 25);
      assert.equal(ev.length, 0);
    } else {
      assert.equal(outObs.outcome, 'bloqueada_final');
      assert.equal(outObs.exigeReabertura, true);
      assert.equal(outObs.bloqueadoPorFinal, true, 'alias deprecated ainda espelha exigeReabertura');
      assert.equal(depois.master_free_time_days, 20);
      assert.equal(ev.length, 1);
    }
  } finally { await pool.end(); }
});

test('D15-A v1.1 #1/#2: tipo de equipamento concorrente com finalizarProcesso nunca promove depois de FINAL sem reabertura', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE1T000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const containers = new ContainerRepository(pool);
    const tipo40hc = (await pool.query(`SELECT id FROM container_types WHERE codigo = '40HC'`)).rows[0].id;

    const [outObs, outFinal] = await Promise.all([
      containers.applyObservation({
        containerId: base.containerId, organizationId: base.orgId, campo: 'containerType',
        valor: tipo40hc, fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'),
      }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);

    assert.deepEqual(outFinal, { ok: true });
    const depois = await container(pool, base.containerId);
    const ev = (await eventosMateriais(pool, base.containerId)).filter((e: any) => e.payload.campo === 'containerType');
    if (outObs.outcome === 'promovida') {
      assert.equal(outObs.exigeReabertura, false);
      assert.equal(depois.container_type_id, tipo40hc);
      assert.equal(ev.length, 0);
    } else {
      assert.equal(outObs.outcome, 'bloqueada_final');
      assert.equal(outObs.exigeReabertura, true);
      assert.equal(depois.container_type_id, base.tipo20dv);
      assert.equal(ev.length, 1);
    }
  } finally { await pool.end(); }
});

test('D15-A v1.1 #1/#2: retorno de tracking concorrente com finalizarProcesso nunca promove depois de FINAL sem reabertura', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE1R000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const containers = new ContainerRepository(pool);

    const [outObs, outFinal] = await Promise.all([
      containers.applyObservation({
        containerId: base.containerId, organizationId: base.orgId, campo: 'trackingReturnDate',
        valor: '2026-09-16', fonte: 'tracking_service', observadoEm: new Date('2026-09-16T00:00:00Z'),
      }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);

    assert.deepEqual(outFinal, { ok: true });
    const depois = await container(pool, base.containerId);
    const ev = (await eventosMateriais(pool, base.containerId)).filter((e: any) => e.payload.campo === 'trackingReturnDate');
    if (outObs.outcome === 'promovida') {
      assert.equal(outObs.exigeReabertura, false);
      assert.equal(depois.tracking_return_date, '2026-09-16');
      assert.equal(ev.length, 0);
    } else {
      assert.equal(outObs.outcome, 'bloqueada_final');
      assert.equal(outObs.exigeReabertura, true);
      assert.equal(depois.tracking_return_date, '2026-09-10');
      assert.equal(ev.length, 1);
    }
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #1 (parte B) — corrida com pausa DETERMINÍSTICA: prova as DUAS ordens
 * possíveis explicitamente (descarga é representativa do caminho genérico
 * de `ContainerRepository`; os outros quatro campos já foram cobertos sem
 * pausa artificial acima — o protocolo universal de lock trata os cinco da
 * MESMA forma, ver `materialChangeGuard.ts`).
 * ================================================================== */

test('D15-A v1.1 #1: observação pausada ANTES da decisão final retém o lock consultivo — finalizarProcesso concorrente só comita DEPOIS (observação promove; fechamento incorpora o valor já promovido)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE2A000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const containers = new ContainerRepository(pool);
    const portao = criarPortao();

    const pObs = containers.applyObservation({
      containerId: base.containerId, organizationId: base.orgId, campo: 'dischargeDate',
      valor: '2026-09-03', fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'),
      _testeAntesDaDecisaoFinal: portao.hook,
    });
    // A observação já tem o lock consultivo e o FOR UPDATE do processo/contêiner
    // adquiridos quando o hook dispara (passos 2-4 do protocolo rodam ANTES dele).
    await portao.aguardarPausado;

    // finalizarProcesso concorrente: seu PRIMEIRO lock é o mesmo consultivo —
    // fica bloqueado no Postgres até a observação comitar ou abortar.
    const pFinal = svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg });

    portao.liberar();
    const [outObs, outFinal] = await Promise.all([pObs, pFinal]);

    assert.equal(outObs.outcome, 'promovida', 'processo ainda OPEN quando a observação decidiu — promove normalmente');
    assert.equal(outObs.exigeReabertura, false);
    assert.deepEqual(outFinal, { ok: true });
    const depois = await container(pool, base.containerId);
    assert.equal(depois.discharge_date, '2026-09-03', 'fechamento rodou DEPOIS — incorporou o valor já promovido e comitado');
    assert.equal((await eventosMateriais(pool, base.containerId)).length, 0, 'nunca bloqueado — nenhum FATO_MATERIAL_POS_FINAL');
  } finally { await pool.end(); }
});

test('D15-A v1.1 #1: finalizarProcesso pausado IMEDIATAMENTE ANTES do commit retém o lock consultivo — observação concorrente só decide DEPOIS que o processo já é FINAL (bloqueia, nunca promove)', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'RACE2B000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    const containers = new ContainerRepository(pool);
    const portao = criarPortao();

    const pFinal = svc.finalizarProcesso({
      processoId: base.processoId, membershipId: gestorId, config: cfg,
      _testeAguardarAntesDoCommit: portao.hook,
    });
    // FINAL já escrito nesta transação (ainda não visível a outras); lock consultivo retido.
    await portao.aguardarPausado;

    const pObs = containers.applyObservation({
      containerId: base.containerId, organizationId: base.orgId, campo: 'dischargeDate',
      valor: '2026-09-03', fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z'),
    });

    portao.liberar();
    const [outFinal, outObs] = await Promise.all([pFinal, pObs]);

    assert.deepEqual(outFinal, { ok: true });
    assert.equal(outObs.outcome, 'bloqueada_final', 'a observação só conseguiu o lock consultivo DEPOIS do FINAL já comitado');
    assert.equal(outObs.exigeReabertura, true);
    const depois = await container(pool, base.containerId);
    assert.equal(depois.discharge_date, '2026-09-01', 'projeção FINAL nunca mutada');
    const ev = await eventosMateriais(pool, base.containerId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.campo, 'dischargeDate');
    assert.equal(ev[0].payload.valorNovo, '2026-09-03');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #3 — falha injetada DEPOIS da observação bruta, ANTES da decisão: desfaz
 * TUDO (nenhuma observação/evento/projeção parcial). Também prova que o lock
 * consultivo é liberado no ROLLBACK (a operação de verdade funciona depois).
 * ================================================================== */

test('D15-A v1.1 #3: falha injetada depois da observação bruta (contêiner) desfaz TUDO — nenhuma observação/evento/projeção parcial', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'ROLOBS000001');
    const containers = new ContainerRepository(pool);
    const antesContagem = await contagemObservacoes(pool, cen.containerId, 'dischargeDate');
    const antes = await container(pool, cen.containerId);

    await assert.rejects(
      () => containers.applyObservation({
        containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
        valor: '2026-09-07', fonte: 'master_bl', observadoEm: new Date('2026-09-21T00:00:00Z'),
        _testeFalhaAposObservacao: () => { throw new Error('falha injetada D15-A v1.1 #3'); },
      }),
      /falha injetada D15-A v1\.1 #3/,
    );

    assert.equal(await contagemObservacoes(pool, cen.containerId, 'dischargeDate'), antesContagem, 'nenhuma observação parcial sobrevive — rollback total');
    assert.equal((await eventosMateriais(pool, cen.containerId)).length, 0, 'nenhum evento parcial');
    const depois = await container(pool, cen.containerId);
    assert.equal(depois.discharge_date, antes.discharge_date, 'projeção intocada — rollback total');

    // A operação de verdade continua funcionando depois — o lock consultivo foi liberado no ROLLBACK.
    const out = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
      valor: '2026-09-07', fonte: 'master_bl', observadoEm: new Date('2026-09-21T00:00:00Z'),
    });
    assert.equal(out.outcome, 'bloqueada_final');
  } finally { await pool.end(); }
});

test('D15-A v1.1 #3: falha injetada depois da observação bruta (Master Free Time, serviço central próprio) também desfaz TUDO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'ROLMFT000001');
    const antesContagem = await contagemObservacoes(pool, cen.containerId, 'masterFreeTimeDays');
    const antes = await container(pool, cen.containerId);

    await assert.rejects(
      () => promoverMasterFreeTime(pool, {
        organizationId: cen.orgId, containerId: cen.containerId, valor: 30, fonte: 'master_bl',
        observadoEm: new Date('2026-09-22T00:00:00Z'), autor: 'teste:D15A-v1.1',
        _testeFalhaAposObservacao: () => { throw new Error('falha injetada D15-A v1.1 #3b'); },
      }),
      /falha injetada D15-A v1\.1 #3b/,
    );

    assert.equal(await contagemObservacoes(pool, cen.containerId, 'masterFreeTimeDays'), antesContagem, 'nenhuma observação parcial sobrevive — rollback total');
    assert.equal((await eventosMateriais(pool, cen.containerId)).length, 0);
    const depois = await container(pool, cen.containerId);
    assert.equal(depois.master_free_time_days, antes.master_free_time_days);

    const out = await promoverMasterFreeTime(pool, {
      organizationId: cen.orgId, containerId: cen.containerId, valor: 30, fonte: 'master_bl',
      observadoEm: new Date('2026-09-22T00:00:00Z'), autor: 'teste:D15A-v1.1',
    });
    assert.equal(out.outcome, 'bloqueada_final');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #2 — deadlock-freedom entre operações de TIPOS diferentes (achado #2):
 * validarMinuta × finalizarProcesso; autorizarReabertura × solicitarReabertura.
 * `lock_timeout` curto (item #6): uma regressão de ordem de lock falha rápido
 * com erro claro em vez de travar a suíte.
 * ================================================================== */

test('D15-A v1.1 #2: validarMinuta concorrente com finalizarProcesso no MESMO processo nunca deadlock — estado final satisfaz os gates normais', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPoolComLockTimeout(5000);
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'DLOCKV000001');
    const svc = new ClosingService(pool);
    const gestorId = await novoGestor(pool, base.orgId);
    // Minuta SEM divergência (mesma data do tracking) — resultado de negócio
    // idêntico nas duas ordens possíveis; só o CAMINHO interno (OPEN × FINAL
    // dentro de validarMinuta) muda conforme quem vence a corrida pelo lock.
    const m = await svc.registrarMinuta({ containerId: base.containerId, numeroInformado: base.numero, dataInformada: '2026-09-10' });

    const [rv, rf] = await Promise.all([
      svc.validarMinuta({ minutaId: m.id, membershipId: gestorId, config: cfg }),
      svc.finalizarProcesso({ processoId: base.processoId, membershipId: gestorId, config: cfg }),
    ]);

    assert.ok((rv as any).ok, `validarMinuta deveria suceder em qualquer ordem — nunca deadlock (${JSON.stringify(rv)})`);
    assert.equal((rv as any).resultado, 'validada');
    assert.deepEqual(rf, { ok: true }, `finalizarProcesso deveria suceder em qualquer ordem — nunca deadlock (${JSON.stringify(rf)})`);

    const proc = (await pool.query(`SELECT apuracao_status FROM processos WHERE id=$1`, [base.processoId])).rows[0];
    assert.equal(proc.apuracao_status, 'FINAL', 'gate normal satisfeito — processo fechou');
    const minuta = (await pool.query(`SELECT estado_minuta FROM minutas WHERE id=$1`, [m.id])).rows[0];
    assert.equal(minuta.estado_minuta, 'VALIDADA', 'gate normal satisfeito — minuta validada');
  } finally { await pool.end(); }
});

test('D15-A v1.1 #2: autorizarReabertura concorrente com uma NOVA solicitarReabertura no mesmo processo nunca deadlock — exatamente UMA transição de estado válida', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPoolComLockTimeout(5000);
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'DLOCKR000001');
    const sol = await cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: cen.gestorId, justificativa: 'corrigir' });
    assert.ok(sol.ok);

    const [rAut, rSol2] = await Promise.all([
      cen.svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: cen.gestorId, config: cfg }),
      cen.svc.solicitarReabertura({ processoId: cen.processoId, membershipId: cen.gestorId, justificativa: 'segunda tentativa concorrente' }),
    ]);

    assert.deepEqual(rAut, { ok: true }, `autorizarReabertura deveria suceder — nunca deadlock (${JSON.stringify(rAut)})`);
    assert.equal((rSol2 as any).ok, false, 'a segunda solicitação concorrente nunca cria uma reabertura adicional');
    assert.ok(
      ['reabertura_ja_aberta', 'processo_nao_final'].includes((rSol2 as any).motivo),
      `motivo inesperado para a segunda solicitação concorrente: ${JSON.stringify(rSol2)}`,
    );

    const { rows: total } = await pool.query(`SELECT count(*)::int AS n FROM reaberturas WHERE processo_id=$1`, [cen.processoId]);
    assert.equal(total[0].n, 1, 'nenhuma segunda reabertura foi criada pela solicitação concorrente — exatamente UMA linha no total');
    const estado = (await pool.query(`SELECT estado FROM reaberturas WHERE id=$1`, [(sol as any).reaberturaId])).rows[0];
    assert.equal(estado.estado, 'RECALCULADA', 'exatamente UMA transição de estado válida — a mesma reabertura avançou até o fim');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #4 — contrato canônico: outcome='bloqueada_final' + exigeReabertura=true
 * nos cinco escritores; promovida/prioridade-menor devolvem exigeReabertura=false.
 * ================================================================== */

test('D15-A v1.1 #4: contrato canônico — todo campo bloqueado por FINAL devolve outcome=\'bloqueada_final\' e exigeReabertura=true, nos cinco escritores', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'CONTRACT001');
    const containers = new ContainerRepository(pool);
    const tipo40hc = (await pool.query(`SELECT id FROM container_types WHERE codigo = '40HC'`)).rows[0].id;

    const outDischarge = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
      valor: '2026-09-08', fonte: 'master_bl', observadoEm: new Date('2026-09-23T00:00:00Z'),
    });
    const outTipo = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'containerType',
      valor: tipo40hc, fonte: 'master_bl', observadoEm: new Date('2026-09-23T00:00:01Z'),
    });
    const outTracking = await containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'trackingReturnDate',
      valor: '2026-09-17', fonte: 'tracking_service', observadoEm: new Date('2026-09-23T00:00:02Z'),
    });
    const outHouse = await tentarHouseFreeTime(pool, { organizationId: cen.orgId, containerId: cen.containerId, valor: 28, fonte: 'house_document', observadoEm: new Date('2026-09-23T00:00:03Z') });
    const outMaster = await promoverMasterFreeTime(pool, {
      organizationId: cen.orgId, containerId: cen.containerId, valor: 28, fonte: 'master_bl',
      observadoEm: new Date('2026-09-23T00:00:04Z'), autor: 'teste:D15A-v1.1',
    });

    for (const [nome, out] of [
      ['dischargeDate', outDischarge], ['containerType', outTipo], ['trackingReturnDate', outTracking],
      ['houseFreeTimeDays', outHouse], ['masterFreeTimeDays', outMaster],
    ] as const) {
      assert.equal(out.outcome, 'bloqueada_final', `${nome}: outcome`);
      assert.equal(out.exigeReabertura, true, `${nome}: exigeReabertura`);
    }
    assert.equal(outMaster.bloqueadoPorFinal, true, 'alias deprecated ainda espelha exigeReabertura');
  } finally { await pool.end(); }
});

test('D15-A v1.1 #4: observação promovida e observação de prioridade menor devolvem exigeReabertura=false (processo OPEN)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const base = await seedZero(pool, 'CONTROPEN01');
    const containers = new ContainerRepository(pool);

    const outPromovida = await containers.applyObservation({
      containerId: base.containerId, organizationId: base.orgId, campo: 'dischargeDate',
      valor: '2026-09-02', fonte: 'master_bl', observadoEm: new Date('2026-09-05T00:00:00Z'),
    });
    assert.equal(outPromovida.outcome, 'promovida');
    assert.equal(outPromovida.exigeReabertura, false);

    const outBaixaPrioridade = await containers.applyObservation({
      containerId: base.containerId, organizationId: base.orgId, campo: 'dischargeDate',
      valor: '2026-09-09', fonte: 'email_heuristic', observadoEm: new Date('2026-09-06T00:00:00Z'),
    });
    assert.equal(outBaixaPrioridade.outcome, 'registrada_sem_promover');
    assert.equal(outBaixaPrioridade.exigeReabertura, false);
    const depois = await container(pool, base.containerId);
    assert.equal(depois.discharge_date, '2026-09-02', 'prioridade menor nunca promove');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #5 — duas tentativas IDÊNTICAS concorrentes, ambas bloqueadas por FINAL,
 * nunca duplicam o evento auditável. Prova (sem migration nova) que a
 * serialização pelo lock consultivo + o dedupe por conteúdo já existente em
 * `registrarFatoMaterialPosFinal` bastam.
 * ================================================================== */

test('D15-A v1.1 #5: duas observações IDÊNTICAS concorrentes, ambas bloqueadas por FINAL, nunca duplicam o evento auditável — sem migration nova', { skip: !url, timeout: 15000 }, async () => {
  const pool = testPool();
  try {
    await setupBanco(pool);
    const cen = await cenarioFinal(pool, 'DEDUPE000001');
    const containers = new ContainerRepository(pool);

    const chamada = () => containers.applyObservation({
      containerId: cen.containerId, organizationId: cen.orgId, campo: 'dischargeDate',
      valor: '2026-09-11', fonte: 'master_bl', observadoEm: new Date('2026-09-25T00:00:00Z'),
    });
    const [r1, r2] = await Promise.all([chamada(), chamada()]);

    assert.equal(r1.outcome, 'bloqueada_final');
    assert.equal(r2.outcome, 'bloqueada_final');
    assert.equal(r1.exigeReabertura, true);
    assert.equal(r2.exigeReabertura, true);

    assert.equal(
      await contagemObservacoes(pool, cen.containerId, 'dischargeDate'), 2,
      'ledger: a observação original (seed) + exatamente UMA nova — a segunda tentativa idêntica (mesmo campo/fonte/observado_em) caiu no ON CONFLICT DO NOTHING',
    );
    const ev = await eventosMateriais(pool, cen.containerId);
    assert.equal(
      ev.length, 1,
      'exatamente UM evento FATO_MATERIAL_POS_FINAL — as duas chamadas disputam a MESMA trava consultiva (serialização total) e o dedupe por conteúdo em registrarFatoMaterialPosFinal cobre a segunda',
    );
    assert.equal(ev[0].payload.valorNovo, '2026-09-11');
  } finally { await pool.end(); }
});
