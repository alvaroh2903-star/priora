import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { novoGestor } from './responsabilidadeTestHelper';
import { buscarDetalheContainer, buscarDetalheProcesso } from '../leitura/detalhe';

/**
 * Fase D12 (Gate G3) — detalhe de processo e contêiner. Cenários pelo
 * pipeline oficial: `ContainerRepository.applyObservation` (mesma via usada
 * pelos testes de integridade da D11) + `recalcularApuracaoContainer`
 * (orquestrador transacional real — relógio, valor, lifecycle).
 */

const url = testDatabaseUrl();
const hoje = '2026-12-01';

interface Cenario { orgId: string; processoId: string; containerId: string; numero: string }

async function cenario(
  pool: Pool, numero: string,
  f: { discharge: string; houseFT: number; masterFT: number; effective?: string; diaria?: number; equipamentoTabela?: string; equipamentoContainer?: string | null },
): Promise<Cenario> {
  const slug = `org-${numero.toLowerCase()}`;
  const org = await new OrganizationRepository(pool).create(slug, slug);
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: `IM-${numero}`, clienteId: null });
  if (f.diaria !== undefined) {
    const tabela = await seedRocketTermoPorEmbarque(pool, { organizationId: org.id, diarias: [{ equipamento: f.equipamentoTabela ?? '20DV', valorDia: f.diaria }] });
    const { rows } = await pool.query(
      `INSERT INTO condicoes_comerciais (organization_id, termo_tipo, tabela_id, fonte_documental) VALUES ($1,'embarque',$2,'teste') RETURNING id`,
      [org.id, tabela],
    );
    await pool.query(`UPDATE processos SET condicao_comercial_id = $2 WHERE id = $1`, [p.id, rows[0].id]);
  }
  const containers = new ContainerRepository(pool);
  const c = await containers.create(org.id, p.id, numero);
  const em = new Date(`${f.discharge}T00:00:00Z`);
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'dischargeDate', valor: f.discharge, fonte: 'master_bl', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'houseFreeTimeDays', valor: f.houseFT, fonte: 'house_document', observadoEm: em });
  await containers.applyObservation({ containerId: c.id, organizationId: org.id, campo: 'masterFreeTimeDays', valor: f.masterFT, fonte: 'master_bl', observadoEm: em });
  if (f.equipamentoContainer !== null) {
    await pool.query(`UPDATE containers SET container_type_id = (SELECT id FROM container_types WHERE codigo = $2) WHERE id = $1`, [c.id, f.equipamentoContainer ?? f.equipamentoTabela ?? '20DV']);
  }
  if (f.effective) await pool.query(`UPDATE containers SET effective_return_date = $2 WHERE id = $1`, [c.id, f.effective]);
  await recalcularApuracaoContainer(pool, c.id, { dataReferencia: hoje });
  return { orgId: org.id, processoId: p.id, containerId: c.id, numero };
}

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
}

test('D12 G3 — os dois relógios nunca se misturam (campos e valores distintos, mesma forma)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // House 5 dias, Master 10 dias: os dois relógios têm último-dia-livre DIFERENTES.
    const c = await cenario(pool, 'MIXA', { discharge: '2026-11-01', houseFT: 5, masterFT: 10 });
    const det = await buscarDetalheContainer(pool, c.orgId, c.containerId, hoje);
    assert.ok(det);
    assert.notEqual(det!.relogios.cliente.ultimoDiaLivre, det!.relogios.rocket.ultimoDiaLivre);
    assert.equal(det!.relogios.cliente.ultimoDiaLivre, '2026-11-05');
    assert.equal(det!.relogios.rocket.ultimoDiaLivre, '2026-11-10');
    // Nenhum campo "status geral": cada relógio tem o seu próprio `dias`/`status`.
    assert.ok('dias' in det!.relogios.cliente && 'dias' in det!.relogios.rocket);
    assert.ok(!('statusGeral' in (det as any)));
  } finally { await pool.end(); }
});

test('D12 G3 — valor ESTIMADO nunca aparece como CONFIRMADO', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // seedRocketTermoPorEmbarque + condição comercial 'embarque' alimentam o motor do CLIENTE.
    const c = await cenario(pool, 'ESTB', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, diaria: 100, equipamentoTabela: '20DV' });
    const det = await buscarDetalheContainer(pool, c.orgId, c.containerId, hoje);
    assert.equal(det!.relogios.cliente.valor.situacao, 'ESTIMADO');
    assert.notEqual(det!.relogios.cliente.valor.situacao, 'CONFIRMADO');
    assert.ok(det!.relogios.cliente.valor.total! > 0);
  } finally { await pool.end(); }
});

test('D12 G3 — exposição indisponível permanece INDISPONIVEL (nunca vira zero nem some)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // Tabela cadastrada para '20DV', mas o contêiner é '40HC' → sem faixa aplicável → UNAVAILABLE.
    const c = await cenario(pool, 'INDC', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, diaria: 100, equipamentoTabela: '20DV', equipamentoContainer: '40HC' });
    const det = await buscarDetalheContainer(pool, c.orgId, c.containerId, hoje);
    assert.equal(det!.relogios.rocket.valor.situacao, 'INDISPONIVEL');
    assert.equal(det!.relogios.rocket.valor.total, null);
    assert.equal(det!.relogios.rocket.valor.moeda, null);
  } finally { await pool.end(); }
});

test('D12 G3 — responsabilidade invalidada por recálculo do relógio volta a aparecer EM_ANALISE, com histórico preservado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, 'INVD', { discharge: '2026-11-01', houseFT: 5, masterFT: 5, effective: '2026-11-20' });
    const autorMembershipId = await novoGestor(pool, c.orgId);
    const rel = (await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id=$1 AND tipo='cliente'`, [c.containerId])).rows[0];
    const decisao = await decidirResponsabilidade(pool, {
      organizationId: c.orgId, containerId: c.containerId, autorMembershipId,
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
      justificativa: 'Teste D12 G3: demurrage do cliente.', evidenciaRef: 'evid://d12-g3',
      hojeReferencia: hoje,
    });
    assert.equal(decisao.ok, true, JSON.stringify(decisao));
    if (!decisao.ok) return;

    const antes = await buscarDetalheContainer(pool, c.orgId, c.containerId, hoje);
    assert.equal(antes!.interno.responsabilidade.estadoDerivado, 'CONFIRMADA_CLIENTE');
    assert.ok(antes!.interno.responsabilidade.decisaoVigente);
    assert.equal(antes!.interno.responsabilidade.invalidada, null);

    // Recálculo do relógio do cliente: novo Free Time House muda o input_hash.
    const containers = new ContainerRepository(pool);
    await containers.applyObservation({ containerId: c.containerId, organizationId: c.orgId, campo: 'houseFreeTimeDays', valor: 8, fonte: 'house_document', observadoEm: new Date('2026-11-15T00:00:00Z') });
    await recalcularApuracaoContainer(pool, c.containerId, { dataReferencia: hoje });

    const depois = await buscarDetalheContainer(pool, c.orgId, c.containerId, hoje);
    assert.equal(depois!.interno.responsabilidade.estadoDerivado, 'EM_ANALISE', 'sem decisão vigente, com demurrage confirmada → EM_ANALISE');
    assert.equal(depois!.interno.responsabilidade.decisaoVigente, null);
    assert.ok(depois!.interno.responsabilidade.invalidada, 'a invalidação deve ficar visível');
    assert.equal(depois!.interno.responsabilidade.invalidada!.decisaoId, decisao.decisaoId);
    assert.equal(depois!.interno.responsabilidade.invalidada!.motivo, 'RELOGIO_RECALCULADO');
    // Histórico preservado: a decisão antiga continua visível no histórico.
    assert.equal(depois!.interno.responsabilidade.historico!.length, 1);
    assert.equal(depois!.interno.responsabilidade.historico![0].id, decisao.decisaoId);
    assert.equal(depois!.interno.responsabilidade.historico![0].status, 'CONFIRMADA_CLIENTE');
  } finally { await pool.end(); }
});

test('D12 G3 — detalhe do processo: 404 (null) quando o contêiner pertence a outra organização', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const a = await cenario(pool, 'ISOX', { discharge: '2026-11-01', houseFT: 5, masterFT: 5 });
    const outraOrg = await new OrganizationRepository(pool).create('outra-g3', 'outra-g3');
    const semAcesso = await buscarDetalheContainer(pool, outraOrg.id, a.containerId, hoje);
    assert.equal(semAcesso, null);
    const semAcessoProcesso = await buscarDetalheProcesso(pool, outraOrg.id, a.processoId, hoje);
    assert.equal(semAcessoProcesso, null);

    const comAcesso = await buscarDetalheContainer(pool, a.orgId, a.containerId, hoje);
    assert.ok(comAcesso);
  } finally { await pool.end(); }
});

test('D12 G3 — detalhe do processo: composição e contêineres batem com o número real de contêineres', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, 'PROD', { discharge: '2026-11-01', houseFT: 5, masterFT: 5 });
    const det = await buscarDetalheProcesso(pool, c.orgId, c.processoId, hoje);
    assert.ok(det);
    assert.equal(det!.conteineres.length, 1);
    assert.equal(det!.composicao.total, 1);
    assert.equal(det!.conteineres[0].containerId, c.containerId);
    assert.equal(det!.contrato, 'demurrage.leitura.v1');
  } finally { await pool.end(); }
});
