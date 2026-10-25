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
import { resolverPendenciaManual } from '../registro/pendencias';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { ClosingService } from '../closing/closingService';
import { registrarMinutaTecnica } from '../closing/minutaTecnica';
import { lockProcesso } from '../closing/materialChangeGuard';
import { decidirResponsabilidade } from '../responsabilidade/decidirResponsabilidade';
import { aplicarFallbackManualContainer } from '../acoes/fallbackManualAdapter';
import { atribuirResponsavel, AtribuirResponsavelInput } from '../responsavel/atribuirResponsavel';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { criarDemurrageAcoesRouter } from '../../routes/demurrageAcoesRoutes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { documentoDeTeste } from './minutaTestHelper';
import { ErroContratoDemurrage, ManualFallbackGovernanca } from '../registro/contrato';

/**
 * Produção P1 (identidade operacional e filas pessoais) — autorização REAL,
 * no backend, das ações operacionais PESSOAIS (vinculadas à atribuição) e
 * checagem de membership ATIVO do ator em todos os serviços de ação.
 * PostgreSQL real; HTTP real pelo router de ações (mesmo padrão da Entrega 2:
 * só a sessão é simulada — `autorizarInterno` roda sem substituição).
 *
 * Ações PESSOAIS (ANALYST só no processo ATRIBUÍDO a ele; MANAGER/ADMIN em
 * qualquer processo da organização, inclusive sem responsável ou de outro):
 * registrar minuta técnica, resolver pendência manual, fallback manual de
 * Free Time, solicitar reabertura. Recusa = `403 {error:'ator_nao_responsavel'}`.
 *
 * Ações ORGANIZACIONAIS por natureza (MANAGER/ADMIN; ANALYST nunca, mesmo
 * responsável): decidir responsabilidade, autorizar reabertura, acionamento
 * administrativo do encerramento (finalizar), atribuir responsável, membros.
 *
 * A checagem do responsável roda DENTRO da transação da ação, depois do lock
 * consultivo do processo (o MESMO da atribuição) — as corridas abaixo provam
 * que uma reatribuição comitada enquanto a ação esperava o lock é respeitada.
 */

const url = testDatabaseUrl();
const T = '2026-09-01T00:00:00Z';
const HOJE = '2026-10-01';

/* ------------------------------------------------------------------ *
 * Infraestrutura.
 * ------------------------------------------------------------------ */

async function setup(pool: Pool) {
  await runMigrations(pool);
  await truncateAll(pool);
  await seedArmadorTables(pool);
}

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
  app.use('/a', criarDemurrageAcoesRouter({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/a`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

interface Membro { home: string; membershipId: string; usuarioId: string }
async function membro(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT'): Promise<Membro> {
  const home = `home-${randomUUID()}`;
  const u = await new UsuarioRepository(pool).create(`${papel} ${randomUUID().slice(0, 6)}`, `${randomUUID()}@rocket.example`, home);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { home, membershipId: m.id, usuarioId: u.id };
}

async function equipe(pool: Pool, slug: string) {
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, `${slug}-${randomUUID().slice(0, 6)}`);
  return {
    orgId: org.id,
    a1: await membro(pool, org.id, 'ANALYST'),
    a2: await membro(pool, org.id, 'ANALYST'),
    gestor: await membro(pool, org.id, 'MANAGER'),
    admin: await membro(pool, org.id, 'ADMIN'),
  };
}

function post(base: string, caminho: string, body: unknown, home: string, chave?: string): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-home-account-id': home, ...(chave ? { 'idempotency-key': chave } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

async function esperar403NaoResponsavel(res: Response, contexto: string) {
  const body = await res.json();
  assert.equal(res.status, 403, `${contexto}: ${JSON.stringify(body)}`);
  assert.deepEqual(body, { error: 'ator_nao_responsavel' }, contexto);
}

/** Atribuição pelo serviço REAL (compare-and-set com o responsável atual). */
async function atribuir(
  pool: Pool, orgId: string, processoId: string, autorMembershipId: string, novo: string | null,
  extra: Partial<AtribuirResponsavelInput> = {},
) {
  const { rows } = await pool.query(`SELECT responsavel_operacional_membership_id AS r FROM processos WHERE id = $1`, [processoId]);
  const r = await atribuirResponsavel(pool, {
    organizationId: orgId, processoId, autor: { tipo: 'membership', membershipId: autorMembershipId },
    novoMembershipId: novo, responsavelAtual: rows[0].r ?? null, motivo: 'distribuição da carteira (teste P1)',
    idempotenciaChave: `atr-${randomUUID()}`, ...extra,
  });
  assert.equal(r.ok, true, `atribuição recusada: ${JSON.stringify(r)}`);
  return r;
}

const responsavelDe = (pool: Pool, processoId: string) =>
  pool.query(`SELECT responsavel_operacional_membership_id AS r FROM processos WHERE id = $1`, [processoId]).then((x) => x.rows[0].r as string | null);

async function desativar(pool: Pool, membershipId: string) {
  await pool.query(`UPDATE organization_memberships SET desativado_em = now(), desativado_motivo = 'desligamento (teste P1)' WHERE id = $1`, [membershipId]);
}

/** Espera até haver uma transação BLOQUEADA num lock consultivo (a ação parada no `lockProcesso`). */
async function esperarAlguemNoLockConsultivo(pool: Pool) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nenhuma transação ficou esperando o lock consultivo do processo');
}

/**
 * Corrida determinística "reatribuição × ação pessoal": a atribuição (serviço
 * real) pausa ANTES do COMMIT, com o lock consultivo do processo retido; a
 * ação do analista é disparada enquanto ele AINDA é o responsável visível
 * (um pré-check fora do lock passaria) e fica parada no `lockProcesso`; a
 * reatribuição comita; a ação prossegue e precisa ver o responsável NOVO.
 */
async function corridaComReatribuicao(
  pool: Pool, orgId: string, processoId: string, gestor: string, analistaOriginal: string, novo: string,
  disparar: () => Promise<Response>,
): Promise<Response> {
  let liberar!: () => void;
  const pausa = new Promise<void>((r) => { liberar = r; });
  let sinalizarPausa!: () => void;
  const emPausa = new Promise<void>((r) => { sinalizarPausa = r; });
  const atr = atribuir(pool, orgId, processoId, gestor, novo, { _testeAntesDoCommit: async () => { sinalizarPausa(); await pausa; } });
  await emPausa;
  assert.equal(await responsavelDe(pool, processoId), analistaOriginal, 'antes do COMMIT da reatribuição o analista ainda é o responsável visível');
  const resposta = disparar();
  await esperarAlguemNoLockConsultivo(pool);
  liberar();
  await atr;
  return resposta;
}

/* ------------------------------------------------------------------ *
 * Cenários (contrato real de registro + tracking real).
 * ------------------------------------------------------------------ */

let seq = 100;
const proximoNumero = (prefixo: string) => numeroContainer(prefixo, seq++);

async function processoMinimo(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = proximoNumero(prefixo);
  const r = await registrarProcessoDemurrage(
    contratoRegistro({ organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)], armador: o('MAERSK', 'shipping_instructions', T) }),
    { pool, hojeReferencia: '2026-09-20' },
  );
  return { processoId: r.processoId, containerId: r.containers[0].containerId, numero };
}

/** Descarga 09-01 e devolução 09-10 pelo tracking + relógios (minuta ACEITA tecnicamente; decisão de responsabilidade possível). */
async function processoComRelogios(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, diasFreeTime = 6) {
  const numero = proximoNumero(prefixo);
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T) })],
    mbl: o(`MBL${prefixo}${seq}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(diasFreeTime, 'house_document', T), masterFreeTimeDays: o(diasFreeTime, 'master_bl', T),
  }), { pool, hojeReferencia: '2026-09-20' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  await new ContainerRepository(pool).applyObservation({
    containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
  });
  await recalcularApuracaoContainer(pool, containerId, { dataReferencia: HOJE });
  return { processoId: r.processoId, containerId, numero };
}

/** Free Time 20/20, devolução no dia 9: ZERO demurrage — `finalizarProcesso` sucede sem tarifa/minuta/responsabilidade. */
const processoFinalizavelSemCusto = (pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) =>
  processoComRelogios(pool, orgId, numeroProcesso, prefixo, 20);

async function finalizar(pool: Pool, processoId: string, gestorMembershipId: string) {
  const r = await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: gestorMembershipId, config: { hoje: HOJE } });
  assert.equal(r.ok, true, `finalização recusada: ${JSON.stringify(r)}`);
}

/** Pendência ABERTA do tipo pedido no processo (reaproveita a que o registro já tiver aberto). */
async function pendenciaAberta(pool: Pool, orgId: string, processoId: string, tipo: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, $3, '{}')
     ON CONFLICT (processo_id, COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo) WHERE estado = 'aberta' DO NOTHING
     RETURNING id`,
    [orgId, processoId, tipo],
  );
  if (rows.length) return rows[0].id;
  const { rows: existente } = await pool.query(
    `SELECT id FROM demurrage_pendencias WHERE processo_id = $1 AND container_id IS NULL AND tipo = $2 AND estado = 'aberta'`,
    [processoId, tipo],
  );
  return existente[0].id;
}

const corpoPendencia = (tipo: string, motivo = 'Confirmado manualmente com o cliente.') => ({ familia: 'demurrage_pendencia', acao: 'resolver', tipo, motivo });
const corpoFallback = (valorDias: number, observadoEm: string, tag: string) => ({
  campo: 'house', valorDias, observadoEm, evidenciaRef: `evid://fallback/${tag}`, justificativa: 'HBL retificado confirmado por e-mail do armador.',
});
const corpoMinuta = (numero: string, data: string | null, tag: string) => ({ numeroInformado: numero, dataInformada: data, documento: documentoDeTeste(tag) });

/* ================================================================== *
 * 1 — Minuta técnica (pessoal).
 * ================================================================== */

test('P1 ações pessoais #1 — minuta: ANALYST responsável registra (aceite técnico automático, sem gestor); outro ANALYST e processo sem responsável → 403 ator_nao_responsavel; MANAGER/ADMIN registram em qualquer processo e ficam como autores', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-min');
    const p1 = await processoComRelogios(pool, eq.orgId, 'IM-P1-MIN-1', 'PAMA');
    const p2 = await processoMinimo(pool, eq.orgId, 'IM-P1-MIN-2', 'PAMB');
    await atribuir(pool, eq.orgId, p1.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    const minutasDe = (containerId: string) => pool.query(`SELECT count(*)::int AS n FROM minutas WHERE container_id = $1`, [containerId]).then((r) => r.rows[0].n);

    await esperar403NaoResponsavel(await post(app.base, `/containers/${p1.containerId}/minutas`, corpoMinuta(p1.numero, '2026-09-10', 'a2'), eq.a2.home, randomUUID()), 'ANALYST não responsável');
    await esperar403NaoResponsavel(await post(app.base, `/containers/${p2.containerId}/minutas`, corpoMinuta(p2.numero, '2026-09-10', 'a1-sem'), eq.a1.home, randomUUID()), 'ANALYST em processo sem responsável');
    assert.equal(await minutasDe(p1.containerId), 0, 'recusa = zero escrita');
    assert.equal(await minutasDe(p2.containerId), 0, 'recusa = zero escrita');

    const ok = await post(app.base, `/containers/${p1.containerId}/minutas`, corpoMinuta(p1.numero, '2026-09-10', 'a1'), eq.a1.home, randomUUID());
    assert.equal(ok.status, 201);
    const bodyOk = await ok.json();
    assert.equal(bodyOk.estado, 'ACEITA', 'aceite técnico automático no próprio registro — nenhuma aprovação de gestor');
    const { rows: m1 } = await pool.query(
      `SELECT m.recebida_por, d.incluido_por_membership_id FROM minutas m JOIN documentos d ON d.minuta_id = m.id WHERE m.id = $1`, [bodyOk.minutaId],
    );
    assert.equal(m1[0].recebida_por, eq.a1.usuarioId);
    assert.equal(m1[0].incluido_por_membership_id, eq.a1.membershipId);

    // MANAGER em processo SEM responsável; ADMIN em processo de OUTRO analista.
    const doGestor = await post(app.base, `/containers/${p2.containerId}/minutas`, corpoMinuta(p2.numero, '2026-09-10', 'gestor'), eq.gestor.home, randomUUID());
    assert.equal(doGestor.status, 201);
    const bodyGestor = await doGestor.json();
    const doAdmin = await post(app.base, `/containers/${p1.containerId}/minutas`, corpoMinuta(p1.numero, '2026-09-10', 'admin'), eq.admin.home, randomUUID());
    assert.equal(doAdmin.status, 201);
    const bodyAdmin = await doAdmin.json();
    const { rows: aud } = await pool.query(
      `SELECT m.id, m.recebida_por, d.incluido_por_membership_id, e.ator_usuario_id
         FROM minutas m JOIN documentos d ON d.minuta_id = m.id
         JOIN closing_events e ON e.tipo_evento = 'MINUTA_RECEBIDA' AND e.payload->>'minutaId' = m.id::text
        WHERE m.id = ANY($1::uuid[])`,
      [[bodyGestor.minutaId, bodyAdmin.minutaId]],
    );
    const porId = new Map(aud.map((r) => [r.id, r]));
    assert.equal(porId.get(bodyGestor.minutaId).recebida_por, eq.gestor.usuarioId, 'auditada como o MANAGER que agiu');
    assert.equal(porId.get(bodyGestor.minutaId).incluido_por_membership_id, eq.gestor.membershipId);
    assert.equal(porId.get(bodyGestor.minutaId).ator_usuario_id, eq.gestor.usuarioId);
    assert.equal(porId.get(bodyAdmin.minutaId).recebida_por, eq.admin.usuarioId, 'auditada como o ADMIN que agiu');
    assert.equal(porId.get(bodyAdmin.minutaId).incluido_por_membership_id, eq.admin.membershipId);
    assert.equal(await responsavelDe(pool, p1.processoId), eq.a1.membershipId, 'agir não muda a atribuição');
    assert.equal(await responsavelDe(pool, p2.processoId), null);
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 2 — Fallback manual (pessoal).
 * ================================================================== */

test('P1 ações pessoais #2 — fallback manual: ANALYST responsável aplica; outro ANALYST e processo sem responsável → 403 ator_nao_responsavel; MANAGER/ADMIN aplicam em qualquer processo e ficam como autores', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-fb');
    const p1 = await processoMinimo(pool, eq.orgId, 'IM-P1-FB-1', 'PAFA');
    const p2 = await processoMinimo(pool, eq.orgId, 'IM-P1-FB-2', 'PAFB');
    await atribuir(pool, eq.orgId, p1.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    const justificativas = () => pool.query(
      `SELECT j.autor_membership_id, o.criado_por, o.entidade_id FROM demurrage_fallback_manual_justificativas j
         JOIN field_observations o ON o.id = j.observation_id ORDER BY j.criado_em`,
    ).then((r) => r.rows);

    await esperar403NaoResponsavel(await post(app.base, `/containers/${p1.containerId}/fallback-manual`, corpoFallback(11, '2026-09-02T00:00:00Z', 'a2'), eq.a2.home), 'ANALYST não responsável');
    await esperar403NaoResponsavel(await post(app.base, `/containers/${p2.containerId}/fallback-manual`, corpoFallback(11, '2026-09-02T00:00:00Z', 'a1-sem'), eq.a1.home), 'ANALYST em processo sem responsável');
    assert.equal((await justificativas()).length, 0, 'recusa = zero escrita (nem observação, nem justificativa, nem aviso)');
    const { rows: ft } = await pool.query(`SELECT house_free_time_days FROM containers WHERE id = ANY($1::uuid[])`, [[p1.containerId, p2.containerId]]);
    assert.ok(ft.every((r) => r.house_free_time_days === null));

    const ok = await post(app.base, `/containers/${p1.containerId}/fallback-manual`, corpoFallback(12, '2026-09-03T00:00:00Z', 'a1'), eq.a1.home);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).resultado, 'aplicado');
    const doGestor = await post(app.base, `/containers/${p2.containerId}/fallback-manual`, corpoFallback(13, '2026-09-04T00:00:00Z', 'gestor'), eq.gestor.home);
    assert.equal(doGestor.status, 200, 'MANAGER em processo SEM responsável');
    const doAdmin = await post(app.base, `/containers/${p1.containerId}/fallback-manual`, corpoFallback(14, '2026-09-05T00:00:00Z', 'admin'), eq.admin.home);
    assert.equal(doAdmin.status, 200, 'ADMIN em processo de OUTRO analista');

    const j = await justificativas();
    assert.deepEqual(j.map((x) => [x.entidade_id, x.autor_membership_id, x.criado_por]), [
      [p1.containerId, eq.a1.membershipId, eq.a1.usuarioId],
      [p2.containerId, eq.gestor.membershipId, eq.gestor.usuarioId],
      [p1.containerId, eq.admin.membershipId, eq.admin.usuarioId],
    ], 'cada fallback auditado como o membership REAL que agiu');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 3 — Resolução manual de pendência (pessoal).
 * ================================================================== */

test('P1 ações pessoais #3 — pendência: ANALYST responsável resolve; outro ANALYST (também depois de resolvida) e processo sem responsável → 403; MANAGER/ADMIN resolvem e ficam como autores; erros fechados do serviço viram 4xx', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-pend');
    const p1 = await processoMinimo(pool, eq.orgId, 'IM-P1-PEND-1', 'PAPA');
    const p2 = await processoMinimo(pool, eq.orgId, 'IM-P1-PEND-2', 'PAPB');
    await atribuir(pool, eq.orgId, p1.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    const pa = await pendenciaAberta(pool, eq.orgId, p1.processoId, 'armador_ausente');
    const pb = await pendenciaAberta(pool, eq.orgId, p1.processoId, 'condicao_comercial_ausente');
    const pc = await pendenciaAberta(pool, eq.orgId, p2.processoId, 'armador_ausente');
    const estado = (id: string) => pool.query(`SELECT estado, resolvido_por FROM demurrage_pendencias WHERE id = $1`, [id]).then((r) => r.rows[0]);

    await esperar403NaoResponsavel(await post(app.base, `/pendencias/${pa}/resolver`, corpoPendencia('armador_ausente'), eq.a2.home), 'ANALYST não responsável');
    await esperar403NaoResponsavel(await post(app.base, `/pendencias/${pc}/resolver`, corpoPendencia('armador_ausente'), eq.a1.home), 'ANALYST em processo sem responsável');
    assert.equal((await estado(pa)).estado, 'aberta');
    assert.equal((await estado(pc)).estado, 'aberta');

    const ok = await post(app.base, `/pendencias/${pa}/resolver`, corpoPendencia('armador_ausente'), eq.a1.home);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).resultado, 'resolvida');
    assert.equal((await estado(pa)).resolvido_por, eq.a1.membershipId);
    // Já resolvida: quem não pode agir no processo recebe 403, nunca `ja_resolvida`.
    await esperar403NaoResponsavel(await post(app.base, `/pendencias/${pa}/resolver`, corpoPendencia('armador_ausente'), eq.a2.home), 'não responsável depois da resolução');

    const doGestor = await post(app.base, `/pendencias/${pc}/resolver`, corpoPendencia('armador_ausente'), eq.gestor.home);
    assert.equal(doGestor.status, 200, 'MANAGER em processo SEM responsável');
    assert.equal((await estado(pc)).resolvido_por, eq.gestor.membershipId, 'auditada como o MANAGER que agiu');
    const doAdmin = await post(app.base, `/pendencias/${pb}/resolver`, corpoPendencia('condicao_comercial_ausente'), eq.admin.home);
    assert.equal(doAdmin.status, 200, 'ADMIN em processo de OUTRO analista');
    assert.equal((await estado(pb)).resolvido_por, eq.admin.membershipId);

    // Mapeamento dos códigos fechados (antes: 500 genérico).
    const pd = await pendenciaAberta(pool, eq.orgId, p1.processoId, 'armador_sem_tracking');
    const soEspacos = await post(app.base, `/pendencias/${pd}/resolver`, corpoPendencia('armador_sem_tracking', '   '), eq.a1.home);
    assert.equal(soEspacos.status, 400);
    assert.deepEqual(await soEspacos.json(), { error: 'campo_obrigatorio', campo: 'motivo' });
    assert.equal((await estado(pd)).estado, 'aberta');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 4 — Solicitar reabertura (pessoal).
 * ================================================================== */

test('P1 ações pessoais #4 — solicitar reabertura: ANALYST responsável solicita; outro ANALYST → 403 (antes e depois de existir a reabertura — nunca `ja_existe`); MANAGER/ADMIN solicitam em qualquer processo e ficam como autores', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-reab');
    const p1 = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-REAB-1', 'PARA');
    const p2 = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-REAB-2', 'PARB');
    const p3 = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-REAB-3', 'PARC');
    await atribuir(pool, eq.orgId, p1.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    await atribuir(pool, eq.orgId, p3.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    for (const p of [p1, p2, p3]) await finalizar(pool, p.processoId, eq.gestor.membershipId);
    const reaberturas = (processoId: string) => pool.query(`SELECT id, solicitada_por FROM reaberturas WHERE processo_id = $1`, [processoId]).then((r) => r.rows);
    const corpo = { justificativa: 'Free Time corrigido pelo armador.' };

    await esperar403NaoResponsavel(await post(app.base, `/processos/${p1.processoId}/reabertura/solicitar`, corpo, eq.a2.home), 'ANALYST não responsável');
    await esperar403NaoResponsavel(await post(app.base, `/processos/${p2.processoId}/reabertura/solicitar`, corpo, eq.a1.home), 'ANALYST em processo sem responsável');
    assert.equal((await reaberturas(p1.processoId)).length, 0);
    assert.equal((await reaberturas(p2.processoId)).length, 0);

    const ok = await post(app.base, `/processos/${p1.processoId}/reabertura/solicitar`, corpo, eq.a1.home);
    assert.equal(ok.status, 201);
    const { reaberturaId } = await ok.json();
    assert.equal((await reaberturas(p1.processoId))[0].solicitada_por, eq.a1.usuarioId);
    await esperar403NaoResponsavel(await post(app.base, `/processos/${p1.processoId}/reabertura/solicitar`, corpo, eq.a2.home), 'não responsável com reabertura já aberta');
    const doGestorJaExiste = await post(app.base, `/processos/${p1.processoId}/reabertura/solicitar`, corpo, eq.gestor.home);
    assert.equal(doGestorJaExiste.status, 200);
    assert.deepEqual(await doGestorJaExiste.json(), { resultado: 'ja_existe', reaberturaId });

    const doGestor = await post(app.base, `/processos/${p2.processoId}/reabertura/solicitar`, corpo, eq.gestor.home);
    assert.equal(doGestor.status, 201, 'MANAGER em processo SEM responsável');
    assert.equal((await reaberturas(p2.processoId))[0].solicitada_por, eq.gestor.usuarioId, 'auditada como o MANAGER que agiu');
    const doAdmin = await post(app.base, `/processos/${p3.processoId}/reabertura/solicitar`, corpo, eq.admin.home);
    assert.equal(doAdmin.status, 201, 'ADMIN em processo de OUTRO analista');
    assert.equal((await reaberturas(p3.processoId))[0].solicitada_por, eq.admin.usuarioId);
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 5 — Ações ORGANIZACIONAIS: ANALYST nunca (nem responsável).
 * ================================================================== */

test('P1 ações organizacionais #5 — decidir responsabilidade, finalizar, autorizar reabertura e atribuir: ANALYST (mesmo responsável) → 403 como antes; MANAGER/ADMIN preservam a autoridade em processo sem responsável', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-org');
    const pResp = await processoComRelogios(pool, eq.orgId, 'IM-P1-ORG-1', 'PAOA');
    const pFin = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-ORG-2', 'PAOB');
    const pReab = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-ORG-3', 'PAOC');
    for (const p of [pResp, pFin, pReab]) await atribuir(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    await finalizar(pool, pReab.processoId, eq.gestor.membershipId);
    const sol = await post(app.base, `/processos/${pReab.processoId}/reabertura/solicitar`, { justificativa: 'Corrigir.' }, eq.a1.home);
    assert.equal(sol.status, 201);
    const { reaberturaId } = await sol.json();

    const { rows: rel } = await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [pResp.containerId]);
    const decisao = {
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel[0].primeiro_dia_demurrage, fim: rel[0].data_final_apuracao }],
      justificativa: 'Sem causa Rocket alegada.', evidenciaRef: 'evid://resp-p1',
    };
    const negadas: Array<[string, Response, string]> = [
      ['decidir responsabilidade', await post(app.base, `/containers/${pResp.containerId}/responsabilidade`, decisao, eq.a1.home), 'AUTOR_NAO_AUTORIZADO'],
      ['finalizar', await post(app.base, `/processos/${pFin.processoId}/finalizar`, {}, eq.a1.home), 'apenas_manager_admin'],
      ['autorizar reabertura', await post(app.base, `/reaberturas/${reaberturaId}/autorizar`, {}, eq.a1.home), 'apenas_manager_admin'],
      ['atribuir', await post(app.base, `/processos/${pFin.processoId}/responsavel`, { membershipId: eq.a2.membershipId, responsavelAtual: eq.a1.membershipId, motivo: 'm' }, eq.a1.home, randomUUID()), 'apenas_manager_admin'],
    ];
    for (const [acao, res, codigo] of negadas) {
      assert.equal(res.status, 403, `${acao}: ANALYST responsável continua sem autoridade organizacional`);
      assert.equal((await res.json()).error, codigo, acao);
    }
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM responsabilidade_decisoes`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [pFin.processoId])).rows[0].apuracao_status, 'OPEN');
    assert.equal((await pool.query(`SELECT estado FROM reaberturas WHERE id = $1`, [reaberturaId])).rows[0].estado, 'SOLICITADA');
    assert.equal(await responsavelDe(pool, pFin.processoId), eq.a1.membershipId);

    // MANAGER/ADMIN: qualquer processo da organização (aqui, de outro / sem responsável).
    await atribuir(pool, eq.orgId, pResp.processoId, eq.gestor.membershipId, null);
    const decidiu = await post(app.base, `/containers/${pResp.containerId}/responsabilidade`, decisao, eq.gestor.home);
    assert.equal(decidiu.status, 200, 'MANAGER decide em processo SEM responsável');
    const { rows: dec } = await pool.query(`SELECT autor_membership_id, autor_papel FROM responsabilidade_decisoes WHERE container_id = $1`, [pResp.containerId]);
    assert.deepEqual(dec[0], { autor_membership_id: eq.gestor.membershipId, autor_papel: 'MANAGER' });
    const finalizou = await post(app.base, `/processos/${pFin.processoId}/finalizar`, {}, eq.admin.home);
    assert.equal(finalizou.status, 200, 'ADMIN finaliza processo de outro analista');
    const autorizou = await post(app.base, `/reaberturas/${reaberturaId}/autorizar`, {}, eq.gestor.home);
    assert.equal(autorizou.status, 200);
    assert.equal((await autorizou.json()).resultado, 'autorizada');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 6 — CLIENT nunca chega a nenhuma ação; minuta nunca volta a exigir gestor.
 * ================================================================== */

test('P1 #6 — CLIENT → 403 em toda rota de ação (antes de qualquer leitura de recurso)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await new OrganizationRepository(pool).create('Org cliente', `p1-cli-${randomUUID().slice(0, 6)}`);
    const cliente = await membro(pool, org.id, 'CLIENT');
    const id = randomUUID();
    const rotas = [
      `/containers/${id}/fallback-manual`, `/containers/${id}/responsabilidade`, `/containers/${id}/minutas`, `/minutas/${id}/validar`,
      `/processos/${id}/finalizar`, `/processos/${id}/reabertura/solicitar`, `/reaberturas/${id}/autorizar`, `/pendencias/${id}/resolver`,
      `/processos/${id}/responsavel`,
    ];
    for (const r of rotas) {
      const res = await post(app.base, r, {}, cliente.home, randomUUID());
      assert.equal(res.status, 403, r);
      assert.equal((await res.json()).error, 'usuario_sem_papel_interno', r);
    }
  } finally { await app.close(); await pool.end(); }
});

test('P1 #7 — nenhuma aprovação de minuta por gestor: `/minutas/:id/validar` segue 410 para ANALYST, MANAGER e ADMIN, sem nenhuma escrita', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-410');
    const p = await processoMinimo(pool, eq.orgId, 'IM-P1-410', 'PAVA');
    await atribuir(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    const reg = await post(app.base, `/containers/${p.containerId}/minutas`, corpoMinuta(p.numero, '2026-09-10', 'v410'), eq.a1.home, randomUUID());
    assert.equal(reg.status, 201);
    const { minutaId, estado } = await reg.json();
    const antes = (await pool.query(`SELECT estado_minuta, atualizado_em FROM minutas WHERE id = $1`, [minutaId])).rows[0];
    for (const quem of [eq.a1, eq.a2, eq.gestor, eq.admin]) {
      const res = await post(app.base, `/minutas/${minutaId}/validar`, { aprovar: true }, quem.home);
      assert.equal(res.status, 410);
      assert.deepEqual(await res.json(), { error: 'rota_removida', detalhe: { substituidaPor: 'aceite_tecnico_automatico_no_registro' } });
    }
    const depois = (await pool.query(`SELECT estado_minuta, atualizado_em FROM minutas WHERE id = $1`, [minutaId])).rows[0];
    assert.deepEqual(depois, antes, 'nenhuma escrita na minuta');
    assert.equal(estado, depois.estado_minuta);
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 8 — Membership DESATIVADO: rejeitado em todos os serviços de ação.
 * ================================================================== */

test('P1 #8 — membership desativado: o middleware recusa (403 membership_inativo) E todo serviço de ação recusa com o código "não autorizado" existente, mesmo se o desativado ainda é o responsável', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-inat');
    const gestor2 = await membro(pool, eq.orgId, 'MANAGER');
    const pAberto = await processoComRelogios(pool, eq.orgId, 'IM-P1-INAT-1', 'PADA');
    const pFinal = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-INAT-2', 'PADB');
    const pReab = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-INAT-3', 'PADC');
    const pFin = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-INAT-4', 'PADD');
    for (const p of [pAberto, pFinal]) await atribuir(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    await finalizar(pool, pFinal.processoId, eq.gestor.membershipId);
    await finalizar(pool, pReab.processoId, eq.gestor.membershipId);
    const sol = await new ClosingService(pool).solicitarReabertura({ processoId: pReab.processoId, membershipId: eq.gestor.membershipId, justificativa: 'Corrigir.' });
    assert.equal(sol.ok, true);
    const pend = await pendenciaAberta(pool, eq.orgId, pAberto.processoId, 'armador_ausente');

    await desativar(pool, eq.a1.membershipId);
    await desativar(pool, gestor2.membershipId);
    assert.equal(await responsavelDe(pool, pAberto.processoId), eq.a1.membershipId, 'a desativação não retira a atribuição (o handoff a tolera)');

    // HTTP: a sessão do desativado já para no middleware.
    const http = await post(app.base, `/containers/${pAberto.containerId}/minutas`, corpoMinuta(pAberto.numero, '2026-09-10', 'inat'), eq.a1.home, randomUUID());
    assert.equal(http.status, 403);
    assert.equal((await http.json()).error, 'membership_inativo');

    // Serviços (chamados diretamente — a régua vale para qualquer chamador).
    const minuta = await registrarMinutaTecnica(pool, {
      containerId: pAberto.containerId, membershipId: eq.a1.membershipId, numeroInformado: pAberto.numero, dataInformada: '2026-09-10',
      documento: documentoDeTeste('inat'), hoje: HOJE,
    });
    assert.deepEqual(minuta, { ok: false, motivo: 'ator_nao_autorizado' });
    await assert.rejects(
      resolverPendenciaManual(pool, { pendenciaId: pend, organizationId: eq.orgId, autorMembershipId: eq.a1.membershipId, motivo: 'm' }),
      (e: any) => e.codigo === 'AUTOR_NAO_AUTORIZADO',
    );
    const fb = await aplicarFallbackManualContainer(pool, {
      organizationId: eq.orgId, numeroProcesso: 'IM-P1-INAT-1', numeroContainer: pAberto.numero, campo: 'house', valorDias: 9,
      observadoEm: T, evidenciaRef: 'evid://inat', autorMembershipId: eq.a1.membershipId, justificativa: 'j',
    });
    assert.equal(fb.ok, false);
    assert.equal((fb as any).codigo, 'MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO');
    assert.equal((fb as any).detalhe.motivo, 'membership_inativo');
    const svc = new ClosingService(pool);
    assert.deepEqual(await svc.solicitarReabertura({ processoId: pFinal.processoId, membershipId: eq.a1.membershipId, justificativa: 'j' }), { ok: false, motivo: 'ator_nao_autorizado' });
    assert.deepEqual(await svc.autorizarReabertura({ reaberturaId: (sol as any).reaberturaId, membershipId: gestor2.membershipId, config: { hoje: HOJE } }), { ok: false, motivo: 'apenas_manager_admin' });
    assert.deepEqual(await svc.finalizarProcesso({ processoId: pFin.processoId, membershipId: gestor2.membershipId, config: { hoje: HOJE } }), { ok: false, motivo: 'apenas_manager_admin' });
    const { rows: rel } = await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [pAberto.containerId]);
    const dec = await decidirResponsabilidade(pool, {
      organizationId: eq.orgId, containerId: pAberto.containerId, autorMembershipId: gestor2.membershipId,
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE', justificativa: 'j', evidenciaRef: 'e',
      periodos: [{ lado: 'CLIENTE', inicio: rel[0].primeiro_dia_demurrage, fim: rel[0].data_final_apuracao }],
      motivoEstruturado: null, substituiDecisaoId: null, motivoCorrecao: null, hojeReferencia: HOJE,
    } as any);
    assert.equal(dec.ok, false);
    assert.equal((dec as any).codigo, 'AUTOR_NAO_AUTORIZADO');

    const { rows: n } = await pool.query(
      `SELECT (SELECT count(*) FROM minutas)::int AS minutas, (SELECT count(*) FROM demurrage_fallback_manual_justificativas)::int AS fallbacks,
              (SELECT count(*) FROM responsabilidade_decisoes)::int AS decisoes,
              (SELECT count(*) FROM reaberturas WHERE processo_id = $1)::int AS reab_final,
              (SELECT estado FROM demurrage_pendencias WHERE id = $2) AS pend,
              (SELECT apuracao_status FROM processos WHERE id = $3) AS fin`,
      [pFinal.processoId, pend, pFin.processoId],
    );
    assert.deepEqual(n[0], { minutas: 0, fallbacks: 0, decisoes: 0, reab_final: 0, pend: 'aberta', fin: 'OPEN' }, 'nenhuma escrita por ator desativado');
  } finally { await app.close(); await pool.end(); }
});

test('P1 #9 — desativação que comita enquanto a ação espera o lock do processo é respeitada (a checagem do ator roda sob o lock, não no middleware)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  const segurador = await pool.connect();
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-inat-corrida');
    const p = await processoMinimo(pool, eq.orgId, 'IM-P1-INATC', 'PAIA');
    await atribuir(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId);

    await segurador.query('BEGIN');
    await lockProcesso(segurador, p.processoId);
    const resposta = post(app.base, `/containers/${p.containerId}/minutas`, corpoMinuta(p.numero, '2026-09-10', 'corrida-inat'), eq.a1.home, randomUUID());
    await esperarAlguemNoLockConsultivo(pool); // o middleware já aceitou a sessão ATIVA
    await desativar(pool, eq.a1.membershipId);
    await segurador.query('COMMIT');

    const res = await resposta;
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'ator_nao_autorizado');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM minutas WHERE container_id = $1`, [p.containerId])).rows[0].n, 0);
  } finally { await segurador.query('ROLLBACK').catch(() => undefined); segurador.release(); await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 10 — Réplica idempotente nunca vaza para quem não pode agir.
 * ================================================================== */

test('P1 #10 — réplica idempotente: ANALYST não responsável nunca recebe a resposta de outro (minuta, mesma Idempotency-Key) nem a própria depois de perder a atribuição (minuta e fallback)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-replay');
    const a3 = await membro(pool, eq.orgId, 'ANALYST');
    const p1 = await processoMinimo(pool, eq.orgId, 'IM-P1-REP-1', 'PAKA');
    const p2 = await processoMinimo(pool, eq.orgId, 'IM-P1-REP-2', 'PAKB');
    for (const p of [p1, p2]) await atribuir(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    const chave = `minuta-${randomUUID()}`;
    const corpo = corpoMinuta(p1.numero, '2026-09-10', 'replay');

    const original = await post(app.base, `/containers/${p1.containerId}/minutas`, corpo, eq.a1.home, chave);
    assert.equal(original.status, 201);
    const { minutaId } = await original.json();

    // Sem a checagem antes da réplica, A3 receberia 200 com a minuta de A1 (o hash não inclui o ator).
    await esperar403NaoResponsavel(await post(app.base, `/containers/${p1.containerId}/minutas`, corpo, a3.home, chave), 'outro ANALYST com a MESMA chave');
    const doGestor = await post(app.base, `/containers/${p1.containerId}/minutas`, corpo, eq.gestor.home, chave);
    assert.equal(doGestor.status, 200, 'MANAGER pode agir no processo: recebe a réplica');
    assert.equal((await doGestor.json()).minutaId, minutaId);

    const fb = corpoFallback(10, '2026-09-06T00:00:00Z', 'replay');
    const fbOriginal = await post(app.base, `/containers/${p2.containerId}/fallback-manual`, fb, eq.a1.home);
    assert.equal(fbOriginal.status, 200);

    // A1 perde a atribuição dos dois processos; o retry idêntico não devolve mais "sucesso".
    await atribuir(pool, eq.orgId, p1.processoId, eq.gestor.membershipId, eq.a2.membershipId);
    await atribuir(pool, eq.orgId, p2.processoId, eq.gestor.membershipId, eq.a2.membershipId);
    await esperar403NaoResponsavel(await post(app.base, `/containers/${p1.containerId}/minutas`, corpo, eq.a1.home, chave), 'retry da minuta depois da reatribuição');
    await esperar403NaoResponsavel(await post(app.base, `/containers/${p2.containerId}/fallback-manual`, fb, eq.a1.home), 'retry do fallback depois da reatribuição');

    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM minutas WHERE container_id = $1)::int AS minutas, (SELECT count(*) FROM demurrage_fallback_manual_justificativas)::int AS fallbacks`,
      [p1.containerId],
    );
    assert.deepEqual(rows[0], { minutas: 1, fallbacks: 1 }, 'nenhuma recusa escreveu nada');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * 11 — Corrida: reatribuição × ação pessoal (checagem sob o lock).
 * ================================================================== */

test('P1 #11 — corrida determinística: reatribuição comitada enquanto a ação do analista espera o lock do processo → 403 ator_nao_responsavel, zero escrita (minuta, pendência, fallback, reabertura)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const eq = await equipe(pool, 'p1-corrida');
    const pMin = await processoMinimo(pool, eq.orgId, 'IM-P1-COR-1', 'PACA');
    const pPend = await processoMinimo(pool, eq.orgId, 'IM-P1-COR-2', 'PACB');
    const pFb = await processoMinimo(pool, eq.orgId, 'IM-P1-COR-3', 'PACC');
    const pReab = await processoFinalizavelSemCusto(pool, eq.orgId, 'IM-P1-COR-4', 'PACD');
    for (const p of [pMin, pPend, pFb, pReab]) await atribuir(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId);
    await finalizar(pool, pReab.processoId, eq.gestor.membershipId);
    const pend = await pendenciaAberta(pool, eq.orgId, pPend.processoId, 'armador_ausente');
    const corrida = (p: { processoId: string }, disparar: () => Promise<Response>) =>
      corridaComReatribuicao(pool, eq.orgId, p.processoId, eq.gestor.membershipId, eq.a1.membershipId, eq.a2.membershipId, disparar);

    await esperar403NaoResponsavel(
      await corrida(pMin, () => post(app.base, `/containers/${pMin.containerId}/minutas`, corpoMinuta(pMin.numero, '2026-09-10', 'corrida'), eq.a1.home, randomUUID())),
      'minuta');
    await esperar403NaoResponsavel(
      await corrida(pPend, () => post(app.base, `/pendencias/${pend}/resolver`, corpoPendencia('armador_ausente'), eq.a1.home)),
      'pendência');
    await esperar403NaoResponsavel(
      await corrida(pFb, () => post(app.base, `/containers/${pFb.containerId}/fallback-manual`, corpoFallback(15, '2026-09-07T00:00:00Z', 'corrida'), eq.a1.home)),
      'fallback');

    // Processo FINAL: a atribuição pelo serviço recusa FINAL — a reatribuição
    // concorrente é simulada sob o MESMO lock consultivo, em outra conexão.
    const segurador = await pool.connect();
    try {
      await segurador.query('BEGIN');
      await lockProcesso(segurador, pReab.processoId);
      await segurador.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [pReab.processoId, eq.a2.membershipId]);
      assert.equal(await responsavelDe(pool, pReab.processoId), eq.a1.membershipId, 'antes do COMMIT o analista ainda é o responsável visível');
      const resposta = post(app.base, `/processos/${pReab.processoId}/reabertura/solicitar`, { justificativa: 'Corrigir.' }, eq.a1.home);
      await esperarAlguemNoLockConsultivo(pool);
      await segurador.query('COMMIT');
      await esperar403NaoResponsavel(await resposta, 'solicitar reabertura');
    } finally { await segurador.query('ROLLBACK').catch(() => undefined); segurador.release(); }

    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM minutas WHERE container_id = $1)::int AS minutas,
              (SELECT estado FROM demurrage_pendencias WHERE id = $2) AS pend,
              (SELECT count(*) FROM demurrage_fallback_manual_justificativas)::int AS fallbacks,
              (SELECT count(*) FROM reaberturas WHERE processo_id = $3)::int AS reaberturas`,
      [pMin.containerId, pend, pReab.processoId],
    );
    assert.deepEqual(rows[0], { minutas: 0, pend: 'aberta', fallbacks: 0, reaberturas: 0 }, 'nenhuma ação passou depois da reatribuição');

    // O NOVO responsável age normalmente no mesmo processo.
    const doNovo = await post(app.base, `/pendencias/${pend}/resolver`, corpoPendencia('armador_ausente'), eq.a2.home);
    assert.equal(doNovo.status, 200);
  } finally { await app.close(); await pool.end(); }
});


test('P1 ações — D10: manual_fallback de ANALYST num processo que a PRÓPRIA entrada cria é recusado (não há responsável persistido); MANAGER cria; ANALYST responsável do processo existente registra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const e = await equipe(pool, 'd10novo');
    const gov = (autorMembershipId: string): ManualFallbackGovernanca =>
      ({ justificativa: 'Free Time confirmado por telefone — nenhuma fonte documental disponível', autorMembershipId });
    const entrada = (processo: string, autor: string) => contratoRegistro({
      organizationId: e.orgId, numeroProcesso: processo, containers: [containerContrato(proximoNumero('DNVA'))],
      houseFreeTimeDays: o(9, 'manual_fallback', T, 'email-operacional.eml', gov(autor)),
    });
    // (a) ANALYST, processo novo: recusado ANTES de qualquer escrita — nada é criado.
    await assert.rejects(
      registrarProcessoDemurrage(entrada('IM-D10-NOVO-A', e.a1.membershipId), { pool }),
      (err: unknown) => err instanceof ErroContratoDemurrage && err.codigo === 'MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO'
        && err.detalhe.motivo === 'ator_nao_responsavel',
    );
    const { rows: nada } = await pool.query(`SELECT 1 FROM processos WHERE organization_id = $1 AND numero_processo = 'IM-D10-NOVO-A'`, [e.orgId]);
    assert.equal(nada.length, 0, 'a recusa desfaz a criação do processo');
    // (b) MANAGER, processo novo: registra.
    const rM = await registrarProcessoDemurrage(entrada('IM-D10-NOVO-M', e.gestor.membershipId), { pool });
    assert.equal(rM.status, 'registrado');
    // (c) ANALYST responsável PERSISTIDO de um processo existente: registra (controle positivo).
    const rM2 = await registrarProcessoDemurrage(entrada('IM-D10-EXIST', e.gestor.membershipId), { pool });
    await pool.query(`UPDATE processos SET responsavel_operacional_membership_id = $2 WHERE id = $1`, [rM2.processoId, e.a1.membershipId]);
    const outra = contratoRegistro({
      organizationId: e.orgId, numeroProcesso: 'IM-D10-EXIST', containers: [containerContrato(proximoNumero('DEXA'))],
      masterFreeTimeDays: o(7, 'manual_fallback', T, 'email-operacional-2.eml', gov(e.a1.membershipId)),
    });
    assert.equal((await registrarProcessoDemurrage(outra, { pool })).status, 'registrado');
  } finally { await pool.end(); }
});
