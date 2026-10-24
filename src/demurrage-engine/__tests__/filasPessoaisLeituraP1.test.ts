import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { atribuirResponsavel } from '../responsavel/atribuirResponsavel';
import { criarDemurrageV2Router } from '../../routes/demurrageV2Routes';
import { criarDemurrageGestaoRouter } from '../../routes/demurrageGestaoRoutes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { confirmarResponsabilidadeClienteIntegral } from './responsabilidadeTestHelper';

/**
 * Produção P1 (filas pessoais) — LEITURAS com escopo explícito
 * (`MINHA_FILA | EQUIPE | SEM_RESPONSAVEL`), ponta a ponta pelos routers reais
 * da V2 e da Gestão. A sessão é injetada pelo mesmo harness dos testes D12/D14
 * (`req.session.homeAccountId`); o RBAC real (`autorizarInterno`) e a
 * resolução de escopo (`resolverEscopo`, sempre a partir do papel da SESSÃO)
 * rodam sem substituição. Os testes com cookie real ficam em
 * `autenticacaoFilasP1.test.ts`.
 */

const url = testDatabaseUrl();
const T = '2026-09-01T00:00:00Z';
const PERIODO = 'periodoInicio=2026-01-01&periodoFim=2026-12-31';

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
  app.use('/api/demurrage/v2', criarDemurrageV2Router({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/demurrage/v2`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

interface Membro { usuarioId: string; membershipId: string; home: string }

async function membro(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT', nome: string): Promise<Membro> {
  const u = await new UsuarioRepository(pool).create(`${nome} ${randomUUID().slice(0, 4)}`, `${randomUUID()}@rocket.example`, `home-${randomUUID()}`);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { usuarioId: u.id, membershipId: m.id, home: u.homeAccountId! };
}

async function processoReal(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(6, 'house_document', T), masterFreeTimeDays: o(6, 'master_bl', T),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  return { processoId: r.processoId, containerId, numero };
}

/** Atribuição REAL pelo serviço do lead (ledger + trilha + compare-and-set com o responsável atual). */
async function atribuir(pool: Pool, orgId: string, processoId: string, autorMembershipId: string, novo: string | null) {
  const { rows } = await pool.query(`SELECT responsavel_operacional_membership_id AS r FROM processos WHERE id = $1`, [processoId]);
  const r = await atribuirResponsavel(pool, {
    organizationId: orgId, processoId, autor: { tipo: 'membership', membershipId: autorMembershipId },
    novoMembershipId: novo, responsavelAtual: rows[0].r ?? null, motivo: 'teste de filas pessoais', idempotenciaChave: randomUUID(),
  });
  assert.equal(r.ok, true, `atribuição recusada: ${JSON.stringify(r)}`);
}

async function desativar(pool: Pool, membershipId: string) {
  await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'saiu da empresa' WHERE id = $1`, [membershipId]);
}

async function cenario(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
  const orgX = await new OrganizationRepository(pool).create('Org X', `p1-filas-x-${randomUUID().slice(0, 6)}`);
  const orgY = await new OrganizationRepository(pool).create('Org Y', `p1-filas-y-${randomUUID().slice(0, 6)}`);
  const ana = await membro(pool, orgX.id, 'ANALYST', 'Ana');
  const bia = await membro(pool, orgX.id, 'ANALYST', 'Bia');
  const gil = await membro(pool, orgX.id, 'MANAGER', 'Gil');
  const adm = await membro(pool, orgX.id, 'ADMIN', 'Adm');
  const cli = await membro(pool, orgX.id, 'CLIENT', 'Cli');
  const yan = await membro(pool, orgY.id, 'ANALYST', 'Yan');
  const gerY = await membro(pool, orgY.id, 'MANAGER', 'GerY');

  const pAna = await processoReal(pool, orgX.id, 'IM-P1F-ANA', 'FANA');
  const pBia = await processoReal(pool, orgX.id, 'IM-P1F-BIA', 'FBIA');
  const pSem = await processoReal(pool, orgX.id, 'IM-P1F-SEM', 'FSEM');
  const pGil = await processoReal(pool, orgX.id, 'IM-P1F-GIL', 'FGIL');
  const pY = await processoReal(pool, orgY.id, 'IM-P1F-Y', 'FYYY');
  await atribuir(pool, orgX.id, pAna.processoId, gil.membershipId, ana.membershipId);
  await atribuir(pool, orgX.id, pBia.processoId, gil.membershipId, bia.membershipId);
  await atribuir(pool, orgX.id, pGil.processoId, gil.membershipId, gil.membershipId);
  await atribuir(pool, orgY.id, pY.processoId, gerY.membershipId, yan.membershipId);
  return { orgX, orgY, ana, bia, gil, adm, cli, yan, gerY, pAna, pBia, pSem, pGil, pY };
}

async function get(base: string, caminho: string, home: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${caminho}`, { headers: { 'x-test-home-account-id': home } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function idsDaFila(base: string, home: string, query = ''): Promise<{ status: number; body: any; ids: string[] }> {
  const r = await get(base, `/processos${query}`, home);
  return { ...r, ids: r.status === 200 ? r.body.itens.map((i: any) => i.processo.id).sort() : [] };
}

const ordenado = (xs: string[]) => [...xs].sort();

/* ========================================================================= *
 * Fila e escopo por papel
 * ========================================================================= */

test('P1 filas #1: ANALYST — padrão MINHA_FILA só com os próprios processos; meta da resposta completa', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const f = await idsDaFila(app.base, c.ana.home);
    assert.equal(f.status, 200);
    assert.deepEqual(f.ids, [c.pAna.processoId], 'só o processo atribuído à Ana');
    assert.equal(f.body.escopo, 'MINHA_FILA');
    assert.equal(f.body.membershipResolvido, c.ana.membershipId);
    assert.equal(f.body.temProxima, false);
    assert.equal(f.body.cursor, null);
    assert.equal(f.body.filtros.escopo, 'MINHA_FILA');
    assert.equal(f.body.filtros.responsavel, c.ana.membershipId);
    assert.equal(f.body.filtros.apuracaoStatus, 'OPEN');
    assert.deepEqual(f.body.itens[0].responsavelOperacional, {
      membershipId: c.ana.membershipId, nome: f.body.itens[0].responsavelOperacional.nome, ativo: true,
    });
    // `escopo=MINHA_FILA` explícito e `responsavel=<ela mesma>` são equivalentes ao padrão.
    assert.deepEqual((await idsDaFila(app.base, c.ana.home, '?escopo=MINHA_FILA')).ids, [c.pAna.processoId]);
    assert.deepEqual((await idsDaFila(app.base, c.ana.home, `?responsavel=${c.ana.membershipId}`)).ids, [c.pAna.processoId]);
    // A Bia vê só o dela; ninguém vê o processo sem responsável na fila pessoal.
    assert.deepEqual((await idsDaFila(app.base, c.bia.home)).ids, [c.pBia.processoId]);
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #2: ANALYST — EQUIPE e SEM_RESPONSAVEL são 403 escopo_nao_permitido em toda lista (V2 e Gestão); escopo desconhecido é 400', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const listas = [
      '/processos', '/filtros', '/minutas', '/reaberturas', '/pendencias', `/processos/${c.pAna.processoId}/pendencias`,
      '/gestao/operacional', '/gestao/financeiro', '/gestao/responsabilidade', '/gestao/responsabilidade/decisoes',
      `/gestao/eficiencia?${PERIODO}`, '/gestao/qualidade', '/gestao/indicadores/G-A1/composicao',
    ];
    for (const lista of listas) {
      const sep = lista.includes('?') ? '&' : '?';
      for (const escopo of ['EQUIPE', 'SEM_RESPONSAVEL']) {
        const r = await get(app.base, `${lista}${sep}escopo=${escopo}`, c.ana.home);
        assert.equal(r.status, 403, `${lista} escopo=${escopo}`);
        assert.deepEqual(r.body, { error: 'escopo_nao_permitido', escopo }, `${lista} escopo=${escopo}`);
      }
      const invalido = await get(app.base, `${lista}${sep}escopo=fila_da_equipe`, c.ana.home);
      assert.equal(invalido.status, 400, `${lista} escopo inválido`);
      assert.deepEqual(invalido.body, { error: 'valor_invalido', campo: 'escopo' });
    }
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #3: ANALYST — responsavel de outro membership é 400 valor_invalido (nunca 403, nunca 500), em toda lista; o próprio é aceito', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const listas = ['/processos', '/filtros', '/minutas', '/reaberturas', '/pendencias', '/gestao/operacional', '/gestao/responsabilidade/decisoes', '/gestao/indicadores/G-A1/composicao'];
    for (const lista of listas) {
      for (const outro of [c.bia.membershipId, c.gil.membershipId, c.yan.membershipId]) {
        const r = await get(app.base, `${lista}?responsavel=${outro}`, c.ana.home);
        assert.equal(r.status, 400, `${lista} responsavel=${outro}`);
        assert.deepEqual(r.body, { error: 'valor_invalido', campo: 'responsavel' });
      }
      const proprio = await get(app.base, `${lista}?responsavel=${c.ana.membershipId}`, c.ana.home);
      assert.equal(proprio.status, 200, `${lista} responsavel=si mesma`);
    }
    // Forma inválida na Gestão: 400 (antes chegava ao PostgreSQL e virava 500).
    for (const campo of ['responsavel', 'cliente', 'armador', 'tipoEquipamento']) {
      const r = await get(app.base, `/gestao/operacional?${campo}=nao-e-uuid`, c.gil.home);
      assert.equal(r.status, 400, `gestão ${campo}`);
      assert.deepEqual(r.body, { error: 'valor_invalido', campo });
    }
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #4: MANAGER/ADMIN — EQUIPE (padrão), SEM_RESPONSAVEL, MINHA_FILA e EQUIPE+responsavel; membership de outra organização, CLIENT ou inexistente é 400', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const todos = ordenado([c.pAna.processoId, c.pBia.processoId, c.pSem.processoId, c.pGil.processoId]);
    for (const gestor of [c.gil, c.adm]) {
      const equipe = await idsDaFila(app.base, gestor.home);
      assert.deepEqual(equipe.ids, todos, 'EQUIPE = organização inteira (nunca a outra organização)');
      assert.equal(equipe.body.escopo, 'EQUIPE');
      assert.equal(equipe.body.membershipResolvido, null);
      assert.deepEqual((await idsDaFila(app.base, gestor.home, '?escopo=EQUIPE')).ids, todos);
      const sem = await idsDaFila(app.base, gestor.home, '?escopo=SEM_RESPONSAVEL');
      assert.deepEqual(sem.ids, [c.pSem.processoId]);
      assert.equal(sem.body.membershipResolvido, null);
      const daBia = await idsDaFila(app.base, gestor.home, `?escopo=EQUIPE&responsavel=${c.bia.membershipId}`);
      assert.deepEqual(daBia.ids, [c.pBia.processoId]);
      assert.equal(daBia.body.membershipResolvido, c.bia.membershipId);
      assert.equal(daBia.body.filtros.responsavel, c.bia.membershipId);
      // `responsavel` sem `escopo` = EQUIPE filtrada (o frontend congelado só manda `responsavel`).
      assert.deepEqual((await idsDaFila(app.base, gestor.home, `?responsavel=${c.ana.membershipId}`)).ids, [c.pAna.processoId]);
      for (const invalido of [c.yan.membershipId, c.cli.membershipId, randomUUID()]) {
        const r = await get(app.base, `/processos?escopo=EQUIPE&responsavel=${invalido}`, gestor.home);
        assert.equal(r.status, 400);
        assert.deepEqual(r.body, { error: 'valor_invalido', campo: 'responsavel' });
        const g = await get(app.base, `/gestao/operacional?responsavel=${invalido}`, gestor.home);
        assert.equal(g.status, 400, 'gestão: mesmo critério');
      }
      // SEM_RESPONSAVEL não combina com um responsável.
      assert.equal((await get(app.base, `/processos?escopo=SEM_RESPONSAVEL&responsavel=${c.ana.membershipId}`, gestor.home)).status, 400);
    }
    const minhaGil = await idsDaFila(app.base, c.gil.home, '?escopo=MINHA_FILA');
    assert.deepEqual(minhaGil.ids, [c.pGil.processoId]);
    assert.equal(minhaGil.body.membershipResolvido, c.gil.membershipId);
    assert.deepEqual((await idsDaFila(app.base, c.adm.home, '?escopo=MINHA_FILA')).ids, [], 'ADMIN sem processo atribuído: fila pessoal vazia');
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #5: sem responsável — fora de toda fila pessoal, em SEM_RESPONSAVEL e EQUIPE; atribuição aparece NA HORA na fila certa; reatribuição move', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const pSem = c.pSem.processoId;
    for (const pessoa of [c.ana, c.bia]) assert.ok(!(await idsDaFila(app.base, pessoa.home)).ids.includes(pSem));
    assert.ok(!(await idsDaFila(app.base, c.gil.home, '?escopo=MINHA_FILA')).ids.includes(pSem));
    assert.ok((await idsDaFila(app.base, c.gil.home, '?escopo=SEM_RESPONSAVEL')).ids.includes(pSem));
    assert.ok((await idsDaFila(app.base, c.gil.home)).ids.includes(pSem));

    await atribuir(pool, c.orgX.id, pSem, c.gil.membershipId, c.ana.membershipId);
    assert.deepEqual((await idsDaFila(app.base, c.ana.home)).ids, ordenado([c.pAna.processoId, pSem]), 'aparece imediatamente na fila da Ana');
    assert.ok(!(await idsDaFila(app.base, c.gil.home, '?escopo=SEM_RESPONSAVEL')).ids.includes(pSem), 'sai de SEM_RESPONSAVEL');
    assert.equal((await get(app.base, `/processos/${pSem}`, c.ana.home)).status, 200, 'e o detalhe passa a abrir para ela');

    await atribuir(pool, c.orgX.id, pSem, c.gil.membershipId, c.bia.membershipId);
    assert.deepEqual((await idsDaFila(app.base, c.ana.home)).ids, [c.pAna.processoId], 'reatribuído: sai da fila da Ana');
    assert.deepEqual((await idsDaFila(app.base, c.bia.home)).ids, ordenado([c.pBia.processoId, pSem]), 'e entra na da Bia');
    assert.deepEqual((await get(app.base, `/processos/${pSem}`, c.ana.home)).body, { error: 'nao_encontrado' });

    await atribuir(pool, c.orgX.id, pSem, c.gil.membershipId, null);
    assert.ok((await idsDaFila(app.base, c.gil.home, '?escopo=SEM_RESPONSAVEL')).ids.includes(pSem), 'retirado: volta a SEM_RESPONSAVEL');
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #6: responsável DESATIVADO — processo vai para SEM_RESPONSAVEL, item marca ativo:false, membership some de /filtros e não é filtro válido', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    await desativar(pool, c.bia.membershipId);
    const sem = await idsDaFila(app.base, c.gil.home, '?escopo=SEM_RESPONSAVEL');
    assert.deepEqual(sem.ids, ordenado([c.pSem.processoId, c.pBia.processoId]));
    const itemBia = sem.body.itens.find((i: any) => i.processo.id === c.pBia.processoId);
    assert.equal(itemBia.responsavelOperacional.membershipId, c.bia.membershipId, 'o membershipId atual continua exposto (compare-and-set da atribuição)');
    assert.equal(itemBia.responsavelOperacional.ativo, false);
    const detalhe = await get(app.base, `/processos/${c.pBia.processoId}`, c.gil.home);
    assert.equal(detalhe.body.responsavelOperacional.ativo, false);
    assert.equal((await get(app.base, `/processos?escopo=EQUIPE&responsavel=${c.bia.membershipId}`, c.gil.home)).status, 400, 'desativado não é filtro válido');
    const filtros = await get(app.base, '/filtros', c.gil.home);
    assert.ok(!filtros.body.responsaveis.some((r: any) => r.membershipId === c.bia.membershipId), 'desativado nunca é opção');
    assert.ok((await idsDaFila(app.base, c.gil.home)).ids.includes(c.pBia.processoId), 'continua visível na EQUIPE');
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #7: FINAL fora da fila padrão em TODOS os escopos; FINAL explícito respeita o escopo pessoal', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL' WHERE id = ANY($1)`, [[c.pAna.processoId, c.pSem.processoId]]);
    assert.deepEqual((await idsDaFila(app.base, c.ana.home)).ids, [], 'ANALYST MINHA_FILA');
    for (const q of ['', '?escopo=EQUIPE', '?escopo=SEM_RESPONSAVEL', '?escopo=MINHA_FILA', `?escopo=EQUIPE&responsavel=${c.ana.membershipId}`]) {
      const ids = (await idsDaFila(app.base, c.gil.home, q)).ids;
      assert.ok(!ids.includes(c.pAna.processoId) && !ids.includes(c.pSem.processoId), `gestor ${q || '(padrão)'}`);
    }
    assert.deepEqual((await idsDaFila(app.base, c.ana.home, '?apuracaoStatus=FINAL')).ids, [c.pAna.processoId], 'FINAL explícito, só o dela');
    assert.deepEqual((await idsDaFila(app.base, c.gil.home, '?escopo=SEM_RESPONSAVEL&apuracaoStatus=FINAL')).ids, [c.pSem.processoId]);
    const filtros = await get(app.base, '/filtros', c.ana.home);
    assert.deepEqual(filtros.body.apuracao, { abertos: 0, finalizados: 1 }, '/filtros conta só o escopo da Ana');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * Cursores e paginação
 * ========================================================================= */

test('P1 filas #8: paginação estável (sem duplicar/pular); cursor preso ao escopo, ao membership e à organização; reatribuição entre páginas = 409 ordem_alterada', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    // EQUIPE página a página (limite=1): mesma população da consulta sem limite, sem repetição.
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const r = await get(app.base, `/processos?limite=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, c.gil.home);
      assert.equal(r.status, 200);
      assert.equal(r.body.temProxima, r.body.cursor !== null);
      vistos.push(...r.body.itens.map((i: any) => i.processo.id));
      cursor = r.body.cursor;
      paginas++;
    } while (cursor && paginas < 10);
    assert.equal(new Set(vistos).size, vistos.length, 'nenhum processo repetido');
    assert.deepEqual(ordenado(vistos), (await idsDaFila(app.base, c.gil.home)).ids, 'nenhum processo pulado');

    // Cursor da EQUIPE não vale em MINHA_FILA (nem para outro membership, nem com outro filtro de responsável).
    const p1 = await get(app.base, '/processos?limite=1', c.gil.home);
    assert.ok(p1.body.cursor);
    const c1 = encodeURIComponent(p1.body.cursor);
    for (const [quem, q] of [
      [c.gil, `?escopo=MINHA_FILA&limite=1&cursor=${c1}`],
      [c.gil, `?escopo=SEM_RESPONSAVEL&limite=1&cursor=${c1}`],
      [c.gil, `?responsavel=${c.ana.membershipId}&limite=1&cursor=${c1}`],
      [c.ana, `?limite=1&cursor=${c1}`],
      [c.yan, `?limite=1&cursor=${c1}`],
    ] as const) {
      const r = await get(app.base, `/processos${q}`, quem.home);
      assert.equal(r.status, 400, q);
      assert.deepEqual(r.body, { error: 'cursor_invalido' });
    }
    // O cursor da MINHA_FILA do Gil não vale para a MINHA_FILA do ADMIN (outro membership, mesmos filtros).
    await atribuir(pool, c.orgX.id, c.pSem.processoId, c.gil.membershipId, c.gil.membershipId);
    const minhaGil = await get(app.base, '/processos?escopo=MINHA_FILA&limite=1', c.gil.home);
    assert.equal(minhaGil.body.temProxima, true);
    const deOutro = await get(app.base, `/processos?escopo=MINHA_FILA&limite=1&cursor=${encodeURIComponent(minhaGil.body.cursor)}`, c.adm.home);
    assert.deepEqual([deOutro.status, deOutro.body], [400, { error: 'cursor_invalido' }]);

    // Reatribuição entre as páginas da MINHA_FILA: nunca um salto silencioso.
    await atribuir(pool, c.orgX.id, c.pSem.processoId, c.gil.membershipId, c.ana.membershipId);
    const depois = await get(app.base, `/processos?escopo=MINHA_FILA&limite=1&cursor=${encodeURIComponent(minhaGil.body.cursor)}`, c.gil.home);
    assert.equal(depois.status, 409);
    assert.deepEqual(depois.body, { error: 'ordem_alterada' });
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * Detalhe de item fora do escopo = 404 idêntico ao de outra organização
 * ========================================================================= */

test('P1 filas #9: ANALYST — detalhe, timeline, contêiner, pendências e documento de processo NÃO atribuído = o MESMO 404 de outra organização/inexistente', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    // Documento de minuta (referência auditável) em cada processo relevante.
    const docMinuta = async (containerId: string, processoId: string, orgId: string, autor: Membro) => {
      const min = (await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1, 'RECEBIDA') RETURNING id`, [containerId])).rows[0].id;
      await pool.query(
        `INSERT INTO documentos (processo_id, container_id, organization_id, minuta_id, versao_minuta, tipo, origem, referencia_armazenamento,
                                 nome_arquivo, tipo_conteudo, tamanho_bytes, hash_conteudo, incluido_por, incluido_por_membership_id)
         VALUES ($1, $2, $3, $4, 1, 'minuta_devolucao', 'referencia_externa', 'ref://teste', 'minuta.pdf', 'application/pdf', 10, $5, $6, $7)`,
        [processoId, containerId, orgId, min, 'a'.repeat(64), autor.usuarioId, autor.membershipId],
      );
      return min as string;
    };
    const minAna = await docMinuta(c.pAna.containerId, c.pAna.processoId, c.orgX.id, c.gil);
    const minSem = await docMinuta(c.pSem.containerId, c.pSem.processoId, c.orgX.id, c.gil);
    const minY = await docMinuta(c.pY.containerId, c.pY.processoId, c.orgY.id, c.gerY);

    const rotas = (p: { processoId: string; containerId: string }, minuta: string) => [
      `/processos/${p.processoId}`, `/processos/${p.processoId}/timeline`, `/containers/${p.containerId}`,
      `/processos/${p.processoId}/pendencias`, `/minutas/${minuta}/documento`, `/pendencias?processoId=${p.processoId}`,
    ];
    const foraDoEscopo = rotas(c.pSem, minSem);
    const outraOrg = rotas(c.pY, minY);
    const inexistente = rotas({ processoId: randomUUID(), containerId: randomUUID() }, randomUUID());
    for (let i = 0; i < foraDoEscopo.length; i++) {
      const a = await get(app.base, foraDoEscopo[i], c.ana.home);
      const b = await get(app.base, outraOrg[i], c.ana.home);
      const x = await get(app.base, inexistente[i], c.ana.home);
      assert.deepEqual([a.status, a.body], [404, { error: 'nao_encontrado' }], `fora do escopo: ${foraDoEscopo[i]}`);
      assert.deepEqual([b.status, b.body], [a.status, a.body], `outra organização idêntica: ${outraOrg[i]}`);
      assert.deepEqual([x.status, x.body], [a.status, a.body], `inexistente idêntico: ${inexistente[i]}`);
    }
    // Os mesmos itens do PRÓPRIO processo abrem; o gestor abre os dois.
    for (const rota of rotas(c.pAna, minAna)) assert.equal((await get(app.base, rota, c.ana.home)).status, 200, `próprio: ${rota}`);
    for (const rota of [...rotas(c.pAna, minAna), ...foraDoEscopo]) assert.equal((await get(app.base, rota, c.gil.home)).status, 200, `gestor: ${rota}`);
    // Processo de outro analista: o mesmo 404.
    assert.deepEqual((await get(app.base, `/processos/${c.pBia.processoId}`, c.ana.home)).body, { error: 'nao_encontrado' });
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * Listas de ação: minutas, reaberturas, pendências
 * ========================================================================= */

test('P1 filas #10: minutas, reaberturas e pendências — listas no escopo (ANALYST só os seus; gestor por escopo), meta completa, cursor preso ao escopo', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const processos = [c.pAna, c.pBia, c.pSem, c.pGil];
    for (const p of processos) {
      await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1, 'RECEBIDA')`, [p.containerId]);
      await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1, 'SOLICITADA', $2, 'teste')`, [p.processoId, c.gil.usuarioId]);
      await pool.query(
        `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, 'mbl_ausente', '{}')
         ON CONFLICT (processo_id, COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo) WHERE estado = 'aberta' DO NOTHING`,
        [c.orgX.id, p.processoId],
      );
    }
    const processosDe = (_lista: string, body: any) => ordenado(Array.from(new Set<string>(body.itens.map((i: any) => i.processo.id))));
    for (const lista of ['/minutas', '/reaberturas', '/pendencias']) {
      const daAna = await get(app.base, lista, c.ana.home);
      assert.equal(daAna.status, 200, lista);
      assert.deepEqual(processosDe(lista, daAna.body), [c.pAna.processoId], `${lista}: ANALYST só os seus`);
      assert.equal(daAna.body.escopo, 'MINHA_FILA');
      assert.equal(daAna.body.membershipResolvido, c.ana.membershipId);
      assert.equal(daAna.body.temProxima, false);
      assert.equal(daAna.body.filtros.escopo, 'MINHA_FILA');
      assert.equal(daAna.body.filtros.responsavel, c.ana.membershipId);

      const equipe = await get(app.base, lista, c.gil.home);
      assert.deepEqual(processosDe(lista, equipe.body), ordenado(processos.map((p) => p.processoId)), `${lista}: EQUIPE`);
      const sem = await get(app.base, `${lista}?escopo=SEM_RESPONSAVEL`, c.gil.home);
      assert.deepEqual(processosDe(lista, sem.body), [c.pSem.processoId], `${lista}: SEM_RESPONSAVEL`);
      const daBia = await get(app.base, `${lista}?responsavel=${c.bia.membershipId}`, c.gil.home);
      assert.deepEqual(processosDe(lista, daBia.body), [c.pBia.processoId], `${lista}: EQUIPE+responsavel`);

      // Página a página (limite=1) sem duplicar/pular, e o cursor da EQUIPE nunca vale em outro escopo.
      const vistos: string[] = [];
      let cursor: string | null = null;
      let primeiroCursor: string | null = null;
      do {
        const r = await get(app.base, `${lista}?limite=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, c.gil.home);
        assert.equal(r.status, 200);
        assert.equal(r.body.temProxima, r.body.cursor !== null);
        vistos.push(...r.body.itens.map((i: any) => i.minutaId ?? i.reaberturaId ?? i.pendenciaId));
        cursor = r.body.cursor;
        primeiroCursor = primeiroCursor ?? cursor;
      } while (cursor);
      assert.equal(vistos.length, equipe.body.itens.length, `${lista}: mesma população paginada`);
      assert.equal(new Set(vistos).size, vistos.length, `${lista}: sem repetição`);
      for (const [quem, q] of [[c.gil, '?escopo=MINHA_FILA&'], [c.gil, '?escopo=SEM_RESPONSAVEL&'], [c.ana, '?'], [c.adm, '?escopo=MINHA_FILA&']] as const) {
        const r = await get(app.base, `${lista}${q}limite=1&cursor=${encodeURIComponent(primeiroCursor!)}`, quem.home);
        assert.deepEqual([r.status, r.body], [400, { error: 'cursor_invalido' }], `${lista}${q}`);
      }
    }
    // Pendências POR processo: o próprio abre com a meta do escopo; o cursor da lista entre processos não vale aqui.
    const porProcesso = await get(app.base, `/processos/${c.pAna.processoId}/pendencias`, c.ana.home);
    assert.equal(porProcesso.status, 200);
    assert.equal(porProcesso.body.escopo, 'MINHA_FILA');
    assert.equal(porProcesso.body.membershipResolvido, c.ana.membershipId);
    assert.ok(porProcesso.body.itens.length >= 1 && porProcesso.body.itens.every((i: any) => i.processo.id === c.pAna.processoId));
    // Gestor em MINHA_FILA não abre a lista do processo de outra pessoa (fora do escopo pedido = 404).
    assert.equal((await get(app.base, `/processos/${c.pAna.processoId}/pendencias?escopo=MINHA_FILA`, c.gil.home)).status, 404);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * /filtros
 * ========================================================================= */

test('P1 filas #11: /filtros — opções e contagens no escopo; responsaveis por papel (gestor: todo membership interno ATIVO com papel; ANALYST: só ele)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const novato = await membro(pool, c.orgX.id, 'ANALYST', 'Novato');
    const daAna = await get(app.base, '/filtros', c.ana.home);
    assert.equal(daAna.status, 200);
    assert.equal(daAna.body.escopo, 'MINHA_FILA');
    assert.equal(daAna.body.membershipResolvido, c.ana.membershipId);
    assert.deepEqual(daAna.body.responsaveis.map((r: any) => r.membershipId), [c.ana.membershipId], 'ANALYST: só ela');
    assert.deepEqual(daAna.body.apuracao, { abertos: 1, finalizados: 0 });
    const totalEstados = daAna.body.estados.reduce((a: number, e: any) => a + e.total, 0);
    assert.equal(totalEstados, 1, 'contagens por estado só do escopo dela');
    assert.equal(daAna.body.armadores.length, 1);

    const equipe = await get(app.base, '/filtros', c.gil.home);
    assert.equal(equipe.body.escopo, 'EQUIPE');
    assert.deepEqual(equipe.body.apuracao, { abertos: 4, finalizados: 0 });
    const ids = ordenado(equipe.body.responsaveis.map((r: any) => r.membershipId));
    assert.deepEqual(ids, ordenado([c.ana, c.bia, c.gil, c.adm, novato].map((m) => m.membershipId)),
      'todo membership interno ativo, inclusive sem processo; nunca CLIENT nem outra organização');
    for (const r of equipe.body.responsaveis) {
      assert.deepEqual(Object.keys(r).sort(), ['membershipId', 'nome', 'papel']);
      assert.ok(['ANALYST', 'MANAGER', 'ADMIN'].includes(r.papel));
    }
    const sem = await get(app.base, '/filtros?escopo=SEM_RESPONSAVEL', c.gil.home);
    assert.deepEqual(sem.body.apuracao, { abertos: 1, finalizados: 0 }, 'SEM_RESPONSAVEL conta só o processo sem responsável');
    assert.equal(sem.body.responsaveis.length, 5, 'responsaveis não depende do escopo (é a lista de quem pode ser atribuído)');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * Gestão — opção (a): escopo como UM predicado SQL em resumo e composição
 * ========================================================================= */

test('P1 filas #12: Gestão — ANALYST restrito à MINHA_FILA; resumo e composição reconciliam por escopo; gestor no padrão = organização inteira', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    const valor = (body: any, id: string) => body.indicadores.find((i: any) => i.id === id).valor as number;

    const opAna = await get(app.base, '/gestao/operacional', c.ana.home);
    assert.equal(opAna.status, 200);
    assert.equal(opAna.body.escopo, 'MINHA_FILA');
    assert.equal(opAna.body.membershipResolvido, c.ana.membershipId);
    assert.equal(opAna.body.filtros.responsavel, c.ana.membershipId);
    const opGil = await get(app.base, '/gestao/operacional', c.gil.home);
    assert.equal(opGil.body.escopo, 'EQUIPE');
    const opSem = await get(app.base, '/gestao/operacional?escopo=SEM_RESPONSAVEL', c.gil.home);
    for (const id of ['G-A1', 'G-A6', 'G-A8']) {
      for (const [quem, q, op] of [[c.ana, '', opAna], [c.gil, '', opGil], [c.gil, '?escopo=SEM_RESPONSAVEL', opSem]] as const) {
        const comp = await get(app.base, `/gestao/indicadores/${id}/composicao${q}`, quem.home);
        assert.equal(comp.status, 200, `${id}${q}`);
        assert.equal(comp.body.total, valor(op.body, id), `${id}${q}: composição reconcilia com o indicador do MESMO escopo`);
        assert.equal(comp.body.escopo, op.body.escopo);
        assert.equal(comp.body.temProxima, comp.body.cursor !== null);
      }
    }
    const compAna = await get(app.base, '/gestao/indicadores/G-A1/composicao', c.ana.home);
    assert.ok(compAna.body.itens.length >= 1);
    assert.ok(compAna.body.itens.every((i: any) => i.processoId === c.pAna.processoId), 'composição do ANALYST: só os processos dele');
    assert.ok(valor(opGil.body, 'G-A1') >= 4 * valor(opAna.body, 'G-A1'), 'gestor no padrão: organização inteira');

    // Cursor de composição preso ao escopo/membership (e à organização).
    const pagina1 = await get(app.base, '/gestao/indicadores/G-A1/composicao?limite=1', c.gil.home);
    assert.equal(pagina1.body.temProxima, true);
    const cur = encodeURIComponent(pagina1.body.cursor);
    for (const [quem, q] of [[c.gil, `?escopo=MINHA_FILA&limite=1&cursor=${cur}`], [c.ana, `?limite=1&cursor=${cur}`], [c.yan, `?limite=1&cursor=${cur}`]] as const) {
      const r = await get(app.base, `/gestao/indicadores/G-A1/composicao${q}`, quem.home);
      assert.deepEqual([r.status, r.body], [400, { error: 'cursor_invalido' }], q);
    }
    // Os demais resumos também respondem no escopo do ANALYST (com a meta), sem 500.
    for (const rota of ['/gestao/financeiro', '/gestao/responsabilidade', `/gestao/eficiencia?${PERIODO}`, `/gestao/qualidade?${PERIODO}`]) {
      const r = await get(app.base, rota, c.ana.home);
      assert.equal(r.status, 200, rota);
      assert.equal(r.body.escopo, 'MINHA_FILA', rota);
      assert.equal(r.body.membershipResolvido, c.ana.membershipId, rota);
    }
    const fin = await get(app.base, '/gestao/financeiro', c.ana.home);
    assert.deepEqual(fin.body.diferencaPotencial, { acessoRestrito: true }, 'G5 inalterado para ANALYST');
  } finally { await app.close(); await pool.end(); }
});

test('P1 filas #13: Gestão — decisões de responsabilidade no escopo; total reconcilia com o resumo; cursor preso ao escopo', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    const c = await cenario(pool);
    for (const p of [c.pAna, c.pSem, c.pBia]) {
      // Pré-condição real de D11: decisão só depois da devolução (Empty Return).
      await ingerirTrackingDoContainer(pool, p.containerId, resultadoTracking({
        containers: [{ numero: p.numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: '2026-09-20' } as any],
        events: [{ date: '2026-09-20', status: 'Empty Return', location: 'Santos', type: 'empty_return', container: p.numero }],
      }), '2026-09-20');
      const r = await confirmarResponsabilidadeClienteIntegral(pool, { containerId: p.containerId, hoje: '2026-09-20', organizationId: c.orgX.id });
      assert.ok((r as any).ok !== false, JSON.stringify(r));
    }
    const totalResumo = (body: any) => body.porStatus.reduce((a: number, s: any) => a + s.total, 0);
    const casos: Array<[Membro, string, string[]]> = [
      [c.ana, '', [c.pAna.processoId]],
      [c.gil, '', [c.pAna.processoId, c.pSem.processoId, c.pBia.processoId]],
      [c.gil, '?escopo=SEM_RESPONSAVEL', [c.pSem.processoId]],
      [c.gil, `?responsavel=${c.bia.membershipId}`, [c.pBia.processoId]],
    ];
    for (const [quem, q, esperado] of casos) {
      const det = await get(app.base, `/gestao/responsabilidade/decisoes${q}`, quem.home);
      assert.equal(det.status, 200, q);
      assert.deepEqual(ordenado(det.body.itens.map((i: any) => i.processoId)), ordenado(esperado), `decisões ${q || '(padrão)'}`);
      const resumo = await get(app.base, `/gestao/responsabilidade${q}`, quem.home);
      assert.equal(det.body.total, totalResumo(resumo.body), `${q}: detalhe reconcilia com o resumo do mesmo escopo`);
      assert.equal(det.body.escopo, resumo.body.escopo);
      assert.equal(det.body.temProxima, false);
    }
    // ANALYST filtrando por processo de outro: lista vazia, igual a processo de outra organização/inexistente.
    const outro = await get(app.base, `/gestao/responsabilidade/decisoes?processo=${c.pSem.processoId}`, c.ana.home);
    const inexistente = await get(app.base, `/gestao/responsabilidade/decisoes?processo=${randomUUID()}`, c.ana.home);
    assert.deepEqual([outro.body.total, outro.body.itens], [0, []]);
    assert.deepEqual([inexistente.body.total, inexistente.body.itens], [0, []]);

    const p1 = await get(app.base, '/gestao/responsabilidade/decisoes?limite=1', c.gil.home);
    assert.equal(p1.body.temProxima, true);
    const cur = encodeURIComponent(p1.body.cursor);
    for (const [quem, q] of [[c.gil, `?escopo=SEM_RESPONSAVEL&limite=1&cursor=${cur}`], [c.ana, `?limite=1&cursor=${cur}`]] as const) {
      const r = await get(app.base, `/gestao/responsabilidade/decisoes${q}`, quem.home);
      assert.deepEqual([r.status, r.body], [400, { error: 'cursor_invalido' }], q);
    }
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * Estático: o escopo nunca introduz OFFSET
 * ========================================================================= */

test('P1 filas #14: nenhuma consulta das leituras tocadas usa OFFSET de SQL; o escopo entra no hash de todo cursor', () => {
  const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const arquivos = [
    'filaOperacional.ts', 'filtros.ts', 'minutasOperacionais.ts', 'reaberturasOperacionais.ts', 'pendenciasOperacionais.ts',
    'escopoFila.ts', 'detalhe.ts', 'timeline.ts', 'documentoMinuta.ts',
    'gestao/operacional.ts', 'gestao/financeiro.ts', 'gestao/selecaoFinanceira.ts', 'gestao/responsabilidade.ts',
    'gestao/eficiencia.ts', 'gestao/qualidade.ts', 'gestao/drilldown.ts',
  ];
  for (const a of arquivos) {
    const codigo = semComentarios(readFileSync(join(__dirname, '../leitura', a), 'utf8'));
    // A fila principal pagina a ORDEM derivada em memória (posição + `ordemHash` no cursor assinado) — a
    // variável JS `offset` é isso, não SQL. Proibido: a cláusula SQL `OFFSET`, em qualquer caixa, num literal.
    assert.doesNotMatch(codigo, /\bOFFSET\b|`[^`]*\boffset\s+\$/, `${a}: OFFSET de SQL`);
  }
  for (const a of ['filaOperacional.ts', 'minutasOperacionais.ts', 'reaberturasOperacionais.ts', 'pendenciasOperacionais.ts', 'gestao/responsabilidade.ts', 'gestao/drilldown.ts']) {
    assert.match(readFileSync(join(__dirname, '../leitura', a), 'utf8'), /paresEscopo\(/, `${a}: escopo no hash do cursor`);
  }
});
