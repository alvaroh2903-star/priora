import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { OrganizationRole } from '../domain/types';
import { AvisoPendencia, AvisoPendenciaTransport } from '../registro/notificacaoPendencia';
import { ArmadorTrackingPort } from '../sources/armadorTrackingSource';
import { AlertTransport } from '../scheduler/alertOutbox';
import { startSchedulerLoop } from '../scheduler/schedulerLoop';
import { executarTickDemurrage, formatarLogTick, TickDeps, TickResultado } from '../../demurrage/schedulerBootstrap';
import { montarEmailAvisoPendencia } from '../../demurrage/avisoPendenciaTransportGraph';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { containerContrato, contratoRegistro, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/**
 * Fase D15-B v1.1 (corretiva) — ligação operacional: a fila de avisos de
 * PENDÊNCIA (`demurrage_pendencia_avisos`, R07/R08) passa a ser consumida
 * AUTOMATICAMENTE pelo tick do scheduler, em etapa própria e isolada, com o
 * papel do destinatário revalidado NO INSTANTE do envio (nunca o papel de
 * quando a entrega nasceu). Mesmo protocolo (claim/posse, SKIP LOCKED,
 * token, retry limitado) já aprovado para `demurrage_fallback_manual_avisos`
 * — ver `demurrageTickFilas.test.ts`, de onde este arquivo deriva seus
 * helpers e convenções de teste.
 */

const url = testDatabaseUrl();
const HOJE = '2026-09-20';
const T_DISCHARGE = '2026-09-10T00:00:00Z';

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

interface Cenario {
  orgId: string;
  processoId: string;
  containerId: string;
  mGestor: string;
  mClient: string;
  uGestorId: string;
}

async function membership(pool: Pool, orgId: string, papel: OrganizationRole, email: string): Promise<{ membershipId: string; usuarioId: string }> {
  const u = await new UsuarioRepository(pool).create(`Pessoa ${email}`, email);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { membershipId: m.id, usuarioId: u.id };
}

async function cenario(pool: Pool, slug: string): Promise<Cenario> {
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const resp = await membership(pool, org.id, 'ANALYST', `resp-${slug}@x.com`);
  const gestor = await membership(pool, org.id, 'MANAGER', `gestor-${slug}@x.com`);
  const cliente = await membership(pool, org.id, 'CLIENT', `cliente-${slug}@x.com`);
  const processo = await new ProcessoRepository(pool).create({
    organizationId: org.id, numeroProcesso: `D15BV11-${slug}`, clienteId: null, responsavelOperacionalMembershipId: resp.membershipId,
  });
  const container = await new ContainerRepository(pool).create(org.id, processo.id, 'D15BV1234567');
  return {
    orgId: org.id, processoId: processo.id, containerId: container.id,
    mGestor: gestor.membershipId, mClient: cliente.membershipId, uGestorId: gestor.usuarioId,
  };
}

/** R07/31.4d: fonte mais forte sobre `manual_fallback` vigente — abre `fallback_manual_superado` + aviso. */
async function dispararR07(pool: Pool, s: Cenario) {
  const containers = new ContainerRepository(pool);
  const manual = await containers.applyObservation({
    containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'manual_fallback',
    observadoEm: new Date('2026-08-01T00:00:00Z'), evidenciaRef: 'confirmado por telefone', criadoPor: s.uGestorId,
  });
  assert.equal(manual.outcome, 'promovida');
  const r = await containers.applyObservation({
    containerId: s.containerId, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 20, fonte: 'house_document',
    observadoEm: new Date('2026-08-05T00:00:00Z'),
  });
  assert.equal(r.outcome, 'bloqueada_fallback_manual', 'pré-condição do cenário: R07 disparado');
}

/** R08/31.5: Empty Return antes da descarga — abre `retorno_vazio_antes_descarga` + aviso ATIVO. */
async function dispararR08(pool: Pool, s: Cenario) {
  const containers = new ContainerRepository(pool);
  await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'dischargeDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date(T_DISCHARGE) });
  const r = await containers.applyObservation({ containerId: s.containerId, organizationId: s.orgId, campo: 'trackingReturnDate', valor: '2026-09-05', fonte: 'tracking_service', observadoEm: new Date('2026-09-05T00:00:00Z') });
  assert.equal(r.outcome, 'bloqueada_cronologia', 'pré-condição do cenário: R08 disparado');
}

const avisosPendencia = async (pool: Pool) =>
  (await pool.query(
    `SELECT a.id, a.destinatario_membership_id, a.status, a.tentativas, a.claim_token, a.erro, p.tipo
       FROM demurrage_pendencia_avisos a JOIN demurrage_pendencias p ON p.id = a.pendencia_id
      ORDER BY a.criado_em, a.destinatario_membership_id`,
  )).rows;

/** Porta de tracking que só CONTA chamadas (nenhuma consulta real, nenhum crédito). */
function portContador() {
  const chamadas: string[] = [];
  const port: ArmadorTrackingPort = {
    async enrich(ref) { chamadas.push(ref); return resultadoTracking({ reference: ref }); },
  };
  return { port, chamadas };
}
const alertasOk: AlertTransport = { async enviar() { return { ok: true } as any; } };

function transportFake(comportamento: (a: AvisoPendencia) => Promise<{ ok: boolean; erro?: string }> = async () => ({ ok: true })) {
  const enviados: AvisoPendencia[] = [];
  const t: AvisoPendenciaTransport = { async enviar(a) { enviados.push(a); return comportamento(a); } };
  return { t, enviados };
}

function deps(pool: Pool, extra: Partial<TickDeps> = {}): TickDeps {
  return { pool, port: portContador().port, transport: alertasOk, workerId: 'tick-teste', ...extra };
}

/* ================================================================== *
 * Envio automático — sem chamada manual ao serviço
 * ================================================================== */

test('v1.1 #1: aviso PENDING de R07 é enviado automaticamente pelo tick do scheduler, sem nenhuma chamada manual ao serviço', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's1');
    await dispararR07(pool, s);
    assert.ok((await avisosPendencia(pool)).every((a) => a.status === 'PENDING'), 'nasce PENDING, nunca enviado pelo registro');

    const fake = transportFake();
    // A ÚNICA ação do teste a partir daqui é rodar o tick — nenhuma chamada
    // direta a `processarAvisosPendenciaPendentes` em parte alguma deste arquivo.
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);

    assert.equal(t.avisosPendencia.reivindicadas, 1);
    assert.equal(t.avisosPendencia.enviadas, 1);
    assert.equal(t.avisosPendencia.restantes, 0);
    assert.equal(fake.enviados.length, 1);
    assert.equal(fake.enviados[0].tipo, 'fallback_manual_superado');
    const avisos = await avisosPendencia(pool);
    assert.equal(avisos[0].status, 'SENT');

    const email = montarEmailAvisoPendencia(fake.enviados[0]);
    for (const proibido of [fake.enviados[0].entregaId, fake.enviados[0].pendenciaId, fake.enviados[0].organizationId, 'claim', 'token']) {
      assert.ok(!email.body.includes(proibido) && !email.subject.includes(proibido), `e-mail não pode conter ${proibido}`);
    }
  } finally { await pool.end(); }
});

test('v1.1 #2: aviso PENDING de R08 é enviado automaticamente pelo tick do scheduler, sem nenhuma chamada manual ao serviço', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's2');
    await dispararR08(pool, s);
    assert.ok((await avisosPendencia(pool)).every((a) => a.status === 'PENDING'));

    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);

    assert.equal(t.avisosPendencia.reivindicadas, 1);
    assert.equal(t.avisosPendencia.enviadas, 1);
    assert.equal(fake.enviados[0].tipo, 'retorno_vazio_antes_descarga');
    assert.equal((await avisosPendencia(pool))[0].status, 'SENT');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Transporte indisponível — retry limitado
 * ================================================================== */

test('v1.1 #3 e #4: transporte indisponível deixa a entrega retentável; o tick seguinte reenvia com sucesso', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's3');
    await dispararR07(pool, s);

    const fora = transportFake(async () => ({ ok: false, erro: 'sem_token_graph' }));
    const t1 = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fora.t }), HOJE);
    assert.equal(t1.avisosPendencia.falhadas, 1);
    assert.equal(t1.avisosPendencia.restantes, 1, 'continua entregável');
    const a1 = (await avisosPendencia(pool))[0];
    assert.equal(a1.status, 'FAILED');
    assert.equal(a1.claim_token, null, 'posse liberada');
    assert.equal(a1.erro, 'sem_token_graph');

    // Canal que LANÇA também não trava a entrega.
    const quebra = transportFake(async () => { throw new Error('Graph 503'); });
    const t2 = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: quebra.t }), '2026-09-21');
    assert.equal(t2.avisosPendencia.falhadas, 1);
    assert.equal((await avisosPendencia(pool))[0].status, 'FAILED');

    const ok = transportFake();
    const t3 = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: ok.t }), '2026-09-22');
    assert.equal(t3.avisosPendencia.enviadas, 1);
    const a3 = (await avisosPendencia(pool))[0];
    assert.equal(a3.status, 'SENT');
    assert.equal(a3.tentativas, 3);
  } finally { await pool.end(); }
});

test('v1.1 #4b: máximo de tentativas — entrega esgotada não é mais reivindicada e aparece como esgotada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's3b');
    await dispararR08(pool, s);
    await pool.query(`UPDATE demurrage_pendencia_avisos SET status = 'FAILED', tentativas = 5, erro = 'x'`);
    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);
    assert.equal(t.avisosPendencia.reivindicadas, 0);
    assert.equal(t.avisosPendencia.esgotadas, 1);
    assert.equal(t.avisosPendencia.restantes, 0);
    assert.equal(fake.enviados.length, 0);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Concorrência, fencing e lease
 * ================================================================== */

test('v1.1 #5: dois ticks CONCORRENTES nunca enviam a mesma entrega duas vezes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's4');
    await dispararR07(pool, s);
    const fake = transportFake(async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true }; });
    const [a, b] = await Promise.all([
      executarTickDemurrage(deps(pool, { workerId: 'instancia-A', avisoPendenciaTransport: fake.t }), HOJE),
      executarTickDemurrage(deps(pool, { workerId: 'instancia-B', avisoPendenciaTransport: fake.t }), HOJE),
    ]);
    assert.equal(fake.enviados.length, 1, 'uma única entrega para o gestor — uma única mensagem');
    assert.equal(a.avisosPendencia.enviadas + b.avisosPendencia.enviadas, 1);
    assert.equal(a.avisosPendencia.reivindicadas + b.avisosPendencia.reivindicadas, 1);
    assert.equal(a.avisosPendencia.possePerdida + b.avisosPendencia.possePerdida, 0);
  } finally { await pool.end(); }
});

test('v1.1 #6 e #7: lease vencido é recuperado; o worker antigo não finaliza depois de perder a posse', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's5');
    await dispararR07(pool, s);

    let liberar!: () => void;
    const portao = new Promise<void>((r) => { liberar = r; });
    let aEnviando = false;
    const lenta = transportFake(async () => { aEnviando = true; await portao; return { ok: false, erro: 'timeout tardio' }; });
    const a = executarTickDemurrage(deps(pool, { workerId: 'antiga', avisoPendenciaTransport: lenta.t }), HOJE);
    for (let i = 0; i < 500 && !aEnviando; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(aEnviando, 'a entrega já foi reivindicada e o transporte está em curso');

    // Lease vencido (worker "morto") — o próximo tick recupera.
    await pool.query(`UPDATE demurrage_pendencia_avisos SET expira_em = now() - interval '1 second'`);
    const nova = transportFake();
    const b = await executarTickDemurrage(deps(pool, { workerId: 'nova', avisoPendenciaTransport: nova.t }), HOJE);
    assert.equal(b.avisosPendencia.enviadas, 1, 'o lease vencido foi recuperado e a entrega enviada');

    liberar();
    const ra = await a;
    assert.equal(ra.avisosPendencia.possePerdida, 1, 'o worker antigo não finaliza — perdeu a posse (fencing pelo claim_token)');
    assert.equal((await avisosPendencia(pool))[0].status, 'SENT', 'o SENT do novo dono prevalece, nunca sobrescrito pelo FAILED tardio');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Papel do destinatário revalidado no envio
 * ================================================================== */

test('v1.1 #8: destinatário rebaixado a CLIENT entre o nascimento da entrega e o tick nunca recebe a notificação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's6');
    await dispararR07(pool, s);
    assert.deepEqual((await avisosPendencia(pool)).map((a) => a.destinatario_membership_id), [s.mGestor], 'entrega criada só para o gestor, no momento em que ele ERA gestor');

    // O ÚNICO gestor da organização é rebaixado a CLIENT antes do tick rodar.
    await pool.query(`UPDATE organization_memberships SET papel = 'CLIENT' WHERE id = $1`, [s.mGestor]);

    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);
    assert.equal(fake.enviados.length, 0, 'nenhum envio a um CLIENT');
    assert.equal(t.avisosPendencia.reivindicadas, 0, 'nunca reivindicada — o papel é lido no instante do claim, não no instante em que a entrega nasceu');
    assert.equal((await avisosPendencia(pool))[0].status, 'PENDING', 'fica pendente, nunca marcada como enviada');

    // Restituído a gestor — o PRÓXIMO tick entrega normalmente, sem intervenção manual.
    await pool.query(`UPDATE organization_memberships SET papel = 'MANAGER' WHERE id = $1`, [s.mGestor]);
    const t2 = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), '2026-09-21');
    assert.equal(t2.avisosPendencia.enviadas, 1);
    assert.equal((await avisosPendencia(pool))[0].status, 'SENT');
  } finally { await pool.end(); }
});

test('v1.1 #8b: linha forjada para um destinatário que SEMPRE foi CLIENT nunca é reivindicada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's6b');
    await dispararR07(pool, s);
    const { rows: [p] } = await pool.query(`SELECT id FROM demurrage_pendencias WHERE processo_id = $1 AND tipo = 'fallback_manual_superado' LIMIT 1`, [s.processoId]);
    await pool.query(`INSERT INTO demurrage_pendencia_avisos (organization_id, pendencia_id, destinatario_membership_id) VALUES ($1,$2,$3)`, [s.orgId, p.id, s.mClient]);

    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);
    assert.equal(t.avisosPendencia.reivindicadas, 1, 'só a entrega do gestor');
    assert.equal(fake.enviados.length, 1);
    assert.equal(fake.enviados[0].destinatarioEmail?.includes('cliente-') ?? false, false, 'nunca o e-mail do cliente');
    assert.ok((await avisosPendencia(pool)).find((a) => a.destinatario_membership_id === s.mClient)?.status === 'PENDING', 'a linha do CLIENT nunca sai de PENDING');
  } finally { await pool.end(); }
});

test('v1.1 #9: membership removido (defesa em profundidade) não derruba o tick — a entrega nunca é reivindicada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's7');
    await dispararR07(pool, s);
    assert.equal((await avisosPendencia(pool)).length, 1);

    // Remove o membership gestor na força (defesa em profundidade — a mesma
    // técnica já usada em `responsavelOperacional.test.ts` para provar que a
    // FK ainda barra mesmo com a trava desligada): dropamos a FK que, em uso
    // normal, torna este caminho inatingível, só para provar que o código de
    // leitura/claim não lança caso ele um dia deixe de existir.
    await pool.query(`ALTER TABLE demurrage_pendencia_avisos DROP CONSTRAINT demurrage_pendencia_avisos_membership_org_fk`);
    try {
      await pool.query(`DELETE FROM organization_memberships WHERE id = $1`, [s.mGestor]);

      const fake = transportFake();
      // A asserção central: o tick INTEIRO completa sem lançar.
      const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);
      assert.equal(t.avisosPendencia.erro, null, 'a etapa não falhou');
      assert.equal(t.avisosPendencia.reivindicadas, 0, 'o JOIN com organization_memberships não casa — nunca reivindicada');
      assert.equal(fake.enviados.length, 0);
      assert.equal(t.janela, HOJE, 'tracking rodou normalmente');
    } finally {
      // A linha cujo destinatário foi removido ficou órfã de propósito (é o
      // próprio cenário do teste) — descartada antes de restaurar a FK, que
      // senão rejeitaria a readição por violar a restrição nos dados já
      // existentes. Restaura a integridade referencial para o resto da suíte.
      await pool.query(`DELETE FROM demurrage_pendencia_avisos WHERE destinatario_membership_id NOT IN (SELECT id FROM organization_memberships)`);
      await pool.query(
        `ALTER TABLE demurrage_pendencia_avisos ADD CONSTRAINT demurrage_pendencia_avisos_membership_org_fk
           FOREIGN KEY (destinatario_membership_id, organization_id) REFERENCES organization_memberships (id, organization_id)`,
      );
    }
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Isolamento entre entregas e entre etapas do tick
 * ================================================================== */

test('v1.1 #10: uma notificação que FALHA não bloqueia as demais, nem nenhuma etapa pré-existente do tick', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s1 = await cenario(pool, 's8a');
    const s2 = await cenario(pool, 's8b');
    await dispararR07(pool, s1);
    await dispararR08(pool, s2);
    assert.equal((await avisosPendencia(pool)).length, 2);

    let chamada = 0;
    const misto = transportFake(async () => { chamada++; return chamada === 1 ? { ok: false, erro: 'falha na primeira' } : { ok: true }; });
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: misto.t }), HOJE);
    assert.equal(t.avisosPendencia.reivindicadas, 2);
    assert.equal(t.avisosPendencia.falhadas, 1);
    assert.equal(t.avisosPendencia.enviadas, 1, 'a segunda entrega foi enviada mesmo com a primeira falhando');
    assert.equal(t.janela, HOJE, 'tracking rodou');
    assert.ok(t.calendario >= 0, 'calendário rodou');
  } finally { await pool.end(); }
});

test('v1.1 #11: falha da ETAPA INTEIRA de avisos de pendência não interrompe o laço do scheduler nem as demais etapas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's9');
    await dispararR07(pool, s);
    const resultados: TickResultado[] = [];
    const erros: unknown[] = [];
    const loop = startSchedulerLoop({
      tick: async () => {
        resultados.push(await executarTickDemurrage(deps(pool, {
          avisoPendenciaTransport: transportFake().t,
          processarAvisosPendencia: async () => { throw new Error('etapa de avisos de pendência quebrou'); },
        }), HOJE));
      },
      runOnStart: false, intervalMs: 10_000_000, onError: (e) => erros.push(e),
    });
    await loop.runNow();
    loop.stop();
    assert.equal(erros.length, 0, 'nenhum erro chegou ao laço');
    assert.equal(resultados.length, 1);
    assert.match(resultados[0].avisosPendencia.erro ?? '', /etapa de avisos de pendência quebrou/);
    assert.equal(resultados[0].janela, HOJE, 'tracking rodou apesar da etapa quebrada');
    assert.ok(resultados[0].calendario >= 0, 'calendário rodou apesar da etapa quebrada');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Nenhum impacto em cadência, claims, fetches ou créditos
 * ================================================================== */

async function cenarioTracking(pool: Pool, comAvisos: boolean) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  const org = await new OrganizationRepository(pool).create('Rocket', 'rocket-v11');
  await registrarProcessoDemurrage(contratoRegistro({
    organizationId: org.id, numeroProcesso: 'IM-TRKV11', containers: [containerContrato(numeroContainer('TRKV', 1))],
    mbl: o('MBLTRKV11', 'master_bl', T_DISCHARGE), armador: o('MAERSK', 'shipping_instructions', T_DISCHARGE),
    houseFreeTimeDays: o(10, 'house_document', T_DISCHARGE), masterFreeTimeDays: o(10, 'master_bl', T_DISCHARGE),
  }), { pool, hojeReferencia: HOJE });
  if (comAvisos) {
    // Trabalho da nova fila numa OUTRA organização, sem MBL (sem target de tracking) — igual ao v1.3 #14.
    const outra = await cenario(pool, 'trkv11-outra');
    await dispararR07(pool, outra);
  }
  const contador = portContador();
  const t = await executarTickDemurrage({ pool, port: contador.port, transport: alertasOk, workerId: 'w', avisoPendenciaTransport: transportFake().t }, HOJE);
  const claims = (await pool.query(`SELECT t.reference_value_canonical AS ref, c.janela, c.status, c.tentativas FROM tracking_schedule_claims c JOIN tracking_targets t ON t.id = c.tracking_target_id ORDER BY 1`)).rows;
  const fetches = (await pool.query(`SELECT count(*)::int n FROM tracking_fetches`)).rows[0].n;
  return { t, chamadas: contador.chamadas, claims, fetches };
}

test('v1.1 #12: a nova fila produz ZERO fetches, ZERO claims e ZERO consumo adicional de crédito de tracking', { skip: !url }, async () => {
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
    assert.equal(com.t.avisosPendencia.enviadas, 1, 'no cenário com avisos, o aviso saiu');

    // A etapa, sozinha, não toca nenhuma tabela de tracking.
    const snap = async () => (await pool.query(
      `SELECT (SELECT count(*) FROM tracking_schedule_claims)::int c, (SELECT count(*) FROM tracking_fetches)::int f,
              (SELECT count(*) FROM tracking_targets)::int t, (SELECT count(*) FROM tracking_events)::int e`)).rows[0];
    await pool.query(`UPDATE demurrage_pendencia_avisos SET status = 'PENDING', claim_token = NULL, worker_id = NULL, expira_em = NULL`);
    const antes = await snap();
    const { processarAvisosPendenciaPendentes } = await import('../registro/notificacaoPendencia');
    await processarAvisosPendenciaPendentes({ pool, transport: transportFake().t, workerId: 'x', limite: 50 });
    assert.deepEqual(await snap(), antes);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Limite por ciclo e contadores no log
 * ================================================================== */

test('v1.1 #13: limite de 50 por ciclo (padrão) é respeitado; os contadores aparecem no resultado e no log do tick', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's10');
    await dispararR07(pool, s);
    const fake = transportFake();
    const t = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t, limites: { avisosPendencia: 0 } }), HOJE);
    assert.equal(t.avisosPendencia.reivindicadas, 0, 'limite 0 — nada reivindicado neste ciclo');
    assert.equal(t.avisosPendencia.restantes, 1);

    const t2 = await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: fake.t }), HOJE);
    assert.equal(t2.avisosPendencia.reivindicadas, 1, 'limite padrão (50) é suficiente para esta carga');
    assert.deepEqual(Object.keys(t2.avisosPendencia).sort(), ['enviadas', 'erro', 'esgotadas', 'falhadas', 'possePerdida', 'reivindicadas', 'restantes', 'semTransporte']);
    const log = formatarLogTick(t2);
    assert.match(log, /avisos-pendencia: reivindicadas=1 enviadas=1 falhadas=0 possePerdida=0 restantes=0 esgotadas=0/);

    // Sem transporte configurado: a etapa não falha, e sinaliza.
    const outro = await cenario(pool, 's10b');
    await dispararR08(pool, outro);
    const t3 = await executarTickDemurrage(deps(pool), HOJE);
    assert.equal(t3.avisosPendencia.semTransporte, true);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Nenhum envio externo dentro de uma transação de banco
 * ================================================================== */

test('v1.1 #14: o claim já está COMMITADO (visível a outra conexão) quando o transporte é chamado — nenhum envio dentro de uma transação', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, 's11');
    await dispararR07(pool, s);

    let statusDuranteEnvio: string | null = null;
    let tentativasDuranteEnvio: number | null = null;
    const espiao: AvisoPendenciaTransport = {
      async enviar(a) {
        // Consulta por OUTRA via (pool: pode ser outra conexão física) — sob
        // READ COMMITTED, só vê o claim se ele já tiver sido COMMITADO.
        const { rows } = await pool.query(`SELECT status, tentativas FROM demurrage_pendencia_avisos WHERE id = $1`, [a.entregaId]);
        statusDuranteEnvio = rows[0]?.status ?? null;
        tentativasDuranteEnvio = rows[0]?.tentativas ?? null;
        return { ok: true };
      },
    };
    await executarTickDemurrage(deps(pool, { avisoPendenciaTransport: espiao }), HOJE);
    assert.equal(statusDuranteEnvio, 'PROCESSING', 'o UPDATE do claim já estava commitado quando o transporte foi chamado');
    assert.equal(tentativasDuranteEnvio, 1);
    assert.equal((await avisosPendencia(pool))[0].status, 'SENT', 'e a finalização aconteceu normalmente depois do envio');
  } finally { await pool.end(); }
});
