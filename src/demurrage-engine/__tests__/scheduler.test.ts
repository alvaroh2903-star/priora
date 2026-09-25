import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { TrackingIncidentRepository } from '../persistence/trackingIncidentRepository';
import { avaliarCadencia, proximaConsulta, deveConsultarAgora, diasEmDemurrage, LIMITE_DIAS_DEMURRAGE } from '../scheduler/cadencePolicy';
import { falhasConsecutivas, deveAbrirIncidente, podeAtualizarManual } from '../scheduler/failurePolicy';
import { sincronizarContainer, sincronizarCiclo, solicitarAtualizacaoManual } from '../scheduler/trackingScheduler';
import { runSchedulerOnce } from '../scheduler/schedulerWorker';
import { AlertOutboxRepository, processarEntregasPendentes, AlertTransport, EntregaPendente } from '../scheduler/alertOutbox';
import { criarGraphAlertTransport, montarEmailPadrao, resolverDestinatariosPorEnv } from '../../demurrage/alertTransportGraph';
import { ArmadorTrackingPort, TrackingEnrichResult } from '../sources/armadorTrackingSource';

const url = testDatabaseUrl();

/* ================================================================== *
 * PARTE A — políticas puras
 * ================================================================== */

test('cadência: exemplo obrigatório — menor vencimento 20/09 → início diário 16/09', () => {
  const base = { dischargeDate: '2026-09-01', houseLastFreeDay: '2026-09-20', masterLastFreeDay: '2026-09-25', emptyReturn: null, algumEmDemurrage: false };
  assert.equal(avaliarCadencia({ ...base, hoje: '2026-09-16' }).inicioDiario, '2026-09-16');
  assert.equal(avaliarCadencia({ ...base, hoje: '2026-09-15' }).fase, 'a_cada_4_dias');
  assert.equal(avaliarCadencia({ ...base, hoje: '2026-09-16' }).fase, 'diario');
  assert.equal(avaliarCadencia({ ...base, hoje: '2026-09-16', algumEmDemurrage: true }).fase, 'a_cada_2_dias');
});

test('cadência: D0 → D+5 → a cada 4 dias; empty return encerra', () => {
  const base = { dischargeDate: '2026-09-01', houseLastFreeDay: '2026-09-20', masterLastFreeDay: '2026-09-25', emptyReturn: null, algumEmDemurrage: false };
  assert.equal(proximaConsulta({ ...base, hoje: '2026-09-03' }, null), '2026-09-06'); // D+5
  assert.equal(proximaConsulta({ ...base, hoje: '2026-09-07' }, '2026-09-06'), '2026-09-10'); // D+9
  assert.equal(proximaConsulta({ ...base, hoje: '2026-09-11' }, '2026-09-10'), '2026-09-14'); // D+13
  assert.equal(deveConsultarAgora({ ...base, hoje: '2026-09-04' }, null), false); // antes de D+5
  // Empty Return → para o tracking automático.
  assert.equal(avaliarCadencia({ ...base, hoje: '2026-09-30', emptyReturn: '2026-09-28' }).fase, 'encerrado');
  assert.equal(proximaConsulta({ ...base, hoje: '2026-09-30', emptyReturn: '2026-09-28' }, '2026-09-25'), null);
});

test('falha: 3ª consecutiva abre incidente; sucesso reseta; manual só MANAGER/ADMIN + cooldown', () => {
  assert.equal(falhasConsecutivas(['falha', 'falha', 'ok', 'falha']), 2);
  assert.equal(falhasConsecutivas(['falha', 'falha', 'falha']), 3);
  assert.equal(deveAbrirIncidente(3, false), true);
  assert.equal(deveAbrirIncidente(3, true), false); // já aberto → não reabre
  assert.equal(deveAbrirIncidente(2, false), false);
  const agora = new Date('2026-09-24T12:00:00Z');
  assert.equal(podeAtualizarManual('ANALYST', null, agora).permitido, false);
  assert.equal(podeAtualizarManual('CLIENT', null, agora).permitido, false);
  assert.equal(podeAtualizarManual('MANAGER', null, agora).permitido, true);
  assert.equal(podeAtualizarManual('MANAGER', new Date('2026-09-24T11:00:00Z'), agora).permitido, false); // 1h < 2h
  assert.equal(podeAtualizarManual('ADMIN', new Date('2026-09-24T09:30:00Z'), agora).permitido, true); // 2h30 > 2h
});

test('suspensão automática aos 30 dias sem Empty Return: dia 29 consulta; dia 30 suspende (relógios seguem)', () => {
  // menor vencimento = 2026-08-01 (House). dias em demurrage = hoje − 2026-08-01.
  const base = { dischargeDate: '2026-07-01', houseLastFreeDay: '2026-08-01', masterLastFreeDay: '2026-08-10', emptyReturn: null, algumEmDemurrage: true };
  assert.equal(LIMITE_DIAS_DEMURRAGE, 30);

  // Dia 29 (2026-08-30): ainda dentro da janela automática.
  const dia29 = { ...base, hoje: '2026-08-30' };
  assert.equal(diasEmDemurrage(dia29), 29);
  assert.equal(avaliarCadencia(dia29).automaticTracking, 'ATIVO');
  assert.notEqual(avaliarCadencia(dia29).fase, 'suspenso_30_dias');
  assert.equal(deveConsultarAgora(dia29, '2026-08-28'), true); // a_cada_2_dias venceu

  // Dia 30 (2026-08-31): suspende o tracking AUTOMÁTICO.
  const dia30 = { ...base, hoje: '2026-08-31' };
  assert.equal(diasEmDemurrage(dia30), 30);
  const r30 = avaliarCadencia(dia30);
  assert.equal(r30.fase, 'suspenso_30_dias');
  assert.equal(r30.automaticTracking, 'SUSPENDED');
  assert.equal(r30.motivoSuspensao, 'MAX_AUTOMATIC_TRACKING_WINDOW_REACHED');
  assert.equal(r30.intervaloDias, null);
  // NÃO consulta mais automaticamente...
  assert.equal(proximaConsulta(dia30, '2026-08-29'), null);
  assert.equal(deveConsultarAgora(dia30, '2026-08-29'), false);

  // ...mas os relógios SEGUEM avançando (nada é zerado, nada é presumido).
  const dia45 = { ...base, hoje: '2026-09-15' };
  assert.ok(diasEmDemurrage(dia45) > 30, 'os dias de demurrage continuam a crescer após a suspensão');
  assert.equal(avaliarCadencia(dia45).fase, 'suspenso_30_dias');
  assert.notEqual(avaliarCadencia(dia45).inicioDiario, null, 'os relógios continuam definidos (processo aberto)');

  // Atualização MANUAL continua possível (independe da cadência automática).
  assert.equal(podeAtualizarManual('MANAGER', null, new Date('2026-08-31T12:00:00Z')).permitido, true);

  // Empty Return posterior encerra normalmente, mesmo depois dos 30 dias.
  assert.equal(avaliarCadencia({ ...dia45, emptyReturn: '2026-09-10' }).fase, 'encerrado');
});

/* ================================================================== *
 * PARTE B — orquestrador (banco + porta fake)
 * ================================================================== */

function resultado(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'hmm', name: 'HMM' }, reference: '', referenceType: 'bl', ok: true,
    needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
    cached: false, resolved: false, at: '2026-09-24T00:00:00Z', ...over,
  };
}
function conteiner(numero: string, dischargeDate: string | null): any {
  return { numero, tipo: null, dischargeDate, availableDate: null, gateOut: null, emptyReturn: null };
}
function fakePort(byRef: Record<string, () => TrackingEnrichResult>) {
  const calls: Record<string, number> = {};
  const port: ArmadorTrackingPort = {
    async enrich(ref) {
      calls[ref] = (calls[ref] || 0) + 1;
      const f = byRef[ref];
      if (!f) throw new Error(`fake sem fixture para ${ref}`);
      return f();
    },
  };
  return { port, calls };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM13', clienteId: null });
  return { orgId: org.id, processoId: processo.id };
}

/** Semeia os fatos de cadência de um contêiner (descarga + free times House/Master). */
async function seedCadencia(
  pool: Pool,
  containerId: string,
  orgId: string,
  f: { discharge: string; houseFT: number; masterFT: number },
) {
  const containers = new ContainerRepository(pool);
  const obsEm = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId, organizationId: orgId, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: obsEm });
  await containers.applyObservation({ containerId, organizationId: orgId, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: obsEm });
  await containers.applyObservation({ containerId, organizationId: orgId, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: obsEm });
}

async function contarFetches(pool: Pool, targetId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int n FROM tracking_fetches WHERE tracking_target_id=$1`, [targetId]);
  return rows[0].n;
}

test('HBL nunca é target executável: reference_type "hbl" é rejeitado pelo banco', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const container = await new ContainerRepository(pool).create(orgId, processoId, 'HDMU0000001');
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'hmm', reference: 'SZPM51914400' });
    await assert.rejects(
      () => pool.query(`INSERT INTO container_tracking_targets (container_id, tracking_target_id, reference_type) VALUES ($1,$2,'hbl')`, [container.id, target.id]),
      /reference_type_check/,
    );
  } finally { await pool.end(); }
});

test('MBL disponível → NÃO consulta o container separadamente; HBL não origina consulta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c = await containers.create(orgId, processoId, 'HDMU0000001');
    const { target: mbl } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM51914400' });
    await targets.linkContainer(c.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'SZPM51914400' });
    // também há um target do próprio contêiner (fallback), que NÃO deve ser consultado.
    const { target: cont } = await targets.upsert({ carrier: 'hmm', reference: 'HDMU0000001' });
    await targets.linkContainer(c.id, cont.id, { referenceType: 'container', referenceRaw: 'HDMU0000001' });

    const { port, calls } = fakePort({
      SZPM51914400: () => resultado({ containers: [conteiner('HDMU0000001', '2026-09-01')], events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'HDMU0000001' }] }),
      HDMU0000001: () => resultado({ containers: [conteiner('HDMU0000001', '2026-09-02')] }),
    });
    const r = await sincronizarContainer({ pool, port, containerId: c.id });
    assert.equal(r.usouMbl, true);
    assert.equal(r.consultouContainer, false);
    assert.equal(calls.SZPM51914400, 1);
    assert.equal(calls.HDMU0000001, undefined, 'o número do contêiner não foi consultado');
    // Descarga do MBL foi promovida (2026-09-01, não a do container 2026-09-02).
    assert.equal((await containers.findById(c.id))?.dischargeDate, '2026-09-01');
  } finally { await pool.end(); }
});

test('MBL indisponível (bloqueado) → o número do contêiner funciona como fallback', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c = await containers.create(orgId, processoId, 'BMOU0000001');
    const { target: mbl } = await targets.upsert({ carrier: 'cmacgm', reference: 'CMAU1' });
    await targets.linkContainer(c.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'CMAU1' });
    const { target: cont } = await targets.upsert({ carrier: 'cmacgm', reference: 'BMOU0000001' });
    await targets.linkContainer(c.id, cont.id, { referenceType: 'container', referenceRaw: 'BMOU0000001' });

    const { port, calls } = fakePort({
      CMAU1: () => resultado({ carrier: { id: 'cmacgm', name: 'CMA CGM' }, ok: false, needsCaptcha: true, message: 'Scraping bloqueado', containers: [], events: [] }),
      BMOU0000001: () => resultado({ carrier: { id: 'cmacgm', name: 'CMA CGM' }, containers: [conteiner('BMOU0000001', '2026-09-03')], events: [{ date: '2026-09-03', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'BMOU0000001' }] }),
    });
    const r = await sincronizarContainer({ pool, port, containerId: c.id });
    assert.equal(r.usouMbl, false);
    assert.equal(r.consultouContainer, true);
    assert.equal(calls.CMAU1, 1);
    assert.equal(calls.BMOU0000001, 1);
    assert.equal((await containers.findById(c.id))?.dischargeDate, '2026-09-03');
  } finally { await pool.end(); }
});

test('MBL compartilhado por dois processos → UMA consulta; múltiplos contêineres reaproveitados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId } = await setup(pool);
    const processos = new ProcessoRepository(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const p1 = await processos.create({ organizationId: orgId, numeroProcesso: 'IM2734', clienteId: null });
    const p2 = await processos.create({ organizationId: orgId, numeroProcesso: 'IM3087', clienteId: null });
    const c1 = await containers.create(orgId, p1.id, 'HDMU2734001');
    const c2 = await containers.create(orgId, p2.id, 'HDMU3087001');
    const { target: mbl } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM51914400' });
    await targets.linkContainer(c1.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'SZPM51914400' });
    await targets.linkContainer(c2.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'SZPM51914400' });

    const { port, calls } = fakePort({
      SZPM51914400: () => resultado({ containers: [conteiner('HDMU2734001', '2026-09-01'), conteiner('HDMU3087001', '2026-09-05')],
        events: [
          { date: '2026-09-01', status: 'Discharge', location: 'S', type: 'discharge', container: 'HDMU2734001' },
          { date: '2026-09-05', status: 'Discharge', location: 'S', type: 'discharge', container: 'HDMU3087001' },
        ] }),
    });
    await sincronizarCiclo({ pool, port, containerIds: [c1.id, c2.id] });
    assert.equal(calls.SZPM51914400, 1, 'nunca duas puxadas só porque há dois processos');
    // Um único TrackingFetch para o target compartilhado.
    const { rows } = await pool.query(`SELECT count(*)::int n FROM tracking_fetches WHERE tracking_target_id=$1`, [mbl.id]);
    assert.equal(rows[0].n, 1);
    assert.equal((await containers.findById(c1.id))?.dischargeDate, '2026-09-01');
    assert.equal((await containers.findById(c2.id))?.dischargeDate, '2026-09-05');
  } finally { await pool.end(); }
});

test('duas organizações compartilhando o target → UMA consulta global; entregas de alerta segregadas; sem vazamento A→B', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const orgRepo = new OrganizationRepository(pool);
    const orgA = await orgRepo.create('Org A', 'orga');
    const orgB = await orgRepo.create('Org B', 'orgb');
    const processos = new ProcessoRepository(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const pA = await processos.create({ organizationId: orgA.id, numeroProcesso: 'A-1', clienteId: null });
    const pB = await processos.create({ organizationId: orgB.id, numeroProcesso: 'B-1', clienteId: null });
    const cA = await containers.create(orgA.id, pA.id, 'HDMUA000001');
    const cB = await containers.create(orgB.id, pB.id, 'HDMUB000001');
    const { target } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM99999999' });
    await targets.linkContainer(cA.id, target.id, { referenceType: 'mbl', referenceRaw: 'SZPM99999999' });
    await targets.linkContainer(cB.id, target.id, { referenceType: 'mbl', referenceRaw: 'SZPM99999999' });

    // MBL falha (bloqueado). 3 ciclos → incidente. Cada ciclo = uma consulta global.
    const { port, calls } = fakePort({ SZPM99999999: () => resultado({ ok: false, needsCaptcha: true, message: 'bloqueado', containers: [], events: [] }) });
    for (let i = 0; i < 3; i++) await sincronizarCiclo({ pool, port, containerIds: [cA.id, cB.id] });
    assert.equal(calls.SZPM99999999, 3, 'uma consulta global por ciclo (não por organização/contêiner)');
    const { rows: fetches } = await pool.query(`SELECT count(*)::int n FROM tracking_fetches WHERE tracking_target_id=$1`, [target.id]);
    assert.equal(fetches[0].n, 3);

    const incidentes = new TrackingIncidentRepository(pool);
    const inc = await incidentes.incidenteAberto(target.id);
    assert.ok(inc, 'incidente aberto na 3ª falha');
    const entregas = await incidentes.entregas(inc!.id);
    const tecnicas = entregas.filter((e) => e.escopo === 'tecnico_global');
    const ops = entregas.filter((e) => e.escopo === 'operacional_org');
    assert.equal(tecnicas.length, 1, 'um alerta técnico global');
    assert.deepEqual(ops.map((e) => e.organizationId).sort(), [orgA.id, orgB.id].sort(), 'uma entrega operacional por organização');
    // Segregação: o conteúdo da entrega de cada org só tem os contêineres dela.
    const soA = await targets.containersForTargetAndOrg(target.id, orgA.id);
    const soB = await targets.containersForTargetAndOrg(target.id, orgB.id);
    assert.deepEqual(soA.map((c) => c.numero), ['HDMUA000001']);
    assert.deepEqual(soB.map((c) => c.numero), ['HDMUB000001']);
    assert.ok(!soA.some((c) => c.organizationId === orgB.id), 'nenhum dado da Org B na entrega da Org A');
  } finally { await pool.end(); }
});

test('supressão: 4ª/5ª falha não geram novo alerta; sucesso reseta; nova sequência = novo incidente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c = await containers.create(orgId, processoId, 'HDMU5000001');
    const { target } = await targets.upsert({ carrier: 'hmm', reference: 'SZPM50000000' });
    await targets.linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: 'SZPM50000000' });
    const incidentes = new TrackingIncidentRepository(pool);

    let modo: 'falha' | 'ok' = 'falha';
    const { port } = fakePort({
      SZPM50000000: () => modo === 'falha'
        ? resultado({ ok: false, needsCaptcha: true, message: 'bloqueado', containers: [], events: [] })
        : resultado({ containers: [conteiner('HDMU5000001', '2026-09-01')], events: [{ date: '2026-09-01', status: 'Discharge', location: 'S', type: 'discharge', container: 'HDMU5000001' }] }),
    });
    const sync = () => sincronizarContainer({ pool, port, containerId: c.id });

    await sync(); await sync(); await sync(); // 3 falhas → incidente
    const inc1 = await incidentes.incidenteAberto(target.id);
    assert.ok(inc1);
    const dep3 = await incidentes.entregas(inc1!.id);
    await sync(); await sync(); // 4ª e 5ª → sem novo alerta
    const dep5 = await incidentes.entregas(inc1!.id);
    assert.deepEqual(dep5.map((e) => e.id).sort(), dep3.map((e) => e.id).sort(), '4ª/5ª não criam novas entregas');
    assert.equal(inc1!.seq, 1);

    modo = 'ok'; await sync(); // sucesso reseta e fecha o incidente
    assert.equal(await incidentes.incidenteAberto(target.id), null);
    modo = 'falha'; await sync(); await sync(); await sync(); // nova sequência → novo incidente
    const inc2 = await incidentes.incidenteAberto(target.id);
    assert.ok(inc2);
    assert.equal(inc2!.seq, 2, 'nova sequência de 3 falhas = novo incidente');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * PARTE C — worker real (aceitação: janela → cache miss → fetch → eventos →
 * próxima janela) + concorrência (dois workers = uma execução) + suspensão
 * ================================================================== */

test('aceitação: worker acha a janela → cache miss → Tracking Service → TrackingFetch → eventos → próxima janela', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c = await containers.create(orgId, processoId, 'HDMUW000001');
    // LFD House 2026-09-20, Master 2026-09-25 → início diário 2026-09-16 (exemplo oficial).
    await seedCadencia(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 25 });
    const { target: mbl } = await targets.upsert({ carrier: 'hmm', reference: 'SZPMW0000001' });
    await targets.linkContainer(c.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'SZPMW0000001' });

    const { port, calls } = fakePort({
      SZPMW0000001: () => resultado({
        cached: false, resolved: true, // cache MISS → foi ao serviço central
        containers: [conteiner('HDMUW000001', '2026-09-01')],
        events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: 'HDMUW000001' }],
      }),
    });

    const r1 = await runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'w1' });
    assert.equal(r1.contêineresNaJanela, 1, 'o worker achou a janela (diário) sem ninguém abrir tela');
    assert.equal(r1.sincronizados, 1);
    assert.equal(calls.SZPMW0000001, 1, 'consultou o Tracking Service uma vez');
    assert.equal(await contarFetches(pool, mbl.id), 1, 'registrou um TrackingFetch');
    // O fetch registrou cache MISS e os eventos foram ingeridos + descarga promovida.
    const { rows: fr } = await pool.query(`SELECT cached, events_count FROM tracking_fetches WHERE tracking_target_id=$1`, [mbl.id]);
    assert.equal(fr[0].cached, false);
    assert.equal(fr[0].events_count, 1);
    assert.equal((await containers.findById(c.id))?.dischargeDate, '2026-09-01');

    // Próxima janela: já consultado hoje (diário) → um novo tick no MESMO dia não reconsulta.
    const r2 = await runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'w1' });
    assert.equal(r2.contêineresNaJanela, 0, 'diário já satisfeito hoje → fora da janela');
    assert.equal(calls.SZPMW0000001, 1, 'nenhuma consulta extra no mesmo dia');
    // Amanhã volta à janela (cadência diária).
    const r3 = await runSchedulerOnce({ pool, port, hoje: '2026-09-17', workerId: 'w1' });
    assert.equal(r3.contêineresNaJanela, 1, 'no dia seguinte a janela diária reabre');
    assert.equal(calls.SZPMW0000001, 2);
    assert.equal(await contarFetches(pool, mbl.id), 2);
  } finally { await pool.end(); }
});

test('concorrência: dois workers no mesmo tick → UMA execução real (claim em PostgreSQL)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c = await containers.create(orgId, processoId, 'HDMUC000001');
    await seedCadencia(pool, c.id, orgId, { discharge: '2026-09-01', houseFT: 20, masterFT: 25 });
    const { target: mbl } = await targets.upsert({ carrier: 'hmm', reference: 'SZPMC0000001' });
    await targets.linkContainer(c.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'SZPMC0000001' });

    let chamadas = 0;
    const port: ArmadorTrackingPort = {
      async enrich() {
        chamadas++;
        await new Promise((res) => setTimeout(res, 5)); // janela para interleaving
        return resultado({ cached: false, resolved: true, containers: [conteiner('HDMUC000001', '2026-09-01')], events: [{ date: '2026-09-01', status: 'Discharge', location: 'S', type: 'discharge', container: 'HDMUC000001' }] });
      },
    };

    // Dois workers disparam o MESMO tick simultaneamente.
    const [a, b] = await Promise.all([
      runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'wA' }),
      runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'wB' }),
    ]);
    assert.equal(chamadas, 1, 'apenas um worker consultou o armador (claim venceu para um só)');
    assert.equal(await contarFetches(pool, mbl.id), 1, 'um único TrackingFetch apesar de dois workers');
    assert.equal(a.sincronizados + b.sincronizados, 1, 'só um worker executou de fato o contêiner');

    // Reinício no mesmo dia: o claim 'done' impede reconsulta.
    const r = await runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'wA' });
    assert.equal(chamadas, 1, 'reinício no mesmo dia não duplica a consulta');
    assert.equal(r.contêineresNaJanela, 0);
  } finally { await pool.end(); }
});

test('30 dias sem Empty Return → worker NÃO consulta; processo/relógios seguem; manual ainda funciona e um Empty Return manual encerra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const { orgId, processoId } = await setup(pool);
    const containers = new ContainerRepository(pool);
    const targets = new TrackingTargetRepository(pool);
    const c = await containers.create(orgId, processoId, 'HDMUS000001');
    // Descarga 2026-07-01, free time 5 → LFD 2026-07-05 → em 2026-09-24 são ~81 dias de demurrage (>30).
    await seedCadencia(pool, c.id, orgId, { discharge: '2026-07-01', houseFT: 5, masterFT: 5 });
    const { target: mbl } = await targets.upsert({ carrier: 'hmm', reference: 'SZPMS0000001' });
    await targets.linkContainer(c.id, mbl.id, { referenceType: 'mbl', referenceRaw: 'SZPMS0000001' });

    let chamadas = 0;
    const port: ArmadorTrackingPort = {
      async enrich() {
        chamadas++;
        // Consulta manual: retorna o Empty Return (devolução do vazio).
        return resultado({ containers: [{ numero: 'HDMUS000001', tipo: null, dischargeDate: '2026-07-01', availableDate: null, gateOut: null, emptyReturn: '2026-09-20' }], events: [{ date: '2026-09-20', status: 'Empty Return', location: 'S', type: 'empty_return', container: 'HDMUS000001' }] });
      },
    };

    // Worker automático: suspenso → NÃO consulta.
    const r = await runSchedulerOnce({ pool, port, hoje: '2026-09-24', workerId: 'w1' });
    assert.equal(r.suspensos, 1, 'contêiner suspenso (>30 dias sem Empty Return)');
    assert.equal(r.contêineresNaJanela, 0, 'nenhuma janela automática');
    assert.equal(chamadas, 0, 'nenhuma consulta automática ao armador');
    assert.equal(await contarFetches(pool, mbl.id), 0);
    // Processo/relógios seguem: o contêiner continua aberto, descarga preservada, sem devolução presumida.
    const antes = await containers.findById(c.id);
    assert.equal(antes?.dischargeDate, '2026-07-01');
    assert.equal(antes?.trackingReturnDate, null, 'nada foi presumido: sem devolução');

    // Atualização MANUAL (MANAGER) continua possível mesmo suspenso — e um Empty Return encerra normalmente.
    const manual = await solicitarAtualizacaoManual({ pool, port, trackingTargetId: mbl.id, papel: 'MANAGER', agora: new Date('2026-09-24T12:00:00Z') });
    assert.equal(manual.executada, true, 'manual funciona apesar da suspensão automática');
    assert.equal(chamadas, 1, 'a consulta manual foi ao armador');
    assert.equal(await contarFetches(pool, mbl.id), 1);
    assert.equal((await containers.findById(c.id))?.trackingReturnDate, '2026-09-20', 'Empty Return manual processado normalmente');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * PARTE D — outbox de alerta: PENDING até um transporte REAL confirmar
 * ================================================================== */

async function abrirIncidenteComEntregas(pool: Pool) {
  const orgRepo = new OrganizationRepository(pool);
  const orgA = await orgRepo.create('Org A', 'orga');
  const orgB = await orgRepo.create('Org B', 'orgb');
  const processos = new ProcessoRepository(pool);
  const containers = new ContainerRepository(pool);
  const targets = new TrackingTargetRepository(pool);
  const incidentes = new TrackingIncidentRepository(pool);
  const pA = await processos.create({ organizationId: orgA.id, numeroProcesso: 'A-1', clienteId: null });
  const pB = await processos.create({ organizationId: orgB.id, numeroProcesso: 'B-1', clienteId: null });
  const cA = await containers.create(orgA.id, pA.id, 'HDMUOA00001');
  const cB = await containers.create(orgB.id, pB.id, 'HDMUOB00001');
  const { target } = await targets.upsert({ carrier: 'hmm', reference: 'SZPMO0000001' });
  await targets.linkContainer(cA.id, target.id, { referenceType: 'mbl', referenceRaw: 'SZPMO0000001' });
  await targets.linkContainer(cB.id, target.id, { referenceType: 'mbl', referenceRaw: 'SZPMO0000001' });
  const inc = await incidentes.abrir(target.id, '3 falhas');
  await incidentes.registrarEntregaTecnica(inc.id);
  await incidentes.registrarEntregaOrg(inc.id, orgA.id);
  await incidentes.registrarEntregaOrg(inc.id, orgB.id);
  return { inc, orgA, orgB, target };
}

test('outbox: entregas nascem PENDING; sem transporte real permanecem PENDING (linha criada ≠ enviada)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const { inc } = await abrirIncidenteComEntregas(pool);
    const { rows } = await pool.query(`SELECT status, enviado_em FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.equal(rows.length, 3, 'uma técnica global + duas operacionais');
    assert.ok(rows.every((r) => r.status === 'PENDING' && r.enviado_em === null), 'toda entrega nasce PENDING, nenhuma enviada');
    const pend = await new AlertOutboxRepository(pool).carregarPendentes();
    assert.equal(pend.length, 3);
  } finally { await pool.end(); }
});

test('outbox: transporte real bem-sucedido → SENT; segregação por organização preservada no conteúdo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const { inc, orgA, orgB } = await abrirIncidenteComEntregas(pool);

    const vistos: EntregaPendente[] = [];
    const transport: AlertTransport = { async enviar(e) { vistos.push(e); return { ok: true }; } };
    const res = await processarEntregasPendentes({ pool, transport });
    assert.equal(res.enviadas, 3);
    assert.equal(res.falhadas, 0);

    // Segregação: a entrega da Org A só carrega contêiner da Org A; a técnica carrega ambos.
    const eA = vistos.find((e) => e.organizationId === orgA.id)!;
    const eB = vistos.find((e) => e.organizationId === orgB.id)!;
    const tec = vistos.find((e) => e.escopo === 'tecnico_global')!;
    assert.deepEqual(eA.containers.map((c) => c.numero), ['HDMUOA00001']);
    assert.deepEqual(eB.containers.map((c) => c.numero), ['HDMUOB00001']);
    assert.deepEqual(tec.containers.map((c) => c.numero).sort(), ['HDMUOA00001', 'HDMUOB00001']);
    assert.ok(!eA.containers.some((c) => c.organizationId === orgB.id), 'sem vazamento B→A');

    const { rows } = await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(rows.every((r) => r.status === 'SENT'), 'todas marcadas SENT após transporte confirmar');
  } finally { await pool.end(); }
});

test('outbox: transporte que falha → FAILED com erro (reprocessável), nunca SENT silencioso', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const { inc } = await abrirIncidenteComEntregas(pool);
    const transport: AlertTransport = { async enviar() { return { ok: false, erro: 'canal indisponível' }; } };
    const res = await processarEntregasPendentes({ pool, transport });
    assert.equal(res.falhadas, 3);
    const { rows } = await pool.query(`SELECT status, erro, tentativas FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(rows.every((r) => r.status === 'FAILED' && r.erro === 'canal indisponível' && r.tentativas === 1));
    // Reprocessável: um transporte bom depois marca SENT.
    const bom: AlertTransport = { async enviar() { return { ok: true }; } };
    await processarEntregasPendentes({ pool, transport: bom });
    const { rows: rows2 } = await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(rows2.every((r) => r.status === 'SENT'), 'FAILED reprocessado vira SENT');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * PARTE E — transporte Graph (e-mail) desacoplado do tracking
 * ================================================================== */

test('Graph: envio bem-sucedido → SENT; usa token + destinatários resolvidos; segregação por org no conteúdo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const { inc, orgA, orgB } = await abrirIncidenteComEntregas(pool);

    const enviados: Array<{ token: string; to: string[]; subject: string; body: string }> = [];
    const transport = criarGraphAlertTransport({
      getToken: async () => 'tok-graph',
      send: async (token, input) => { enviados.push({ token, to: input.to, subject: input.subject, body: input.body }); },
      resolverDestinatarios: (e) =>
        e.escopo === 'tecnico_global' ? { to: ['tech@priora.com'] }
        : e.organizationId === orgA.id ? { to: ['ops-a@empresaA.com'] }
        : { to: ['ops-b@empresaB.com'] },
    });

    const res = await processarEntregasPendentes({ pool, transport });
    assert.equal(res.enviadas, 3);
    assert.ok(enviados.every((e) => e.token === 'tok-graph'), 'usou o token do Graph');
    const { rows } = await pool.query(`SELECT status, enviado_em FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(rows.every((r) => r.status === 'SENT' && r.enviado_em !== null));

    // Segregação: o e-mail da Org A cita só o contêiner da Org A; o técnico cita ambos.
    const emailA = enviados.find((e) => e.to[0] === 'ops-a@empresaA.com')!;
    const emailTec = enviados.find((e) => e.to[0] === 'tech@priora.com')!;
    assert.match(emailA.body, /HDMUOA00001/);
    assert.doesNotMatch(emailA.body, /HDMUOB00001/, 'sem vazamento B→A no corpo do e-mail');
    assert.match(emailTec.body, /HDMUOA00001/);
    assert.match(emailTec.body, /HDMUOB00001/);
  } finally { await pool.end(); }
});

test('Graph: falha de e-mail → FAILED reprocessável e NÃO afeta o tracking (FalhaTracking intacta, sem nova consulta)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const { inc, target } = await abrirIncidenteComEntregas(pool);

    const antesFetches = await contarFetches(pool, target.id);
    const antesInc = await new TrackingIncidentRepository(pool).incidenteAberto(target.id);

    // Graph lança (indisponível) → o adaptador devolve ok:false → entrega FAILED.
    const transport = criarGraphAlertTransport({
      getToken: async () => 'tok',
      send: async () => { throw new Error('Graph 503'); },
      resolverDestinatarios: () => ({ to: ['x@y.com'] }),
    });
    const res = await processarEntregasPendentes({ pool, transport });
    assert.equal(res.falhadas, 3);
    const { rows } = await pool.query(`SELECT status, erro FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(rows.every((r) => r.status === 'FAILED' && /Graph 503/.test(r.erro)));

    // DESACOPLAMENTO: nada no tracking mudou — nenhum fetch novo, incidente igual.
    assert.equal(await contarFetches(pool, target.id), antesFetches, 'falha de e-mail não gera consulta ao armador');
    const depoisInc = await new TrackingIncidentRepository(pool).incidenteAberto(target.id);
    assert.equal(depoisInc!.id, antesInc!.id, 'o incidente/FalhaTracking permanece o mesmo (não incrementa)');

    // Retry após o Graph voltar → SENT.
    const bom = criarGraphAlertTransport({ getToken: async () => 'tok', send: async () => {}, resolverDestinatarios: () => ({ to: ['x@y.com'] }) });
    await processarEntregasPendentes({ pool, transport: bom });
    const { rows: r2 } = await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(r2.every((r) => r.status === 'SENT'), 'FAILED de e-mail é reprocessável até enviar');
  } finally { await pool.end(); }
});

test('Graph: sem destinatário/sem token → FAILED (nunca SENT antes da confirmação do Graph)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await runMigrations(pool); await truncateAll(pool);
    const { inc } = await abrirIncidenteComEntregas(pool);

    // Sem destinatário resolvido → nem tenta o Graph → FAILED.
    let tentouEnviar = 0;
    const semDest = criarGraphAlertTransport({ getToken: async () => 'tok', send: async () => { tentouEnviar++; }, resolverDestinatarios: () => ({ to: [] }) });
    await processarEntregasPendentes({ pool, transport: semDest });
    let { rows } = await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]);
    assert.ok(rows.every((r) => r.status === 'FAILED'));
    assert.equal(tentouEnviar, 0, 'sem destinatário nem chega a chamar o Graph');

    // Com destinatário mas sem token (conta Microsoft não conectada) → FAILED, sem enviar.
    const semToken = criarGraphAlertTransport({ getToken: async () => null, send: async () => { tentouEnviar++; }, resolverDestinatarios: () => ({ to: ['x@y.com'] }) });
    await processarEntregasPendentes({ pool, transport: semToken });
    ({ rows } = await pool.query(`SELECT status FROM tracking_alert_deliveries WHERE incident_id=$1`, [inc.id]));
    assert.ok(rows.every((r) => r.status === 'FAILED'));
    assert.equal(tentouEnviar, 0, 'sem token não envia nada (nunca SENT sem confirmação)');
  } finally { await pool.end(); }
});

test('Graph: resolver por env (técnico global × por organização) e conteúdo padrão', () => {
  const resolver = resolverDestinatariosPorEnv({
    DEMURRAGE_ALERT_TECH_EMAILS: 'tech1@p.com, tech2@p.com',
    DEMURRAGE_ALERT_ORG_EMAILS: JSON.stringify({ 'org-123': ['ops@empresa.com'] }),
  } as any);
  const tec = resolver({ escopo: 'tecnico_global', organizationId: null } as EntregaPendente);
  assert.deepEqual((tec as any).to, ['tech1@p.com', 'tech2@p.com']);
  const op = resolver({ escopo: 'operacional_org', organizationId: 'org-123' } as EntregaPendente);
  assert.deepEqual((op as any).to, ['ops@empresa.com']);
  const semMap = resolver({ escopo: 'operacional_org', organizationId: 'org-sem-map' } as EntregaPendente);
  assert.deepEqual((semMap as any).to, [], 'org sem mapeamento → sem destinatário (entrega fica reprocessável)');

  const email = montarEmailPadrao({ escopo: 'tecnico_global', armador: 'hmm', referencia: 'SZPM1', containers: [{ containerId: 'x', numero: 'HDMU1', organizationId: 'o' }] } as EntregaPendente);
  assert.match(email.subject, /Incidente técnico/);
  assert.match(email.body, /HDMU1/);
});
