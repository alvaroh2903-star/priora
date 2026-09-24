import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { ProcessoRepository } from '../persistence/processoRepository';

const url = testDatabaseUrl();

test('multiempresa: isolamento entre organizações', { skip: !url }, async (t) => {
  const pool = testPool();
  await runMigrations(pool);
  await truncateAll(pool);

  const orgs = new OrganizationRepository(pool);
  const usuarios = new UsuarioRepository(pool);
  const memberships = new OrganizationMembershipRepository(pool);
  const clientes = new ClienteRepository(pool);
  const processos = new ProcessoRepository(pool);

  const orgA = await orgs.create('Rocket', 'rocket');
  const orgB = await orgs.create('Outra Empresa', 'outra-empresa');

  await t.test('mesmo numero_processo em duas organizações diferentes: permitido', async () => {
    const clienteA = await clientes.create(orgA.id, 'BRA TRADE');
    const clienteB = await clientes.create(orgB.id, 'BRA TRADE');
    const procA = await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM2151', clienteId: clienteA.id });
    const procB = await processos.create({ organizationId: orgB.id, numeroProcesso: 'IM2151', clienteId: clienteB.id });
    assert.notEqual(procA.id, procB.id);
  });

  await t.test('mesmo numero_processo duas vezes na MESMA organização: rejeitado', async () => {
    const cliente = await clientes.create(orgA.id, 'KLABIN');
    await processos.create({ organizationId: orgA.id, numeroProcesso: 'IM9999', clienteId: cliente.id });
    await assert.rejects(
      () => processos.create({ organizationId: orgA.id, numeroProcesso: 'IM9999', clienteId: cliente.id }),
      /duplicate key|unique/i,
    );
  });

  await t.test('Processo não pode referenciar Cliente de outra organização (trigger)', async () => {
    const clienteDeB = await clientes.create(orgB.id, 'CLIENTE-DE-B');
    await assert.rejects(
      () =>
        processos.create({ organizationId: orgA.id, numeroProcesso: 'IM7777', clienteId: clienteDeB.id }),
      /nao corresponde a organizacao do Cliente/,
    );
  });

  await t.test('OrganizationMembership não pode vincular Cliente de outra organização (trigger)', async () => {
    const usuario = await usuarios.create('Ana Analista', 'ana@rocket.example');
    const clienteDeB = await clientes.create(orgB.id, 'OUTRO-CLIENTE-DE-B');
    await assert.rejects(
      () => memberships.create(orgA.id, usuario.id, 'CLIENT', clienteDeB.id),
      /nao corresponde a organizacao do Cliente/,
    );
  });

  await t.test('OrganizationMembership válida: papel por organização', async () => {
    const usuario = await usuarios.create('Beto Gestor', 'beto@rocket.example');
    const membership = await memberships.create(orgA.id, usuario.id, 'MANAGER');
    assert.equal(membership.papel, 'MANAGER');
    assert.equal(membership.organizationId, orgA.id);
  });

  await t.test('um usuário não pode ter dois memberships na MESMA organização (unique)', async () => {
    const usuario = await usuarios.create('Carla Admin', 'carla@rocket.example');
    await memberships.create(orgA.id, usuario.id, 'ADMIN');
    await assert.rejects(() => memberships.create(orgA.id, usuario.id, 'ANALYST'), /duplicate key|unique/i);
  });

  await pool.end();
});
