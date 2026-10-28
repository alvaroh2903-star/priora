import { test } from 'node:test';
import { documentoDeTeste } from './minutaTestHelper';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { atribuirResponsavelDeTeste, testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { criarDemurrageV2Router } from '../../routes/demurrageV2Routes';
import { criarDemurrageAcoesRouter } from '../../routes/demurrageAcoesRoutes';
import { containerContrato, contratoRegistro, numeroContainer, o } from './registroDemurrageHelpers';
import { contarConsultas } from './gestaoBenchmarkG7';
import { contextoSeguroPendencia, TIPOS_COM_CONTEXTO_SEGURO_DEFINIDO } from '../leitura/pendenciaContextoSeguro';

/**
 * Produção P1 (Entrega 3) — suíte de aceitação das três leituras
 * operacionais novas: pendências de um processo (`GET
 * /processos/:processoId/pendencias`), reaberturas da organização (`GET
 * /reaberturas`) e minutas da organização (`GET /minutas`). Roda com
 * PostgreSQL real, mesmo padrão HTTP de `demurrageV2Routes.test.ts` (D12
 * Gate G7): `requireAuth` real é substituído por um middleware de teste que
 * só injeta `req.session.homeAccountId` a partir do cabeçalho
 * `x-test-home-account-id` — o RBAC real (`autorizarInterno`) roda SEM
 * substituição nenhuma.
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

function get(base: string, caminho: string, home?: string, cabecalhos: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${caminho}`, { headers: { ...(home ? { 'x-test-home-account-id': home } : {}), ...cabecalhos } });
}

function post(base: string, caminho: string, body: unknown, home?: string, cabecalhos: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(home ? { 'x-test-home-account-id': home } : {}), ...cabecalhos },
    body: JSON.stringify(body ?? {}),
  });
}

async function processoReal(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T) })],
    mbl: o(`MBL${prefixo}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(6, 'house_document', T), masterFreeTimeDays: o(6, 'master_bl', T),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  return { processoId: r.processoId, containerId: r.containers[0].containerId, numero };
}

/* ========================================================================= *
 * 1-4 — autorização e isolamento (reuso do modelo congelado D12 G6).
 * ========================================================================= */

test('Entrega 3 #1: sem sessão -> 401 nas três rotas', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-01');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-01', 'ETAA');
    for (const caminho of [`/processos/${processoId}/pendencias`, '/reaberturas', '/minutas']) {
      const r = await get(app.base, caminho);
      assert.equal(r.status, 401, caminho);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #2: CLIENT -> 403 nas três rotas', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-02');
    const homeCliente = await usuarioInterno(pool, org.id, 'CLIENT');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-02', 'ETAB');
    for (const caminho of [`/processos/${processoId}/pendencias`, '/reaberturas', '/minutas']) {
      const r = await get(app.base, caminho, homeCliente);
      assert.equal(r.status, 403, caminho);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #3: membership revogada (removida) é rejeitada — mesmo caminho fechado do D12 G6, nenhuma regra nova', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-03');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const membershipId = await membershipIdPorHome(pool, home);
    const r1 = await get(app.base, '/reaberturas', home);
    assert.equal(r1.status, 200, 'antes da revogação, acesso normal');
    await pool.query(`DELETE FROM organization_memberships WHERE id = $1`, [membershipId]);
    const r2 = await get(app.base, '/reaberturas', home);
    assert.equal(r2.status, 403, 'membership revogada -> sem papel interno -> 403, mesmo padrão de CLIENT');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #4: organizationId por query/corpo/cabeçalho é rejeitado (400 parametro_nao_aceito) — reuso do Gate G6', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-04');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const outraOrg = await criarOrg(pool, 'e3-04-outra');
    const r1 = await get(app.base, `/reaberturas?organizationId=${outraOrg.id}`, home);
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error, 'parametro_nao_aceito');
    const r2 = await get(app.base, '/minutas', home, { 'x-organization-id': outraOrg.id });
    assert.equal(r2.status, 400);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 5-10 — pendências de processo.
 * ========================================================================= */

test('Entrega 3 #5: processo de OUTRA organização devolve o MESMO 404 de inexistente', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'e3-05-a');
    const orgB = await criarOrg(pool, 'e3-05-b');
    const homeA = await usuarioInterno(pool, orgA.id, 'ANALYST');
    const { processoId: processoDeB } = await processoReal(pool, orgB.id, 'IM-E3-05B', 'ETAC');

    const rInexistente = await get(app.base, `/processos/${randomUUID()}/pendencias`, homeA);
    const rOutraOrg = await get(app.base, `/processos/${processoDeB}/pendencias`, homeA);
    assert.equal(rInexistente.status, 404);
    assert.equal(rOutraOrg.status, 404);
    assert.deepEqual(await rInexistente.json(), await rOutraOrg.json(), 'indistinguível — mesmo corpo, mesmo status');

    // Produção P1 (filas pessoais): para o ANALYST o 404 acima já decorre só do predicado de RESPONSÁVEL
    // (o processo de B nunca é atribuído a ele) — o predicado de ORGANIZAÇÃO não é exercido. Um MANAGER de A
    // (escopo EQUIPE: sem restrição de responsável) repete as MESMAS asserções: aqui só a organização pode
    // produzir o 404. Controle: um processo da própria org A é 200 para ele.
    const homeGestorA = await usuarioInterno(pool, orgA.id, 'MANAGER');
    const { processoId: processoDeA } = await processoReal(pool, orgA.id, 'IM-E3-05A', 'ETCA');
    assert.equal((await get(app.base, `/processos/${processoDeA}/pendencias`, homeGestorA)).status, 200, 'controle: MANAGER de A lê o processo da própria organização');
    const rInexistenteGestor = await get(app.base, `/processos/${randomUUID()}/pendencias`, homeGestorA);
    const rOutraOrgGestor = await get(app.base, `/processos/${processoDeB}/pendencias`, homeGestorA);
    assert.equal(rInexistenteGestor.status, 404);
    assert.equal(rOutraOrgGestor.status, 404);
    assert.deepEqual(await rInexistenteGestor.json(), await rOutraOrgGestor.json(), 'indistinguível para o MANAGER — mesmo corpo, mesmo status');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #6/#7: lista devolve pendenciaId/tipo reais; padrão só devolve ABERTAS', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-06');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    // processoReal sem mbl/armador próprios dispara mbl_ausente/armador_ausente automaticamente —
    // aqui pedimos um processo normal (com mbl/armador) e abrimos pendências manualmente, controladas.
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-E3-06', 'ETAD');
    // Produção P1 (filas pessoais): ANALYST só lê as pendências de processo ATRIBUÍDO a ele (fora disso, o
    // mesmo 404 de inexistente) — ele passa a ser o responsável; a regra verificada aqui não muda.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    const { rows: [aberta] } = await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto) VALUES ($1,$2,$3,'armador_sem_tracking', $4) RETURNING id, tipo`,
      [org.id, processoId, containerId, JSON.stringify({ codigo: 'XYZ' })],
    );
    await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, estado, resolvido_em)
       VALUES ($1,$2,$3,'free_time_ausente', $4, 'resolvida', now())`,
      [org.id, processoId, containerId, JSON.stringify({ campo: 'houseFreeTimeDays', motivo: 'sem fonte' })],
    );

    const r = await get(app.base, `/processos/${processoId}/pendencias`, home);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.itens.length, 1, 'padrão só devolve ABERTAS — a resolvida não aparece');
    assert.equal(body.itens[0].pendenciaId, aberta.id);
    assert.equal(body.itens[0].tipo, 'armador_sem_tracking');
    assert.equal(body.itens[0].estado, 'aberta');
    assert.equal(body.itens[0].processo.id, processoId);
    assert.equal(body.itens[0].container?.id, containerId);
    assert.equal(typeof body.itens[0].podeResolver, 'boolean');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #8: filtro estado=resolvida funciona', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-08');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-E3-08', 'ETAE');
    // Produção P1 (filas pessoais): ANALYST só lê as pendências de processo ATRIBUÍDO a ele (fora disso, o
    // mesmo 404 de inexistente) — ele passa a ser o responsável; a regra verificada aqui não muda.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, estado, resolvido_em)
       VALUES ($1,$2,$3,'free_time_ausente', '{}', 'resolvida', now())`,
      [org.id, processoId, containerId],
    );
    const r = await get(app.base, `/processos/${processoId}/pendencias?estado=resolvida`, home);
    const body = await r.json();
    assert.equal(body.itens.length, 1);
    assert.equal(body.itens[0].estado, 'resolvida');
    assert.ok(body.itens[0].resolvidaEm);
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #9: allowlist de contexto seguro — todos os 16 tipos suportados têm campos seguros, nunca o JSON bruto', () => {
  // Produção P1 (correção de minuta, migration 0048): o CHECK de
  // `demurrage_pendencias.tipo` ganhou `minuta_inconsistente` e
  // `minuta_divergente_tracking` (14 → 16), cada um com allowlist própria.
  assert.equal(TIPOS_COM_CONTEXTO_SEGURO_DEFINIDO.length, 16);
  const bruto = {
    campo: 'houseFreeTimeDays', fonte: 'manual_fallback', codigo: 'XYZ', tipoOriginal: '40HC',
    motivo: 'm', diasDemurrageCliente: 3, valorRegistrado: 1, valorConflitante: 2,
    valorManual: 1, valorNovo: 2, fonteNova: 'master_bl', observationId: randomUUID(),
    origem: 'migration_0030_backfill', candidatas: [randomUUID(), randomUUID()],
    selecaoLegada: { tipoOriginal: '40HC', fonte: 'master_bl' },
    dischargeDate: '2026-01-01', gateOutDate: '2026-01-05', trackingReturnDate: '2026-01-04',
    segredoNuncaExposto: 'nao-deveria-aparecer-em-nenhum-campo-seguro',
  };
  for (const tipo of TIPOS_COM_CONTEXTO_SEGURO_DEFINIDO) {
    const seguro = contextoSeguroPendencia(tipo, bruto);
    assert.ok(seguro.rotulo && seguro.rotulo.length > 0, `${tipo}: rótulo fixo`);
    assert.equal(seguro.temEvidencia, false);
    const textoSerializado = JSON.stringify(seguro.campos);
    assert.ok(!textoSerializado.includes('observationId'), `${tipo}: nunca expõe observationId`);
    assert.ok(!textoSerializado.includes('candidatas'), `${tipo}: nunca expõe a lista crua de candidatas`);
    assert.ok(!textoSerializado.includes('nao-deveria-aparecer'), `${tipo}: nunca repassa um campo fora da allowlist`);
  }
});

test('Entrega 3 #10: tipo desconhecido/futuro nunca expõe o contexto bruto — rótulo genérico, campos vazios', () => {
  const seguro = contextoSeguroPendencia('tipo_futuro_ainda_nao_catalogado', { segredo: 'nunca deveria sair', outroCampo: 123 });
  assert.equal(seguro.rotulo, 'Pendência');
  assert.deepEqual(seguro.campos, []);
  assert.equal(seguro.temEvidencia, false);
  assert.ok(!JSON.stringify(seguro).includes('segredo'));
});

/* ========================================================================= *
 * 11-17 — reaberturas e minutas: filtros padrão, compatibilidade com
 * Entrega 2, isolamento entre organizações, flags de capacidade.
 * ========================================================================= */

test('Entrega 3 #11: /reaberturas — padrão só devolve SOLICITADA', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-11');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId: p1 } = await processoReal(pool, org.id, 'IM-E3-11A', 'ETAF');
    const { processoId: p2 } = await processoReal(pool, org.id, 'IM-E3-11B', 'ETAG');

    // p1: fica SOLICITADA. p2: já decidida (AUTORIZADA) — estado diferente do padrão.
    const u = await new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool).create('Solicitante', `${randomUUID()}@rocket.example`);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'pendente ainda')`, [p1, u.id]);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, autorizada_por, justificativa) VALUES ($1,'AUTORIZADA',$2,$2,'ja decidida')`, [p2, u.id]);

    const r = await get(app.base, '/reaberturas', homeManager);
    const body = await r.json();
    assert.equal(body.itens.length, 1, 'só a SOLICITADA aparece no padrão');
    assert.equal(body.itens[0].estado, 'SOLICITADA');
    assert.equal(body.itens[0].processo.id, p1);
    assert.equal(typeof body.itens[0].podeAutorizar, 'boolean');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #12: resultado de /reaberturas traz o reaberturaId exigido pela rota de autorização da Entrega 2', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-12');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-12', 'ETAH');
    const u = await new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool).create('Solicitante', `${randomUUID()}@rocket.example`);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'motivo')`, [processoId, u.id]);

    const lido = await (await get(app.base, '/reaberturas', homeManager)).json();
    const reaberturaId = lido.itens[0].reaberturaId;
    assert.ok(reaberturaId);

    const acaoBase = app.base.replace('/api/demurrage/v2', '/api/demurrage/v2/acoes');
    const autorizar = await post(acaoBase, `/reaberturas/${reaberturaId}/autorizar`, {}, homeManager);
    assert.equal(autorizar.status, 200, 'o ID lido é aceito, sem tradução, pela rota congelada da Entrega 2');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #13 (P1): /minutas — padrão devolve só o que exige ação (aqui: a RECEBIDA legada), nunca a VALIDADA', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-13');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId: p1, containerId: c1 } = await processoReal(pool, org.id, 'IM-E3-13A', 'ETAI');
    const { processoId: p2, containerId: c2 } = await processoReal(pool, org.id, 'IM-E3-13B', 'ETAJ');
    // Produção P1 (filas pessoais): /minutas do ANALYST é MINHA_FILA (processos atribuídos a ele) — os DOIS
    // processos passam a ser dele, para que a VALIDADA continue na fila consultada e o filtro padrão seja o que a exclui.
    const mAnalista = await membershipIdPorHome(pool, home);
    await atribuirResponsavelDeTeste(pool, p1, mAnalista);
    await atribuirResponsavelDeTeste(pool, p2, mAnalista);
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta, numero_informado) VALUES ($1,'RECEBIDA','X')`, [c1]);
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta, numero_informado, data_validada) VALUES ($1,'VALIDADA','X','2026-09-10')`, [c2]);

    const r = await get(app.base, '/minutas', home);
    const body = await r.json();
    assert.equal(body.itens.length, 1, 'só a RECEBIDA aparece no padrão');
    assert.equal(body.itens[0].estado, 'RECEBIDA');
    assert.equal(body.itens[0].container.id, c1);
    // Produção P1: contrato v2 — a RECEBIDA inserida aqui é LEGADA (aguardava a
    // validação humana que não existe mais); a ação do analista é registrar uma substituta.
    assert.equal(body.contrato, 'demurrage.leitura.minutas.v2');
    // Produção P1 (filas pessoais): a constante 'fila_da_equipe' deixou de existir — o escopo devolvido é o
    // resolvido pelo servidor, e o do ANALYST é sempre MINHA_FILA.
    assert.equal(body.escopo, 'MINHA_FILA');
    assert.equal(body.itens[0].legado, true);
    assert.equal(body.itens[0].acaoNecessaria, 'registrar_minuta_substituta');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #14 (reescrito na correção P1): o item de /minutas traz o contêiner exigido pela ação do analista (registrar a substituta), que tira o item da lista', { skip: !url }, async () => {
  // Produção P1 (correção de minuta): a rota de VALIDAÇÃO por gestor foi
  // removida (410) — a expectativa antiga ("o minutaId lido é aceito pela rota
  // de validação") deixou de valer. A garantia deste teste — a leitura
  // devolve exatamente o identificador que a ação exige, sem tradução — vale
  // para a ação que a substituiu: registrar a minuta substituta no contêiner.
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-14');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId, numero } = await processoReal(pool, org.id, 'IM-E3-14', 'ETAK');
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta, numero_informado, data_informada) VALUES ($1,'RECEBIDA',$2,'2026-09-10')`, [containerId, numero]);

    const lido = await (await get(app.base, '/minutas', homeManager)).json();
    const minutaId = lido.itens[0].minutaId;
    assert.ok(minutaId);
    assert.equal(lido.itens[0].temEvidencia, false);
    assert.equal(lido.itens[0].container.id, containerId);

    const acaoBase = app.base.replace('/api/demurrage/v2', '/api/demurrage/v2/acoes');
    const validar = await post(acaoBase, `/minutas/${minutaId}/validar`, {}, homeManager);
    assert.equal(validar.status, 410, 'não existe mais validação por gestor');
    const substituta = await post(acaoBase, `/containers/${lido.itens[0].container.id}/minutas`, {
      numeroInformado: numero, dataInformada: '2026-09-10',
      // Produção P1 (arquivos de minuta): o documento é um ARQUIVO armazenado do contêiner lido.
      documento: await documentoDeTeste(pool, containerId),
    }, homeManager, { 'idempotency-key': randomUUID() });
    assert.equal(substituta.status, 201, 'o contêiner lido é aceito, sem tradução, pela ação de registro');
    assert.deepEqual((await (await get(app.base, '/minutas', homeManager)).json()).itens, [], 'a legada foi substituída — nenhum item irremovível');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #15: filas de organização (/reaberturas, /minutas) nunca vazam outra organização', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'e3-15-a');
    const orgB = await criarOrg(pool, 'e3-15-b');
    const homeA = await usuarioInterno(pool, orgA.id, 'ANALYST');
    const { processoId: pA, containerId: cA } = await processoReal(pool, orgA.id, 'IM-E3-15A', 'ETAL');
    const { processoId: pB, containerId: cB } = await processoReal(pool, orgB.id, 'IM-E3-15B', 'ETAM');
    // Produção P1 (filas pessoais): as listas do ANALYST são MINHA_FILA — pA passa a ser dele. Como a fila
    // pessoal já exclui pB (sem responsável), um MANAGER de A (EQUIPE: só o predicado de organização protege)
    // também é verificado, para que o isolamento entre organizações continue provado sem depender do responsável.
    await atribuirResponsavelDeTeste(pool, pA, await membershipIdPorHome(pool, homeA));
    const homeGestorA = await usuarioInterno(pool, orgA.id, 'MANAGER');
    const uA = await new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool).create('A', `${randomUUID()}@rocket.example`);
    const uB = await new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool).create('B', `${randomUUID()}@rocket.example`);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'a')`, [pA, uA.id]);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'b')`, [pB, uB.id]);
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1,'RECEBIDA')`, [cA]);
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1,'RECEBIDA')`, [cB]);

    for (const leitor of [homeA, homeGestorA]) {
      const reab = await (await get(app.base, '/reaberturas', leitor)).json();
      assert.equal(reab.itens.length, 1);
      assert.equal(reab.itens[0].processo.id, pA);
      const min = await (await get(app.base, '/minutas', leitor)).json();
      assert.equal(min.itens.length, 1);
      assert.equal(min.itens[0].container.id, cA);
    }
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #16/#17: flags de capacidade corretas por papel, e NUNCA dispensam a revalidação da Entrega 2', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-16');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId, containerId, numero } = await processoReal(pool, org.id, 'IM-E3-16', 'ETAN');
    // Produção P1 (filas pessoais): leituras do ANALYST (pendências do processo, /reaberturas e /minutas em
    // MINHA_FILA) só alcançam processo atribuído a ele — ele passa a ser o responsável; as flags por papel não mudam.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, homeAnalyst));
    const u = await new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool).create('S', `${randomUUID()}@rocket.example`);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'m')`, [processoId, u.id]);
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta, numero_informado, data_informada) VALUES ($1,'RECEBIDA',$2,'2026-09-10')`, [containerId, numero]);
    await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto) VALUES ($1,$2,$3,'armador_sem_tracking','{}')`,
      [org.id, processoId, containerId],
    );

    const [pendAnalyst, pendManager] = await Promise.all([
      get(app.base, `/processos/${processoId}/pendencias`, homeAnalyst).then((r) => r.json()),
      get(app.base, `/processos/${processoId}/pendencias`, homeManager).then((r) => r.json()),
    ]);
    assert.equal(pendAnalyst.itens[0].podeResolver, true, 'ANALYST pode resolver pendência (mesma régua de registro/pendencias.ts)');
    assert.equal(pendManager.itens[0].podeResolver, true);

    const [reabAnalyst, reabManager] = await Promise.all([
      get(app.base, '/reaberturas', homeAnalyst).then((r) => r.json()),
      get(app.base, '/reaberturas', homeManager).then((r) => r.json()),
    ]);
    assert.equal(reabAnalyst.itens[0].podeAutorizar, false, 'ANALYST não autoriza reabertura');
    assert.equal(reabManager.itens[0].podeAutorizar, true, 'MANAGER autoriza');

    const [minAnalyst, minManager] = await Promise.all([
      get(app.base, '/minutas', homeAnalyst).then((r) => r.json()),
      get(app.base, '/minutas', homeManager).then((r) => r.json()),
    ]);
    // Produção P1: `podeValidar` saiu do contrato (não existe aprovação de gestor);
    // a ação sobre a minuta é a mesma para qualquer papel interno.
    assert.ok(!('podeValidar' in minAnalyst.itens[0]));
    assert.equal(minAnalyst.itens[0].acaoNecessaria, 'registrar_minuta_substituta');
    assert.equal(minManager.itens[0].acaoNecessaria, 'registrar_minuta_substituta');

    // #17: mesmo que um cliente HTTP ignorasse a flag, a rota de ação da Entrega 2
    // revalida o papel no momento da mutação — a leitura nunca autoriza por si só.
    const acaoBase = app.base.replace('/api/demurrage/v2', '/api/demurrage/v2/acoes');
    const minutaId = minAnalyst.itens[0].minutaId;
    const reaberturaId = reabAnalyst.itens[0].reaberturaId;
    const tentativaValidar = await post(acaoBase, `/minutas/${minutaId}/validar`, {}, homeAnalyst);
    assert.equal(tentativaValidar.status, 410, 'a validação não existe para ninguém (P1)');
    const tentativaAutorizar = await post(acaoBase, `/reaberturas/${reaberturaId}/autorizar`, {}, homeAnalyst);
    assert.equal(tentativaAutorizar.status, 403);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 18-25 — cursor keyset: adulteração, cross-org, cross-rota, filtros, limite,
 * paginação sem duplicar/omitir, desempate determinístico, LIMIT+1.
 * ========================================================================= */

async function semearPendenciasEmLote(pool: Pool, orgId: string, processoId: string, n: number): Promise<string[]> {
  const { rows } = await pool.query(
    `WITH novos_containers AS (
       INSERT INTO containers (organization_id, processo_id, numero)
       SELECT $1, $2, 'E3LOTE' || substr(md5(random()::text || i::text), 1, 8) || lpad(i::text, 8, '0') FROM generate_series(1, $3) AS i
       RETURNING id, numero
     )
     INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto, criado_em)
     SELECT $1, $2, nc.id,
            (ARRAY['armador_ausente','mbl_ausente','tipo_ausente'])[(row_number() OVER (ORDER BY nc.numero) % 3) + 1],
            '{}'::jsonb,
            now() - ((row_number() OVER (ORDER BY nc.numero)) || ' seconds')::interval
       FROM novos_containers nc
     RETURNING id`,
    [orgId, processoId, n],
  );
  return rows.map((r) => r.id);
}

test('Entrega 3 #18: cursor assinado adulterado é rejeitado (400 cursor_invalido)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-18');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-18', 'ETAO');
    // Produção P1 (filas pessoais): ANALYST só lê as pendências de processo ATRIBUÍDO a ele (fora disso, o
    // mesmo 404 de inexistente) — ele passa a ser o responsável; a regra verificada aqui não muda.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    await semearPendenciasEmLote(pool, org.id, processoId, 3);
    const p1 = await (await get(app.base, `/processos/${processoId}/pendencias?limite=1`, home)).json();
    assert.ok(p1.cursor);
    const adulterado = p1.cursor.slice(0, -2) + (p1.cursor.slice(-2) === 'AA' ? 'BB' : 'AA');
    const r = await get(app.base, `/processos/${processoId}/pendencias?limite=1&cursor=${encodeURIComponent(adulterado)}`, home);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'cursor_invalido');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #19: cursor de OUTRA organização é rejeitado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'e3-19-a');
    const orgB = await criarOrg(pool, 'e3-19-b');
    const homeA = await usuarioInterno(pool, orgA.id, 'ANALYST');
    const homeB = await usuarioInterno(pool, orgB.id, 'ANALYST');
    const { processoId: pA } = await processoReal(pool, orgA.id, 'IM-E3-19A', 'ETAP');
    const { processoId: pB } = await processoReal(pool, orgB.id, 'IM-E3-19B', 'ETAQ');
    // Produção P1 (filas pessoais): ANALYST só lê as pendências de processo ATRIBUÍDO a ele (fora disso, o
    // mesmo 404 de inexistente) — sem isto homeA recebia 404, `cursorDeA` era `undefined` e homeB enviava o
    // literal "undefined" (400 por lixo, não por cursor assinado de outra organização). pA passa a ser de homeA
    // e pB de homeB (simetria), e o cursor de A é exigido (como em #18/#20): o 400 é de um cursor VÁLIDO de A.
    await atribuirResponsavelDeTeste(pool, pA, await membershipIdPorHome(pool, homeA));
    await atribuirResponsavelDeTeste(pool, pB, await membershipIdPorHome(pool, homeB));
    await semearPendenciasEmLote(pool, orgA.id, pA, 2);
    await semearPendenciasEmLote(pool, orgB.id, pB, 2);
    const cursorDeA = (await (await get(app.base, `/processos/${pA}/pendencias?limite=1`, homeA)).json()).cursor;
    assert.ok(cursorDeA, 'pré-condição: a org A emitiu um cursor assinado válido');
    // Produção P1 (filas pessoais): controle — na própria sessão de A o mesmo cursor é aceito (200), e o cursor
    // da própria B é aceito por B; só a troca de organização produz o 400 abaixo.
    assert.equal((await get(app.base, `/processos/${pA}/pendencias?limite=1&cursor=${encodeURIComponent(cursorDeA)}`, homeA)).status, 200);
    const cursorDeB = (await (await get(app.base, `/processos/${pB}/pendencias?limite=1`, homeB)).json()).cursor;
    assert.ok(cursorDeB, 'pré-condição: a org B emitiu um cursor assinado válido');
    assert.equal((await get(app.base, `/processos/${pB}/pendencias?limite=1&cursor=${encodeURIComponent(cursorDeB)}`, homeB)).status, 200);
    // Mesmo com um processo válido NA org B, o cursor da org A nunca é aceito pela sessão de B.
    const r = await get(app.base, `/processos/${pB}/pendencias?limite=1&cursor=${encodeURIComponent(cursorDeA)}`, homeB);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'cursor_invalido');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #20: cursor de outra ROTA (/minutas) é rejeitado em /reaberturas', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-20');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-E3-20', 'ETAR');
    // Produção P1 (filas pessoais): /minutas do ANALYST é MINHA_FILA — o processo passa a ser dele, para haver cursor.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1,'RECEBIDA'), ($1,'RECEBIDA')`, [containerId]);
    const cursorDeMinutas = (await (await get(app.base, '/minutas?limite=1', home)).json()).cursor;
    assert.ok(cursorDeMinutas);
    const r = await get(app.base, `/reaberturas?limite=1&cursor=${encodeURIComponent(cursorDeMinutas)}`, home);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'cursor_invalido');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #21: mudar um filtro invalida o cursor (400) — mudar só o limite NÃO invalida', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-21');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-21', 'ETAS');
    // Produção P1 (filas pessoais): ANALYST só lê as pendências de processo ATRIBUÍDO a ele (fora disso, o
    // mesmo 404 de inexistente) — ele passa a ser o responsável; a regra verificada aqui não muda.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    await semearPendenciasEmLote(pool, org.id, processoId, 6); // 2 ciclos de 3 tipos -> 2 linhas de 'armador_ausente'
    const p1 = await (await get(app.base, `/processos/${processoId}/pendencias?limite=1&tipo=armador_ausente`, home)).json();
    assert.ok(p1.cursor, 'duas linhas de armador_ausente e limite=1 -> deve haver próxima página');

    const comFiltroMudado = await get(app.base, `/processos/${processoId}/pendencias?limite=1&tipo=mbl_ausente&cursor=${encodeURIComponent(p1.cursor)}`, home);
    assert.equal(comFiltroMudado.status, 400, 'filtro diferente do cursor original -> cursor_invalido');

    const comLimiteMudado = await get(app.base, `/processos/${processoId}/pendencias?limite=5&tipo=armador_ausente&cursor=${encodeURIComponent(p1.cursor)}`, home);
    assert.equal(comLimiteMudado.status, 200, 'só o limite mudou — o MESMO cursor continua válido');
  } finally { await app.close(); await pool.end(); }
});

test('Entrega 3 #22-23-24-25: paginação completa sem duplicar/omitir, desempate determinístico, LIMIT+1 nunca vaza', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-2225');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-2225', 'ETAT');
    // Produção P1 (filas pessoais): ANALYST só lê as pendências de processo ATRIBUÍDO a ele (fora disso, o
    // mesmo 404 de inexistente) — ele passa a ser o responsável; a regra verificada aqui não muda.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    const total = 17;
    const idsEsperados = await semearPendenciasEmLote(pool, org.id, processoId, total);

    // Força um EMPATE real de timestamp entre duas linhas, para provar que o
    // desempate por `id` é determinístico mesmo sob empate (#24).
    const { rows: doisPrimeiros } = await pool.query(
      `SELECT id FROM demurrage_pendencias WHERE processo_id = $1 ORDER BY criado_em DESC LIMIT 2`, [processoId],
    );
    await pool.query(`UPDATE demurrage_pendencias SET criado_em = now() WHERE id = ANY($1)`, [[doisPrimeiros[0].id, doisPrimeiros[1].id]]);

    const limite = 4;
    const coletados: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const qs: string = cursor ? `?limite=${limite}&cursor=${encodeURIComponent(cursor)}` : `?limite=${limite}`;
      const body: any = await (await get(app.base, `/processos/${processoId}/pendencias${qs}`, home)).json();
      assert.ok(body.itens.length <= limite, 'o LIMIT+1 nunca vaza para a resposta — nunca mais que `limite` itens');
      coletados.push(...body.itens.map((i: any) => i.pendenciaId));
      cursor = body.cursor;
      paginas += 1;
      assert.ok(paginas < 20, 'proteção contra loop infinito no teste');
    } while (cursor);

    assert.equal(coletados.length, total, 'nenhuma linha omitida');
    assert.equal(new Set(coletados).size, total, 'nenhuma linha duplicada');
    assert.deepEqual(new Set(coletados), new Set(idsEsperados));

    // Repetir a travessia inteira produz a MESMA ordem — prova de desempate determinístico sob empate real.
    const segundaOrdem: string[] = [];
    cursor = null;
    do {
      const qs: string = cursor ? `?limite=${limite}&cursor=${encodeURIComponent(cursor)}` : `?limite=${limite}`;
      const body: any = await (await get(app.base, `/processos/${processoId}/pendencias${qs}`, home)).json();
      segundaOrdem.push(...body.itens.map((i: any) => i.pendenciaId));
      cursor = body.cursor;
    } while (cursor);
    assert.deepEqual(segundaOrdem, coletados, 'mesma ordem, mesmo sob empate real de timestamp — desempate por id');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 26 — contagem de consultas CONSTANTE em relação ao tamanho da base.
 * ========================================================================= */

test('Entrega 3 #26: contagem de consultas por página é CONSTANTE entre 100 e 10.000 linhas', { skip: !url, timeout: 60000 }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-26');
    const { processoId } = await processoReal(pool, org.id, 'IM-E3-26', 'ETAU');

    const { buscarPendenciasProcesso } = await import('../leitura/pendenciasOperacionais');

    await semearPendenciasEmLote(pool, org.id, processoId, 100);
    const { contador: c100, restaurar: r1 } = contarConsultas(pool);
    await buscarPendenciasProcesso(pool, { organizationId: org.id, processoId, filtros: {}, limite: 50, papel: 'ANALYST' });
    r1();
    const n100 = c100.n;

    await semearPendenciasEmLote(pool, org.id, processoId, 9900); // total agora 10.000
    const { contador: c10k, restaurar: r2 } = contarConsultas(pool);
    await buscarPendenciasProcesso(pool, { organizationId: org.id, processoId, filtros: {}, limite: 50, papel: 'ANALYST' });
    r2();
    const n10k = c10k.n;

    assert.equal(n100, n10k, `a contagem de consultas não pode crescer com o tamanho da base (100 linhas: ${n100}, 10.000 linhas: ${n10k})`);
    assert.equal(n100, 1, 'uma única consulta SQL por página — nenhuma consulta por linha devolvida');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 27 — fingerprint zero-escrita, inclusive em caminhos de erro.
 * ========================================================================= */

test('Entrega 3 #27: fingerprint do banco idêntico antes/depois de TODAS as leituras e erros das três rotas', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'e3-27');
    const outraOrg = await criarOrg(pool, 'e3-27-outra');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeCliente = await usuarioInterno(pool, org.id, 'CLIENT');
    const { processoId, containerId } = await processoReal(pool, org.id, 'IM-E3-27', 'ETAV');
    // Produção P1 (filas pessoais): sem atribuição, as leituras de SUCESSO do ANALYST virariam 404/listas vazias
    // (fila pessoal) e o fingerprint deixaria de cobrir o caminho feliz — ele passa a ser o responsável.
    await atribuirResponsavelDeTeste(pool, processoId, await membershipIdPorHome(pool, home));
    await pool.query(`INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto) VALUES ($1,$2,$3,'armador_ausente','{}')`, [org.id, processoId, containerId]);
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta) VALUES ($1,'RECEBIDA')`, [containerId]);
    const u = await new (await import('../persistence/usuarioRepository')).UsuarioRepository(pool).create('S', `${randomUUID()}@rocket.example`);
    await pool.query(`INSERT INTO reaberturas (processo_id, estado, solicitada_por, justificativa) VALUES ($1,'SOLICITADA',$2,'m')`, [processoId, u.id]);

    const { rows: tabelas } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const fingerprint = async () => {
      const partes: string[] = [];
      for (const { table_name: t } of tabelas) {
        const { rows } = await pool.query(`SELECT md5(coalesce(array_agg(t.*::text ORDER BY t.*::text)::text, '')) AS h, count(*)::int AS n FROM "${t}" t`);
        partes.push(`${t}:${rows[0].n}:${rows[0].h}`);
      }
      return partes.join('|');
    };

    const antes = await fingerprint();
    const respostas: number[] = [];
    const chamar = async (caminho: string, home2?: string) => { const r = await get(app.base, caminho, home2); respostas.push(r.status); return r; };
    await chamar(`/processos/${processoId}/pendencias`, home);
    await chamar(`/processos/${processoId}/pendencias?estado=resolvida&limite=1`, home);
    await chamar('/reaberturas', home);
    await chamar('/reaberturas?estado=AUTORIZADA', home);
    await chamar('/minutas', home);
    await chamar('/minutas?divergente=true', home);
    // Caminhos de ERRO — nenhum deles pode escrever nada.
    await chamar(`/processos/${processoId}/pendencias`); // 401
    await chamar(`/processos/${processoId}/pendencias`, homeCliente); // 403
    await chamar(`/processos/${randomUUID()}/pendencias`, home); // 404
    await chamar(`/processos/${processoId}/pendencias?estado=invalido`, home); // 400 valor_invalido
    await chamar(`/reaberturas?cursor=lixo-adulterado`, home); // 400 cursor_invalido
    await chamar(`/minutas?organizationId=${outraOrg.id}`, home); // 400 parametro_nao_aceito

    const depois = await fingerprint();
    assert.ok(respostas.includes(401) && respostas.includes(403) && respostas.includes(404) && respostas.includes(400), `cobre os caminhos de erro: ${respostas.join(',')}`);
    assert.equal(antes, depois, 'nenhuma leitura (sucesso OU erro) altera uma única linha do banco');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 30 — nenhum arquivo de frontend alterado (mesma disciplina de v1.1/v1.2).
 * ========================================================================= */

test('Entrega 3 #30: nenhum arquivo de frontend (public/, .html, .css) está entre as mudanças não commitadas desta entrega', () => {
  const { execSync } = require('child_process');
  const saida = execSync('git status --porcelain', { cwd: __dirname + '/../../..', encoding: 'utf8' });
  const caminhosProibidos = saida
    .split('\n')
    .map((linha: string) => linha.slice(3))
    .filter((caminho: string) => caminho.startsWith('public/') || caminho.endsWith('.html') || caminho.endsWith('.css'));
  assert.deepEqual(caminhosProibidos, [], `arquivos de frontend não deveriam estar entre as mudanças: ${caminhosProibidos.join(', ')}`);
});
