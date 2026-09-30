import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { LifecycleRepository } from '../persistence/lifecycleRepository';
import { buscarFilaOperacional } from '../leitura/filaOperacional';
import { filtroFilaVazio, ErroLeitura } from '../leitura/contrato';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';

/**
 * Fase D12 (Gate G2) — read model da fila operacional.
 *
 * Cenários construídos pelo pipeline OFICIAL (registro + ingestão de tracking
 * real via `ingestTrackingResult`), nunca por INSERT direto em containers/
 * processos — a mesma disciplina dos testes da D10/D11.
 */

const url = testDatabaseUrl();

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  return new OrganizationRepository(pool).create('Rocket', 'rocket-g2');
}

async function processoComContainerDerivado(
  pool: Pool,
  orgId: string,
  numeroProcesso: string,
  opts: { prefixo: string; dischargeDate: string; freeTimeDias: number; hoje: string },
) {
  const numero = numeroContainer(opts.prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${opts.prefixo}`, 'master_bl', `${opts.dischargeDate}T00:00:00Z`),
    armador: o('MAERSK', 'shipping_instructions', `${opts.dischargeDate}T00:00:00Z`),
    houseFreeTimeDays: o(opts.freeTimeDias, 'house_document', `${opts.dischargeDate}T00:00:00Z`),
    masterFreeTimeDays: o(opts.freeTimeDias, 'master_bl', `${opts.dischargeDate}T00:00:00Z`),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: opts.hoje });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: opts.dischargeDate, availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: opts.dischargeDate, status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), opts.hoje);
  return { processoId: r.processoId, containerId, numero };
}

async function adicionarContainerSemDescarga(pool: Pool, processoId: string, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({ organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)] });
  await registrarProcessoDemurrage(entrada, { pool });
  const { rows } = await pool.query(`SELECT id FROM containers WHERE processo_id = $1 AND numero = $2`, [processoId, numero]);
  return rows[0].id as string;
}

test('D12 G2 — equivalência: montarFatos(id) === montarFatosEmLote([...ids]).get(id)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const a = await processoComContainerDerivado(pool, org.id, 'IM-D12-EQ-A', { prefixo: 'EQAA', dischargeDate: '2026-09-01', freeTimeDias: 5, hoje: '2026-09-20' });
    const b = await processoComContainerDerivado(pool, org.id, 'IM-D12-EQ-B', { prefixo: 'EQBB', dischargeDate: '2026-09-14', freeTimeDias: 5, hoje: '2026-09-20' });

    const repo = new LifecycleRepository(pool);
    const config = { hoje: '2026-09-20' as const };
    const unitA = await repo.montarFatos(a.containerId, config);
    const unitB = await repo.montarFatos(b.containerId, config);
    const lote = await repo.montarFatosEmLote([a.containerId, b.containerId], config);

    assert.deepEqual(lote.get(a.containerId), unitA);
    assert.deepEqual(lote.get(b.containerId), unitB);
  } finally { await pool.end(); }
});

test('D12 G2 — dois processos com prioridades diferentes saem na ordem oficial (CRITICA_7_14 antes de ATENCAO_1_6)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    // A: descarga 09-01, FT 6 dias → LFD 09-06 → 14 dias de demurrage → CRITICA_7_14.
    const a = await processoComContainerDerivado(pool, org.id, 'IM-D12-ORD-A', { prefixo: 'ORDA', dischargeDate: '2026-09-01', freeTimeDias: 6, hoje });
    // B: descarga 09-14, FT 5 dias → LFD 09-19 → 1 dia de demurrage → ATENCAO_1_6.
    const b = await processoComContainerDerivado(pool, org.id, 'IM-D12-ORD-B', { prefixo: 'ORDB', dischargeDate: '2026-09-14', freeTimeDias: 5, hoje });

    const c = await pool.query(`SELECT numero, estado, prioridade_balde FROM containers WHERE id = ANY($1)`, [[a.containerId, b.containerId]]);
    const balde = Object.fromEntries(c.rows.map((r) => [r.numero, r.prioridade_balde]));
    assert.equal(balde[a.numero], 'CRITICA_7_14');
    assert.equal(balde[b.numero], 'ATENCAO_1_6');

    const resp = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje });
    const ordemProcessos = resp.itens.map((i) => i.processo.id);
    assert.ok(ordemProcessos.indexOf(a.processoId) < ordemProcessos.indexOf(b.processoId), 'CRITICA_7_14 deve vir antes de ATENCAO_1_6');
    assert.equal(resp.itens[ordemProcessos.indexOf(a.processoId)].prioridade.balde, 'CRITICA_7_14');
    assert.equal(resp.itens[ordemProcessos.indexOf(b.processoId)].prioridade.balde, 'ATENCAO_1_6');
    assert.equal(resp.contrato, 'demurrage.leitura.v1');
    assert.equal(resp.incluiuSilenciosos, false);
  } finally { await pool.end(); }
});

test('D12 G2 — processo multi-contêiner consolida corretamente (composição + líder correto)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const primeiro = await processoComContainerDerivado(pool, org.id, 'IM-D12-MULTI', { prefixo: 'MULA', dischargeDate: '2026-09-01', freeTimeDias: 5, hoje });
    await adicionarContainerSemDescarga(pool, primeiro.processoId, org.id, 'IM-D12-MULTI', 'MULB');
    // Recalcula a consolidação do processo (o registro do 2º contêiner não reprocessa lifecycle sozinho).
    const repo = new LifecycleRepository(pool);
    await repo.consolidarProcessoDeCache(primeiro.processoId, { hoje });

    const resp = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje });
    const item = resp.itens.find((i) => i.processo.id === primeiro.processoId);
    assert.ok(item, 'processo multi-contêiner deve aparecer na fila');
    assert.equal(item!.conteineres.total, 2);
    assert.equal(item!.conteineres.emDemurrage, 1);
    assert.equal(item!.conteineres.comPendencia, 1);
    assert.equal(item!.estadoMaisRelevante.codigo, 'EM_DEMURRAGE_CRITICO', 'o líder (em demurrage) não pode ser mascarado pelo contêiner pendente');
  } finally { await pool.end(); }
});

test('D12 G2 — paginação: cursor não duplica nem omite itens, e detecta cursor inválido/adulterado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    const p1 = await processoComContainerDerivado(pool, org.id, 'IM-D12-PAG-1', { prefixo: 'PAGA', dischargeDate: '2026-09-01', freeTimeDias: 5, hoje });
    const p2 = await processoComContainerDerivado(pool, org.id, 'IM-D12-PAG-2', { prefixo: 'PAGB', dischargeDate: '2026-09-02', freeTimeDias: 5, hoje });
    const p3 = await processoComContainerDerivado(pool, org.id, 'IM-D12-PAG-3', { prefixo: 'PAGC', dischargeDate: '2026-09-03', freeTimeDias: 5, hoje });

    const pagina1 = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje, limite: 1 });
    assert.equal(pagina1.itens.length, 1);
    assert.ok(pagina1.cursor);

    const pagina2 = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje, limite: 1, cursor: pagina1.cursor });
    assert.equal(pagina2.itens.length, 1);
    assert.notEqual(pagina2.itens[0].processo.id, pagina1.itens[0].processo.id);

    const pagina3 = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje, limite: 1, cursor: pagina2.cursor });
    assert.equal(pagina3.itens.length, 1);
    assert.equal(pagina3.cursor, null, 'última página não tem próximo cursor');

    const idsPaginados = [pagina1, pagina2, pagina3].map((p) => p.itens[0].processo.id);
    assert.deepEqual(new Set(idsPaginados), new Set([p1.processoId, p2.processoId, p3.processoId]), 'sem duplicar nem omitir');

    // Página completa (limite alto) reproduz a MESMA ordem.
    const completa = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje, limite: 50 });
    assert.deepEqual(completa.itens.map((i) => i.processo.id), idsPaginados);

    await assert.rejects(
      () => buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje, limite: 1, cursor: 'lixo-nao-assinado' }),
      (err: unknown) => err instanceof ErroLeitura && err.status === 400 && err.codigo === 'cursor_invalido',
    );

    const cursorAdulterado = pagina1.cursor!.slice(0, -2) + 'zz';
    await assert.rejects(
      () => buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje, limite: 1, cursor: cursorAdulterado }),
      (err: unknown) => err instanceof ErroLeitura && err.status === 400 && err.codigo === 'cursor_invalido',
    );
  } finally { await pool.end(); }
});

test('D12 G2 — organização A nunca enxerga processos da organização B', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const orgB = await new OrganizationRepository(pool).create('Outra', 'outra-g2');
    const hoje = '2026-09-20';
    const a = await processoComContainerDerivado(pool, org.id, 'IM-D12-ISO-A', { prefixo: 'ISOA', dischargeDate: '2026-09-01', freeTimeDias: 5, hoje });
    const b = await processoComContainerDerivado(pool, orgB.id, 'IM-D12-ISO-B', { prefixo: 'ISOB', dischargeDate: '2026-09-01', freeTimeDias: 5, hoje });

    const respA = await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje });
    assert.ok(respA.itens.some((i) => i.processo.id === a.processoId));
    assert.ok(!respA.itens.some((i) => i.processo.id === b.processoId));

    const respB = await buscarFilaOperacional(pool, { organizationId: orgB.id, filtros: filtroFilaVazio(), hoje });
    assert.ok(respB.itens.some((i) => i.processo.id === b.processoId));
    assert.ok(!respB.itens.some((i) => i.processo.id === a.processoId));
  } finally { await pool.end(); }
});

test('D12 G2 — GET não grava nem recalcula nada (fingerprint do banco idêntico antes/depois)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    const org = await setup(pool);
    const hoje = '2026-09-20';
    await processoComContainerDerivado(pool, org.id, 'IM-D12-RO', { prefixo: 'RONL', dischargeDate: '2026-09-01', freeTimeDias: 5, hoje });

    const fingerprint = async () => {
      const tabelas = ['processos', 'containers', 'relogios', 'valores_apurados', 'closing_events', 'snapshots'];
      const partes: string[] = [];
      for (const t of tabelas) {
        const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h FROM ${t} t`);
        partes.push(`${t}:${rows[0].h}`);
      }
      return partes.join('|');
    };

    const antes = await fingerprint();
    await buscarFilaOperacional(pool, { organizationId: org.id, filtros: filtroFilaVazio(), hoje });
    await buscarFilaOperacional(pool, { organizationId: org.id, filtros: { ...filtroFilaVazio(), incluirSilenciosos: true }, hoje });
    const depois = await fingerprint();
    assert.equal(antes, depois, 'nenhuma leitura da fila pode alterar uma linha sequer');
  } finally { await pool.end(); }
});
