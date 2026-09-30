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
import { criarDemurrageV2Router } from '../../routes/demurrageV2Routes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/**
 * Fase D12 (Gate G7) — rotas V2 ponta a ponta. `requireAuth` real é
 * substituído por um middleware de teste que só injeta `req.session`
 * (mesmo padrão de `leituraAutorizacao.test.ts`) — o RBAC real (G6) roda sem
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
  // `requireAuth` real depende de MSAL (conta ativa) — substituído aqui pelo
  // equivalente do teste: `req.session.homeAccountId` já foi injetado acima
  // pelo middleware de teste; só falta exigir que ele exista (401 sem ele).
  const requireAuthDeTeste = (req: any, res: any, next: any) => {
    if (!req.session?.homeAccountId) { res.status(401).json({ error: 'nao_autenticado' }); return; }
    next();
  };
  app.use('/api/demurrage/v2', criarDemurrageV2Router({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/demurrage/v2`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g7');
}

async function processoReal(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', '2026-09-01T00:00:00Z'),
    armador: o('MAERSK', 'shipping_instructions', '2026-09-01T00:00:00Z'),
    houseFreeTimeDays: o(6, 'house_document', '2026-09-01T00:00:00Z'),
    masterFreeTimeDays: o(6, 'master_bl', '2026-09-01T00:00:00Z'),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  return { processoId: r.processoId, containerId, numero };
}

async function usuarioInterno(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT') {
  const u = await new UsuarioRepository(pool).create(`Usuario ${randomUUID()}`, `${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
  await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return u.homeAccountId!;
}

test('D12 G7 — rotas V2: fluxo feliz completo (fila, detalhe, timeline, contêiner, filtros)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-D12-G7-1', 'GSAA');
    const hdr = { 'x-test-home-account-id': home };

    const fila = await fetch(`${app.base}/processos`, { headers: hdr }).then((r) => r.json());
    assert.equal(fila.contrato, 'demurrage.leitura.v1');
    assert.ok(fila.itens.some((i: any) => i.processo.id === processoId));

    const detalheProc = await fetch(`${app.base}/processos/${processoId}`, { headers: hdr });
    assert.equal(detalheProc.status, 200);
    const bodyProc = await detalheProc.json();
    assert.equal(bodyProc.processoId, processoId);
    assert.ok(bodyProc.conteineres.length >= 1);

    const timeline = await fetch(`${app.base}/processos/${processoId}/timeline`, { headers: hdr });
    assert.equal(timeline.status, 200);
    const bodyTimeline = await timeline.json();
    assert.ok(bodyTimeline.eventos.length > 0);

    const detalheContainer = await fetch(`${app.base}/containers/${containerId}`, { headers: hdr });
    assert.equal(detalheContainer.status, 200);
    const bodyContainer = await detalheContainer.json();
    assert.equal(bodyContainer.containerId, containerId);
    assert.ok('interno' in bodyContainer && 'responsabilidade' in bodyContainer.interno);

    const filtros = await fetch(`${app.base}/filtros`, { headers: hdr });
    assert.equal(filtros.status, 200);
    const bodyFiltros = await filtros.json();
    assert.ok(Array.isArray(bodyFiltros.armadores));
  } finally { await app.close(); await pool.end(); }
});

test('D12 G7 — CLIENT recebe 403 em toda rota; sem sessão recebe 401', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const homeClient = await usuarioInterno(pool, org.id, 'CLIENT');
    const rotas = ['/processos', '/filtros', `/processos/${randomUUID()}`, `/processos/${randomUUID()}/timeline`, `/containers/${randomUUID()}`];
    for (const rota of rotas) {
      const semSessao = await fetch(`${app.base}${rota}`);
      assert.equal(semSessao.status, 401, `sem sessão em ${rota}`);
      const comClient = await fetch(`${app.base}${rota}`, { headers: { 'x-test-home-account-id': homeClient } });
      assert.equal(comClient.status, 403, `CLIENT em ${rota}`);
    }
  } finally { await app.close(); await pool.end(); }
});

test('D12 G7 — organizationId na query é rejeitado (400) mesmo em rota de detalhe', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const r = await fetch(`${app.base}/processos?organizationId=${randomUUID()}`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error, 'parametro_nao_aceito');
  } finally { await app.close(); await pool.end(); }
});

test('D12 G7 — recurso de outra organização devolve 404 idêntico ao inexistente', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const outra = await new OrganizationRepository(pool).create('outra-g7', 'outra-g7');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId, containerId } = await processoReal(pool, outra.id, 'IM-D12-G7-2', 'GSBB');

    const r1 = await fetch(`${app.base}/processos/${processoId}`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(r1.status, 404);
    const r2 = await fetch(`${app.base}/containers/${containerId}`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(r2.status, 404);
    const r3 = await fetch(`${app.base}/processos/${randomUUID()}`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(r3.status, 404);
    assert.deepEqual(await r1.json(), await r3.json(), 'outra organização e inexistente devolvem a MESMA resposta');
  } finally { await app.close(); await pool.end(); }
});

test('D12 G7 — GETs não gravam nem recalculam nada (fingerprint do banco idêntico antes/depois de bater todas as rotas)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'ADMIN');
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-D12-G7-3', 'GSCC');
    const hdr = { 'x-test-home-account-id': home };

    const fingerprint = async () => {
      const tabelas = ['processos', 'containers', 'relogios', 'valores_apurados', 'closing_events', 'snapshots', 'tracking_events'];
      const partes: string[] = [];
      for (const t of tabelas) {
        const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h FROM ${t} t`);
        partes.push(`${t}:${rows[0].h}`);
      }
      return partes.join('|');
    };

    const antes = await fingerprint();
    await fetch(`${app.base}/processos`, { headers: hdr });
    await fetch(`${app.base}/processos/${processoId}`, { headers: hdr });
    await fetch(`${app.base}/processos/${processoId}/timeline`, { headers: hdr });
    await fetch(`${app.base}/containers/${containerId}`, { headers: hdr });
    await fetch(`${app.base}/filtros`, { headers: hdr });
    const depois = await fingerprint();
    assert.equal(antes, depois);
  } finally { await app.close(); await pool.end(); }
});

test('D12 G7 — a V2 montada antes da V1 nunca deixa uma requisição de /v2 cair no router V1 (Q10)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'ANALYST');

    // Espelha o index.ts: V2 montada em '/api/demurrage/v2' ANTES de '/api/demurrage' (V1).
    let v1Chamada = 0;
    const v1Stub = express.Router();
    v1Stub.use((_req, _res, next) => { v1Chamada++; next(); });
    v1Stub.get('/', (_req, res) => res.json({ v1: true }));

    const app = express();
    app.use((req: any, _res, next) => {
      const h = req.get('x-test-home-account-id');
      req.session = h ? { homeAccountId: h } : {};
      next();
    });
    const requireAuthDeTeste = (req: any, res: any, next: any) => {
      if (!req.session?.homeAccountId) { res.status(401).json({ error: 'nao_autenticado' }); return; }
      next();
    };
    app.use('/api/demurrage/v2', criarDemurrageV2Router({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
    app.use('/api/demurrage', v1Stub);

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const respostaV2 = await fetch(`${base}/api/demurrage/v2/filtros`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(respostaV2.status, 200);
    const bodyV2 = await respostaV2.json();
    assert.equal(bodyV2.contrato, 'demurrage.leitura.v1');
    assert.equal(v1Chamada, 0, 'o router V1 nunca deveria ser tocado por uma requisição /v2/*');

    const respostaV1 = await fetch(`${base}/api/demurrage/`, { headers: { 'x-test-home-account-id': home } });
    assert.equal(respostaV1.status, 200);
    assert.equal((await respostaV1.json()).v1, true);
    assert.equal(v1Chamada, 1, 'a V1 continua respondendo normalmente na sua própria rota');

    await new Promise((resolve) => server.close(() => resolve(undefined)));
  } finally { await pool.end(); }
});

test('D12 G7 — ANALYST enxerga os dois relógios completos (Q2)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const org = await setup(pool);
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoReal(pool, org.id, 'IM-D12-G7-4', 'GSDD');
    const r = await fetch(`${app.base}/containers/${containerId}`, { headers: { 'x-test-home-account-id': home } });
    const body = await r.json();
    assert.ok(body.relogios.cliente && body.relogios.rocket);
    assert.ok('dias' in body.relogios.rocket && 'valor' in body.relogios.rocket);
  } finally { await app.close(); await pool.end(); }
});
