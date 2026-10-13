import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { SchedulerRepository } from '../persistence/schedulerRepository';
import { runSchedulerOnce } from '../scheduler/schedulerWorker';
import { ArmadorTrackingPort, TrackingEnrichResult, TrackingEventLike } from '../sources/armadorTrackingSource';

/**
 * D16 v1.1 (corretiva) — fencing do claim individual do tracking scheduler
 * (`tracking_schedule_claims.claim_token`, migration 0039).
 *
 * Regressão da corrida: A reivindica, fica stale, B retoma, A termina tarde e
 * chama `concluirClaim` — antes finalizava a posse de B; agora é rejeitado
 * com `posse_perdida` e nada muda. Staleness é SEMPRE produzida recuando
 * `claimed_em` via SQL (nunca dormindo em tempo real).
 */

const url = testDatabaseUrl();
const JANELA = '2026-09-16';
const M0038 = '0038_d15c_v1_1_publicacao_tarifaria.sql';
const M0039 = '0039_tracking_schedule_claims_fencing.sql';

/* ---------------- helpers ---------------- */

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function linhaClaim(pool: Pool, targetId: string, janela: string) {
  const { rows } = await pool.query(
    `SELECT status, claimed_por, claim_token, tentativas, concluido_em, erro
       FROM tracking_schedule_claims WHERE tracking_target_id=$1 AND janela=$2`,
    [targetId, janela],
  );
  assert.equal(rows.length, 1, 'exatamente uma linha de claim por (target, janela)');
  return rows[0];
}

/** Torna o claim stale de forma DETERMINÍSTICA (sem sleep): recua claimed_em em 1 hora. */
async function tornarStale(pool: Pool, targetId: string, janela: string) {
  const r = await pool.query(
    `UPDATE tracking_schedule_claims SET claimed_em = now() - interval '1 hour'
      WHERE tracking_target_id=$1 AND janela=$2`,
    [targetId, janela],
  );
  assert.equal(r.rowCount, 1);
}

function resultado(over: Partial<TrackingEnrichResult> = {}): TrackingEnrichResult {
  return {
    carrier: { id: 'hmm', name: 'HMM' }, reference: '', referenceType: 'bl', ok: true,
    needsLogin: false, needsCaptcha: false, message: undefined, events: [], containers: [],
    cached: false, resolved: false, at: '2026-09-16T00:00:00Z', ...over,
  };
}

/** Org + processo + contêiner com cadência diária em 2026-09-16 + target MBL vinculado. */
async function containerNaJanela(pool: Pool, numero: string, referencia: string) {
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const processo = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-D16', clienteId: null });
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, processo.id, numero);
  // LFD House 2026-09-20 / Master 2026-09-25 → início diário 2026-09-16 (exemplo oficial da cadência).
  const obsEm = new Date('2026-09-01T00:00:00Z');
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'master_bl', observadoEm: obsEm });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document', observadoEm: obsEm });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: 25, fonte: 'master_bl', observadoEm: obsEm });
  const targets = new TrackingTargetRepository(pool);
  const { target } = await targets.upsert({ carrier: 'hmm', reference: referencia });
  await targets.linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: referencia });
  return { containerId: c.id, targetId: target.id, numero };
}

/** Porta fake que CONTA as chamadas reais a enrich() (sem rede). */
function portaContadora(numero: string, opts: { atrasoMs?: number } = {}) {
  const contador = { chamadas: 0 };
  const port: ArmadorTrackingPort = {
    async enrich() {
      contador.chamadas++;
      // Só abre espaço para interleaving entre workers concorrentes — não é usado para staleness.
      if (opts.atrasoMs) await new Promise((res) => setTimeout(res, opts.atrasoMs));
      return resultado({
        cached: false, resolved: true,
        containers: [{ numero, tipo: null, dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null }],
        events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
      });
    },
  };
  return { port, contador };
}

async function fetchesDe(pool: Pool, targetId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int n FROM tracking_fetches WHERE tracking_target_id=$1`, [targetId]);
  return rows[0].n;
}

/** Banco temporário isolado (mesmo idioma de d15c.test.ts) para os testes de migration. */
async function comBancoTemporario<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const base = testDatabaseUrl()!;
  const admin = new Pool({ connectionString: base });
  const nome = `d16v11_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE "${nome}"`);
  const destino = new URL(base);
  destino.pathname = `/${nome}`;
  const pool = new Pool({ connectionString: destino.toString() });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [nome]);
    await admin.query(`DROP DATABASE IF EXISTS "${nome}"`);
    await admin.end();
  }
}

async function colunaClaimTokenExiste(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'tracking_schedule_claims' AND column_name = 'claim_token'`,
  );
  if (rows.length) assert.equal(rows[0].data_type, 'uuid');
  return rows.length === 1;
}

async function constraintTokenExiste(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM pg_constraint
      WHERE conname = 'tracking_schedule_claims_token_consistente'
        AND conrelid = 'tracking_schedule_claims'::regclass AND contype = 'c'`,
  );
  return rows.length === 1;
}

/* ================================================================== *
 * #1–#7 — corrida A (stale) × B (retomada), passo a passo
 * ================================================================== */

test('D16 v1.1 #1-#7: retomada de claim stale — A perde a posse, só B finaliza', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await setup(pool);
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'hmm', reference: 'SZPMD16000001' });
    const targetId = target.id;
    const repo = new SchedulerRepository(pool);
    let tokenA: string;
    let tokenB: string;

    await t.test('D16 v1.1 #1: Worker A reivindica o target/janela e recebe claimToken', async () => {
      const a = await repo.claimJanela(targetId, JANELA, { workerId: 'A' });
      assert.equal(a.venceu, true);
      assert.ok(a.claimToken, 'claimToken não nulo');
      tokenA = a.claimToken!;
      const row = await linhaClaim(pool, targetId, JANELA);
      assert.equal(row.status, 'claimed');
      assert.equal(row.claimed_por, 'A');
      assert.equal(row.claim_token, tokenA, 'o token devolvido é o persistido');
      // Sem staleness, uma segunda reivindicação NÃO vence.
      const outro = await repo.claimJanela(targetId, JANELA, { workerId: 'B' });
      assert.deepEqual(outro, { venceu: false, claimToken: null });
    });

    await t.test('D16 v1.1 #2: claim de A fica stale de forma determinística (claimed_em recuado via SQL)', async () => {
      await tornarStale(pool, targetId, JANELA);
      const { rows } = await pool.query(
        `SELECT claimed_em < now() - interval '30 minutes' AS stale FROM tracking_schedule_claims
          WHERE tracking_target_id=$1 AND janela=$2`,
        [targetId, JANELA],
      );
      assert.equal(rows[0].stale, true);
      const row = await linhaClaim(pool, targetId, JANELA);
      assert.equal(row.status, 'claimed');
      assert.equal(row.claim_token, tokenA, 'recuar claimed_em não muda a posse por si só');
    });

    await t.test('D16 v1.1 #3: Worker B retoma o claim stale e recebe um claimToken DIFERENTE do de A', async () => {
      const b = await repo.claimJanela(targetId, JANELA, { workerId: 'B', staleInterval: '30 minutes' });
      assert.equal(b.venceu, true);
      assert.ok(b.claimToken);
      assert.notEqual(b.claimToken, tokenA, 'retomada gera token novo');
      tokenB = b.claimToken!;
      const row = await linhaClaim(pool, targetId, JANELA);
      assert.equal(row.status, 'claimed');
      assert.equal(row.claimed_por, 'B');
      assert.equal(row.claim_token, tokenB);
      assert.equal(row.tentativas, 2);
    });

    await t.test('D16 v1.1 #4: A tenta concluir com SUCESSO usando o token obsoleto → posse_perdida; linha intacta (de B)', async () => {
      const antes = await linhaClaim(pool, targetId, JANELA);
      const r = await repo.concluirClaim(targetId, JANELA, tokenA, true);
      assert.deepEqual(r, { aplicado: false, motivo: 'posse_perdida' });
      const depois = await linhaClaim(pool, targetId, JANELA);
      assert.deepEqual(depois, antes, 'nada foi alterado pela tentativa de A');
      assert.equal(depois.status, 'claimed');
      assert.equal(depois.claimed_por, 'B');
      assert.equal(depois.claim_token, tokenB);
      assert.equal(depois.concluido_em, null);
    });

    await t.test('D16 v1.1 #5: A tenta concluir como FALHA usando o token obsoleto → posse_perdida; linha intacta', async () => {
      const antes = await linhaClaim(pool, targetId, JANELA);
      const r = await repo.concluirClaim(targetId, JANELA, tokenA, false, 'erro');
      assert.deepEqual(r, { aplicado: false, motivo: 'posse_perdida' });
      const depois = await linhaClaim(pool, targetId, JANELA);
      assert.deepEqual(depois, antes);
      assert.equal(depois.status, 'claimed');
      assert.equal(depois.claimed_por, 'B');
      assert.equal(depois.claim_token, tokenB);
      assert.equal(depois.erro, null, 'o erro de A não foi gravado');
    });

    await t.test('D16 v1.1 #6: B conclui com SUCESSO usando o próprio token → aplicado', async () => {
      const r = await repo.concluirClaim(targetId, JANELA, tokenB, true);
      assert.deepEqual(r, { aplicado: true });
    });

    await t.test('D16 v1.1 #7: estado final pertence a B — done, claimed_por=B, claim_token limpo', async () => {
      const row = await linhaClaim(pool, targetId, JANELA);
      assert.equal(row.status, 'done');
      assert.equal(row.claimed_por, 'B');
      assert.equal(row.claim_token, null, 'token limpo ao sair de claimed');
      assert.ok(row.concluido_em, 'concluido_em preenchido');
      assert.equal(row.erro, null);
      // Finalização é de uso único: nem B (token já consumido) nem A conseguem refinalizar.
      assert.deepEqual(await repo.concluirClaim(targetId, JANELA, tokenB, false, 'tarde'), { aplicado: false, motivo: 'posse_perdida' });
      assert.deepEqual(await repo.concluirClaim(targetId, JANELA, tokenA, false, 'tarde'), { aplicado: false, motivo: 'posse_perdida' });
      assert.equal((await linhaClaim(pool, targetId, JANELA)).status, 'done');
    });
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #8 — concorrência ordinária (sem staleness) segue com UM vencedor
 * ================================================================== */

test('D16 v1.1 #8: dois claimJanela concorrentes → exatamente UM vencedor (com token); o perdedor sem token', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'hmm', reference: 'SZPMD16000008' });
    const repo = new SchedulerRepository(pool);
    const [a, b] = await Promise.all([
      repo.claimJanela(target.id, JANELA, { workerId: 'A' }),
      repo.claimJanela(target.id, JANELA, { workerId: 'B' }),
    ]);
    const vencedores = [a, b].filter((r) => r.venceu);
    assert.equal(vencedores.length, 1, 'exatamente um vencedor');
    assert.ok(vencedores[0].claimToken);
    const perdedor = a.venceu ? b : a;
    assert.deepEqual(perdedor, { venceu: false, claimToken: null });
    const row = await linhaClaim(pool, target.id, JANELA);
    assert.equal(row.claim_token, vencedores[0].claimToken);
    assert.equal(row.tentativas, 1);
  } finally { await pool.end(); }
});

test('D16 v1.1 #8: dois runSchedulerOnce concorrentes no mesmo tick → UMA chamada a enrich() (garantia preservada após o fencing)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const fx = await containerNaJanela(pool, 'HDMUD160008', 'SZPMD16TICK8');
    const { port, contador } = portaContadora(fx.numero, { atrasoMs: 5 });
    const [a, b] = await Promise.all([
      runSchedulerOnce({ pool, port, hoje: JANELA, workerId: 'wA' }),
      runSchedulerOnce({ pool, port, hoje: JANELA, workerId: 'wB' }),
    ]);
    assert.equal(contador.chamadas, 1, 'apenas um worker chamou enrich()');
    assert.equal(await fetchesDe(pool, fx.targetId), 1, 'um único TrackingFetch');
    assert.equal(a.sincronizados + b.sincronizados, 1);
    const row = await linhaClaim(pool, fx.targetId, JANELA);
    assert.equal(row.status, 'done', 'o vencedor finalizou com o próprio token');
    assert.equal(row.claim_token, null);
    assert.ok(row.claimed_por === 'wA' || row.claimed_por === 'wB');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #9 — retomada não cria fetch extra
 * ================================================================== */

test('D16 v1.1 #9: A reivindica e "morre" (stale); o tick de B retoma via reivindicar → enrich() chamado UMA vez no total', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const fx = await containerNaJanela(pool, 'HDMUD160009', 'SZPMD16TICK9');
    const repo = new SchedulerRepository(pool);
    const { port, contador } = portaContadora(fx.numero);

    // A reivindica e morre: nunca chama a porta, nunca finaliza.
    const a = await repo.claimJanela(fx.targetId, JANELA, { workerId: 'A' });
    assert.equal(a.venceu, true);
    const tokenA = a.claimToken!;

    // Enquanto o claim de A está FRESCO, um tick de B não executa nada.
    const r0 = await runSchedulerOnce({ pool, port, hoje: JANELA, workerId: 'B' });
    assert.equal(r0.sincronizados, 0);
    assert.equal(contador.chamadas, 0, 'claim vigente de A bloqueia B');
    assert.equal((await linhaClaim(pool, fx.targetId, JANELA)).claimed_por, 'A');

    await tornarStale(pool, fx.targetId, JANELA);

    const r1 = await runSchedulerOnce({ pool, port, hoje: JANELA, workerId: 'B', staleInterval: '30 minutes' });
    assert.equal(r1.sincronizados, 1, 'B executou o claim recuperado');
    assert.equal(contador.chamadas, 1, 'só a consulta de B — nenhuma extra pela retomada');
    assert.equal(await fetchesDe(pool, fx.targetId), 1);

    const row = await linhaClaim(pool, fx.targetId, JANELA);
    assert.equal(row.status, 'done');
    assert.equal(row.claimed_por, 'B');
    assert.equal(row.claim_token, null);
    assert.equal(row.tentativas, 2);

    // A "ressuscita" tarde: não consegue finalizar a janela que B concluiu.
    assert.deepEqual(await repo.concluirClaim(fx.targetId, JANELA, tokenA, false, 'A voltou'), { aplicado: false, motivo: 'posse_perdida' });
    assert.equal((await linhaClaim(pool, fx.targetId, JANELA)).status, 'done');

    // Tick posterior no mesmo dia: cadência satisfeita → sem nova consulta.
    await runSchedulerOnce({ pool, port, hoje: JANELA, workerId: 'B' });
    assert.equal(contador.chamadas, 1);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #10 — rodada compartilhada (VesselCall) usa a MESMA barreira fenced
 * ================================================================== */

const HOJE_VC = '2026-09-20';
const IDENT = { armador: 'MAERSK', armadorOriginal: 'maersk', vessel: 'OCEAN CARGO', vesselOriginal: 'Ocean Cargo', voyage: 'V1', voyageOriginal: 'V1', pod: 'SINGAPURA', podOriginal: 'Singapura' };
const numeroVc = (i: number) => `HDMU000000${i}`;

function travelResult(ref: string): TrackingEnrichResult {
  const i = ref.replace(/\D/g, '');
  const numero = numeroVc(Number(i));
  const loaded: TrackingEventLike = { date: '2026-09-05', status: 'Loaded on board', location: 'SINGAPURA', vessel: 'OCEAN CARGO', voyage: 'V1', type: 'loaded', statusPrevistoConfirmado: 'confirmado', container: numero };
  return {
    carrier: { id: 'maersk', name: 'Maersk' }, reference: ref, referenceType: 'bl', ok: true, needsLogin: false, needsCaptcha: false,
    events: [loaded], containers: [{ numero, tipo: null, dischargeDate: null, availableDate: null, gateOut: null, emptyReturn: null }],
    cached: false, resolved: false, at: '2026-09-20T00:00:00Z', etaPrevista: '2026-09-25',
  };
}

/** Grupo mínimo de N contêineres confirmados no MESMO VesselCall, dentro da janela de formação (cópia de vesselSharing.test.ts). */
async function grupoVesselCall(pool: Pool, n: number) {
  const o = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  const p = await new ProcessoRepository(pool).create({ organizationId: o.id, numeroProcesso: 'IM-G', clienteId: null });
  const vc = await new VesselCallRepository(pool).upsert({ organizationId: o.id, componentes: IDENT, podFonte: 'master_bl' });
  const sharing = new VesselSharingRepository(pool);
  const containers: { id: string; targetId: string; ref: string; numero: string }[] = [];
  for (let i = 0; i < n; i++) {
    const numero = numeroVc(i);
    const c = await new ContainerRepository(pool).create(o.id, p.id, numero);
    await new FieldObservationRepository(pool).insert({ organizationId: o.id, entidadeTipo: 'container', entidadeId: c.id, campo: 'podDescarga', valor: 'SINGAPURA', fonte: 'master_bl', observadoEm: new Date('2026-09-01T00:00:00Z') });
    const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'maersk', reference: `MBL-${i}` });
    await new TrackingTargetRepository(pool).linkContainer(c.id, target.id, { referenceType: 'mbl', referenceRaw: `MBL-${i}` });
    await new VesselCallRepository(pool).associarContainer({ containerId: c.id, vesselCallId: vc.id, organizationId: o.id, chave: 'k', origemDados: 'tracking_service' });
    await sharing.confirmarEstruturado({ organizationId: o.id, vesselCallId: vc.id, containerId: c.id, trackingTargetId: target.id, processoId: p.id, etaPrevista: '2026-09-25', vinculoConfirmado: true, fonte: 'tracking_service', evidencia: 'loaded on board', observadoEm: new Date('2026-09-05T00:00:00Z'), statusPrevistoConfirmado: 'confirmado' });
    containers.push({ id: c.id, targetId: target.id, ref: target.referenceValueCanonical, numero });
  }
  return { orgId: o.id, vesselCallId: vc.id, containers };
}

test('D16 v1.1 #10: rodada compartilhada (VesselCall) adquire/conclui o claim da referência pela MESMA barreira fenced do individual', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const g = await grupoVesselCall(pool, 3);
    const repo = new SchedulerRepository(pool);
    const targetPorRef = new Map(g.containers.map((c) => [c.ref, c.targetId]));

    // Observação DURANTE a consulta real da referência (dentro do caminho compartilhado):
    // a linha do claim está 'claimed' com token; um token nunca emitido é rejeitado
    // sem alterar nada — mesmo com a linha ainda ativa.
    const durante: Array<{ targetId: string; row: any; tentativaIntrusa: unknown; rowDepois: any }> = [];
    let chamadas = 0;
    const port: ArmadorTrackingPort = {
      async enrich(ref: string) {
        chamadas++;
        const targetId = targetPorRef.get(ref);
        assert.ok(targetId, `ref inesperada ${ref}`);
        const row = await linhaClaim(pool, targetId!, HOJE_VC);
        const tentativaIntrusa = await repo.concluirClaim(targetId!, HOJE_VC, randomUUID(), true);
        const rowDepois = await linhaClaim(pool, targetId!, HOJE_VC);
        durante.push({ targetId: targetId!, row, tentativaIntrusa, rowDepois });
        return travelResult(ref);
      },
    };

    const r = await runSchedulerOnce({ pool, port, hoje: HOJE_VC, workerId: 'W' });
    assert.equal(r.rodadasCompartilhadas, 1, 'a referência passou pelo caminho COMPARTILHADO');
    assert.equal(r.contêineresCobertos, 2, 'os demais foram cobertos');
    assert.equal(r.sincronizados, 0, 'nenhum contêiner foi pelo caminho individual');
    assert.equal(chamadas, 1, 'uma única consulta real (a da referência)');

    const rodada = (await pool.query(
      `SELECT referencia_container_id FROM vessel_call_rodadas WHERE vessel_call_id=$1 AND data_operacional=$2`,
      [g.vesselCallId, HOJE_VC],
    )).rows[0];
    const ref = g.containers.find((c) => c.id === rodada.referencia_container_id)!;
    assert.ok(ref, 'rodada registrou a referência');
    assert.equal(durante.length, 1);
    assert.equal(durante[0].targetId, ref.targetId, 'a consulta foi do target da referência');

    // Durante a execução compartilhada: claim individual ativo, com token, de W.
    assert.equal(durante[0].row.status, 'claimed');
    assert.equal(durante[0].row.claimed_por, 'W');
    assert.ok(durante[0].row.claim_token, 'a rodada compartilhada reivindicou com claimToken');
    assert.deepEqual(durante[0].tentativaIntrusa, { aplicado: false, motivo: 'posse_perdida' }, 'token nunca emitido rejeitado em plena execução');
    assert.deepEqual(durante[0].rowDepois, durante[0].row, 'nada alterado pela tentativa intrusa');

    // Após o tick: finalizado de verdade (pelo token real devolvido a reivindicar).
    const fim = await linhaClaim(pool, ref.targetId, HOJE_VC);
    assert.equal(fim.status, 'done');
    assert.equal(fim.claimed_por, 'W');
    assert.equal(fim.claim_token, null);
    // Cobertos não têm claim individual.
    for (const c of g.containers.filter((x) => x.id !== ref.id)) {
      const { rowCount } = await pool.query(`SELECT 1 FROM tracking_schedule_claims WHERE tracking_target_id=$1`, [c.targetId]);
      assert.equal(rowCount, 0, 'coberto não reivindica claim individual');
    }

    // Finalizar a MESMA (target, janela) com um token nunca emitido (UUID válido) → posse_perdida.
    assert.deepEqual(await repo.concluirClaim(ref.targetId, HOJE_VC, randomUUID(), true), { aplicado: false, motivo: 'posse_perdida' });
    assert.deepEqual(await linhaClaim(pool, ref.targetId, HOJE_VC), fim, 'linha intacta');

    // Token literal não-UUID: a coluna é UUID, então o PostgreSQL rejeita o parâmetro
    // (erro de sintaxe) ANTES de qualquer UPDATE — falha fechada, nada é alterado.
    // (Comportamento observado; ver relatório: não devolve `posse_perdida`, lança.)
    await assert.rejects(
      () => repo.concluirClaim(ref.targetId, HOJE_VC, 'um-token-que-nunca-foi-emitido', true),
      /invalid input syntax for type uuid/,
    );
    assert.deepEqual(await linhaClaim(pool, ref.targetId, HOJE_VC), fim, 'linha intacta após token malformado');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #11 — suítes existentes (cadência/crédito) seguem verdes
 * ================================================================== */

test('D16 v1.1 #11: fencing não altera a cadência — tick do dia seguinte reabre a janela normalmente', { skip: !url }, async () => {
  // Confirmação de que scheduler.test.ts, schedulerLoop.test.ts, demurrageTickFilas.test.ts e
  // vesselSharing.test.ts seguem verdes é feita executando essas suítes junto com esta
  // (ver relatório). Aqui, um sanity check local da cadência com o fencing ativo.
  const pool = testPool();
  try {
    await setup(pool);
    const fx = await containerNaJanela(pool, 'HDMUD160011', 'SZPMD16TICK11');
    const { port, contador } = portaContadora(fx.numero);
    const r1 = await runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'w' });
    assert.equal(r1.contêineresNaJanela, 1);
    const r2 = await runSchedulerOnce({ pool, port, hoje: '2026-09-16', workerId: 'w' });
    assert.equal(r2.contêineresNaJanela, 0, 'mesmo dia: já consultado');
    const r3 = await runSchedulerOnce({ pool, port, hoje: '2026-09-17', workerId: 'w' });
    assert.equal(r3.contêineresNaJanela, 1, 'dia seguinte: janela diária reabre');
    assert.equal(contador.chamadas, 2);
    const { rows } = await pool.query(`SELECT janela::text, status, claim_token FROM tracking_schedule_claims WHERE tracking_target_id=$1 ORDER BY janela`, [fx.targetId]);
    assert.deepEqual(rows.map((x) => [x.janela, x.status, x.claim_token]), [['2026-09-16', 'done', null], ['2026-09-17', 'done', null]]);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #12 — migration 0039: banco novo e banco já em 0038
 * ================================================================== */

test('D16 v1.1 #12: migration 0039 aplica num banco novo e num banco já em 0038', { skip: !url }, async (t) => {
  await t.test('D16 v1.1 #12a: banco novo — 0039 aplicada; coluna claim_token (uuid) e CHECK existem; idempotente', async () => {
    await comBancoTemporario(async (pool) => {
      const r1 = await runMigrations(pool);
      assert.ok(r1.applied.includes(M0039));
      assert.equal(await colunaClaimTokenExiste(pool), true);
      assert.equal(await constraintTokenExiste(pool), true);
      const r2 = await runMigrations(pool);
      assert.equal(r2.applied.length, 0, 'reexecutar não reaplica nada');
      assert.ok(r2.alreadyApplied.includes(M0039));
      // A invariante é efetiva: 'claimed' sem token e 'done' com token são recusados.
      const { target } = await new TrackingTargetRepository(pool).upsert({ carrier: 'hmm', reference: 'SZPMD16MIG12A' });
      await assert.rejects(
        () => pool.query(`INSERT INTO tracking_schedule_claims (tracking_target_id, janela, status, tentativas, claimed_em) VALUES ($1,'2026-09-16','claimed',1,now())`, [target.id]),
        /tracking_schedule_claims_token_consistente/,
      );
      await assert.rejects(
        () => pool.query(`INSERT INTO tracking_schedule_claims (tracking_target_id, janela, status, tentativas, claimed_em, claim_token) VALUES ($1,'2026-09-16','done',1,now(),gen_random_uuid())`, [target.id]),
        /tracking_schedule_claims_token_consistente/,
      );
    });
  });

  await t.test('D16 v1.1 #12b: banco em 0038 — sem claim_token; upgrade aplica exatamente 0039 e faz backfill descartável', async () => {
    await comBancoTemporario(async (pool) => {
      const r38 = await runMigrations(pool, { until: M0038 });
      assert.ok(r38.applied.includes(M0038));
      assert.ok(!r38.applied.includes(M0039));
      assert.equal(await colunaClaimTokenExiste(pool), false, 'claim_token ainda não existe em 0038');
      assert.equal(await constraintTokenExiste(pool), false);

      // Linhas legadas: uma 'claimed' (precisa de token de backfill) e uma 'done' (fica NULL).
      const targets = new TrackingTargetRepository(pool);
      const { target: t1 } = await targets.upsert({ carrier: 'hmm', reference: 'SZPMD16MIG12B1' });
      const { target: t2 } = await targets.upsert({ carrier: 'hmm', reference: 'SZPMD16MIG12B2' });
      await pool.query(`INSERT INTO tracking_schedule_claims (tracking_target_id, janela, status, tentativas, claimed_por, claimed_em) VALUES ($1,'2026-09-16','claimed',1,'legado',now())`, [t1.id]);
      await pool.query(`INSERT INTO tracking_schedule_claims (tracking_target_id, janela, status, tentativas, claimed_por, claimed_em, concluido_em) VALUES ($1,'2026-09-16','done',1,'legado',now(),now())`, [t2.id]);

      const r39 = await runMigrations(pool);
      assert.deepEqual(r39.applied, [M0039, '0040_handoff_demurrage.sql'], 'aplica a 0039 (e a 0040, aditiva, que já existe à frente)');
      assert.equal(await colunaClaimTokenExiste(pool), true);
      assert.equal(await constraintTokenExiste(pool), true);

      const legadoClaimed = await linhaClaim(pool, t1.id, '2026-09-16');
      const legadoDone = await linhaClaim(pool, t2.id, '2026-09-16');
      assert.equal(legadoClaimed.status, 'claimed');
      assert.ok(legadoClaimed.claim_token, "'claimed' legado recebe token de backfill");
      assert.equal(legadoDone.claim_token, null, "'done' legado segue sem token");

      // O token de backfill é descartável: nenhum worker o detém; uma retomada
      // (stale) o substitui e só o token novo finaliza.
      const repo = new SchedulerRepository(pool);
      await tornarStale(pool, t1.id, '2026-09-16');
      const novo = await repo.claimJanela(t1.id, '2026-09-16', { workerId: 'novo' });
      assert.equal(novo.venceu, true);
      assert.notEqual(novo.claimToken, legadoClaimed.claim_token);
      assert.deepEqual(await repo.concluirClaim(t1.id, '2026-09-16', legadoClaimed.claim_token, true), { aplicado: false, motivo: 'posse_perdida' });
      assert.deepEqual(await repo.concluirClaim(t1.id, '2026-09-16', novo.claimToken!, true), { aplicado: true });
    });
  });
});
