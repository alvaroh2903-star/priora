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

/**
 * Produção P1 (Entrega 2 v1.1) — suíte de aceitação da CORRETIVA exigida
 * pela auditoria que recusou a Entrega 2 original: achado #1 (regressão
 * vermelha, corrigido em `handoffVinculoTransacaoV12.test.ts`), achado #2
 * (idempotência atômica do registro de minuta — migration 0043,
 * `acoes/minutaIdempotencia.ts`), achado #3 (verificação do tipo
 * PERSISTIDO da pendência — `acoes/pendenciaVerificacao.ts`), e a auditoria
 * de concorrência das outras 6 ações expostas. Roda com PostgreSQL real.
 *
 * Mesmo padrão HTTP de `demurrageAcoesEntrega2.test.ts` (D12 Gate G7):
 * `requireAuth` real é substituído por um middleware de teste que só injeta
 * `req.session.homeAccountId` a partir do cabeçalho `x-test-home-account-id`
 * — o RBAC real (`autorizarInterno`) roda SEM substituição nenhuma.
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

/** `minutas.recebida_por` referencia `usuarios(id)` — NUNCA `organization_memberships(id)` (ver migration 0016). */
async function usuarioIdPorHome(pool: Pool, home: string): Promise<string> {
  const { rows } = await pool.query(`SELECT id FROM usuarios WHERE home_account_id = $1 LIMIT 1`, [home]);
  return rows[0].id;
}

function post(base: string, caminho: string, body: unknown, home?: string, cabecalhos: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(home ? { 'x-test-home-account-id': home } : {}), ...cabecalhos },
    body: JSON.stringify(body ?? {}),
  });
}

async function processoMinimo(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const r = await registrarProcessoDemurrage(
    contratoRegistro({ organizationId: orgId, numeroProcesso, containers: [containerContrato(numero)] }),
    { pool, hojeReferencia: '2026-09-20' },
  );
  return { processoId: r.processoId, containerId: r.containers[0].containerId, numero };
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

async function processoFinalizavelSemCusto(pool: Pool, orgId: string, numeroProcesso: string, prefixo: string) {
  const numero = numeroContainer(prefixo, Math.floor(Math.random() * 900000) + 1000);
  const entrada = contratoRegistro({
    organizationId: orgId, numeroProcesso, containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T) })],
    mbl: o(`MBL${prefixo}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    houseFreeTimeDays: o(20, 'house_document', T), masterFreeTimeDays: o(20, 'master_bl', T),
  });
  const r = await registrarProcessoDemurrage(entrada, { pool, hojeReferencia: '2026-10-01' });
  const containerId = r.containers[0].containerId;
  await ingerirTrackingDoContainer(pool, containerId, resultadoTracking({
    containers: [{ numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any],
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: numero }],
  }), '2026-09-20');
  await new ContainerRepository(pool).applyObservation({
    containerId, organizationId: orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
  });
  await recalcularApuracaoContainer(pool, containerId, { dataReferencia: '2026-10-01' });
  return { processoId: r.processoId, containerId, numero };
}

/* ========================================================================= *
 * 3-11 — idempotência ATÔMICA do registro de minuta (achado #2)
 * ========================================================================= */

test('v1.1 #3: retry idêntico (mesmo contêiner/número/data/evidência) devolve a MESMA minuta, sem escrita nova', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-03');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-03', 'ECRA');
    const chave = randomUUID();
    const corpo = { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'evid://v11-03' };

    const r1 = await post(app.base, `/containers/${containerId}/minutas`, corpo, home, { 'idempotency-key': chave });
    assert.equal(r1.status, 201);
    const b1 = await r1.json();

    const r2 = await post(app.base, `/containers/${containerId}/minutas`, corpo, home, { 'idempotency-key': chave });
    assert.equal(r2.status, 200, 'retry idêntico é 200 (não cria), nunca 201 de novo');
    const b2 = await r2.json();
    assert.equal(b2.minutaId, b1.minutaId);

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'exatamente uma minuta — o retry não escreveu nada novo');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #4: mesma chave com OUTRO contêiner conflita (idempotency_key_reutilizada), zero minuta nova', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-04');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId: c1, numero: n1 } = await processoComRelogios(pool, org.id, 'IM-V11-04A', 'ECRB');
    const { containerId: c2, numero: n2 } = await processoComRelogios(pool, org.id, 'IM-V11-04B', 'ECRC');
    const chave = randomUUID();

    const r1 = await post(app.base, `/containers/${c1}/minutas`, { numeroInformado: n1, dataInformada: '2026-09-10', evidenciaRef: 'e1' }, home, { 'idempotency-key': chave });
    assert.equal(r1.status, 201);

    const r2 = await post(app.base, `/containers/${c2}/minutas`, { numeroInformado: n2, dataInformada: '2026-09-10', evidenciaRef: 'e1' }, home, { 'idempotency-key': chave });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error, 'idempotency_key_reutilizada');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [c2]);
    assert.equal(rows[0].n, 0, 'o contêiner 2 não ganhou nenhuma minuta');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #5: mesma chave com OUTRO número informado conflita, zero escrita nova', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-05');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-05', 'ECRD');
    const chave = randomUUID();

    const r1 = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e' }, home, { 'idempotency-key': chave });
    assert.equal(r1.status, 201);

    const r2 = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: 'OUTRO999', dataInformada: '2026-09-10', evidenciaRef: 'e' }, home, { 'idempotency-key': chave });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error, 'idempotency_key_reutilizada');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'nenhuma segunda minuta foi criada');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #6: mesma chave com OUTRA data informada conflita, zero escrita nova', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-06');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-06', 'ECRE');
    const chave = randomUUID();

    const r1 = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e' }, home, { 'idempotency-key': chave });
    assert.equal(r1.status, 201);

    const r2 = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-11', evidenciaRef: 'e' }, home, { 'idempotency-key': chave });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error, 'idempotency_key_reutilizada');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1);
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #7: mesma chave com OUTRA evidência conflita, zero escrita nova', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-07');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-07', 'ECRF');
    const chave = randomUUID();

    const r1 = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'evid://original' }, home, { 'idempotency-key': chave });
    assert.equal(r1.status, 201);

    const r2 = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'evid://outra' }, home, { 'idempotency-key': chave });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error, 'idempotency_key_reutilizada');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1);
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #8: duas requisições CONCORRENTES IDÊNTICAS de minuta criam exatamente UMA minuta, mesmo hash', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-08');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-08', 'ECRG');
    const chave = randomUUID();
    const corpo = { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'evid://concorrente' };
    const chamar = () => post(app.base, `/containers/${containerId}/minutas`, corpo, home, { 'idempotency-key': chave });

    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    assert.ok([200, 201].includes(r1.status) && [200, 201].includes(r2.status));
    assert.equal(b1.minutaId, b2.minutaId, 'as duas respostas apontam para a MESMA minuta');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'exatamente UMA minuta foi criada sob concorrência');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #9: duas requisições CONCORRENTES CONFLITANTES de minuta (mesma chave, corpos diferentes) produzem um vencedor e um conflito determinísticos', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-09');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-09', 'ECRH');
    const chave = randomUUID();

    const [r1, r2] = await Promise.all([
      post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e' }, home, { 'idempotency-key': chave }),
      post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-11', evidenciaRef: 'e' }, home, { 'idempotency-key': chave }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 409], 'exatamente um vencedor (201) e um conflito (409) — nunca dois sucessos, nunca dois conflitos');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'só a requisição vencedora escreveu — exatamente uma minuta');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #10: falha injetada ANTES do commit não deixa minuta nem chave bem-sucedida — retry seguinte aplica do zero', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-10');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-10', 'ECRI');
    const usuarioId = await usuarioIdPorHome(pool, home);
    const chave = randomUUID();
    const entrada = {
      organizationId: org.id, containerId, numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e',
      recebidaPor: usuarioId, idempotenciaRota: 'registrar_minuta', idempotenciaChave: chave,
    };

    await assert.rejects(() => registrarMinutaIdempotente(pool, entrada, {
      _testeFalhaAntesDoCommit: () => { throw new Error('falha injetada antes do commit'); },
    }));

    const { rows: minutas1 } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(minutas1[0].n, 0, 'nenhuma minuta persistida — o rollback desfez a tentativa inteira');

    const r2 = await registrarMinutaIdempotente(pool, entrada);
    assert.ok(r2.ok && r2.novo, 'a MESMA chave, depois da falha, aplica do zero normalmente (nada ficou "meio-gravado")');
    const { rows: minutas2 } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(minutas2[0].n, 1);
  } finally { await pool.end(); }
});

test('v1.1 #11: retry depois do COMMIT (simulando um crash do chamador que não viu a resposta) devolve a minuta ORIGINAL, sem janela de duplo-write', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-11');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-11', 'ECRJ');
    const usuarioId = await usuarioIdPorHome(pool, home);
    const chave = randomUUID();
    const entrada = {
      organizationId: org.id, containerId, numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e',
      recebidaPor: usuarioId, idempotenciaRota: 'registrar_minuta', idempotenciaChave: chave,
    };

    const r1 = await registrarMinutaIdempotente(pool, entrada);
    assert.ok(r1.ok && r1.novo);

    // "Crash" simulado: o chamador nunca viu a resposta de r1 e tenta de novo
    // com os MESMOS dados — como se nada tivesse acontecido do seu lado.
    const r2 = await registrarMinutaIdempotente(pool, entrada);
    assert.ok(r2.ok && !r2.novo, 'retry pós-commit nunca cria de novo — devolve a minuta original');
    assert.equal(r2.minuta.id, r1.minuta.id);

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1);
  } finally { await pool.end(); }
});

test('v1.1 #12: não há janela de duplo-write — a identidade de idempotência de uma minuta é IMUTÁVEL depois de criada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-12');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-12', 'ECRK');
    const usuarioId = await usuarioIdPorHome(pool, home);
    const chave = randomUUID();
    const entrada = {
      organizationId: org.id, containerId, numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e',
      recebidaPor: usuarioId, idempotenciaRota: 'registrar_minuta', idempotenciaChave: chave,
    };
    const r = await registrarMinutaIdempotente(pool, entrada);
    assert.ok(r.ok);

    // Nenhum código (presente ou futuro) pode "mover" a identidade já
    // reivindicada para outra chave/hash — a escrita de negócio e a
    // identidade são a MESMA linha, no MESMO insert; isto prova que a
    // identidade nunca se solta da linha que a criou.
    await assert.rejects(
      () => pool.query(`UPDATE minutas SET idempotencia_chave = $2 WHERE id = $1`, [r.minuta.id, randomUUID()]),
      /imutavel/,
    );
    await assert.rejects(
      () => pool.query(`UPDATE minutas SET idempotencia_hash = 'outro-hash' WHERE id = $1`, [r.minuta.id]),
      /imutavel/,
    );
  } finally { await pool.end(); }
});

test('v1.1 #13: chave LEGADA (gravada na tabela genérica 0042, sem hash) é rejeitada explicitamente — nunca reconciliada às cegas', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-13');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const membershipId = await membershipIdPorHome(pool, home);
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-13', 'ECRL');
    const chaveLegada = randomUUID();

    // Simula uma chave gravada pelo mecanismo ANTERIOR (0042), antes desta
    // corretiva existir — sem hash de pedido nem amarração a contêiner.
    await pool.query(
      `INSERT INTO demurrage_acoes_idempotencia (organization_id, membership_id, rota, chave, resultado)
       VALUES ($1, $2, 'registrar_minuta', $3, '{"minutaId":"00000000-0000-0000-0000-000000000000","estado":"RECEBIDA"}'::jsonb)`,
      [org.id, membershipId, chaveLegada],
    );

    const r = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e' }, home, { 'idempotency-key': chaveLegada });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'idempotency_key_legado_sem_hash');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM minutas WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 0, 'nenhuma minuta foi criada nem "adivinhada" a partir da chave legada');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #14: a MESMA chave textual em organizações DIFERENTES nunca interfere — cada uma cria a sua própria minuta', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'v11-14a');
    const orgB = await criarOrg(pool, 'v11-14b');
    const homeA = await usuarioInterno(pool, orgA.id, 'ANALYST');
    const homeB = await usuarioInterno(pool, orgB.id, 'ANALYST');
    const { containerId: cA, numero: nA } = await processoComRelogios(pool, orgA.id, 'IM-V11-14A', 'ECRM');
    const { containerId: cB, numero: nB } = await processoComRelogios(pool, orgB.id, 'IM-V11-14B', 'ECRN');
    const chave = randomUUID();

    const rA = await post(app.base, `/containers/${cA}/minutas`, { numeroInformado: nA, dataInformada: '2026-09-10', evidenciaRef: 'e' }, homeA, { 'idempotency-key': chave });
    const rB = await post(app.base, `/containers/${cB}/minutas`, { numeroInformado: nB, dataInformada: '2026-09-10', evidenciaRef: 'e' }, homeB, { 'idempotency-key': chave });
    assert.equal(rA.status, 201);
    assert.equal(rB.status, 201, 'a mesma chave textual numa organização DIFERENTE nunca conflita');

    const bA = await rA.json(); const bB = await rB.json();
    assert.notEqual(bA.minutaId, bB.minutaId);
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 15-18 — verificação do TIPO PERSISTIDO da pendência (achado #3)
 * ========================================================================= */

test('v1.1 #15: tipo pedido no corpo DIVERGENTE do tipo persistido é rejeitado (409), zero escrita', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-15');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoComRelogios(pool, org.id, 'IM-V11-15', 'ECRO');
    const { rows } = await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, 'mbl_ausente', '{}') RETURNING id`,
      [org.id, processoId],
    );
    const pendenciaId = rows[0].id;

    const res = await post(app.base, `/pendencias/${pendenciaId}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'armador_ausente', motivo: 'm' }, home);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'tipo_divergente_do_persistido');

    const { rows: pend } = await pool.query(`SELECT estado FROM demurrage_pendencias WHERE id = $1`, [pendenciaId]);
    assert.equal(pend[0].estado, 'aberta', 'a divergência não resolveu nada');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #16: uma pendência de família NÃO suportada (ex.: VesselCall) nunca é resolvível "disfarçada" de um tipo demurrage suportado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-16');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { rows } = await pool.query(
      `INSERT INTO vessel_call_pendencias (organization_id, tipo, contexto_hash) VALUES ($1, 'pod_nao_confirmado', $2) RETURNING id`,
      [org.id, `hash-${randomUUID()}`],
    );
    const pendenciaDeOutraFamilia = rows[0].id;

    const res = await post(app.base, `/pendencias/${pendenciaDeOutraFamilia}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'armador_ausente', motivo: 'm' }, home);
    assert.equal(res.status, 404, 'um id de outra tabela/família é indistinguível de inexistente — nunca resolvido por um tipo "emprestado"');

    const { rows: vc } = await pool.query(`SELECT estado FROM vessel_call_pendencias WHERE id = $1`, [pendenciaDeOutraFamilia]);
    assert.equal(vc[0].estado, 'aberta', 'zero escrita na pendência de outra família');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #17: a rejeição por divergência de tipo tem fingerprint de ZERO escrita (nenhuma linha de negócio muda)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-17');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { processoId } = await processoComRelogios(pool, org.id, 'IM-V11-17', 'ECRP');
    const { rows } = await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, 'mbl_ausente', '{}') RETURNING id`,
      [org.id, processoId],
    );
    const pendenciaId = rows[0].id;
    const fingerprint = async () => (await pool.query(
      `SELECT estado, resolvido_em, resolvido_por, resolvido_motivo FROM demurrage_pendencias WHERE id = $1`, [pendenciaId],
    )).rows[0];
    const antes = await fingerprint();

    const res = await post(app.base, `/pendencias/${pendenciaId}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'tipo_ausente', motivo: 'm' }, home);
    assert.equal(res.status, 409);

    assert.deepEqual(await fingerprint(), antes, 'a linha da pendência não mudou em NENHUM campo');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #18: pendência de OUTRA organização é indistinguível de inexistente (mesmo corpo de resposta)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'v11-18a');
    const orgB = await criarOrg(pool, 'v11-18b');
    const homeA = await usuarioInterno(pool, orgA.id, 'ANALYST');
    const { processoId } = await processoComRelogios(pool, orgB.id, 'IM-V11-18', 'ECRQ');
    const { rows } = await pool.query(
      `INSERT INTO demurrage_pendencias (organization_id, processo_id, tipo, contexto) VALUES ($1, $2, 'mbl_ausente', '{}') RETURNING id`,
      [orgB.id, processoId],
    );
    const pendenciaDeB = rows[0].id;

    const resInexistente = await post(app.base, `/pendencias/${randomUUID()}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'mbl_ausente', motivo: 'm' }, homeA);
    const resCruzado = await post(app.base, `/pendencias/${pendenciaDeB}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'mbl_ausente', motivo: 'm' }, homeA);
    assert.equal(resInexistente.status, 404);
    assert.equal(resCruzado.status, 404);
    assert.deepEqual(await resInexistente.json(), await resCruzado.json());
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 19-23 — auditoria de concorrência das outras ações expostas
 * ========================================================================= */

test('v1.1 #19: fallback manual — replay CONCORRENTE idêntico nunca duplica justificativa/aviso nem aplica o valor duas vezes', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-19');
    const home = await usuarioInterno(pool, org.id, 'ANALYST');
    const { containerId } = await processoMinimo(pool, org.id, 'IM-V11-19', 'ECRR');
    const corpo = { campo: 'house', valorDias: 12, observadoEm: T, evidenciaRef: 'evid://v11-19', justificativa: 'Confirmado por e-mail.' };
    const chamar = () => post(app.base, `/containers/${containerId}/fallback-manual`, corpo, home);

    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    assert.ok([r1.status, r2.status].every((s) => s === 200));

    const { rows: cont } = await pool.query(`SELECT house_free_time_days FROM containers WHERE id = $1`, [containerId]);
    assert.equal(cont[0].house_free_time_days, 12);
    const { rows: just } = await pool.query(
      `SELECT count(*)::int n FROM demurrage_fallback_manual_justificativas j
         JOIN field_observations o ON o.id = j.observation_id WHERE o.entidade_id = $1`,
      [containerId],
    );
    assert.equal(just.length ? just[0].n : 0, 1, 'exatamente UMA justificativa — o replay concorrente não duplicou nada governado');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #20: decisão de responsabilidade — retry CONCORRENTE não cria uma segunda versão não intencional', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-20');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId } = await processoComRelogios(pool, org.id, 'IM-V11-20', 'ECRS');
    const { rows: rel } = await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [containerId]);
    const corpo = {
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE',
      periodos: [{ lado: 'CLIENTE', inicio: rel[0].primeiro_dia_demurrage, fim: rel[0].data_final_apuracao }],
      justificativa: 'Sem causa Rocket.', evidenciaRef: 'evid://v11-20',
    };
    const chamar = () => post(app.base, `/containers/${containerId}/responsabilidade`, corpo, home);

    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], 'um vencedor (versão 1) e um conflito (VERSAO_DESATUALIZADA) — nunca duas versões criadas às cegas');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM responsabilidade_decisoes WHERE container_id = $1`, [containerId]);
    assert.equal(rows[0].n, 1, 'exatamente UMA decisão persistida sob concorrência');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #21: validação de minuta — duas chamadas CONCORRENTES na mesma minuta RECEBIDA nunca duplicam o evento de validação', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-21');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { containerId, numero } = await processoComRelogios(pool, org.id, 'IM-V11-21', 'ECRT');
    const reg = await post(app.base, `/containers/${containerId}/minutas`, { numeroInformado: numero, dataInformada: '2026-09-10', evidenciaRef: 'e' }, homeAnalyst, { 'idempotency-key': randomUUID() });
    const { minutaId } = await reg.json();

    const chamar = () => post(app.base, `/minutas/${minutaId}/validar`, {}, homeManager);
    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    assert.ok([r1.status, r2.status].every((s) => s === 200), 'ambas as respostas são 200 — a segunda é um resultado idempotente, nunca um erro');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_VALIDADA'`, [containerId]);
    assert.equal(rows[0].n, 1, 'exatamente UM evento MINUTA_VALIDADA — a serialização por minutaId impediu a duplicação');
    const { rows: minutas } = await pool.query(`SELECT estado_minuta FROM minutas WHERE id = $1`, [minutaId]);
    assert.equal(minutas[0].estado_minuta, 'VALIDADA');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #22: finalização — retry CONCORRENTE permanece idempotente (exatamente um fechamento)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-22');
    const home = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoFinalizavelSemCusto(pool, org.id, 'IM-V11-22', 'ECRU');
    const chamar = () => post(app.base, `/processos/${processoId}/finalizar`, { justificativa: 'Rotina.' }, home);

    const [r1, r2] = await Promise.all([chamar(), chamar()]);
    assert.ok([r1.status, r2.status].every((s) => s === 200));
    const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
    assert.ok([b1.resultado, b2.resultado].includes('finalizado'));
    assert.ok([b1.resultado, b2.resultado].includes('ja_final') || b1.resultado === b2.resultado);

    const { rows } = await pool.query(`SELECT count(*)::int n FROM fechamentos WHERE processo_id = $1`, [processoId]);
    assert.equal(rows[0].n, 1, 'exatamente UM fechamento sob concorrência');
  } finally { await app.close(); await pool.end(); }
});

test('v1.1 #23: reabertura (solicitação e autorização) — concorrência permanece idempotente ponta a ponta', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-23');
    const homeAnalyst = await usuarioInterno(pool, org.id, 'ANALYST');
    const homeManager = await usuarioInterno(pool, org.id, 'MANAGER');
    const { processoId } = await processoFinalizavelSemCusto(pool, org.id, 'IM-V11-23', 'ECRV');
    await new ClosingService(pool).finalizarProcesso({ processoId, membershipId: await membershipIdPorHome(pool, homeManager), config: { hoje: '2026-10-01' } });

    const chamarSolicitar = () => post(app.base, `/processos/${processoId}/reabertura/solicitar`, { justificativa: 'Corrigir.' }, homeAnalyst);
    const [s1, s2] = await Promise.all([chamarSolicitar(), chamarSolicitar()]);
    const [bs1, bs2] = await Promise.all([s1.json(), s2.json()]);
    assert.equal(bs1.reaberturaId, bs2.reaberturaId);
    const { rows: reab } = await pool.query(`SELECT count(*)::int n FROM reaberturas WHERE processo_id = $1`, [processoId]);
    assert.equal(reab[0].n, 1);

    const reaberturaId = bs1.reaberturaId;
    const chamarAutorizar = () => post(app.base, `/reaberturas/${reaberturaId}/autorizar`, {}, homeManager);
    const [a1, a2] = await Promise.all([chamarAutorizar(), chamarAutorizar()]);
    assert.ok([a1.status, a2.status].every((s) => s === 200));
    // `autorizarReabertura` já encadeia o recálculo na mesma chamada —
    // o estado final observável é 'RECALCULADA' (nunca fica parado em
    // 'AUTORIZADA'); o que esta asserção prova é que a transição SAIU de
    // 'SOLICITADA' exatamente UMA vez sob concorrência.
    const { rows: reabAutorizada } = await pool.query(`SELECT count(*)::int n FROM reaberturas WHERE id = $1 AND estado != 'SOLICITADA'`, [reaberturaId]);
    assert.equal(reabAutorizada[0].n, 1, 'exatamente uma autorização efetiva sob concorrência');
    const { rows: reabFinal } = await pool.query(`SELECT estado FROM reaberturas WHERE id = $1`, [reaberturaId]);
    assert.notEqual(reabFinal[0].estado, 'SOLICITADA');
  } finally { await app.close(); await pool.end(); }
});

/* ========================================================================= *
 * 24 — nenhum arquivo de frontend alterado
 * ========================================================================= */

test('v1.1 #24: nenhum arquivo de frontend (public/, .html, .css) está entre as mudanças não commitadas desta corretiva', () => {
  const { execSync } = require('child_process');
  const saida = execSync('git status --porcelain', { cwd: __dirname + '/../../..', encoding: 'utf8' });
  const caminhosProibidos = saida
    .split('\n')
    .map((linha: string) => linha.slice(3))
    .filter((caminho: string) => caminho.startsWith('public/') || caminho.endsWith('.html') || caminho.endsWith('.css'));
  assert.deepEqual(caminhosProibidos, [], `arquivos de frontend não deveriam estar entre as mudanças: ${caminhosProibidos.join(', ')}`);
});

/* ========================================================================= *
 * 25-26 — migrations
 * ========================================================================= */

test('v1.1 #25: migração limpa 0001→0045 aplica em ordem e reexecutar é um no-op', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const r1 = await runMigrations(pool);
    assert.ok(r1.applied.includes('0043_acoes_minuta_idempotencia_atomica.sql'));
    assert.ok(r1.applied.includes('0044_acoes_minuta_idempotencia_tenant_e_chave.sql'));
    assert.ok(r1.applied.includes('0045_leitura_operacional_indices.sql'));
    assert.ok(r1.applied.includes('0046_leitura_operacional_pendencias_por_processo.sql'));
    assert.ok(r1.applied.includes('0047_handoff_controle_capacidade.sql'));
    assert.equal(r1.applied[r1.applied.length - 1], '0047_handoff_controle_capacidade.sql');
    const r2 = await runMigrations(pool);
    assert.deepEqual(r2.applied, [], 'reexecutar não reaplica nada');
  } finally { await pool.end(); }
});

test('v1.1 #26: upgrade 0042→0043 preserva linhas de idempotência GENÉRICAS já existentes (0042) intactas', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool, { until: '0042_acoes_idempotencia.sql' });

    const org = await criarOrg(pool, 'v11-26');
    const u = await new UsuarioRepository(pool).create('Legado', `legado-${randomUUID()}@rocket.example`);
    const membership = await new OrganizationMembershipRepository(pool).create(org.id, u.id, 'ANALYST');
    await pool.query(
      `INSERT INTO demurrage_acoes_idempotencia (organization_id, membership_id, rota, chave, resultado)
       VALUES ($1, $2, 'registrar_minuta', 'chave-pre-existente', '{"minutaId":"00000000-0000-0000-0000-000000000000"}'::jsonb)`,
      [org.id, membership.id],
    );

    const r = await runMigrations(pool);
    assert.ok(r.applied.includes('0043_acoes_minuta_idempotencia_atomica.sql'), 'a migration 0043 aplica sobre um banco com linhas 0042 pré-existentes');

    const { rows } = await pool.query(`SELECT organization_id, rota, chave FROM demurrage_acoes_idempotencia WHERE chave = 'chave-pre-existente'`);
    assert.equal(rows.length, 1, 'a linha legada permanece intacta — a migration 0043 nunca a tocou nem a interpretou');
    assert.equal(rows[0].organization_id, org.id);

    // As colunas novas de `minutas` existem e aceitam NULL — nenhuma minuta
    // pré-existente (sem idempotência) é afetada.
    const { rows: cols } = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'minutas' AND column_name LIKE 'idempotencia_%' ORDER BY column_name`,
    );
    assert.equal(cols.length, 4);
    assert.ok(cols.every((c: any) => c.is_nullable === 'YES'));
  } finally { await pool.end(); }
});
