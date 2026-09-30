import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'crypto';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { resolverAutorizacao, criarAutorizarInterno, AutorizedRequest } from '../leitura/autorizacao';
import { ErroLeitura } from '../leitura/contrato';

/**
 * Fase D12 (Gate G6) — RBAC e isolamento. `resolverAutorizacao` puro (contra
 * o banco) + o middleware HTTP completo, incluindo a rejeição explícita de
 * `organizationId` vindo da requisição (nunca ignorado silenciosamente).
 */

const url = testDatabaseUrl();

async function subirServidorTeste(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // Simula requireAuth: injeta a sessão a partir de um cabeçalho de teste.
    const home = req.get('x-test-home-account-id');
    req.session = home ? { homeAccountId: home } : {};
    next();
  });
  app.get('/protegida', criarAutorizarInterno(), (req: AutorizedRequest, res) => {
    res.json({ ok: true, autorizacao: req.autorizacao });
  });
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test('D12 G6 — RBAC e isolamento', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const orgs = new OrganizationRepository(pool);
  const usuarios = new UsuarioRepository(pool);
  const memberships = new OrganizationMembershipRepository(pool);

  const orgA = await orgs.create('Rocket', 'rocket-g6');
  const orgB = await orgs.create('Outra', 'outra-g6');

  await t.test('sem sessão: resolverAutorizacao não é nem chamado — o middleware devolve 401', async () => {
    const { base, close } = await subirServidorTeste();
    try {
      const r = await fetch(`${base}/protegida`);
      assert.equal(r.status, 401);
    } finally {
      await close();
    }
  });

  await t.test('usuário sem nenhum membership interno (inexistente ou só CLIENT) → 403 usuario_sem_papel_interno', async () => {
    const usuarioClient = await usuarios.create('Cliente Puro', `cliente-${randomUUID()}@ex.com`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, usuarioClient.id, 'CLIENT');
    await assert.rejects(
      () => resolverAutorizacao(pool, usuarioClient.homeAccountId!),
      (err: unknown) => err instanceof ErroLeitura && err.status === 403 && err.codigo === 'usuario_sem_papel_interno',
    );
    // home_account_id nunca cadastrado
    await assert.rejects(
      () => resolverAutorizacao(pool, `home-${randomUUID()}`),
      (err: unknown) => err instanceof ErroLeitura && err.status === 403,
    );
  });

  await t.test('exatamente um membership interno: resolução automática da organização (Q1)', async () => {
    const usuario = await usuarios.create('Ana Analista', `ana-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    const m = await memberships.create(orgA.id, usuario.id, 'ANALYST');
    const autorizacao = await resolverAutorizacao(pool, usuario.homeAccountId!);
    assert.equal(autorizacao.organizationId, orgA.id);
    assert.equal(autorizacao.membershipId, m.id);
    assert.equal(autorizacao.papel, 'ANALYST');
  });

  await t.test('mais de um membership interno em organizações distintas: 409 organizacao_ambigua (Q1)', async () => {
    const usuario = await usuarios.create('Gestor Duplo', `duplo-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, usuario.id, 'MANAGER');
    await memberships.create(orgB.id, usuario.id, 'ADMIN');
    await assert.rejects(
      () => resolverAutorizacao(pool, usuario.homeAccountId!),
      (err: unknown) => err instanceof ErroLeitura && err.status === 409 && err.codigo === 'organizacao_ambigua',
    );
  });

  await t.test('MANAGER e ADMIN também resolvem normalmente (todos os três papéis internos)', async () => {
    const gestor = await usuarios.create('Gestora M', `m-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, gestor.id, 'MANAGER');
    const admin = await usuarios.create('Admin A', `a-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    await memberships.create(orgB.id, admin.id, 'ADMIN');
    const rGestor = await resolverAutorizacao(pool, gestor.homeAccountId!);
    assert.equal(rGestor.papel, 'MANAGER');
    const rAdmin = await resolverAutorizacao(pool, admin.homeAccountId!);
    assert.equal(rAdmin.papel, 'ADMIN');
  });

  await t.test('HTTP: organizationId na query é rejeitado com 400 parametro_nao_aceito (nunca ignorado)', async () => {
    const usuario = await usuarios.create('Http Analyst', `http-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, usuario.id, 'ANALYST');
    const { base, close } = await subirServidorTeste();
    try {
      const r = await fetch(`${base}/protegida?organizationId=${orgB.id}`, {
        headers: { 'x-test-home-account-id': usuario.homeAccountId! },
      });
      assert.equal(r.status, 400);
      const body = await r.json();
      assert.equal(body.error, 'parametro_nao_aceito');
      assert.equal(body.campo, 'organizationId');
    } finally {
      await close();
    }
  });

  await t.test('HTTP: organizationId no cabeçalho x-organization-id também é rejeitado', async () => {
    const usuario = await usuarios.create('Http Analyst 2', `http2-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, usuario.id, 'ANALYST');
    const { base, close } = await subirServidorTeste();
    try {
      const r = await fetch(`${base}/protegida`, {
        headers: { 'x-test-home-account-id': usuario.homeAccountId!, 'x-organization-id': orgB.id },
      });
      assert.equal(r.status, 400);
    } finally {
      await close();
    }
  });

  await t.test('HTTP: fluxo feliz resolve a organização real e nunca a do parâmetro (que nem existe aqui)', async () => {
    const usuario = await usuarios.create('Http Analyst 3', `http3-${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, usuario.id, 'ANALYST');
    const { base, close } = await subirServidorTeste();
    try {
      const r = await fetch(`${base}/protegida`, { headers: { 'x-test-home-account-id': usuario.homeAccountId! } });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.autorizacao.organizationId, orgA.id);
    } finally {
      await close();
    }
  });

  await t.test('HTTP: CLIENT recebe 403', async () => {
    const usuario = await usuarios.create('Cliente Http', `chttp-${randomUUID()}@ex.com`, `home-${randomUUID()}`);
    await memberships.create(orgA.id, usuario.id, 'CLIENT');
    const { base, close } = await subirServidorTeste();
    try {
      const r = await fetch(`${base}/protegida`, { headers: { 'x-test-home-account-id': usuario.homeAccountId! } });
      assert.equal(r.status, 403);
      const body = await r.json();
      assert.equal(body.error, 'usuario_sem_papel_interno');
    } finally {
      await close();
    }
  });
});
