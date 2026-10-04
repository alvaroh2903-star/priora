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
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { criarDemurrageGestaoRouter } from '../../routes/demurrageGestaoRoutes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { confirmarResponsabilidadeClienteIntegral } from './responsabilidadeTestHelper';

/**
 * Fase D14 (Gates G5/G6) — rotas de Gestão ponta a ponta: RBAC/isolamento
 * (reaproveitados da D12 sem alteração), visibilidade de campo por papel,
 * rejeição de `organizationId`, drill-down (cursor assinado) e PROVA de
 * zero escrita (fingerprint completo do banco antes/depois de cada rota).
 * Mesmo padrão de harness HTTP de `demurrageV2Routes.test.ts` (G7 da D12):
 * `requireAuth` real substituído por um middleware de teste que só injeta
 * `req.session` — o RBAC real (`autorizarInterno`, D12 G6) roda sem
 * substituição nenhuma.
 */

const url = testDatabaseUrl();

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
  app.use('/api/demurrage/v2/gestao', criarDemurrageGestaoRouter({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/demurrage/v2/gestao`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g5g6-routes');
}

async function usuarioInterno(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT') {
  const u = await new UsuarioRepository(pool).create(`Usuario ${randomUUID()}`, `${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
  await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return u.homeAccountId!;
}

async function processoReal(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, hoje = '2026-09-20') {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(6, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(6, 'master_bl', '2026-09-01T00:00:00Z'),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: hoje });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), hoje);
  return { processoId: r.processoId, containerId, numero };
}

/** Variante devolvida (Empty Return) — pré-condição real do trigger de D11 (nunca decisão antes da devolução). */
async function processoDevolvido(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, hoje = '2026-09-20') {
  const base = await processoReal(pool, orgId, numeroProcesso, prefixo, hoje);
  await ingerirTrackingDoContainer(pool, base.containerId, resultadoTracking({
    containers: [{ numero: base.numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: hoje } as any],
    events: [{ date: hoje, status: 'Empty Return', location: 'Santos', type: 'empty_return', container: base.numero }],
  }), hoje);
  return base;
}

/** Fingerprint do conteúdo INTEIRO de cada tabela relevante — qualquer escrita (INSERT/UPDATE/DELETE) muda o hash. */
const TABELAS_FINGERPRINT = [
  'organizations', 'usuarios', 'organization_memberships',
  'processos', 'containers', 'relogios', 'valores_apurados',
  'responsabilidade_decisoes', 'demurrage_pendencias', 'minutas', 'fechamentos', 'reaberturas', 'closing_events',
  'tracking_targets', 'container_tracking_targets', 'tracking_fetches', 'tracking_incidents',
  'condicoes_comerciais', 'tariff_tables', 'tariff_brackets', 'field_observations',
];
async function fingerprintBanco(pool: Pool): Promise<string> {
  const partes: string[] = [];
  for (const tabela of TABELAS_FINGERPRINT) {
    const { rows } = await pool.query(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM ${tabela} t`);
    partes.push(`${tabela}:${rows[0].h}`);
  }
  return partes.join(';');
}

const ROTAS_GET = ['/operacional', '/financeiro', '/responsabilidade', '/eficiencia', '/qualidade'];

test('D14 G5 — CLIENT recebe 403 em toda rota de Gestão; sem sessão recebe 401', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const homeClient = await usuarioInterno(pool, org.id, 'CLIENT');
    const rotas = [...ROTAS_GET, `/indicadores/G-A1/composicao`];
    for (const rota of rotas) {
      const semSessao = await fetch(`${app.base}${rota}`);
      assert.equal(semSessao.status, 401, `sem sessão em ${rota}`);
      const comClient = await fetch(`${app.base}${rota}`, { headers: { 'x-test-home-account-id': homeClient } });
      assert.equal(comClient.status, 403, `CLIENT em ${rota}`);
    }
  } finally { await app.close(); await pool.end(); }
});

test('D14 G5 — organizationId em query/corpo/cabeçalho é rejeitado (400 parametro_nao_aceito) em qualquer rota de Gestão', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const rQuery = await fetch(`${app.base}/operacional?organizationId=${randomUUID()}`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(rQuery.status, 400);
    assert.equal((await rQuery.json()).error, 'parametro_nao_aceito');

    const rHeader = await fetch(`${app.base}/financeiro`, { headers: { 'x-test-home-account-id': home, 'x-organization-id': randomUUID() } });
    assert.equal(rHeader.status, 400);
    assert.equal((await rHeader.json()).error, 'parametro_nao_aceito');
  } finally { await app.close(); await pool.end(); }
});

test('D14 G5 — ANALYST nunca recebe `diferencaPotencial` em /financeiro: campo substituído por marcador explícito, nunca omitido silenciosamente nem um valor fabricado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    await processoReal(pool, org.id, 'IM-D14-G5-1', 'RGAA');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const homeAdmin = await usuarioInterno(pool, org.id, 'ADMIN');

    const rAnalyst = await fetch(`${app.base}/financeiro`, { headers: { 'x-test-home-account-id': homeAnalyst } });
    assert.equal(rAnalyst.status, 200);
    const bodyAnalyst = await rAnalyst.json();
    assert.deepEqual(bodyAnalyst.diferencaPotencial, { acessoRestrito: true }, 'ANALYST: marcador explícito, nunca omitido nem fabricado');
    // Os demais campos (custo do cliente, exposição Rocket) continuam visíveis ao ANALYST.
    assert.ok(bodyAnalyst.valorBrutoCliente);
    assert.ok(bodyAnalyst.exposicaoRocket);
    assert.ok(bodyAnalyst.valorAtribuidoCliente);

    for (const home of [homeManager, homeAdmin]) {
      const r = await fetch(`${app.base}/financeiro`, { headers: { 'x-test-home-account-id': home } });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.notDeepEqual(body.diferencaPotencial, { acessoRestrito: true }, 'MANAGER/ADMIN: valor real, nunca o marcador de restrição');
      assert.ok(Array.isArray(body.diferencaPotencial.grupos));
      assert.ok(body.diferencaPotencial.inelegiveis);
    }
  } finally { await app.close(); await pool.end(); }
});

test('D14 G5 — marcador de restrição nunca se confunde com pendente/indisponível (tipos distintos)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const r = await fetch(`${app.base}/financeiro`, { headers: { 'x-test-home-account-id': homeAnalyst } });
    const body = await r.json();
    assert.equal(body.diferencaPotencial.acessoRestrito, true);
    assert.equal(body.diferencaPotencial.grupos, undefined, 'o marcador NUNCA carrega os campos do valor real (grupos/inelegiveis)');
  } finally { await app.close(); await pool.end(); }
});

test('D14 G5 — ANALYST pode ler /responsabilidade e /operacional normalmente (evidência operacional e estado de responsabilidade são visíveis)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const { containerId } = await processoDevolvido(pool, org.id, 'IM-D14-G5-2', 'RGBB');
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: '2026-09-20' as any, organizationId: org.id });
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');

    const rOp = await fetch(`${app.base}/operacional`, { headers: { 'x-test-home-account-id': homeAnalyst } });
    assert.equal(rOp.status, 200);
    assert.equal((await rOp.json()).contrato, 'demurrage.gestao.operacional.v1');

    const rResp = await fetch(`${app.base}/responsabilidade`, { headers: { 'x-test-home-account-id': homeAnalyst } });
    assert.equal(rResp.status, 200);
    const bodyResp = await rResp.json();
    assert.ok(bodyResp.contrato);
  } finally { await app.close(); await pool.end(); }
});

test('D14 G6 — composição (drill-down): cursor adulterado é rejeitado; reconcilia com a contagem do indicador', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    await processoReal(pool, org.id, 'IM-D14-G6-CURSOR-1', 'CURA');
    await processoReal(pool, org.id, 'IM-D14-G6-CURSOR-2', 'CURB');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');

    const rOp = await fetch(`${app.base}/operacional`, { headers: { 'x-test-home-account-id': home } });
    const op = await rOp.json();
    const gA1 = op.indicadores.find((i: any) => i.id === 'G-A1');

    const rComp = await fetch(`${app.base}/indicadores/G-A1/composicao?limite=1`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(rComp.status, 200);
    const comp = await rComp.json();
    assert.equal(comp.total, gA1.valor, 'a composição reconcilia com a contagem do indicador');
    assert.equal(comp.itens.length, 1);
    assert.ok(comp.cursor, 'há próxima página');

    const rCursorRuim = await fetch(`${app.base}/indicadores/G-A1/composicao?cursor=adulterado123`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(rCursorRuim.status, 400);
    assert.equal((await rCursorRuim.json()).error, 'cursor_invalido');

    const rPag2 = await fetch(`${app.base}/indicadores/G-A1/composicao?limite=1&cursor=${encodeURIComponent(comp.cursor)}`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(rPag2.status, 200);
    const pag2 = await rPag2.json();
    assert.notEqual(pag2.itens[0]?.containerId, comp.itens[0]?.containerId, 'páginas distintas, sem repetir item');
  } finally { await app.close(); await pool.end(); }
});

test('D14 G6 — indicadorId desconhecido devolve 404 (nunca uma composição vazia fabricada)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const r = await fetch(`${app.base}/indicadores/G-NAO-EXISTE/composicao`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(r.status, 404);
  } finally { await app.close(); await pool.end(); }
});

test('D14 G6 — ZERO ESCRITAS: nenhuma das 6 rotas de Gestão altera UMA LINHA do banco (fingerprint completo antes/depois)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const { containerId } = await processoDevolvido(pool, org.id, 'IM-D14-G6-ZW', 'ZWAA');
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId, hoje: '2026-09-20' as any, organizationId: org.id });
    const home = await usuarioInterno(pool, org.id, 'ADMIN');

    const antes = await fingerprintBanco(pool);
    for (const rota of ROTAS_GET) {
      const r = await fetch(`${app.base}${rota}`, { headers: { 'x-test-home-account-id': home } });
      assert.equal(r.status, 200, `rota ${rota} deveria responder 200`);
    }
    const rComp = await fetch(`${app.base}/indicadores/G-A1/composicao`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(rComp.status, 200);
    const depois = await fingerprintBanco(pool);
    assert.equal(depois, antes, 'o fingerprint completo do banco não muda — nenhuma rota de Gestão escreve');
  } finally { await app.close(); await pool.end(); }
});
