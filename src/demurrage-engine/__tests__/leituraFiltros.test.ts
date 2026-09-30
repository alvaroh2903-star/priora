import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ClienteRepository } from '../persistence/clienteRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { buscarFilaOperacional } from '../leitura/filaOperacional';
import { normalizarFiltrosFila, buscarOpcoesFiltros } from '../leitura/filtros';
import { filtroFilaVazio, ErroLeitura } from '../leitura/contrato';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/** Fase D12 (Gate G5) — normalização de filtros + agregado de `/filtros`. */

const url = testDatabaseUrl();

test('D12 G5 — normalizarFiltrosFila: valores válidos e inválidos (sem banco)', () => {
  const vazio = normalizarFiltrosFila({});
  assert.deepEqual(vazio, filtroFilaVazio());

  const cheio = normalizarFiltrosFila({
    estado: 'EM_DEMURRAGE_CRITICO', prioridade: 'CRITICA_15', comPendencia: 'true',
    incluirSilenciosos: 'false', periodoCampo: 'devolucao', periodoInicio: '2026-01-01', periodoFim: '2026-01-31', busca: '  im1234  ',
  });
  assert.equal(cheio.estado, 'EM_DEMURRAGE_CRITICO');
  assert.equal(cheio.balde, 'CRITICA_15');
  assert.equal(cheio.comPendencia, true);
  assert.equal(cheio.periodoCampo, 'devolucao');
  assert.equal(cheio.periodoInicio, '2026-01-01');
  assert.equal(cheio.busca, 'im1234');

  assert.throws(() => normalizarFiltrosFila({ estado: 'ESTADO_INEXISTENTE' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400 && e.codigo === 'valor_invalido');
  assert.throws(() => normalizarFiltrosFila({ prioridade: 'INEXISTENTE' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400);
  assert.throws(() => normalizarFiltrosFila({ comPendencia: 'sim' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400);
  assert.throws(() => normalizarFiltrosFila({ periodoCampo: 'entrega' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400);
  assert.throws(() => normalizarFiltrosFila({ periodoInicio: '2026-01-01' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400, 'período exige início E fim juntos');
  assert.throws(() => normalizarFiltrosFila({ periodoInicio: '31-01-2026', periodoFim: '2026-01-01' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400);
  assert.throws(() => normalizarFiltrosFila({ cliente: 'nao-e-uuid' }), (e: unknown) => e instanceof ErroLeitura && e.status === 400);
});

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g5');
}

async function processo(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, opts: { clienteId?: string; dischargeDate: string; freeTimeDias: number; hoje: string }) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', `${opts.dischargeDate}T00:00:00Z`),
    armador: o('MAERSK', 'shipping_instructions', `${opts.dischargeDate}T00:00:00Z`),
    houseFreeTimeDays: o(opts.freeTimeDias, 'house_document', `${opts.dischargeDate}T00:00:00Z`),
    masterFreeTimeDays: o(opts.freeTimeDias, 'master_bl', `${opts.dischargeDate}T00:00:00Z`),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: opts.hoje });
  if (opts.clienteId) await pool.query(`UPDATE processos SET cliente_id = $2 WHERE id = $1`, [r.processoId, opts.clienteId]);
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: opts.dischargeDate, availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: opts.dischargeDate, status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), opts.hoje);
  return { processoId: r.processoId, containerId, numero };
}

test('D12 G5 — filtro por estado, por balde e combinado funcionam contra a fila real', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const clienteA = await new ClienteRepository(pool).create(org.id, 'Cliente A');
    const clienteB = await new ClienteRepository(pool).create(org.id, 'Cliente B');
    const critico = await processo(pool, org.id, 'IM-D12-F5-1', 'FVAA', { clienteId: clienteA.id, dischargeDate: '2026-09-01', freeTimeDias: 6, hoje });
    const atencao = await processo(pool, org.id, 'IM-D12-F5-2', 'FVBB', { clienteId: clienteB.id, dischargeDate: '2026-09-14', freeTimeDias: 5, hoje });

    const porEstado = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), estado: 'EM_DEMURRAGE_CRITICO' }, hoje });
    assert.deepEqual(porEstado.itens.map((i) => i.processo.id), [critico.processoId]);

    const porBalde = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), balde: 'ATENCAO_1_6' }, hoje });
    assert.deepEqual(porBalde.itens.map((i) => i.processo.id), [atencao.processoId]);

    const porCliente = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), clienteId: clienteA.id }, hoje });
    assert.deepEqual(porCliente.itens.map((i) => i.processo.id), [critico.processoId]);

    // Combinado (AND): cliente A com balde CRITICA_7_14 → só o processo crítico; cliente A com ATENCAO_1_6 → vazio.
    const combinadoOk = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), clienteId: clienteA.id, balde: 'CRITICA_7_14' }, hoje });
    assert.deepEqual(combinadoOk.itens.map((i) => i.processo.id), [critico.processoId]);
    const combinadoVazio = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), clienteId: clienteA.id, balde: 'ATENCAO_1_6' }, hoje });
    assert.equal(combinadoVazio.itens.length, 0);

    // Busca por número do processo.
    const porBusca = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), busca: 'F5-1' }, hoje });
    assert.deepEqual(porBusca.itens.map((i) => i.processo.id), [critico.processoId]);

    // Busca por número de contêiner (Q4: casamento a nível de contêiner).
    const porContainer = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), busca: atencao.numero }, hoje });
    assert.deepEqual(porContainer.itens.map((i) => i.processo.id), [atencao.processoId]);
  } finally { await pool.end(); }
});

test('D12 G5 — período (descarga) filtra corretamente e valida o campo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const cedo = await processo(pool, org.id, 'IM-D12-F5-3', 'FVCC', { dischargeDate: '2026-09-01', freeTimeDias: 6, hoje });
    const tarde = await processo(pool, org.id, 'IM-D12-F5-4', 'FVDD', { dischargeDate: '2026-09-15', freeTimeDias: 5, hoje });

    const resp = await buscarFilaOperacional(pool, {
      organizationId: org.id,
      filtros: { ...filtroFilaVazio(), periodoCampo: 'descarga', periodoInicio: '2026-09-01', periodoFim: '2026-09-05' },
      hoje,
    });
    assert.deepEqual(resp.itens.map((i) => i.processo.id), [cedo.processoId]);
    assert.ok(!resp.itens.some((i) => i.processo.id === tarde.processoId));
  } finally { await pool.end(); }
});

test('D12 G5 — GET /filtros: opções e contagens batem com os dados reais da organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const clienteA = await new ClienteRepository(pool).create(org.id, 'Cliente Opções');
    await processo(pool, org.id, 'IM-D12-F5-5', 'FVEE', { clienteId: clienteA.id, dischargeDate: '2026-09-01', freeTimeDias: 6, hoje });

    const opcoes = await buscarOpcoesFiltros(pool, org.id);
    assert.equal(opcoes.contrato, 'demurrage.leitura.v1');
    assert.ok(opcoes.clientes.some((c) => c.id === clienteA.id));
    assert.ok(opcoes.armadores.some((a) => a.codigo === 'MAERSK'));
    const critico = opcoes.estados.find((e) => e.codigo === 'EM_DEMURRAGE_CRITICO');
    assert.ok(critico && critico.total >= 1);
    const baldeCritico = opcoes.baldes.find((b) => b.codigo === 'CRITICA_7_14');
    assert.ok(baldeCritico && baldeCritico.total >= 1);
  } finally { await pool.end(); }
});
