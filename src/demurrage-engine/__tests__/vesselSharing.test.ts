import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { FieldObservationRepository } from '../persistence/fieldObservationRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { VesselSharingRepository } from '../persistence/vesselSharingRepository';
import { executarRodadaCompartilhada, planejarRodadasCompartilhadas } from '../tracking/vesselRound';
import { ordenarCandidatos, janelaFormacaoValida } from '../tracking/vesselSharing';
import { validarFatosCompartilhados, IdentidadeVesselCall } from '../tracking/vesselSharedFacts';
import { ConsultaRealizada } from '../scheduler/trackingScheduler';
import { runSchedulerOnce } from '../scheduler/schedulerWorker';
import { ArmadorTrackingPort, TrackingEnrichResult, TrackingEventLike } from '../sources/armadorTrackingSource';

const url = testDatabaseUrl();
const HOJE = '2026-09-20';
const IDENT = { armador: 'MAERSK', armadorOriginal: 'maersk', vessel: 'OCEAN CARGO', vesselOriginal: 'Ocean Cargo', voyage: 'V1', voyageOriginal: 'V1', pod: 'SINGAPURA', podOriginal: 'Singapura' };
const numeroDe = (i: number) => `HDMU000000${i}`;

/* ---------- puro ---------- */
test('puro: ordenarCandidatos (mais antigo primeiro; desempate por id) e janela de 4 dias', () => {
  const r = ordenarCandidatos([
    { containerId: 'C', trackingTargetId: null, ultimaConsultaValida: '2026-09-10' },
    { containerId: 'A', trackingTargetId: null, ultimaConsultaValida: null },
    { containerId: 'B', trackingTargetId: null, ultimaConsultaValida: '2026-09-05' },
  ]);
  assert.deepEqual(r.map((x) => x.containerId), ['A', 'B', 'C']);
  assert.equal(janelaFormacaoValida(['2026-09-01', '2026-09-05']), true);
  assert.equal(janelaFormacaoValida(['2026-09-01', '2026-09-06']), false);
});

/* ---------- integração ---------- */
async function setup(pool: Pool) { await runMigrations(pool); await truncateAll(pool); }
const org = (pool: Pool, slug = 'rocket') => new OrganizationRepository(pool).create('Rocket', slug);

/** Resposta com FATO DE VIAGEM (loaded confirmado) para o contêiner do ref MBL-<i>. */
function travelResult(ref: string, over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  const i = ref.replace(/\D/g, '');
  const numero = `HDMU000000${i}`;
  const loaded: TrackingEventLike = { date: '2026-09-05', status: 'Loaded on board', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V1', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numero };
  return {
    carrier: { id: 'maersk', name: 'Maersk' }, reference: ref, referenceType: 'bl', ok: true, needsLogin: false, needsCaptcha: false,
    events: [loaded], containers: [{ numero, tipo: null, dischargeDate: null, availableDate: null, gateOut: null, emptyReturn: null }],
    cached: false, resolved: false, at: '2026-09-20T00:00:00Z', etaPrevista: '2026-09-25', ...over,
  };
}
function fakePort(over: (ref: string) => Partial<TrackingEnrichResult> = () => ({})): ArmadorTrackingPort {
  return { async enrich(ref: string) { return travelResult(ref, over(ref)); } };
}

async function grupo(pool: Pool, n: number, opts: { slug?: string } = {}) {
  const o = await org(pool, opts.slug ?? 'rocket');
  const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-G', clienteId: null });
  const vc = await new VesselCallRepository(pool).upsert({ organizationId: o.id, componentes: IDENT, podFonte: 'master_bl' });
  const sharing = new VesselSharingRepository(pool);
  const containers: { id: string; targetId: string; ref: string; numero: string }[] = [];
  for (let i = 0; i < n; i++) {
    const numero = numeroDe(i);
    const c = await new ContainerRepository(pool).create(o.id, p.id, numero);
    await new FieldObservationRepository(pool).insert({ organizationId: o.id, entidadeTipo: 'container', entidadeId: c.id, campo: 'podDescarga', valor: 'SINGAPURA', fonte: 'master_bl', observadoEm: new Date('2026-09-01T00:00:00Z') });
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: `MBL-${i}` });
    await new TrackingTargetRepository(pool).linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: `MBL-${i}` });
    await new VesselCallRepository(pool).associarContainer({ containerId: c.id, vesselCallId: vc.id, organizationId: o.id, chave: 'k', origemDados: 'tracking_service' });
    await sharing.confirmarEstruturado({ organizationId: o.id, vesselCallId: vc.id, containerId: c.id, trackingTargetId: target.id, processoId: p.id, etaPrevista: '2026-09-25', vinculoConfirmado: true, fonte: 'tracking_service', evidencia: 'loaded on board', observadoEm: new Date('2026-09-05T00:00:00Z'), statusPrevistoConfirmado: 'confirmado' });
    containers.push({ id: c.id, targetId: target.id, ref: target.referenceValueCanonical, numero });
  }
  return { orgId: o.id, processoId: p.id, vesselCallId: vc.id, containers, port: fakePort() };
}
const fetchesDe = (pool: Pool, targetId: string) => pool.query(`SELECT count(*)::int n FROM tracking_fetches WHERE tracking_target_id=$1`, [targetId]).then((r) => r.rows[0].n);
const idSet = (arr: { id: string }[]) => new Set(arr.map((c) => c.id));

test('#4 referência compartilhada adquire/conclui claim individual (TrackingFetch real) e cobre os demais', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const r = await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'executada');
    assert.equal(r.cobertos.length, 2);
    const ref = g.containers.find((c) => c.id === r.referenciaContainerId)!;
    assert.equal(await fetchesDe(pool, ref.targetId), 1, 'referência tem TrackingFetch real');
    for (const c of g.containers.filter((x) => x.id !== ref.id)) assert.equal(await fetchesDe(pool, c.targetId), 0, 'coberto não gera fetch');
    // Proveniência real (#11): fetch, target/processo consultados, evidência, campos.
    const cob = (await pool.query(`SELECT cobertura_originadora_fetch_id, target_consultado_id, processo_consultado_id, campos_compartilhados, evidencia FROM vessel_call_coberturas WHERE vessel_call_id=$1 AND estado='vigente'`, [g.vesselCallId])).rows;
    assert.ok(cob.every((x) => x.cobertura_originadora_fetch_id && x.target_consultado_id && x.processo_consultado_id && x.evidencia && x.campos_compartilhados.length));
  } finally { await pool.end(); }
});

test('#1 cobertura vigente suprime o individual em ticks posteriores (planejador)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    // Tick posterior (outro dia): os 2 cobertos devem ser suprimidos do individual.
    const plano = await planejarRodadasCompartilhadas({ pool, port: g.port, dataOperacional: '2026-09-21', devidos: g.containers.map((c) => c.id) });
    assert.ok(plano.suprimidosPorCobertura.size >= 2, 'cobertos suprimidos do individual');
    for (const c of g.containers) if (c.id !== [...plano.referenciasExecutadas][0]) { /* cobertos ∈ tratados */ }
    assert.ok([...plano.suprimidosPorCobertura].every((id) => plano.tratados.has(id)));
  } finally { await pool.end(); }
});

test('#2/#3 dois workers → uma única consulta; quem perde o claim não consulta o grupo individualmente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const [pa, pb] = await Promise.all([
      planejarRodadasCompartilhadas({ pool, port: g.port, dataOperacional: HOJE, devidos: g.containers.map((c) => c.id), workerId: 'A' }),
      planejarRodadasCompartilhadas({ pool, port: g.port, dataOperacional: HOJE, devidos: g.containers.map((c) => c.id), workerId: 'B' }),
    ]);
    const rodadas = pa.rodadas + pb.rodadas;
    assert.equal(rodadas, 1, 'apenas uma rodada executa');
    // Total de fetches no grupo = 1 (só a referência).
    let total = 0; for (const c of g.containers) total += await fetchesDe(pool, c.targetId);
    assert.equal(total, 1, 'somente uma consulta efetiva no grupo');
    // O worker que perdeu retira os participantes do individual (grupoEmExecucaoPorOutroWorker) — nenhum liberado.
    const perdedor = pa.rodadas === 0 ? pa : pb;
    assert.equal(perdedor.liberadosParaIndividual.size, 0);
    assert.ok(g.containers.every((c) => perdedor.tratados.has(c.id)), 'todos do grupo tratados (não vão ao individual)');
  } finally { await pool.end(); }
});

test('#5 resposta sem fatos de viagem → não cria cobertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const semViagem = fakePort(() => ({ events: [{ date: '2026-09-19', status: 'Gate out', location: 'SANTOS', vessel: null, voyage: null, type: 'gate_out' }], containers: [], etaPrevista: null }));
    const r = await executarRodadaCompartilhada({ pool, port: semViagem, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'executada');
    assert.equal(r.cobertos.length, 0, 'sem fato de viagem → sem cobertura');
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g.vesselCallId)).length, 0);
  } finally { await pool.end(); }
});

test('#6 result.ok só com Gate Out/Empty Return → não cria cobertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const soIndividual = fakePort((ref) => ({
      events: [{ date: '2026-09-19', status: 'Empty return', location: 'SANTOS', vessel: null, voyage: null, type: 'empty_return', container: numeroDe(Number(ref.replace(/\D/g, ''))) }],
      containers: [{ numero: numeroDe(Number(ref.replace(/\D/g, ''))), tipo: null, dischargeDate: null, availableDate: null, gateOut: '2026-09-18', emptyReturn: null }], etaPrevista: null,
    }));
    // Empty return preencheria tracking_return → encerra; para isolar o #6 usamos só gate_out + sem viagem.
    const soGate = fakePort((ref) => ({ events: [{ date: '2026-09-18', status: 'Gate out', location: 'SANTOS', vessel: null, voyage: null, type: 'gate_out', container: numeroDe(Number(ref.replace(/\D/g, ''))) }], containers: [], etaPrevista: null }));
    void soIndividual;
    const r = await executarRodadaCompartilhada({ pool, port: soGate, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.cobertos.length, 0);
  } finally { await pool.end(); }
});

test('#7 berth descoberto na rodada encerra o grupo sem renovar cobertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    // Primeira rodada cria cobertura para o outro.
    await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    // Rodada seguinte: a resposta traz BERTH no POD → após ingestão, saída conservadora.
    const comBerth = fakePort((ref) => ({ events: [
      { date: '2026-09-05', status: 'Loaded', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V1', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numeroDe(Number(ref.replace(/\D/g, ''))) },
      { date: '2026-09-24', status: 'Berthed', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V1', type: 'berth' },
    ] }));
    // Expira coberturas p/ liberar candidato à nova rodada.
    await pool.query(`UPDATE vessel_call_coberturas SET coberto_ate = now() - interval '1 hour' WHERE vessel_call_id=$1`, [g.vesselCallId]);
    const r = await executarRodadaCompartilhada({ pool, port: comBerth, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: '2026-09-22', devidos: idSet(g.containers) });
    assert.equal(r.status, 'encerrado');
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g.vesselCallId)).length, 0, 'nenhum beneficiado coberto');
  } finally { await pool.end(); }
});

test('#8 descarga descoberta na rodada encerra o grupo sem renovar cobertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const comDescarga = fakePort((ref) => ({ containers: [{ numero: numeroDe(Number(ref.replace(/\D/g, ''))), tipo: null, dischargeDate: '2026-09-26', availableDate: null, gateOut: null, emptyReturn: null }] }));
    const r = await executarRodadaCompartilhada({ pool, port: comDescarga, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'encerrado');
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g.vesselCallId)).length, 0);
  } finally { await pool.end(); }
});

test('#9 rolagem da referência não cobre o VesselCall anterior', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    // A referência (menor id) reporta OUTRO navio/viagem → rola para novo VesselCall.
    const ref = [...g.containers].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const comRolagem = fakePort((r) => (r === ref.ref
      ? { events: [{ date: '2026-09-06', status: 'Loaded', location: 'SINGAPURA', vessel: 'OTHER SHIP', voyage: 'V2', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: ref.numero }] }
      : {}));
    const r = await executarRodadaCompartilhada({ pool, port: comRolagem, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'executada');
    assert.equal(r.motivo, 'referencia_divergente');
    assert.equal(r.cobertos.length, 0, 'não cobre o VesselCall anterior com resposta divergente');
    // A referência saiu do grupo anterior (removida) e os demais permanecem.
    assert.equal((await new VesselSharingRepository(pool).participantesElegiveis(g.vesselCallId)).length, 2);
  } finally { await pool.end(); }
});

test('#10 mudança SOMENTE de ETA mantém o grupo e renova cobertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const etaNova = fakePort(() => ({ etaPrevista: '2026-09-27' }));
    const r = await executarRodadaCompartilhada({ pool, port: etaNova, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'executada');
    assert.equal(r.cobertos.length, 1, 'grupo mantido; cobertura renovada');
    assert.equal((await new VesselSharingRepository(pool).participantesElegiveis(g.vesselCallId)).length, 2, 'ETA não remove participante');
  } finally { await pool.end(); }
});

test('#12 falha percorre a política e tenta no máximo uma alternativa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const ref = [...g.containers].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const port = fakePort((r) => (r === ref.ref ? { ok: false, message: 'portal fora' } : {}));
    const r = await executarRodadaCompartilhada({ pool, port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'executada');
    assert.equal(r.tentativas, 2, 'referência + 1 alternativa');
    const tent = await pool.query(`SELECT resultado FROM vessel_call_rodada_tentativas t JOIN vessel_call_rodadas rd ON rd.id=t.rodada_id WHERE rd.vessel_call_id=$1 ORDER BY numero_tentativa`, [g.vesselCallId]);
    assert.deepEqual(tent.rows.map((x) => x.resultado), ['falha', 'consulta_efetiva']);
    // A referência falhada teve TrackingFetch (pipeline individual) e incidente avaliado.
    assert.equal(await fetchesDe(pool, ref.targetId), 1);
  } finally { await pool.end(); }
});

test('#13 saída libera imediatamente todos ao individual (planejador)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    await pool.query(`UPDATE containers SET discharge_date='2026-09-26' WHERE id=$1`, [g.containers[0].id]);
    const plano = await planejarRodadasCompartilhadas({ pool, port: g.port, dataOperacional: '2026-09-27', devidos: g.containers.map((c) => c.id) });
    assert.equal(plano.rodadas, 0);
    assert.ok(g.containers.every((c) => plano.liberadosParaIndividual.has(c.id)), 'todos liberados ao individual');
    assert.equal(plano.tratados.size, 0);
  } finally { await pool.end(); }
});

test('#14 atualização manual ignora cobertura e respeita limite (2/dia)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    const coberto = g.containers.find((c) => c.id !== undefined)!; // qualquer coberto
    const { solicitarAtualizacaoManual } = await import('../scheduler/trackingScheduler');
    // Manual ignora cobertura: consulta mesmo o target coberto.
    const m1 = await solicitarAtualizacaoManual({ pool, port: g.port, trackingTargetId: coberto.targetId, papel: 'MANAGER', agora: new Date('2026-09-20T08:00:00Z') });
    assert.equal(m1.executada, true);
    const m2 = await solicitarAtualizacaoManual({ pool, port: g.port, trackingTargetId: coberto.targetId, papel: 'MANAGER', agora: new Date('2026-09-20T08:30:00Z') });
    // cooldown ~2h → segunda no mesmo curto intervalo é barrada (política existente preservada).
    assert.equal(m2.executada, false);
  } finally { await pool.end(); }
});

/* ---------- v1.3: validador estruturado (puro) ---------- */
const IDENT_NORM: IdentidadeVesselCall = { armador: 'MAERSK', vessel: 'OCEAN CARGO', voyage: 'V1', pod: 'SINGAPURA', identidadeConfirmada: true };
function consultaDe(result: Partial<TrackingEnrichResult>): ConsultaRealizada {
  const base = travelResult('MBL-0', result);
  return { targetId: 't0', referenceValueCanonical: 'MBL0', result: base, fetchId: 'f0', cached: false, ok: base.ok };
}

test('v1.3(#7) puro: resposta sem navio não declara navio como compartilhado', () => {
  const c = consultaDe({ events: [{ date: '2026-09-05', status: 'Loaded', location: 'SINGAPURA', vessel: null, voyage: 'V1', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numeroDe(0) }] });
  const f = validarFatosCompartilhados({ numero: numeroDe(0), consulta: c, identidade: IDENT_NORM });
  assert.equal(f.ok, true);
  const campos = f.camposValidos.map((x) => x.campo);
  assert.ok(!campos.includes('navio'), 'navio ausente na resposta não é declarado');
  assert.ok(campos.includes('viagem'));
});

test('v1.3(#8) puro: viagem divergente → incompatível, sem cobertura', () => {
  const c = consultaDe({ events: [{ date: '2026-09-05', status: 'Loaded', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V9', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numeroDe(0) }] });
  const f = validarFatosCompartilhados({ numero: numeroDe(0), consulta: c, identidade: IDENT_NORM });
  assert.equal(f.compativel, false);
  assert.equal(f.motivoRejeicao, 'viagem_divergente');
  assert.equal(f.ok, false);
});

test('v1.3(#9) puro: POD/destino divergente → incompatível, sem cobertura', () => {
  const c = consultaDe({ events: [
    { date: '2026-09-05', status: 'Loaded', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V1', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numeroDe(0) },
    { date: '2026-09-26', status: 'Discharged', location: 'ROTERDA', vessel: 'OCEAN CARGO', voyage: 'V1', type: 'discharge', container: numeroDe(0) },
  ] });
  const f = validarFatosCompartilhados({ numero: numeroDe(0), consulta: c, identidade: IDENT_NORM });
  assert.equal(f.compativel, false);
  assert.equal(f.motivoRejeicao, 'destino_divergente');
});

test('v1.3 puro: ETA isolada só gera fato eta e exige identidade confirmada', () => {
  const c = consultaDe({ events: [], etaPrevista: '2026-09-28' });
  const ok = validarFatosCompartilhados({ numero: numeroDe(0), consulta: c, identidade: IDENT_NORM });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.camposValidos.map((x) => x.campo), ['eta']);
  const semIdent = validarFatosCompartilhados({ numero: numeroDe(0), consulta: c, identidade: { ...IDENT_NORM, identidadeConfirmada: false } });
  assert.equal(semIdent.ok, false);
  assert.equal(semIdent.motivoRejeicao, 'eta_sem_identidade_confirmada');
});

/* ---------- v1.3: integração ---------- */
test('v1.3(#1,#2) saída pós-ingestão invalida coberturas e libera os demais ao individual no mesmo tick', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const sharing = new VesselSharingRepository(pool);
    const r1 = await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r1.cobertos.length, 2, 'primeira rodada cobre 2');
    // Tick posterior: a referência (única não coberta) encontra DESCARGA → encerra e invalida tudo.
    const comDescarga = fakePort((ref) => ({ containers: [{ numero: numeroDe(Number(ref.replace(/\D/g, ''))), tipo: null, dischargeDate: '2026-09-26', availableDate: null, gateOut: null, emptyReturn: null }] }));
    const plano = await planejarRodadasCompartilhadas({ pool, port: comDescarga, dataOperacional: '2026-09-22', devidos: g.containers.map((c) => c.id) });
    assert.equal((await sharing.coberturasVigentes(g.vesselCallId)).length, 0, 'coberturas invalidadas na saída');
    for (const id of r1.cobertos) {
      assert.ok(plano.liberadosParaIndividual.has(id), 'antes coberto agora liberado ao individual');
      assert.ok(!plano.suprimidosPorCobertura.has(id), 'supressão em memória removida');
    }
  } finally { await pool.end(); }
});

test('v1.3(#3) rodada concluída com falha não bloqueia o individual no mesmo dia', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const portFail = fakePort(() => ({ ok: false, message: 'portal fora' }));
    const r = await executarRodadaCompartilhada({ pool, port: portFail, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.desfecho, 'falha_sem_cobertura');
    const plano = await planejarRodadasCompartilhadas({ pool, port: portFail, dataOperacional: HOJE, devidos: g.containers.map((c) => c.id) });
    assert.equal(plano.suprimidosPorCobertura.size, 0);
    assert.ok(g.containers.every((c) => plano.liberadosParaIndividual.has(c.id)), 'todos liberados ao individual');
  } finally { await pool.end(); }
});

test('v1.3(#4) rodada concluída sem fatos compartilháveis não bloqueia o individual', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const soGate = fakePort((ref) => ({ events: [{ date: '2026-09-18', status: 'Gate out', location: 'SANTOS', vessel: null, voyage: null, type: 'gate_out', container: numeroDe(Number(ref.replace(/\D/g, ''))) }], containers: [], etaPrevista: null }));
    const r = await executarRodadaCompartilhada({ pool, port: soGate, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.desfecho, 'sucesso_sem_cobertura');
    const plano = await planejarRodadasCompartilhadas({ pool, port: soGate, dataOperacional: HOJE, devidos: g.containers.map((c) => c.id) });
    assert.equal(plano.suprimidosPorCobertura.size, 0);
    assert.ok(g.containers.every((c) => plano.liberadosParaIndividual.has(c.id)));
  } finally { await pool.end(); }
});

test('v1.3(#5) ja_concluida com cobertura suprime somente os realmente cobertos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const r1 = await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    // Mesmo dia: a rodada está concluída (com cobertura). Suprime só os 2 cobertos; a referência volta ao individual.
    const plano = await planejarRodadasCompartilhadas({ pool, port: g.port, dataOperacional: HOJE, devidos: g.containers.map((c) => c.id) });
    assert.equal(plano.suprimidosPorCobertura.size, 2, 'só os cobertos suprimidos');
    assert.ok(!plano.suprimidosPorCobertura.has(r1.referenciaContainerId!), 'referência não é suprimida por cobertura');
    assert.ok(plano.liberadosParaIndividual.has(r1.referenciaContainerId!), 'referência liberada ao individual necessário');
  } finally { await pool.end(); }
});

test('v1.3(#6) ETA isolada gera cobertura apenas do campo eta', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const etaOnly = fakePort(() => ({ events: [], etaPrevista: '2026-09-28' }));
    const r = await executarRodadaCompartilhada({ pool, port: etaOnly, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.status, 'executada');
    assert.equal(r.cobertos.length, 1);
    const cob = (await pool.query(`SELECT campos_compartilhados FROM vessel_call_coberturas WHERE vessel_call_id=$1 AND estado='vigente'`, [g.vesselCallId])).rows;
    assert.deepEqual(cob[0].campos_compartilhados, ['eta'], 'cobertura só do campo eta');
  } finally { await pool.end(); }
});

test('v1.3(#8) viagem divergente na rodada não gera cobertura (integração)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const ref = [...g.containers].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const portV9 = fakePort((r) => (r === ref.ref
      ? { events: [{ date: '2026-09-06', status: 'Loaded', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V9', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: ref.numero }] }
      : {}));
    const r = await executarRodadaCompartilhada({ pool, port: portV9, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    assert.equal(r.motivo, 'referencia_divergente');
    assert.equal(r.desfecho, 'divergencia_referencia');
    assert.equal(r.cobertos.length, 0);
  } finally { await pool.end(); }
});

test('v1.3(#10) evidência da cobertura contém fonte, valor, observado_em e referência ao evento', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    await executarRodadaCompartilhada({ pool, port: g.port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: idSet(g.containers) });
    const cob = (await pool.query(`SELECT evidencia FROM vessel_call_coberturas WHERE vessel_call_id=$1 AND estado='vigente' LIMIT 1`, [g.vesselCallId])).rows[0];
    const ev = JSON.parse(cob.evidencia);
    assert.ok(ev.trackingFetchId && ev.targetConsultadoId && ev.containerConsultadoId, 'refs de fetch/target/contêiner');
    assert.ok(Array.isArray(ev.campos) && ev.campos.length, 'campos efetivos');
    assert.ok(ev.campos.every((c: any) => c.campo && c.valor && c.fonte && c.observadoEm && c.evidencia), 'cada campo com valor/fonte/observado_em/evidência');
  } finally { await pool.end(); }
});

test('v1.3(#11) exceção durante o planejamento conclui (falha) os claims adquiridos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    void g;
    const boom: ArmadorTrackingPort = { async enrich() { throw new Error('boom no planejamento'); } };
    await assert.rejects(runSchedulerOnce({ pool, port: boom, hoje: HOJE, workerId: 'W' }), /boom no planejamento/);
    const claims = await pool.query(`SELECT status FROM tracking_schedule_claims WHERE janela=$1`, [HOJE]);
    assert.ok(claims.rows.length >= 1, 'ao menos um claim individual foi adquirido no planejamento');
    assert.ok(claims.rows.every((r) => r.status === 'failed'), 'claims adquiridos concluídos com falha (não abandonados até o stale)');
  } finally { await pool.end(); }
});

test('isolamento: coberturas não cruzam organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g1 = await grupo(pool, 2, { slug: 'iso-a' });
    const g2 = await grupo(pool, 2, { slug: 'iso-b' });
    await executarRodadaCompartilhada({ pool, port: g1.port, organizationId: g1.orgId, vesselCallId: g1.vesselCallId, dataOperacional: HOJE, devidos: idSet(g1.containers) });
    const cobA = await pool.query(`SELECT organization_id FROM vessel_call_coberturas WHERE vessel_call_id=$1`, [g1.vesselCallId]);
    assert.ok(cobA.rows.every((r) => r.organization_id === g1.orgId));
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g2.vesselCallId)).length, 0);
  } finally { await pool.end(); }
});
