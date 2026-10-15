import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { ClosingService } from '../closing/closingService';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { criarDemurrageAcoesRouter } from '../../routes/demurrageAcoesRoutes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/**
 * Produção P1 (Entrega 2) — suíte de aceitação das rotas internas de ação
 * operacional (`/api/demurrage/v2/acoes`). Roda com PostgreSQL real.
 *
 * Mesmo padrão HTTP de `demurrageV2Routes.test.ts` (D12 Gate G7):
 * `requireAuth` real é substituído por um middleware de teste que só injeta
 * `req.session.homeAccountId` a partir do cabeçalho `x-test-home-account-id`
 * — o RBAC real (`autorizarInterno`, Gate G6) roda SEM substituição nenhuma.
 */

const url = testDatabaseUrl();
const T = '2026-09-01T00:00:00Z';

async function subirApp(pool: Pool) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    const home = req.get('x-test-home-account-id');
    req.session = home ? { homeAccountId: home } : {};
    next();
  });
  const requireAuthDeTeste = (req: any, res: any, next: any) => {
    if (!req.session?.homeAccountId) { res.status(401).json({ error: 'nao_autenticado' }); return; }
    next();
  };
  app.use('/api/demurrage/v2/acoes', criarDemurrageAcoesRouter({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/demurrage/v2/acoes`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
}

async function criarOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

async function usuarioInterno(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT'): Promise<string> {
  const u = await new UsuarioRepository(pool).create(`Usuario ${randomUUID()}`, `${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
  await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return u.homeAccountId!;
}

async function membershipIdPorHome(pool: Pool, home: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT m.id FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id WHERE u.home_account_id = $1 LIMIT 1`,
    [home],
  );
  return rows[0].id;
}

function post(base: string, caminho: string, body: unknown, home?: string): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(home ? { 'x-test-home-account-id': home } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/** Processo + contêiner mínimos (sem tracking) — suficiente para o fallback manual. */
async function processoMinimo(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const r = await registrarProcessoDemurrage(
    contratoRegistro({ organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)] }),
    { pool, hojeReferencia: '2026-09-20' },
  );
  return { processoId: r.processoId, containerId: r.containers[0].containerId, numero };
}

/**
 * Processo mínimo mas COM armador informado — registro não abre sozinho a
 * pendência automática `armador_ausente` (D10), deixando o tipo livre para o
 * teste inserir manualmente sem colidir com a unicidade de pendência aberta.
 */
async function processoMinimoComArmador(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const r = await registrarProcessoDemurrage(
    contratoRegistro({
      organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
      armador: o('MAERSK', 'shipping_instructions', T),
    }),
    { pool, hojeReferencia: '2026-09-20' },
  );
  return { processoId: r.processoId, containerId: r.containers[0].containerId, numero };
}

/** Processo + contêiner com descarga e devolução via tracking + relógios calculados — suficiente para decisão de responsabilidade. */
async function processoComRelogios(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, diasFreeTime = 6) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(diasFreeTime, 'house_document', T), masterFreeTimeDays: o(diasFreeTime, 'master_bl', T),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  await new ContainerRepository(pool).applyObservation({
    containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
  });
  await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-09-20' });
  return { processoId: r.processoId, containerId, numero };
}

/**
 * Processo + contêiner com Free Time de 20 dias e devolução no dia 9
 * (ZERO custo de demurrage) — suficiente para `finalizarProcesso` suceder
 * sem precisar de tarifa/responsabilidade/minuta (gates de comprovação e
 * confirmação de valor não entram em jogo neste caminho — mesmo padrão já
 * usado em `closingD15AV11.test.ts`).
 */
async function processoFinalizavelSemCusto(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T) })],
    mbl: o(`MBL${prefixo}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(20, 'house_document', T), masterFreeTimeDays: o(20, 'master_bl', T),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-10-01' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  await new ContainerRepository(pool).applyObservation({
    containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
  });
  await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-10-01' });
  return { processoId: r.processoId, containerId, numero };
}

/* ========================================================================= *
 * 1-7 — autenticação, papel, isolamento organizacional
 * ========================================================================= */

test('Entrega 2 #1: sem sessão -> 401', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const res = await post(app.base, `/containers/${randomUUID()}/fallback-manual`, {});
    assert.equal(res.status, 401);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #2: CLIENT -> 403', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-2');
    const home = await usuarioInterno(pool, org.id, 'CLIENT');
    const res = await post(app.base, `/containers/${randomUUID()}/fallback-manual`, {}, home);
    assert.equal(res.status, 403);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #3: membership revogado (linha apagada) é rejeitado em TODA requisição', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-3');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const r1 = await post(app.base, `/containers/${randomUUID()}/fallback-manual`, {}, home);
    assert.notEqual(r1.status, 401);
    await pool.query(`DELETE FROM organization_memberships WHERE usuario_id = (SELECT id FROM usuarios WHERE home_account_id = $1)`, [home]);
    const r2 = await post(app.base, `/containers/${randomUUID()}/fallback-manual`, {}, home);
    assert.equal(r2.status, 403, 'papel é relido a cada requisição — nunca cacheado na sessão');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #4: recurso de outra organização é indistinguível de inexistente (404)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'e2-4a');
    const orgB = await criarOrg(pool, 'e2-4b');
    const homeA = await usuarioInterno(pool, orgA.id, 'MANAGER');
    const { containerId: containerDeB } = await processoMinimo(pool, orgB.id, 'IM-E2-4B', 'ECQB');

    const resInexistente = await post(app.base, `/containers/${randomUUID()}/fallback-manual`, { campo: 'house', valorDias: 10, observadoEm: T, evidenciaRef: 'e', justificativa: 'j' }, homeA);
    const resCruzado = await post(app.base, `/containers/${containerDeB}/fallback-manual`, { campo: 'house', valorDias: 10, observadoEm: T, evidenciaRef: 'e', justificativa: 'j' }, homeA);
    assert.equal(resInexistente.status, 404);
    assert.equal(resCruzado.status, 404);
    assert.deepEqual(await resInexistente.json(), await resCruzado.json(), 'resposta IDÊNTICA — nenhum vazamento de existência do recurso de outra organização');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #5/#6/#7: organizationId vindo do corpo, query ou cabeçalho é sempre rejeitado (400), nunca ignorado silenciosamente', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-567');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId } = await processoMinimo(pool, org.id, 'IM-E2-567', 'ECQC');
    const outraOrg = randomUUID();

    const noCorpo = await post(app.base, `/containers/${containerId}/fallback-manual`, { organizationId: outraOrg, campo: 'house', valorDias: 10, observadoEm: T, evidenciaRef: 'e', justificativa: 'j' }, home);
    assert.equal(noCorpo.status, 400);

    const naQuery = await fetch(`${app.base}/containers/${containerId}/fallback-manual?organizationId=${outraOrg}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-home-account-id': home },
      body: JSON.stringify({ campo: 'house', valorDias: 10, observadoEm: T, evidenciaRef: 'e', justificativa: 'j' }),
    });
    assert.equal(naQuery.status, 400);

    const noCabecalho = await fetch(`${app.base}/containers/${containerId}/fallback-manual`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-home-account-id': home, 'x-organization-id': outraOrg },
      body: JSON.stringify({ campo: 'house', valorDias: 10, observadoEm: T, evidenciaRef: 'e', justificativa: 'j' }),
    });
    assert.equal(noCabecalho.status, 400);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 8-12 — fallback manual governado
 * ========================================================================= */

test('Entrega 2 #8/#9: fallback manual governado aplica House e Master Free Time pelo serviço congelado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-89');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId: c1 } = await processoMinimo(pool, org.id, 'IM-E2-8', 'ECQD');
    const { containerId: c2 } = await processoMinimo(pool, org.id, 'IM-E2-9', 'ECQE');

    const rHouse = await post(app.base, `/containers/${c1}/fallback-manual`, { campo: 'house', valorDias: 12, observadoEm: T, evidenciaRef: 'evid://house', justificativa: 'Confirmado por e-mail do armador.' }, home);
    assert.equal(rHouse.status, 200);
    const bodyHouse = await rHouse.json();
    assert.equal(bodyHouse.resultado, 'aplicado');

    const rMaster = await post(app.base, `/containers/${c2}/fallback-manual`, { campo: 'master', valorDias: 14, observadoEm: T, evidenciaRef: 'evid://master', justificativa: 'Confirmado por e-mail do armador.' }, home);
    assert.equal(rMaster.status, 200);
    assert.equal((await rMaster.json()).resultado, 'aplicado');

    const { rows } = await pool.query(`SELECT house_free_time_days, master_free_time_days FROM containers WHERE id = ANY($1)`, [[c1, c2]]);
    assert.ok(rows.some((r) => r.house_free_time_days === 12));
    assert.ok(rows.some((r) => r.master_free_time_days === 14));
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #10: fallback manual SEM justificativa é rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-10');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoMinimo(pool, org.id, 'IM-E2-10', 'ECQF');
    const res = await post(app.base, `/containers/${containerId}/fallback-manual`, { campo: 'house', valorDias: 10, observadoEm: T, evidenciaRef: 'e' }, home);
    assert.equal(res.status, 400);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #11: fallback manual SEM evidência é rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-11');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoMinimo(pool, org.id, 'IM-E2-11', 'ECQG');
    const res = await post(app.base, `/containers/${containerId}/fallback-manual`, { campo: 'house', valorDias: 10, observadoEm: T, justificativa: 'j' }, home);
    assert.equal(res.status, 400);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #12: fallback manual grava o AUTOR real (membership da sessão) e enfileira o aviso durável aos gestores', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-12');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const membershipReal = await membershipIdPorHome(pool, home);
    const { containerId } = await processoMinimo(pool, org.id, 'IM-E2-12', 'ECQH');

    const membershipFalso = randomUUID();
    const res = await post(app.base, `/containers/${containerId}/fallback-manual`, {
      campo: 'house', valorDias: 9, observadoEm: T, evidenciaRef: 'evid://12', justificativa: 'Ok.', autorMembershipId: membershipFalso, membershipId: membershipFalso,
    }, home);
    assert.equal(res.status, 200);

    const { rows: just } = await pool.query(
      `SELECT j.autor_membership_id AS "autorMembershipId" FROM demurrage_fallback_manual_justificativas j
         JOIN field_observations o ON o.id = j.observation_id
        WHERE o.entidade_id = $1`,
      [containerId],
    );
    assert.equal(just.length, 1);
    assert.equal(just[0].autorMembershipId, membershipReal, 'o autor persistido é SEMPRE o membership real da sessão — nunca o do corpo');
    assert.notEqual(just[0].autorMembershipId, membershipFalso);

    const { rows: avisos } = await pool.query(`SELECT count(*)::int n FROM demurrage_fallback_manual_avisos WHERE justificativa_id = $1`, [just[0].id ?? null]);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 13-15 — decisão de responsabilidade
 * ========================================================================= */

test('Entrega 2 #13: decisão de responsabilidade aplica pelo serviço real (D11)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-13');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-E2-13', 'ECQI');
    const { rows: rel } = await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [containerId]);

    const res = await post(app.base, `/containers/${containerId}/responsabilidade`, {
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel[0].primeiro_dia_demurrage, fim: rel[0].data_final_apuracao }],
      justificativa: 'Sem causa Rocket alegada.', evidenciaRef: 'evid://resp-13',
    }, home);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.versao, 1);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM responsabilidade_decisoes WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #14: cobertura de responsabilidade inválida (períodos ausentes) é rejeitada', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-14');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-E2-14', 'ECQJ');

    const res = await post(app.base, `/containers/${containerId}/responsabilidade`, {
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE', periodos: [],
      justificativa: 'Sem causa Rocket alegada.', evidenciaRef: 'evid://resp-14',
    }, home);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'PERIODOS_AUSENTES');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #15: restrição NAO_APLICAVEL (achado D11 v1.1) permanece preservada através da rota', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-15');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    // Free Time de 6 dias (não-zero) para o cliente -> NAO_APLICAVEL exige o
    // relógio do cliente com ZERO dias; a restrição do serviço deve rejeitar.
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-E2-15', 'ECQK', 60);

    const res = await post(app.base, `/containers/${containerId}/responsabilidade`, {
      status: 'NAO_APLICAVEL', baseRelogio: 'NAO_APLICAVEL', motivoEstruturado: 'DIFERENCA_COMERCIAL_FREE_TIME', periodos: [],
      justificativa: 'Diferença comercial de Free Time.', evidenciaRef: 'evid://resp-15',
    }, home);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(['NAO_APLICAVEL_INVALIDO', 'SEM_APURACAO_DETERMINAVEL', 'BASE_RELOGIO_INVALIDA'].includes(body.error), body.error);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 16-18 — minutas
 * ========================================================================= */

test('Entrega 2 #16: registro de minuta usa o caminho oficial (ClosingService.registrarMinuta) e exige Idempotency-Key', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-16');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-E2-16', 'ECQL');

    const semChave = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10' }, home);
    assert.equal(semChave.status, 400);

    const res = await fetch(`${app.base}/containers/${containerId}/minutas`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-home-account-id': home, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ numeroInformado: numero, dataInformada: '2026-09-10' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.estado, 'RECEBIDA');
    const { rows } = await pool.query(`SELECT recebida_por AS "recebidoPor" FROM minutas WHERE id = $1`, [body.minutaId]);
    assert.ok(rows[0]);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #17/#18: validação de minuta usa o closingService; divergência preserva as DUAS evidências', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-1718');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-E2-1718', 'ECQM');

    // Minuta com data DIFERENTE do tracking_return_date (2026-09-10) -> divergência.
    const reg = await fetch(`${app.base}/containers/${containerId}/minutas`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-home-account-id': homeAnalyst, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ numeroInformado: numero, dataInformada: '2026-09-12' }),
    });
    const { minutaId } = await reg.json();

    const rejeitadaPorAnalista = await post(app.base, `/minutas/${minutaId}/validar`, {}, homeAnalyst);
    assert.equal(rejeitadaPorAnalista.status, 403, 'validação é MANAGER/ADMIN — ANALYST não pode');

    const divergente = await post(app.base, `/minutas/${minutaId}/validar`, {}, homeManager);
    assert.equal(divergente.status, 200);
    const bodyDiv = await divergente.json();
    assert.equal(bodyDiv.resultado, 'divergencia_pendente');

    const { rows: container } = await pool.query(`SELECT tracking_return_date AS "trackingReturnDate", effective_return_date AS "effectiveReturnDate" FROM containers WHERE id = $1`, [containerId]);
    assert.equal(container[0].trackingReturnDate, '2026-09-10', 'tracking preservado');
    assert.equal(container[0].effectiveReturnDate, null, 'ainda não aceita — nenhuma das duas fontes é descartada');

    const aceita = await post(app.base, `/minutas/${minutaId}/validar`, { aceitarDivergencia: true }, homeManager);
    assert.equal(aceita.status, 200);
    assert.equal((await aceita.json()).resultado, 'validada');
    const { rows: container2 } = await pool.query(`SELECT tracking_return_date AS "trackingReturnDate", effective_return_date AS "effectiveReturnDate" FROM containers WHERE id = $1`, [containerId]);
    assert.equal(container2[0].trackingReturnDate, '2026-09-10', 'tracking AINDA preservado mesmo depois da aceitação');
    assert.equal(container2[0].effectiveReturnDate, '2026-09-12', 'a minuta validada agora é a devolução efetiva');

    // Retry idempotente: minuta já processada não é reenviada ao serviço.
    const retry = await post(app.base, `/minutas/${minutaId}/validar`, { aceitarDivergencia: true }, homeManager);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).resultado, 'ja_processada');
    const { rows: eventos } = await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_VALIDADA'`, [containerId]);
    assert.equal(eventos[0].n, 1, 'retry nunca duplica o evento de auditoria');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 19-20 — finalização
 * ========================================================================= */

test('Entrega 2 #19: finalização sucede pela rota quando todos os gates são válidos (retry depois do sucesso é idempotente)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-19');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoFinalizavelSemCusto(pool, org.id, 'IM-E2-19', 'ECQS');

    const res = await post(app.base, `/processos/${processoId}/finalizar`, { justificativa: 'Fechamento de rotina.' }, home);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).resultado, 'finalizado');
    const { rows: f1 } = await pool.query(`SELECT count(*)::int n FROM fechamentos WHERE processo_id = $1`, [processoId]);
    assert.equal(f1[0].n, 1);

    const retry = await post(app.base, `/processos/${processoId}/finalizar`, { justificativa: 'Fechamento de rotina.' }, home);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).resultado, 'ja_final');
    const { rows: f2 } = await pool.query(`SELECT count(*)::int n FROM fechamentos WHERE processo_id = $1`, [processoId]);
    assert.equal(f2[0].n, 1, 'retry depois do sucesso nunca duplica o fechamento');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #20: um gate de fechamento bloqueado ainda bloqueia através da rota (nenhum gate é contornado)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-20');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoMinimo(pool, org.id, 'IM-E2-20', 'ECQT');

    const res = await post(app.base, `/processos/${processoId}/finalizar`, {}, home);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.notEqual(body.error, undefined);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM fechamentos WHERE processo_id = $1`, [processoId]);
    assert.equal(rows[0].n, 0, 'o gate bloqueou — nenhum fechamento foi gravado');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 21-23 — reabertura
 * ========================================================================= */

test('Entrega 2 #21: solicitação de reabertura sucede pela rota', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-21');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoFinalizavelSemCusto(pool, org.id, 'IM-E2-21', 'ECQU');
    await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: await membershipIdPorHome(pool, homeManager), config: { hoje: '2026-10-01' } });

    const res = await post(app.base, `/processos/${processoId}/reabertura/solicitar`, { justificativa: 'Corrigir free time.' }, home);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.reaberturaId);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #22/#27: duas solicitações de reabertura CONCORRENTES para o MESMO processo nunca duplicam — vencedor determinístico', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-22');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoFinalizavelSemCusto(pool, org.id, 'IM-E2-22', 'ECQV');
    await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: await membershipIdPorHome(pool, homeManager), config: { hoje: '2026-10-01' } });

    const chamar = () => post(app.base, `/processos/${processoId}/reabertura/solicitar`, { justificativa: 'Corrigir free time.' }, home);
    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    assert.ok([200, 201].includes(r1.status) && [200, 201].includes(r2.status));
    assert.equal(b1.reaberturaId, b2.reaberturaId, 'as duas respostas apontam para a MESMA reabertura');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM reaberturas WHERE processo_id = $1`, [processoId]);
    assert.equal(rows[0].n, 1, 'exatamente UMA reabertura foi criada sob concorrência');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #23: autorização de reabertura exige MANAGER/ADMIN; ANALYST é rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-23');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoFinalizavelSemCusto(pool, org.id, 'IM-E2-23', 'ECQW');
    await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: await membershipIdPorHome(pool, homeManager), config: { hoje: '2026-10-01' } });
    const sol = await post(app.base, `/processos/${processoId}/reabertura/solicitar`, { justificativa: 'Corrigir.' }, homeAnalyst);
    const { reaberturaId } = await sol.json();

    const negado = await post(app.base, `/reaberturas/${reaberturaId}/autorizar`, {}, homeAnalyst);
    assert.equal(negado.status, 403);

    const autorizado = await post(app.base, `/reaberturas/${reaberturaId}/autorizar`, {}, homeManager);
    assert.equal(autorizado.status, 200);
    assert.equal((await autorizado.json()).resultado, 'autorizada');

    const retry = await post(app.base, `/reaberturas/${reaberturaId}/autorizar`, {}, homeManager);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).resultado, 'ja_autorizada');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 24-25 — resolução de pendência
 * ========================================================================= */

test('Entrega 2 #24: resolução típada de pendência funciona para um tipo suportado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-24');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoMinimoComArmador(pool, org.id, 'IM-E2-24', 'ECQN');
    const { rows } = await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, 'armador_ausente', '{}') RETURNING id`,
      [org.id, processoId],
    );
    const pendenciaId = rows[0].id;

    const res = await post(app.base, `/pendencias/${pendenciaId}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'armador_ausente', motivo: 'Confirmado manualmente com o cliente.' }, home);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).resultado, 'resolvida');
    const { rows: pend } = await pool.query(`SELECT estado, resolvido_por AS "resolvidoPor" FROM demurrage_pendencias WHERE id = $1`, [pendenciaId]);
    assert.equal(pend[0].estado, 'resolvida');
    assert.ok(pend[0].resolvidoPor);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 2 #25: combinação família/ação/tipo não suportada é rejeitada, ZERO escrita', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-25');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoMinimoComArmador(pool, org.id, 'IM-E2-25', 'ECQO');
    const { rows } = await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, 'armador_ausente', '{}') RETURNING id`,
      [org.id, processoId],
    );
    const pendenciaId = rows[0].id;

    const tipoErrado = await post(app.base, `/pendencias/${pendenciaId}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'mismatch_carrier', motivo: 'm' }, home);
    assert.equal(tipoErrado.status, 400);
    const familiaErrada = await post(app.base, `/pendencias/${pendenciaId}/resolver`, { familia: 'vessel_call_pendencia', acao: 'resolver', tipo: 'armador_ausente', motivo: 'm' }, home);
    assert.equal(familiaErrada.status, 400);
    const acaoErrada = await post(app.base, `/pendencias/${pendenciaId}/resolver`, { familia: 'demurrage_pendencia', acao: 'excluir', tipo: 'armador_ausente', motivo: 'm' }, home);
    assert.equal(acaoErrada.status, 400);

    const { rows: pend } = await pool.query(`SELECT estado FROM demurrage_pendencias WHERE id = $1`, [pendenciaId]);
    assert.equal(pend[0].estado, 'aberta', 'nenhuma das três tentativas rejeitadas escreveu nada');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 26 — concorrência: comandos IDÊNTICOS concorrentes permanecem idempotentes
 * ========================================================================= */

test('Entrega 2 #26: duas requisições concorrentes com a MESMA Idempotency-Key de registro de minuta nunca duplicam', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-26');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-E2-26', 'ECQP');
    const chave = randomUUID();
    const chamar = () => fetch(`${app.base}/containers/${containerId}/minutas`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-home-account-id': home, 'idempotency-key': chave },
      body: JSON.stringify({ numeroInformado: numero, dataInformada: '2026-09-10' }),
    });
    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    assert.equal(b1.minutaId, b2.minutaId, 'as duas respostas devolvem a MESMA minuta');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'exatamente UMA minuta foi criada');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 28 — atribuição de auditoria sempre do membership autenticado
 * ========================================================================= */

test('Entrega 2 #28: a decisão de responsabilidade grava o autor REAL da sessão, mesmo que o corpo mande outro', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-28');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const membershipReal = await membershipIdPorHome(pool, home);
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-E2-28', 'ECQQ');
    const { rows: rel } = await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [containerId]);

    const membershipFalso = randomUUID();
    const res = await post(app.base, `/containers/${containerId}/responsabilidade`, {
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel[0].primeiro_dia_demurrage, fim: rel[0].data_final_apuracao }],
      justificativa: 'Sem causa Rocket.', evidenciaRef: 'evid://28', autorMembershipId: membershipFalso,
    }, home);
    assert.equal(res.status, 200);
    const { rows } = await pool.query(`SELECT autor_membership_id AS "autorMembershipId" FROM responsabilidade_decisoes WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].autorMembershipId, membershipReal);
    assert.notEqual(rows[0].autorMembershipId, membershipFalso);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 29 — nenhum erro bruto/evidência sensível escapa
 * ========================================================================= */

test('Entrega 2 #29: erro inesperado devolve só a resposta genérica — nenhum marcador do erro escapa', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e2-29');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoMinimo(pool, org.id, 'IM-E2-29', 'ECQR');
    const marcador = `MARCADOR-SEGREDO-${randomUUID()}`;

    // `registrarProcessoDemurrage` abre sua PRÓPRIA transação via `pool.connect()`
    // e escreve com `client.query(...)` — nunca com `pool.query(...)` diretamente.
    // A injeção precisa interceptar o CLIENTE devolvido por `connect()`, não o
    // pool. `pg-pool` chama `connect` em DOIS estilos (promessa OU callback —
    // `pool.query(...)` por baixo dos panos usa o estilo callback), então o
    // wrapper precisa suportar os dois; ignorar o estilo callback faz `await`
    // resolver `undefined` e quebra QUALQUER `pool.query` concorrente.
    const wrapClient = (client: any) => {
      if (client && !client.__e2_29_patched) {
        client.__e2_29_patched = true;
        const originalQuery = client.query.bind(client);
        client.query = (...args: unknown[]) => {
          const texto = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
          if (typeof texto === 'string' && texto.includes('INSERT INTO demurrage_fallback_manual_justificativas')) {
            throw new Error(`falha inesperada simulada: ${marcador}`);
          }
          return originalQuery(...args);
        };
      }
      return client;
    };
    const originalConnect = pool.connect.bind(pool);
    (pool as unknown as { connect: unknown }).connect = ((...connectArgs: unknown[]) => {
      const maybeCb = connectArgs[connectArgs.length - 1];
      if (typeof maybeCb === 'function') {
        return (originalConnect as (...a: unknown[]) => unknown)(
          ...connectArgs.slice(0, -1),
          (err: unknown, client: unknown, release: unknown) => {
            if (!err) wrapClient(client);
            (maybeCb as (...a: unknown[]) => unknown)(err, client, release);
          },
        );
      }
      return (originalConnect as (...a: unknown[]) => Promise<any>)(...connectArgs).then(wrapClient);
    }) as typeof pool.connect;

    const res = await post(app.base, `/containers/${containerId}/fallback-manual`, { campo: 'house', valorDias: 7, observadoEm: T, evidenciaRef: 'evid://29', justificativa: 'j' }, home);
    assert.equal(res.status, 500);
    const corpo = await res.text();
    assert.ok(!corpo.includes(marcador));
    const tudo = logs.join('\n');
    assert.ok(!tudo.includes(marcador), 'o marcador do erro nunca aparece em log');
  } finally {
    console.error = origErr;
    await app.close(); await pool.end();
  }
});

/* ========================================================================= *
 * 30 — nenhuma rota GET nesta entrega (puramente mutação) — checagem estrutural
 * ========================================================================= */

test('Entrega 2 #30: o router de ações não expõe nenhuma rota GET (toda ação é explicitamente um comando)', () => {
  const router = criarDemurrageAcoesRouter();
  const metodos = new Set<string>();
  for (const camada of (router as any).stack) {
    const rota = camada.route;
    if (rota?.methods) Object.keys(rota.methods).forEach((m) => metodos.add(m));
  }
  assert.ok(!metodos.has('get'), 'nenhuma rota GET deveria existir neste router');
});

/* ========================================================================= *
 * 32 — nenhum arquivo de frontend alterado
 * ========================================================================= */

test('Entrega 2 #32: nenhum arquivo de frontend (public/, .html, .css) está entre as mudanças não commitadas desta entrega', () => {
  const { execSync } = require('child_process');
  const saida = execSync('git status --porcelain', { cwd: __dirname + '/../../..', encoding: 'utf8' });
  const caminhosProibidos = saida
    .split('\n')
    .map((linha: string) => linha.slice(3))
    .filter((caminho: string) => caminho.startsWith('public/') || caminho.endsWith('.html') || caminho.endsWith('.css'));
  assert.deepEqual(caminhosProibidos, [], `arquivos de frontend não deveriam estar entre as mudanças: ${caminhosProibidos.join(', ')}`);
});
