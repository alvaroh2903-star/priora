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
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { ClosingService } from '../closing/closingService';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { criarDemurrageAcoesRouter } from '../../routes/demurrageAcoesRoutes';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';
import { registrarMinutaIdempotente } from '../acoes/minutaIdempotencia';
import { reavaliarMinutasDoProcesso } from '../closing/minutaTecnica';
import { normalizarIdempotencyKey, IdempotencyKeyInvalida } from '../acoes/idempotencyKey';
import { documentoDeTeste } from './minutaTestHelper';
import { novoMembro } from './responsabilidadeTestHelper';

/** Produção P1 (correção de minuta): o registro exige o documento (referência auditável). Fixo — retries idênticos mantêm o mesmo hash. */
const DOC_E2 = documentoDeTeste('entrega2-documento-fixo');

/**
 * Produção P1 (Entrega 2 v1.2) — suíte de aceitação da corretiva FINAL de
 * integridade sobre a v1.1 (commit 86ad7fa), já aprovada (1090/1090). Três
 * achados, cada um uma fronteira de integridade distinta:
 *
 *  - achado #1: a organização da identidade de idempotência da minuta
 *    (`minutas.idempotencia_organizacao_id`) não era amarrada, PELO BANCO, à
 *    organização real do contêiner-alvo (`containers.organization_id`) — só
 *    a rota HTTP conferia isso. Migration 0044 acrescenta a FK composta
 *    `(container_id, idempotencia_organizacao_id) REFERENCES containers (id,
 *    organization_id)`, reusando `containers_id_org_unique` (0020).
 *  - achado #2: a guarda de "minuta já processada" só existia na rota
 *    (pré-leitura sob `comLockPorChave`) — `ClosingService.validarMinuta`,
 *    chamado diretamente, reprocessava uma minuta já VALIDADA/REJEITADA. A
 *    guarda definitiva agora vive DENTRO do serviço, depois do lock
 *    consultivo e da releitura travada da minuta.
 *  - achado #3: o cabeçalho `Idempotency-Key` não tinha limite de tamanho
 *    nem conjunto de caracteres — `acoes/idempotencyKey.ts` normaliza e
 *    valida ANTES de qualquer tentativa de escrita; migration 0044
 *    acrescenta uma CHECK de tamanho como defesa em profundidade no banco.
 *
 * Mesmo padrão HTTP das suítes anteriores desta família (D12 Gate G7):
 * `requireAuth` real é substituído por um middleware de teste que só injeta
 * `req.session.homeAccountId` a partir do cabeçalho `x-test-home-account-id`
 * — o RBAC real (`autorizarInterno`) roda SEM substituição nenhuma.
 */

const url = testDatabaseUrl();
const T = '2026-09-01T00:00:00Z';
const cfg = { hoje: '2026-09-20' as any };

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
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: 'erro_interno', detalhe: String(err?.message ?? err) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api/demurrage/v2/acoes`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
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

function post(base: string, caminho: string, body: unknown, home?: string, cabecalhos: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(home ? { 'x-test-home-account-id': home } : {}), ...cabecalhos },
    body: JSON.stringify(body ?? {}),
  });
}

async function processoComRelogios(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string, diasFreeTime = 6) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)],
    mbl: o(`MBL${prefixo}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(diasFreeTime, 'house_document', T), masterFreeTimeDays: o(diasFreeTime, 'master_bl', T),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-09-20' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  await new ContainerRepository(pool).applyObservation({
    containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
  });
  await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-09-20' });
  return { processoId: r.processoId, containerId, numero };
}

/** Insere processo+contêiner CRUS (sem motor), só para os testes de integridade de banco (achado #1). */
async function containerCru(pool: Pool, orgId: string, numero: string): Promise<string> {
  const { rows: [proc] } = await pool.query(`INSERT INTO processos (organization_id, numero_processo) VALUES ($1, $2) RETURNING id`, [orgId, `PROC-${numero}`]);
  const { rows: [c] } = await pool.query(`INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1, $2, $3) RETURNING id`, [orgId, proc.id, numero]);
  return c.id;
}

/* ========================================================================= *
 * 1-6 — achado #1: organização da identidade de idempotência da minuta
 * amarrada, PELO BANCO, à organização real do contêiner (migration 0044).
 * ========================================================================= */

test('v1.2 #1: identidade de idempotência com a organização CORRETA do contêiner é aceita (rota e adaptador direto)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-01');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V12-01', 'ECSA');

    const r1 = await post(app.base, `/containers/${containerId}/minutas`, { documento: DOC_E2, numeroInformado: numero, dataInformada: '2026-09-10' }, home, { 'idempotency-key': randomUUID() });
    assert.equal(r1.status, 201);

    const containerId2 = await containerCru(pool, org.id, numeroContainer('ECSB', 1));
    const direto = await registrarMinutaIdempotente(pool, {
      organizationId: org.id, containerId: containerId2, numeroInformado: null, dataInformada: null, evidenciaRef: null,
      membershipId: await novoMembro(pool, org.id, 'ANALYST'), documento: DOC_E2, hoje: '2026-10-01',
      idempotenciaRota: 'registrar_minuta', idempotenciaChave: randomUUID(),
    });
    assert.ok(direto.ok, `organização correta deveria ser aceita (${JSON.stringify(direto)})`);
  } finally { await app.close(); await pool.end(); }
});

test('v1.2 #2: SQL direto gravando idempotencia_organizacao_id de OUTRA organização que a do container é rejeitado pelo banco', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'v12-02-a');
    const orgB = await criarOrg(pool, 'v12-02-b');
    const containerIdA = await containerCru(pool, orgA.id, numeroContainer('ECSC', 1));

    await assert.rejects(
      () => pool.query(
        `INSERT INTO minutas (container_id, estado_minuta, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
         VALUES ($1, 'RECEBIDA', $2, 'registrar_minuta', $3, 'hash-teste')`,
        [containerIdA, orgB.id, randomUUID()],
      ),
      /minutas_idempotencia_organizacao_do_container/,
      'FK composta deveria recusar: contêiner é da orgA, idempotência diz orgB',
    );

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerIdA]);
    assert.equal(rows[0].n, 0, 'nenhuma linha foi gravada — a rejeição é total');
  } finally { await pool.end(); }
});

test('v1.2 #3: chamada direta ao adaptador (fora da rota) com organização DIFERENTE do contêiner é rejeitada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'v12-03-a');
    const orgB = await criarOrg(pool, 'v12-03-b');
    const containerIdA = await containerCru(pool, orgA.id, numeroContainer('ECSD', 1));

    // A rota HTTP confere organizacaoDoContainer ANTES de chamar o adaptador;
    // este teste prova que, mesmo SEM essa checagem de rota, o banco por si
    // só recusa — a garantia não depende de nenhum chamador lembrar de checar.
    // Membership REAL de A (o ator é resolvido na organização do contêiner); a
    // identidade de idempotência diz B — é o BANCO que recusa a mistura.
    const membroA = await novoMembro(pool, orgA.id, 'ANALYST');
    await assert.rejects(
      () => registrarMinutaIdempotente(pool, {
        organizationId: orgB.id, containerId: containerIdA, numeroInformado: null, dataInformada: null, evidenciaRef: null,
        membershipId: membroA, documento: DOC_E2, hoje: '2026-10-01',
        idempotenciaRota: 'registrar_minuta', idempotenciaChave: randomUUID(),
      }),
      /minutas_idempotencia_organizacao_do_container|foreign key/,
    );

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerIdA]);
    assert.equal(rows[0].n, 0, 'a chamada direta rejeitada não deixou nenhuma minuta órfã');
  } finally { await pool.end(); }
});

test('v1.2 #4: linhas de minuta anteriores à 0044 (legadas e idempotentes) sobrevivem intactas à migration', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0043_acoes_minuta_idempotencia_atomica.sql' });

    const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Legado', 'legado-v12') RETURNING id`);
    const { rows: [proc] } = await pool.query(`INSERT INTO processos (organization_id, numero_processo) VALUES ($1, 'PROC-LEG') RETURNING id`, [org.id]);
    const { rows: [c] } = await pool.query(`INSERT INTO containers (organization_id, processo_id, numero) VALUES ($1, $2, 'LEGV1200001') RETURNING id`, [org.id, proc.id]);

    // Legada: upload direto (sem idempotência) — as quatro colunas ficam NULL.
    const { rows: [legada] } = await pool.query(
      `INSERT INTO minutas (container_id, estado_minuta, numero_informado) VALUES ($1, 'RECEBIDA', 'LEGV1200001') RETURNING id`,
      [c.id],
    );
    // Idempotente, já com a organização CORRETA (único jeito que a rota já produzia).
    const { rows: [idempotente] } = await pool.query(
      `INSERT INTO minutas (container_id, estado_minuta, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
       VALUES ($1, 'RECEBIDA', $2, 'registrar_minuta', 'chave-legada-v12', 'hash-legado') RETURNING id`,
      [c.id, org.id],
    );

    const r = await runMigrations(pool);
    assert.ok(r.applied.includes('0044_acoes_minuta_idempotencia_tenant_e_chave.sql'));

    const { rows: depois } = await pool.query(`SELECT id, estado_minuta, idempotencia_organizacao_id, idempotencia_chave FROM minutas WHERE id IN ($1,$2) ORDER BY id`, [legada.id, idempotente.id]);
    assert.equal(depois.length, 2, 'as duas linhas sobreviveram à migration');
    const legadaDepois = depois.find((r2) => r2.id === legada.id)!;
    assert.equal(legadaDepois.idempotencia_organizacao_id, null, 'linha legada permanece sem idempotência — nunca é "corrigida" retroativamente');
    const idempotenteDepois = depois.find((r2) => r2.id === idempotente.id)!;
    assert.equal(idempotenteDepois.idempotencia_organizacao_id, org.id);
    assert.equal(idempotenteDepois.idempotencia_chave, 'chave-legada-v12');
  } finally {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    await pool.end();
  }
});

test('v1.2 #5: banco novo — migração limpa 0001→0044 cria a FK composta e a CHECK de tamanho', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const r = await runMigrations(pool);
    assert.equal(r.applied[r.applied.length - 1], '0048_minuta_aceite_tecnico_encerramento_automatico.sql');

    const { rows: fk } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'minutas_idempotencia_organizacao_do_container'`,
    );
    assert.equal(fk.length, 1, 'FK composta existe no banco novo');
    const { rows: chk } = await pool.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'minutas_idempotencia_chave_tamanho'`,
    );
    assert.equal(chk.length, 1, 'CHECK de tamanho existe no banco novo');

    const r2 = await runMigrations(pool);
    assert.deepEqual(r2.applied, [], 'reexecutar não reaplica nada');
  } finally { await pool.end(); }
});

test('v1.2 #6: upgrade 0043→0044 aplica sobre um banco com minutas idempotentes pré-existentes e passa a valer para novas linhas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0043_acoes_minuta_idempotencia_atomica.sql' });

    const orgA = await criarOrg(pool, 'v12-06-a');
    const orgB = await criarOrg(pool, 'v12-06-b');
    const containerIdA = await containerCru(pool, orgA.id, numeroContainer('ECSE', 1));
    await pool.query(
      `INSERT INTO minutas (container_id, estado_minuta, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
       VALUES ($1, 'RECEBIDA', $2, 'registrar_minuta', 'chave-pre-0044', 'hash-pre-0044')`,
      [containerIdA, orgA.id],
    );

    const r = await runMigrations(pool);
    assert.ok(r.applied.includes('0044_acoes_minuta_idempotencia_tenant_e_chave.sql'), 'a migration 0044 aplica sobre um banco com linhas 0043 pré-existentes');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE idempotencia_chave = 'chave-pre-0044'`);
    assert.equal(rows[0].n, 1, 'a linha pré-existente permanece intacta — a 0044 nunca a tocou');

    // Depois do upgrade, a FK já vale para escritas NOVAS.
    await assert.rejects(
      () => pool.query(
        `INSERT INTO minutas (container_id, estado_minuta, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
         VALUES ($1, 'RECEBIDA', $2, 'registrar_minuta', 'chave-pos-0044', 'hash-pos-0044')`,
        [containerIdA, orgB.id],
      ),
      /minutas_idempotencia_organizacao_do_container/,
    );
  } finally {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);
    await pool.end();
  }
});

/* ========================================================================= *
 * 7-12 — achado #2: guarda definitiva de já-processada DENTRO do serviço.
 *
 * Produção P1 (correção de minuta): `ClosingService.validarMinuta` e a rota
 * `POST /minutas/:id/validar` (aprovação de MANAGER/ADMIN) foram REMOVIDOS —
 * a regra de produto mudou: o aceite é técnico e automático, no registro e
 * na reavaliação quando os fatos mudam. As expectativas antigas (uma
 * "validação efetiva" + réplica `ja_validada`/`ja_rejeitada`) deixaram de
 * valer porque não existe mais decisão humana a proteger. A GARANTIA de
 * fundo do achado #2 — o serviço, chamado direto e em concorrência, nunca
 * reprocessa nem duplica efeito — é reprovada aqui sobre o que a substituiu.
 * ========================================================================= */

test('v1.2 #7 (P1): duas reavaliações CONCORRENTES da mesma minuta (sem rota, sem lock de rota) produzem exatamente UM aceite técnico', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-07');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const membershipId = await membershipIdPorHome(pool, home);
    const { processoId, containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V12-07', 'ECSF');
    const svc = new ClosingService(pool);
    const r = await svc.registrarMinuta({ containerId, membershipId, numeroInformado: numero, dataInformada: '2026-09-10', documento: DOC_E2, config: cfg });
    assert.ok(r.ok && r.minuta.estado === 'ACEITA');
    // Simula "registrada antes do tracking" (RECEBIDA aguardando a devolução) — o caso em que a reavaliação decide.
    await pool.query(
      `UPDATE minutas SET estado_minuta = 'RECEBIDA', aguardando = 'DEVOLUCAO_TRACKING', data_tracking_comparada = NULL,
              fatos_avaliacao = jsonb_build_object('tracking', NULL, 'descarga', '2026-09-01', 'gateOut', NULL) WHERE id = $1`,
      [r.ok && r.minuta.id],
    );
    const antes = (await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_ACEITA'`, [containerId])).rows[0].n;

    const [a, b] = await Promise.all([
      reavaliarMinutasDoProcesso(pool, processoId, cfg.hoje),
      reavaliarMinutasDoProcesso(pool, processoId, cfg.hoje),
    ]);
    assert.equal(a.reavaliadas + b.reavaliadas, 1, `exatamente UMA reavaliação efetiva (${JSON.stringify([a, b])})`);
    const depois = (await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_ACEITA'`, [containerId])).rows[0].n;
    assert.equal(depois - antes, 1, 'exatamente UM evento de aceite — nunca duplicado por concorrência direta no serviço');
    assert.equal((await pool.query(`SELECT estado_minuta FROM minutas WHERE container_id = $1`, [containerId])).rows[0].estado_minuta, 'ACEITA');
  } finally { await pool.end(); }
});

test('v1.2 #8 (P1): reavaliação repetida de uma minuta já ACEITA é um no-op estrito (sem UPDATE, sem evento, sem recálculo)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-08');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const membershipId = await membershipIdPorHome(pool, home);
    const { processoId, containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V12-08', 'ECSG');
    const svc = new ClosingService(pool);
    const r = await svc.registrarMinuta({ containerId, membershipId, numeroInformado: numero, dataInformada: '2026-09-10', documento: DOC_E2, config: cfg });
    assert.ok(r.ok && r.minuta.estado === 'ACEITA');
    const linhaAntes = (await pool.query(`SELECT atualizado_em, avaliada_em FROM minutas WHERE container_id = $1`, [containerId])).rows[0];
    const eventosAntes = (await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1`, [containerId])).rows[0].n;

    for (let i = 0; i < 3; i++) assert.deepEqual(await reavaliarMinutasDoProcesso(pool, processoId, cfg.hoje), { reavaliadas: 0 });

    assert.deepEqual((await pool.query(`SELECT atualizado_em, avaliada_em FROM minutas WHERE container_id = $1`, [containerId])).rows[0], linhaAntes, 'nenhum UPDATE');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1`, [containerId])).rows[0].n, eventosAntes, 'nenhum evento novo (nem RECALCULO)');
  } finally { await pool.end(); }
});

test('v1.2 #9 (P1): reavaliação repetida de uma minuta INCONSISTENTE é um no-op estrito (sem evento, pendência intocada)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-09');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const membershipId = await membershipIdPorHome(pool, home);
    const { processoId, containerId } = await processoComRelogios(pool, org.id, 'IM-V12-09', 'ECSH');
    const svc = new ClosingService(pool);
    // Número informado DIVERGENTE do contêiner real -> INCONSISTENTE (NUMERO_DIVERGENTE).
    const r = await svc.registrarMinuta({ containerId, membershipId, numeroInformado: 'NUMERO0ERRADO', dataInformada: '2026-09-10', documento: DOC_E2, config: cfg });
    assert.ok(r.ok && r.minuta.estado === 'INCONSISTENTE' && r.minuta.motivoRejeicao === 'NUMERO_DIVERGENTE');
    const pendAntes = (await pool.query(`SELECT id, estado FROM demurrage_pendencias WHERE container_id = $1`, [containerId])).rows;

    assert.deepEqual(await reavaliarMinutasDoProcesso(pool, processoId, cfg.hoje), { reavaliadas: 0 });
    assert.deepEqual(await reavaliarMinutasDoProcesso(pool, processoId, cfg.hoje), { reavaliadas: 0 });

    const { rows: eventos } = await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_INCONSISTENTE'`, [containerId]);
    assert.equal(eventos[0].n, 1, 'exatamente UM evento de inconsistência — a reavaliação nunca grava de novo');
    assert.deepEqual((await pool.query(`SELECT id, estado FROM demurrage_pendencias WHERE container_id = $1`, [containerId])).rows, pendAntes);
  } finally { await pool.end(); }
});

test('v1.2 #12 (P1): a rota de validação foi REMOVIDA — requisições concorrentes recebem ambas 410, nenhuma leitura de minuta, nenhum evento', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-12');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V12-12', 'ECSI');
    const reg = await post(app.base, `/containers/${containerId}/minutas`, { documento: DOC_E2, numeroInformado: numero, dataInformada: '2026-09-10' }, homeAnalyst, { 'idempotency-key': randomUUID() });
    const { minutaId, estado } = await reg.json();
    assert.equal(estado, 'ACEITA', 'o aceite já aconteceu no registro, sem gestor');
    const eventosAntes = (await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1`, [containerId])).rows[0].n;

    const chamar = () => post(app.base, `/minutas/${minutaId}/validar`, {}, homeManager);
    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    assert.deepEqual([r1.status, r2.status], [410, 410]);
    assert.deepEqual(await r1.json(), { error: 'rota_removida', detalhe: { substituidaPor: 'aceite_tecnico_automatico_no_registro' } });
    assert.equal((await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1`, [containerId])).rows[0].n, eventosAntes);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 13-18 — achado #3: contrato de transporte do Idempotency-Key.
 * ========================================================================= */

test('v1.2 #13: Idempotency-Key vazio é rejeitado (400)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-13');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-V12-13', 'ECSJ');
    const r = await post(app.base, `/containers/${containerId}/minutas`, { documento: DOC_E2, numeroInformado: 'x', dataInformada: '2026-09-10' }, home, { 'idempotency-key': '' });
    assert.equal(r.status, 400);
  } finally { await app.close(); await pool.end(); }
});

test('v1.2 #14: Idempotency-Key só com espaço em branco é rejeitado — pelo contrato puro (400) e, quando o cabeçalho sobrevive ao transporte HTTP, pela rota', { skip: !url }, async () => {
  // O parser HTTP (RFC 7230, OWS) já remove espaço em branco nas BORDAS de um
  // cabeçalho em trânsito — um valor "só espaço" chega ao Express como ''
  // (idêntico a ausente), nunca como espaço preservado. A validação de
  // CONTEÚDO (depois do trim) é testada diretamente na função pura; a rota
  // é testada com o valor '' que o transporte realmente entrega.
  assert.throws(() => normalizarIdempotencyKey('   '), IdempotencyKeyInvalida);
  assert.throws(() => normalizarIdempotencyKey('\t\n '), IdempotencyKeyInvalida);

  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-14');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-V12-14', 'ECSK');
    const r = await post(app.base, `/containers/${containerId}/minutas`, { documento: DOC_E2, numeroInformado: 'x', dataInformada: '2026-09-10' }, home, { 'idempotency-key': '   ' });
    assert.equal(r.status, 400, 'o transporte HTTP entrega isso como cabeçalho vazio — ainda assim 400, nunca aceito como chave válida');
  } finally { await app.close(); await pool.end(); }
});

test('v1.2 #15: Idempotency-Key acima do limite (200 caracteres) é rejeitado (400 idempotency_key_invalida)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-15');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-V12-15', 'ECSL');
    const chaveGigante = 'a'.repeat(201);
    const r = await post(app.base, `/containers/${containerId}/minutas`, { documento: DOC_E2, numeroInformado: 'x', dataInformada: '2026-09-10' }, home, { 'idempotency-key': chaveGigante });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'idempotency_key_invalida');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 0, 'nada chegou a ser gravado — rejeitado ANTES do banco');
  } finally { await app.close(); await pool.end(); }
});

test('v1.2 #16: Idempotency-Key com caractere fora do conjunto permitido (espaço interno/aspas) é rejeitado (400 idempotency_key_invalida)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-16');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-V12-16', 'ECSM');
    for (const chaveInvalida of ['chave com espaco', 'chave"aspas', 'chave\\barra']) {
      const r = await post(app.base, `/containers/${containerId}/minutas`, { documento: DOC_E2, numeroInformado: 'x', dataInformada: '2026-09-10' }, home, { 'idempotency-key': chaveInvalida });
      assert.equal(r.status, 400, `deveria rejeitar: ${JSON.stringify(chaveInvalida)}`);
      assert.equal((await r.json()).error, 'idempotency_key_invalida');
    }
  } finally { await app.close(); await pool.end(); }
});

test('v1.2 #17: chaves equivalentes (mesmo valor, espaço nas bordas diferente) são normalizadas para a MESMA identidade', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-17');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V12-17', 'ECSN');
    const corpo = { documento: DOC_E2, numeroInformado: numero, dataInformada: '2026-09-10' };

    const r1 = await post(app.base, `/containers/${containerId}/minutas`, corpo, home, { 'idempotency-key': '  CHAVE-EQUIVALENTE-V12-17  ' });
    assert.equal(r1.status, 201);
    const b1 = await r1.json();

    const r2 = await post(app.base, `/containers/${containerId}/minutas`, corpo, home, { 'idempotency-key': 'CHAVE-EQUIVALENTE-V12-17' });
    assert.equal(r2.status, 200, 'reconhecida como a MESMA chave (normalizada) — retry, não conflito');
    const b2 = await r2.json();
    assert.equal(b2.minutaId, b1.minutaId);

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'exatamente uma minuta — as duas grafias da chave são a mesma identidade');

    // A função pura de normalização concorda com o comportamento observado pela rota.
    assert.equal(normalizarIdempotencyKey('  CHAVE-EQUIVALENTE-V12-17  '), normalizarIdempotencyKey('CHAVE-EQUIVALENTE-V12-17'));
    assert.throws(() => normalizarIdempotencyKey('   '), IdempotencyKeyInvalida);
  } finally { await app.close(); await pool.end(); }
});

test('v1.2 #18: o banco, por si só, recusa uma idempotencia_chave persistida além do limite (defesa em profundidade)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v12-18');
    const containerId = await containerCru(pool, org.id, numeroContainer('ECSO', 1));
    const chaveGigante = 'b'.repeat(201);

    await assert.rejects(
      () => pool.query(
        `INSERT INTO minutas (container_id, estado_minuta, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
         VALUES ($1, 'RECEBIDA', $2, 'registrar_minuta', $3, 'hash-gigante')`,
        [containerId, org.id, chaveGigante],
      ),
      /minutas_idempotencia_chave_tamanho/,
    );

    // Uma chave DENTRO do limite, pela mesma via direta, continua aceita — a
    // CHECK é sobre tamanho, nunca sobre a via de escrita.
    await pool.query(
      `INSERT INTO minutas (container_id, estado_minuta, idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
       VALUES ($1, 'RECEBIDA', $2, 'registrar_minuta', $3, 'hash-ok')`,
      [containerId, org.id, 'a'.repeat(200)],
    );
    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'só a linha dentro do limite foi gravada');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 21 — nenhum arquivo de frontend alterado (mesma disciplina da v1.1 #24).
 * ========================================================================= */

test('v1.2 #21: nenhum arquivo de frontend (public/, .html, .css) está entre as mudanças não commitadas desta corretiva', () => {
  const { execSync } = require('child_process');
  const saida = execSync('git status --porcelain', { cwd: __dirname + '/../../..', encoding: 'utf8' });
  const caminhosProibidos = saida
    .split('\n')
    .map((linha: string) => linha.slice(3))
    .filter((caminho: string) => caminho.startsWith('public/') || caminho.endsWith('.html') || caminho.endsWith('.css'));
  assert.deepEqual(caminhosProibidos, [], `arquivos de frontend não deveriam estar entre as mudanças: ${caminhosProibidos.join(', ')}`);
});
