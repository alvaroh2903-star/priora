import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { TrackingTargetRepository } from '../persistence/trackingTargetRepository';
import { VesselCallRepository } from '../persistence/vesselCallRepository';
import { VesselSharingRepository } from '../persistence/vesselSharingRepository';
import { executarRodadaCompartilhada, planejarRodadasCompartilhadas } from '../tracking/vesselRound';
import { ordenarCandidatos, janelaFormacaoValida } from '../tracking/vesselSharing';
import { ArmadorTrackingPort, TrackingEnrichResult } from '../sources/armadorTrackingSource';

const url = testDatabaseUrl();
const HOJE = '2026-09-20';
const IDENT = { armador: 'MAERSK', armadorOriginal: 'maersk', vessel: 'OCEAN CARGO', vesselOriginal: 'Ocean Cargo', voyage: 'V1', voyageOriginal: 'V1', pod: 'SINGAPURA', podOriginal: 'Singapura' };

/* ---------- puro ---------- */

test('puro: ordenarCandidatos põe o mais antigo primeiro; desempate por containerId', () => {
  const r = ordenarCandidatos([
    { containerId: 'C', trackingTargetId: null, ultimaConsultaValida: '2026-09-10' },
    { containerId: 'A', trackingTargetId: null, ultimaConsultaValida: null },
    { containerId: 'B', trackingTargetId: null, ultimaConsultaValida: '2026-09-05' },
  ]);
  assert.deepEqual(r.map((x) => x.containerId), ['A', 'B', 'C']); // null (nunca consultado) primeiro
});

test('puro: janela de formação — ≤4 dias válida; >4 dias inválida', () => {
  assert.equal(janelaFormacaoValida(['2026-09-01', '2026-09-05']), true);
  assert.equal(janelaFormacaoValida(['2026-09-01', '2026-09-06']), false);
  assert.equal(janelaFormacaoValida(['2026-09-01']), true);
});

/* ---------- integração ---------- */

async function setup(pool: Pool) { await runMigrations(pool); await truncateAll(pool); }
const org = (pool: Pool, slug = 'rocket') => new OrganizationRepository(pool).create('Rocket', slug);

function fakePort(over: (ref: string) => Partial<TrackingEnrichResult> = () => ({})): ArmadorTrackingPort {
  return {
    async enrich(ref: string): Promise<TrackingEnrichResult> {
      return {
        carrier: { id: 'maersk', name: 'Maersk' }, reference: ref, referenceType: 'bl', ok: true,
        needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
        cached: false, resolved: false, at: '2026-09-20T00:00:00Z', ...over(ref),
      };
    },
  };
}

/** Monta VesselCall + N participantes confirmados (elegíveis) e devolve ids. */
async function grupo(pool: Pool, n: number, opts: { slug?: string } = {}) {
  const o = await org(pool, opts.slug ?? 'rocket');
  const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-G', clienteId: null });
  const vc = await new VesselCallRepository(pool).upsert({ organizationId: o.id, componentes: IDENT, podFonte: 'master_bl' });
  const sharing = new VesselSharingRepository(pool);
  const containers: { id: string; targetId: string; ref: string }[] = [];
  for (let i = 0; i < n; i++) {
    const numero = `HDMU000000${i}`;
    const c = await new ContainerRepository(pool).create(o.id, p.id, numero);
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: `MBL-${i}` });
    await new TrackingTargetRepository(pool).linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: `MBL-${i}` });
    await new VesselCallRepository(pool).associarContainer({ containerId: c.id, vesselCallId: vc.id, organizationId: o.id, chave: 'k', origemDados: 'tracking_service' });
    await sharing.confirmarEstruturado({
      organizationId: o.id, vesselCallId: vc.id, containerId: c.id, trackingTargetId: target.id, processoId: p.id,
      etaPrevista: '2026-09-25', vinculoConfirmado: true, fonte: 'tracking_service', evidencia: 'loaded on board',
      observadoEm: new Date('2026-09-05T00:00:00Z'), statusPrevistoConfirmado: 'confirmado',
    });
    containers.push({ id: c.id, targetId: target.id, ref: target.referenceValueCanonical });
  }
  return { orgId: o.id, processoId: p.id, vesselCallId: vc.id, containers };
}
const fetchesDe = (pool: Pool, targetId: string) => pool.query(`SELECT count(*)::int n FROM tracking_fetches WHERE tracking_target_id=$1`, [targetId]).then((r) => r.rows[0].n);
const rodada = (pool: Pool, vcId: string) => pool.query(`SELECT * FROM vessel_call_rodadas WHERE vessel_call_id=$1`, [vcId]).then((r) => r.rows);

test('rodada: 3 participantes → 1 referência consultada (fetch real), 2 cobertos; só a referência tem TrackingFetch', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const devidos = new Set(g.containers.map((c) => c.id));
    const r = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos });
    assert.equal(r.status, 'executada');
    assert.equal(r.cobertos.length, 2);
    assert.ok(r.referenciaContainerId);
    assert.equal(r.resultadoReferencia, 'consulta_efetiva');
    // Só a referência tem fetch; cobertos não.
    const ref = g.containers.find((c) => c.id === r.referenciaContainerId)!;
    assert.equal(await fetchesDe(pool, ref.targetId), 1);
    for (const c of g.containers.filter((x) => x.id !== ref.id)) {
      assert.equal(await fetchesDe(pool, c.targetId), 0, 'coberto não gera TrackingFetch');
    }
    // Cobertos ficam vigentes e excluídos da seleção automática.
    const vigentes = await new VesselSharingRepository(pool).coberturasVigentes(g.vesselCallId);
    assert.equal(vigentes.length, 2);
  } finally { await pool.end(); }
});

test('formação: <2 elegíveis → sem grupo; confirmações fora da janela de 4 dias → não ativa', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g1 = await grupo(pool, 1);
    const r1 = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g1.orgId, vesselCallId: g1.vesselCallId, dataOperacional: HOJE, devidos: new Set(g1.containers.map((c) => c.id)) });
    assert.equal(r1.status, 'sem_grupo');

    const g2 = await grupo(pool, 2, { slug: 'org-jan' });
    // Afasta as confirmações em >4 dias.
    await pool.query(`UPDATE vessel_call_participantes SET confirmado_em='2026-09-01T00:00:00Z' WHERE container_id=$1`, [g2.containers[0].id]);
    await pool.query(`UPDATE vessel_call_participantes SET confirmado_em='2026-09-10T00:00:00Z' WHERE container_id=$1`, [g2.containers[1].id]);
    const r2 = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g2.orgId, vesselCallId: g2.vesselCallId, dataOperacional: HOJE, devidos: new Set(g2.containers.map((c) => c.id)) });
    assert.equal(r2.status, 'sem_grupo');
    assert.equal(r2.motivo, 'formacao_fora_da_janela');
  } finally { await pool.end(); }
});

test('claim da rodada: única por (org, vessel_call, data) — concorrência e após conclusão', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const devidos = new Set(g.containers.map((c) => c.id));
    // Concorrência: duas execuções simultâneas → só uma executa.
    const [a, b] = await Promise.all([
      executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos }),
      executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos }),
    ]);
    const exec = [a, b].filter((r) => r.status === 'executada').length;
    const naoAdq = [a, b].filter((r) => r.status === 'nao_adquiriu').length;
    assert.equal(exec, 1, 'apenas uma rodada executa');
    assert.equal(naoAdq, 1);
    assert.equal((await rodada(pool, g.vesselCallId)).length, 1, 'uma única linha de rodada por data');
    // Nova execução no MESMO dia → já concluída, não cria outra rodada nem novo fetch.
    const c = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos });
    assert.equal(c.status, 'nao_adquiriu');
    assert.equal(c.motivo, 'ja_concluida');
    assert.equal((await rodada(pool, g.vesselCallId)).length, 1);
  } finally { await pool.end(); }
});

test('fallback: referência falha → alternativa assume (máx 2); ambas falham → sem cobertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const devidos = new Set(g.containers.map((c) => c.id));
    // Ordena candidatos p/ saber quem é referência (mais antigo; todos null → menor containerId).
    const refRef = [...g.containers].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    // Port: a referência falha; as demais ok.
    const port = fakePort((ref) => (ref === refRef.ref ? { ok: false, message: 'portal fora' } : {}));
    const r = await executarRodadaCompartilhada({ pool, port, organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos });
    assert.equal(r.status, 'executada');
    assert.equal(r.tentativas, 2, 'referência + 1 alternativa');
    assert.equal(r.resultadoReferencia, 'consulta_efetiva');
    const tent = await pool.query(`SELECT numero_tentativa, resultado FROM vessel_call_rodada_tentativas t JOIN vessel_call_rodadas rd ON rd.id=t.rodada_id WHERE rd.vessel_call_id=$1 ORDER BY numero_tentativa`, [g.vesselCallId]);
    assert.deepEqual(tent.rows.map((x) => x.resultado), ['falha', 'consulta_efetiva']);

    // Grupo novo em que TODAS falham → nenhuma cobertura criada.
    const g2 = await grupo(pool, 2, { slug: 'org-falha' });
    const r2 = await executarRodadaCompartilhada({ pool, port: fakePort(() => ({ ok: false, message: 'fora' })), organizationId: g2.orgId, vesselCallId: g2.vesselCallId, dataOperacional: HOJE, devidos: new Set(g2.containers.map((c) => c.id)) });
    assert.equal(r2.resultadoReferencia, 'falha');
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g2.vesselCallId)).length, 0);
  } finally { await pool.end(); }
});

test('cache vs efetiva: resposta de cache sustenta cobertura e é contada como cache', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const r = await executarRodadaCompartilhada({ pool, port: fakePort(() => ({ cached: true })), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: new Set(g.containers.map((c) => c.id)) });
    assert.equal(r.resultadoReferencia, 'cache_hit');
    assert.equal(r.cobertos.length, 1);
    const t = await pool.query(`SELECT cache_hit, consulta_efetiva FROM vessel_call_rodada_tentativas t JOIN vessel_call_rodadas rd ON rd.id=t.rodada_id WHERE rd.vessel_call_id=$1`, [g.vesselCallId]);
    assert.equal(t.rows[0].cache_hit, true);
    assert.equal(t.rows[0].consulta_efetiva, false);
  } finally { await pool.end(); }
});

test('saída conservadora: descarga/berth no destino encerra e invalida coberturas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    // Primeira rodada cobre o outro.
    await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: new Set(g.containers.map((c) => c.id)) });
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g.vesselCallId)).length, 1);
    // Um contêiner descarrega → saída conservadora.
    await pool.query(`UPDATE containers SET discharge_date='2026-09-26' WHERE id=$1`, [g.containers[0].id]);
    const r = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: '2026-09-27', devidos: new Set(g.containers.map((c) => c.id)) });
    assert.equal(r.status, 'encerrado');
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g.vesselCallId)).length, 0, 'coberturas invalidadas na saída');
  } finally { await pool.end(); }
});

test('divergência: remover 1 participante mantém os demais; <2 encerra o grupo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 3);
    const sharing = new VesselSharingRepository(pool);
    await sharing.removerParticipante(g.vesselCallId, g.containers[0].id, 'navio divergente');
    assert.equal((await sharing.participantesElegiveis(g.vesselCallId)).length, 2, 'os demais permanecem');
    const r = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: new Set([g.containers[1].id, g.containers[2].id]) });
    assert.equal(r.status, 'executada');
    // Remove mais um → sobra 1 → encerra.
    await sharing.removerParticipante(g.vesselCallId, g.containers[1].id, 'viagem divergente');
    const r2 = await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: '2026-09-21', devidos: new Set([g.containers[2].id]) });
    assert.equal(r2.status, 'sem_grupo');
  } finally { await pool.end(); }
});

test('ETA muda não remove participante; invalida cobertura de ETA; participantes seguem', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupo(pool, 2);
    const sharing = new VesselSharingRepository(pool);
    await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g.orgId, vesselCallId: g.vesselCallId, dataOperacional: HOJE, devidos: new Set(g.containers.map((c) => c.id)) });
    // Nova ETA na mesma identidade → atualiza evento e invalida coberturas de ETA (sem remover).
    await new VesselCallRepository(pool).aplicarEvento(g.vesselCallId, { campo: 'eta', valor: '2026-09-27', fonte: 'tracking_service', observadoEm: new Date() });
    await sharing.invalidarCoberturas(g.vesselCallId, 'eta_alterada');
    assert.equal((await sharing.participantesElegiveis(g.vesselCallId)).length, 2, 'ETA não remove participante');
    assert.equal((await sharing.coberturasVigentes(g.vesselCallId)).length, 0);
  } finally { await pool.end(); }
});

test('confirmação: vínculo previsto NÃO confirma; humano auditado habilita', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const o = await org(pool);
    const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-H', clienteId: null });
    const vc = await new VesselCallRepository(pool).upsert({ organizationId: o.id, componentes: IDENT, podFonte: 'master_bl' });
    const c = await new ContainerRepository(pool).create(o.id, p.id, 'HDMUHUM0001');
    await new VesselCallRepository(pool).associarContainer({ containerId: c.id, vesselCallId: vc.id, organizationId: o.id, chave: 'k', origemDados: 'tracking_service' });
    const sharing = new VesselSharingRepository(pool);
    // Previsto: vinculoConfirmado=false → não elegível.
    await sharing.confirmarEstruturado({ organizationId: o.id, vesselCallId: vc.id, containerId: c.id, etaPrevista: '2026-09-25', vinculoConfirmado: false, fonte: 'tracking_service', observadoEm: new Date(), statusPrevistoConfirmado: 'previsto' });
    assert.equal((await sharing.participantesElegiveis(vc.id)).length, 0, 'previsto não habilita');
    // Humano auditado → habilita.
    await sharing.confirmarHumano({ organizationId: o.id, vesselCallId: vc.id, containerId: c.id, etaPrevista: '2026-09-25', usuario: 'ana', motivo: 'confirmado no portal', evidencia: 'print', observadoEm: new Date() });
    assert.equal((await sharing.participantesElegiveis(vc.id)).length, 1, 'humano auditado habilita');
  } finally { await pool.end(); }
});

test('scheduler: planejarRodadasCompartilhadas é inerte sem participantes; ativo trata cobertos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // Inerte: nenhum participante.
    const inerte = await planejarRodadasCompartilhadas({ pool, port: fakePort(), dataOperacional: HOJE, devidos: [] });
    assert.equal(inerte.tratados.size, 0);
    // Ativo: grupo confirmado, devidos = os 3.
    const g = await grupo(pool, 3);
    const plano = await planejarRodadasCompartilhadas({ pool, port: fakePort(), dataOperacional: HOJE, devidos: g.containers.map((c) => c.id) });
    assert.equal(plano.rodadas, 1);
    assert.equal(plano.cobertos, 2);
    assert.equal(plano.tratados.size, 3, 'referência + 2 cobertos excluídos do individual');
  } finally { await pool.end(); }
});

test('isolamento: participantes e coberturas não cruzam organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g1 = await grupo(pool, 2, { slug: 'iso-a' });
    const g2 = await grupo(pool, 2, { slug: 'iso-b' });
    await executarRodadaCompartilhada({ pool, port: fakePort(), organizationId: g1.orgId, vesselCallId: g1.vesselCallId, dataOperacional: HOJE, devidos: new Set(g1.containers.map((c) => c.id)) });
    const cobA = await pool.query(`SELECT organization_id FROM vessel_call_coberturas WHERE vessel_call_id=$1`, [g1.vesselCallId]);
    assert.ok(cobA.rows.every((r) => r.organization_id === g1.orgId));
    assert.equal((await new VesselSharingRepository(pool).coberturasVigentes(g2.vesselCallId)).length, 0, 'org B intocada');
  } finally { await pool.end(); }
});
