import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { OrganizationRole } from '../domain/types';
import { registrarProcessoDemurrage, processarPosCommitOutboxPendentes } from '../registro/registrarProcessoDemurrage';
import { AvisoFallbackManual, AvisoFallbackManualTransport } from '../registro/avisosFallbackManual';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { AlertTransport } from '../scheduler/alertOutbox';
import { startSchedulerLoop } from '../scheduler/schedulerLoop';
import { executarTickDemurrage, formatarLogTick, TickDeps, TickResultado } from '../../demurrage/schedulerBootstrap';
import { montarEmailFallbackManual } from '../../demurrage/avisoFallbackManualTransportGraph';
import { containerContrato, contratoRegistro, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/**
 * Fase D10 v1.3 — ligação operacional: as duas filas do registro
 * (`demurrage_pos_commit_outbox` e `demurrage_fallback_manual_avisos`) são
 * consumidas AUTOMATICAMENTE pelo tick do scheduler, em etapas isoladas, sem
 * tocar cadência/claims/consumo de tracking.
 */

const url = testDatabaseUrl();
const HOJE = '2026-09-20';
const T = '2026-09-18T00:00:00Z';

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket');
}
async function membership(pool: Pool, orgId: string, papel: OrganizationRole, email: string) {
  const u = await new UsuarioRepository(pool).create(`Pessoa ${email}`, email);
  return (await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel)).id;
}

/** Porta de tracking que só CONTA chamadas (nenhuma consulta real, nenhum crédito). */
function portContador() {
  const chamadas: string[] = [];
  const port: ArmadorTrackingPort = {
    async enrich(ref) { chamadas.push(ref); return resultadoTracking({ reference: ref }); },
  };
  return { port, chamadas };
}
const alertasOk: AlertTransport = { async enviar() { return { ok: true } as any; } };

function transportFake(comportamento: (a: AvisoFallbackManual) => Promise<{ ok: boolean; erro?: string }> = async () => ({ ok: true })) {
  const enviados: AvisoFallbackManual[] = [];
  const t: AvisoFallbackManualTransport = { async enviar(a) { enviados.push(a); return comportamento(a); } };
  return { t, enviados };
}

function deps(pool: Pool, extra: Partial<TickDeps> = {}): TickDeps {
  return { pool, port: portContador().port, transport: alertasOk, workerId: 'tick-teste', ...extra };
}

const outbox = async (pool: Pool) =>
  (await pool.query(`SELECT container_id, estado, tentativas, concluido_em, worker_id, claim_token FROM demurrage_pos_commit_outbox ORDER BY container_id`)).rows;

/** Registro cujo pós-commit FALHOU (linha em `falha`, sem relógios) — só o tick pode repará-lo. */
async function registroComPosCommitFalho(pool: Pool, orgId: string, prefixo = 'TKPC') {
  const entrada = contratoRegistro({ organizationId: orgId, numeroProcesso: `IM-${prefixo}`, containers: [containerContrato(numeroContainer(prefixo, 1))] });
  await assert.rejects(() => registrarProcessoDemurrage(entrada, {
    pool, hojeReferencia: HOJE, _testeFalhaPosCommit: () => { throw new Error('crash simulado pós-commit'); },
  }));
  const { rows } = await pool.query(`SELECT c.id FROM containers c JOIN processos p ON p.id=c.processo_id WHERE p.numero_processo=$1`, [`IM-${prefixo}`]);
  return rows[0].id as string;
}

/** Fallback manual registrado (gera avisos PENDING para os gestores). */
async function registroComFallback(pool: Pool, orgId: string, autorId: string, prefixo = 'TKAV') {
  return registrarProcessoDemurrage(contratoRegistro({
    organizationId: orgId, numeroProcesso: `IM-${prefixo}`, containers: [containerContrato(numeroContainer(prefixo, 1))],
    houseFreeTimeDays: o(11, 'manual_fallback', T, 'ligacao-0918.eml', { justificativa: 'cliente confirmou por telefone', autorMembershipId: autorId }),
  }), { pool, hojeReferencia: HOJE });
}

const avisos = async (pool: Pool) =>
  (await pool.query(`SELECT id, destinatario_membership_id, status, tentativas, claim_token, erro FROM demurrage_fallback_manual_avisos ORDER BY destinatario_membership_id`)).rows;

/* ================================================================== *
 * Reparo automático do pós-commit
 * ================================================================== */

test('v1.3 #1: item pós-commit em falha é reparado pelo ciclo, sem novo registro', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const containerId = await registroComPosCommitFalho(pool, org.id);
    assert.equal((await outbox(pool))[0].estado, 'falha');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [containerId])).rows[0].n, 0);
    const ledgerAntes = (await pool.query(`SELECT count(*)::int n FROM demurrage_registros`)).rows[0].n;

    const t = await executarTickDemurrage(deps(pool), HOJE);

    assert.equal(t.posCommit.reparados, 1);
    assert.equal(t.posCommit.reivindicados, 1);
    assert.equal(t.posCommit.falhos, 0);
    assert.equal(t.posCommit.restantes, 0);
    assert.equal(t.posCommit.erro, null);
    assert.equal((await outbox(pool))[0].estado, 'concluido');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM relogios WHERE container_id=$1`, [containerId])).rows[0].n, 2, 'derivados reparados pelo ciclo');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM demurrage_registros`)).rows[0].n, ledgerAntes, 'nenhum novo registro foi necessário');
  } finally { await pool.end(); }
});

test('v1.3 #2: item concluído não é reivindicado nem recalculado pela etapa em ticks posteriores', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    await executarTickDemurrage(deps(pool), HOJE);
    const concluido = (await outbox(pool))[0];
    for (const dia of ['2026-09-21', '2026-09-22']) {
      const t = await executarTickDemurrage(deps(pool), dia);
      assert.equal(t.posCommit.reivindicados, 0, `tick ${dia}: nada a reivindicar`);
      assert.equal(t.posCommit.reparados, 0);
    }
    const depois = (await outbox(pool))[0];
    assert.equal(depois.tentativas, concluido.tentativas, 'tentativas inalteradas');
    assert.equal(depois.concluido_em.getTime(), concluido.concluido_em.getTime(), 'conclusão original preservada');
  } finally { await pool.end(); }
});

test('v1.3 #3: claim vencido (worker morto) é recuperado pelo ciclo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    await pool.query(`UPDATE demurrage_pos_commit_outbox
                         SET estado = 'processando', claim_token = gen_random_uuid(), worker_id = 'worker-morto',
                             expira_em = now() - interval '5 minutes'`);
    const t = await executarTickDemurrage(deps(pool), HOJE);
    assert.equal(t.posCommit.reparados, 1);
    const l = (await outbox(pool))[0];
    assert.equal(l.estado, 'concluido');
    assert.equal(l.worker_id, null);
    assert.equal(l.claim_token, null);
  } finally { await pool.end(); }
});

test('v1.3 #3b: claim VIVO de outro worker não é tocado pelo ciclo (fencing preservado)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    const { rows: [vivo] } = await pool.query(`UPDATE demurrage_pos_commit_outbox
       SET estado = 'processando', claim_token = gen_random_uuid(), worker_id = 'outro-vivo', expira_em = now() + interval '5 minutes'
     RETURNING claim_token`);
    const t = await executarTickDemurrage(deps(pool), HOJE);
    assert.equal(t.posCommit.reivindicados, 0);
    const l = (await outbox(pool))[0];
    assert.equal(l.claim_token, vivo.claim_token);
    assert.equal(l.worker_id, 'outro-vivo');
  } finally { await pool.end(); }
});

test('v1.3 #4: dois ticks CONCORRENTES não finalizam a mesma posse (um único reparo)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    const antes = (await outbox(pool))[0];
    const [a, b] = await Promise.all([
      executarTickDemurrage(deps(pool, { workerId: 'instancia-A' }), HOJE),
      executarTickDemurrage(deps(pool, { workerId: 'instancia-B' }), HOJE),
    ]);
    assert.equal(a.posCommit.reparados + b.posCommit.reparados, 1, 'exatamente um reparo');
    assert.equal(a.posCommit.reivindicados + b.posCommit.reivindicados, 1, 'exatamente um claim');
    assert.equal(a.posCommit.possePerdida + b.posCommit.possePerdida, 0);
    const depois = (await outbox(pool))[0];
    assert.equal(depois.estado, 'concluido');
    assert.equal(depois.tentativas, antes.tentativas + 1, 'uma única tentativa a mais');
  } finally { await pool.end(); }
});

test('v1.3 #5: falha da etapa de reparo NÃO bloqueia calendário, tracking nem avisos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registroComFallback(pool, org.id, analista);
    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, {
      fallbackAvisoTransport: fake.t,
      processarPosCommit: async () => { throw new Error('banco indisponível na etapa de reparo'); },
    }), HOJE);
    assert.match(t.posCommit.erro ?? '', /banco indisponível/);
    assert.equal(t.posCommit.restantes, null);
    assert.equal(t.janela, HOJE, 'tracking rodou');
    assert.ok(t.calendario >= 0, 'calendário rodou');
    assert.equal(t.avisosFallback.enviadas, 1, 'avisos seguiram mesmo com o reparo falhando');
    assert.equal(t.avisosFallback.erro, null);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Envio automático dos avisos de fallback
 * ================================================================== */

test('v1.3 #6: aviso pendente é enviado pelo ciclo com o conteúdo mínimo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registroComFallback(pool, org.id, analista);
    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: fake.t }), HOJE);
    assert.equal(t.avisosFallback.reivindicadas, 1);
    assert.equal(t.avisosFallback.enviadas, 1);
    assert.equal(t.avisosFallback.restantes, 0);
    assert.equal((await avisos(pool))[0].status, 'SENT');
    const email = montarEmailFallbackManual(fake.enviados[0]);
    for (const esperado of ['IM-TKAV', numeroContainer('TKAV', 1), 'House Free Time', '11 dia(s)', 'cliente confirmou por telefone', 'ligacao-0918.eml', 'Pessoa a@rocket.example', '2026-09-18']) {
      assert.ok(email.body.includes(esperado), `e-mail deveria conter ${esperado}`);
    }
    for (const proibido of [fake.enviados[0].entregaId, fake.enviados[0].justificativaId, fake.enviados[0].organizationId, 'claim', 'token']) {
      assert.ok(!email.body.includes(proibido) && !email.subject.includes(proibido), `e-mail não pode conter ${proibido}`);
    }
  } finally { await pool.end(); }
});

test('v1.3 #7 e #8: falha no transporte permanece reprocessável e é enviada em tick posterior', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registroComFallback(pool, org.id, analista);

    const fora = transportFake(async () => ({ ok: false, erro: 'sem_token_graph' }));
    const t1 = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: fora.t }), HOJE);
    assert.equal(t1.avisosFallback.falhadas, 1);
    assert.equal(t1.avisosFallback.restantes, 1, 'continua entregável');
    const a1 = (await avisos(pool))[0];
    assert.equal(a1.status, 'FAILED');
    assert.equal(a1.claim_token, null, 'posse liberada');
    assert.equal(a1.erro, 'sem_token_graph');

    // canal que LANÇA também não trava a entrega
    const quebra = transportFake(async () => { throw new Error('Graph 503'); });
    const t2 = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: quebra.t }), '2026-09-21');
    assert.equal(t2.avisosFallback.falhadas, 1);
    assert.equal((await avisos(pool))[0].status, 'FAILED');

    const ok = transportFake();
    const t3 = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: ok.t }), '2026-09-22');
    assert.equal(t3.avisosFallback.enviadas, 1);
    const a3 = (await avisos(pool))[0];
    assert.equal(a3.status, 'SENT');
    assert.equal(a3.tentativas, 3);
  } finally { await pool.end(); }
});

test('v1.3 #7b: máximo de tentativas — entrega esgotada não é mais reivindicada e aparece como esgotada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registroComFallback(pool, org.id, analista);
    await pool.query(`UPDATE demurrage_fallback_manual_avisos SET status = 'FAILED', tentativas = 5, erro = 'x'`);
    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: fake.t }), HOJE);
    assert.equal(t.avisosFallback.reivindicadas, 0);
    assert.equal(t.avisosFallback.esgotadas, 1);
    assert.equal(t.avisosFallback.restantes, 0);
    assert.equal(fake.enviados.length, 0);
  } finally { await pool.end(); }
});

test('v1.3 #9: reexecução do ciclo não cria nova entrega nem reenvia', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await membership(pool, org.id, 'ADMIN', 'adm@rocket.example');
    await registroComFallback(pool, org.id, analista);
    const fake = transportFake();
    for (const dia of ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']) {
      await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: fake.t }), dia);
    }
    assert.equal(fake.enviados.length, 2, 'uma mensagem por gestor, uma única vez');
    assert.equal((await avisos(pool)).length, 2, 'nenhuma entrega nova criada pelos ticks');
    assert.ok((await avisos(pool)).every((a) => a.status === 'SENT'));
  } finally { await pool.end(); }
});

test('v1.3 #10: destinatário CLIENT nunca recebe (nem entrega criada, nem gestor rebaixado, nem linha forjada)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    const gestor = await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    const cliente = await membership(pool, org.id, 'CLIENT', 'c@portal.example');
    const r = await registroComFallback(pool, org.id, analista);
    assert.deepEqual((await avisos(pool)).map((a) => a.destinatario_membership_id), [gestor], 'entrega criada só para o gestor');

    // Linha forjada direto no banco para um CLIENT + o gestor rebaixado a CLIENT antes do tick.
    const { rows: [j] } = await pool.query(`SELECT id FROM demurrage_fallback_manual_justificativas LIMIT 1`);
    await pool.query(`INSERT INTO demurrage_fallback_manual_avisos (organization_id, justificativa_id, destinatario_membership_id) VALUES ($1,$2,$3)`, [org.id, j.id, cliente]);
    await pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [gestor]);

    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: fake.t }), HOJE);
    assert.equal(fake.enviados.length, 0, 'nenhum envio a CLIENT');
    assert.equal(t.avisosFallback.reivindicadas, 0);
    assert.ok((await avisos(pool)).every((a) => a.status === 'PENDING'));
    assert.ok(r.processoId);
  } finally { await pool.end(); }
});

test('v1.3 #11: duas instâncias concorrentes respeitam o fencing — cada entrega enviada uma vez', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await membership(pool, org.id, 'ADMIN', 'adm@rocket.example');
    await registroComFallback(pool, org.id, analista);
    const fake = transportFake(async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true }; });
    const [a, b] = await Promise.all([
      executarTickDemurrage(deps(pool, { workerId: 'instancia-A', fallbackAvisoTransport: fake.t }), HOJE),
      executarTickDemurrage(deps(pool, { workerId: 'instancia-B', fallbackAvisoTransport: fake.t }), HOJE),
    ]);
    const ids = fake.enviados.map((e) => e.entregaId);
    assert.equal(ids.length, 2, 'duas entregas, duas mensagens');
    assert.equal(new Set(ids).size, 2, 'nenhuma entrega enviada duas vezes');
    assert.equal(a.avisosFallback.enviadas + b.avisosFallback.enviadas, 2);
    assert.equal(a.avisosFallback.possePerdida + b.avisosFallback.possePerdida, 0);
  } finally { await pool.end(); }
});

test('v1.3 #11b: instância antiga com posse vencida não finaliza (ao menos uma vez, sem sobrescrever o novo dono)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registroComFallback(pool, org.id, analista);
    let liberar!: () => void;
    const portao = new Promise<void>((r) => { liberar = r; });
    let aEnviando = false;
    const lenta = transportFake(async () => { aEnviando = true; await portao; return { ok: false, erro: 'timeout tardio' }; });
    const a = executarTickDemurrage(deps(pool, { workerId: 'antiga', fallbackAvisoTransport: lenta.t }), HOJE);
    for (let i = 0; i < 500 && !aEnviando; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(aEnviando);
    await pool.query(`UPDATE demurrage_fallback_manual_avisos SET expira_em = now() - interval '1 second'`);
    const nova = transportFake();
    const b = await executarTickDemurrage(deps(pool, { workerId: 'nova', fallbackAvisoTransport: nova.t }), HOJE);
    assert.equal(b.avisosFallback.enviadas, 1);
    liberar();
    const ra = await a;
    assert.equal(ra.avisosFallback.possePerdida, 1, 'a antiga não finalizou (FAILED tardio recusado)');
    assert.equal((await avisos(pool))[0].status, 'SENT', 'o SENT do novo dono prevalece');
  } finally { await pool.end(); }
});

test('v1.3 #12: falha da etapa de avisos não interrompe o laço do scheduler', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    const resultados: TickResultado[] = [];
    const erros: unknown[] = [];
    const loop = startSchedulerLoop({
      tick: async () => {
        resultados.push(await executarTickDemurrage(deps(pool, {
          fallbackAvisoTransport: transportFake().t,
          processarAvisosFallback: async () => { throw new Error('etapa de avisos quebrou'); },
        }), HOJE));
      },
      runOnStart: false, intervalMs: 10_000_000, onError: (e) => erros.push(e),
    });
    await loop.runNow();
    await loop.runNow();
    loop.stop();
    assert.equal(erros.length, 0, 'nenhum erro chegou ao laço');
    assert.equal(resultados.length, 2, 'o laço seguiu executando ticks');
    assert.match(resultados[0].avisosFallback.erro ?? '', /etapa de avisos quebrou/);
    assert.equal(resultados[0].posCommit.reparados, 1, 'a etapa de reparo rodou apesar dos avisos');
    assert.equal(resultados[0].janela, HOJE, 'tracking rodou apesar dos avisos');
  } finally { await pool.end(); }
});

test('v1.3 #12b: falha numa etapa PRÉ-EXISTENTE (calendário) não impede o consumo das filas no mesmo tick', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    // Pool que falha SÓ na consulta do calendário; todo o resto passa ao pool real.
    const poolComCalendarioQuebrado = new Proxy(pool, {
      get(alvo, prop) {
        if (prop === 'query') {
          return (sql: any, ...rest: any[]) => {
            const texto = typeof sql === 'string' ? sql : sql?.text ?? '';
            if (/WHERE p\.apuracao_status = 'OPEN'/.test(texto)) return Promise.reject(new Error('calendário indisponível'));
            return (alvo as any).query(sql, ...rest);
          };
        }
        const v = Reflect.get(alvo, prop);
        return typeof v === 'function' ? v.bind(alvo) : v;
      },
    }) as Pool;
    await assert.rejects(
      () => executarTickDemurrage(deps(poolComCalendarioQuebrado), HOJE),
      /calendário indisponível/,
      'o erro da etapa existente continua sendo reportado ao laço (comportamento preservado)',
    );
    assert.equal((await outbox(pool))[0].estado, 'concluido', 'a fila de reparo foi consumida no mesmo tick');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Mesma data, cadência intacta, contadores
 * ================================================================== */

test('v1.3 #13: calendário, tracking e reparo recebem a MESMA data operacional do tick', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id);
    let hojeDoReparo: string | null = null;
    const t = await executarTickDemurrage(deps(pool, {
      processarPosCommit: async (p, opts) => { hojeDoReparo = opts.hojeReferencia; return processarPosCommitOutboxPendentes(p, opts); },
    }), '2026-09-17'); // data deliberadamente ≠ relógio real: nenhuma etapa pode reler o relógio civil
    assert.equal(t.hoje, '2026-09-17');
    assert.equal(t.janela, '2026-09-17', 'tracking');
    assert.equal(hojeDoReparo, '2026-09-17', 'reparo');
    const { rows } = await pool.query(`SELECT DISTINCT data_final_apuracao FROM relogios`);
    assert.deepEqual(rows.map((r) => r.data_final_apuracao), ['2026-09-17'], 'calendário/recálculo apuraram com o mesmo hoje');
  } finally { await pool.end(); }
});

async function cenarioTracking(pool: Pool, comFilas: boolean) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket');
  await registrarProcessoDemurrage(contratoRegistro({
    organizationId: org.id, numeroProcesso: 'IM-TRK', containers: [containerContrato(numeroContainer('TRKA', 1))],
    mbl: o('MBLTRK1', 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(10, 'house_document', T), masterFreeTimeDays: o(10, 'master_bl', T),
  }), { pool, hojeReferencia: HOJE });
  if (comFilas) {
    // Trabalho das duas filas numa OUTRA organização, sem MBL (sem target de tracking).
    const outra = await new OrganizationRepository(pool).create('Outra', 'outra');
    await registroComPosCommitFalho(pool, outra.id, 'FILA');
    const analista = await membership(pool, outra.id, 'ANALYST', 'a@outra.example');
    await membership(pool, outra.id, 'MANAGER', 'g@outra.example');
    await registroComFallback(pool, outra.id, analista, 'FILB');
  }
  const contador = portContador();
  const t = await executarTickDemurrage({ pool, port: contador.port, transport: alertasOk, workerId: 'w', fallbackAvisoTransport: transportFake().t }, HOJE);
  const claims = (await pool.query(`SELECT t.reference_value_canonical AS ref, c.janela, c.status, c.tentativas FROM tracking_schedule_claims c JOIN tracking_targets t ON t.id = c.tracking_target_id ORDER BY 1`)).rows;
  const fetches = (await pool.query(`SELECT count(*)::int n FROM tracking_fetches`)).rows[0].n;
  return { t, chamadas: contador.chamadas, claims, fetches };
}

test('v1.3 #14: cadência, claims e consumo de tracking idênticos com e sem trabalho nas novas filas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const sem = await cenarioTracking(pool, false);
    const com = await cenarioTracking(pool, true);
    assert.ok(sem.chamadas.length >= 1, 'o cenário consulta tracking (comparação não é vazia)');
    assert.deepEqual(com.chamadas, sem.chamadas, 'mesmas consultas ao armador (mesmo consumo de créditos)');
    assert.deepEqual(com.claims, sem.claims, 'mesmos claims de janela');
    assert.equal(com.fetches, sem.fetches, 'mesmos fetches');
    for (const k of ['janela', 'avaliados', 'naJanela', 'sincronizados', 'suspensos'] as const) {
      assert.equal(com.t[k], sem.t[k], `indicador ${k} inalterado`);
    }
    assert.equal(com.t.posCommit.reparados, 1, 'no cenário com filas, o reparo aconteceu');
    assert.equal(com.t.avisosFallback.enviadas, 1, 'no cenário com filas, o aviso saiu');

    // As etapas de manutenção, sozinhas, não tocam nenhuma tabela de tracking.
    const snap = async () => (await pool.query(
      `SELECT (SELECT count(*) FROM tracking_schedule_claims)::int c, (SELECT count(*) FROM tracking_fetches)::int f,
              (SELECT count(*) FROM tracking_targets)::int t, (SELECT count(*) FROM tracking_events)::int e`)).rows[0];
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente'`);
    const antes = await snap();
    await processarPosCommitOutboxPendentes(pool, { hojeReferencia: HOJE, workerId: 'x', limite: 50 });
    assert.deepEqual(await snap(), antes);
  } finally { await pool.end(); }
});

test('v1.3 #15: os novos contadores aparecem no resultado e no log do tick; limite por ciclo respeitado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    await registroComPosCommitFalho(pool, org.id, 'CNTA');
    await registroComPosCommitFalho(pool, org.id, 'CNTB');
    await registroComPosCommitFalho(pool, org.id, 'CNTC');
    const analista = await membership(pool, org.id, 'ANALYST', 'a@rocket.example');
    await membership(pool, org.id, 'MANAGER', 'g@rocket.example');
    await registroComFallback(pool, org.id, analista);
    const t = await executarTickDemurrage(deps(pool, {
      fallbackAvisoTransport: transportFake().t, limites: { posCommit: 2, avisosFallback: 10 },
    }), HOJE);
    assert.deepEqual(Object.keys(t.posCommit).sort(), ['erro', 'falhos', 'possePerdida', 'reivindicados', 'reparados', 'restantes']);
    assert.deepEqual(Object.keys(t.avisosFallback).sort(), ['enviadas', 'erro', 'esgotadas', 'falhadas', 'possePerdida', 'reivindicadas', 'restantes', 'semTransporte']);
    assert.equal(t.posCommit.reivindicados, 2, 'limite por ciclo');
    assert.equal(t.posCommit.restantes, 1, '3 falhos − 2 do limite (o registro com fallback já se reparou sozinho)');
    const log = formatarLogTick(t);
    assert.match(log, /registro-posCommit: reivindicados=2 reparados=2 falhos=0 possePerdida=0 restantes=1/);
    assert.match(log, /avisos-fallback: reivindicadas=1 enviadas=1 falhadas=0 possePerdida=0 restantes=0 esgotadas=0/);
    assert.match(log, /calendário=\d+ avaliados=\d+/, 'indicadores pré-existentes preservados no log');

    // Próximo tick drena o restante.
    const t2 = await executarTickDemurrage(deps(pool, { fallbackAvisoTransport: transportFake().t, limites: { posCommit: 2 } }), HOJE);
    assert.equal(t2.posCommit.reparados, 1);
    assert.equal(t2.posCommit.restantes, 0);

    // Sem transporte configurado: a etapa não falha, e sinaliza.
    const t3 = await executarTickDemurrage(deps(pool), HOJE);
    assert.equal(t3.avisosFallback.semTransporte, true);
  } finally { await pool.end(); }
});
