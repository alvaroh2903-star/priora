import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import express from 'express';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { numeroContainer, o } from './registroDemurrageHelpers';
import { EntradaHandoffV1, validarEntradaHandoff } from '../handoff/contrato';
import { CONTRATO_REGISTRO_DEMURRAGE_V1, RegistroProcessoDemurrageV1 } from '../registro/contrato';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { CREDENCIAL_IDENTIDADE_INTERNA, processarEventoHandoff } from '../handoff/handoffService';
import { classificarFalhaHandoff } from '../handoff/erros';
import { _resetChavesCacheParaTeste, provisionarCredencial } from '../handoff/credenciais';
import { calcularAssinatura, construirStringCanonica } from '../handoff/assinatura';
import { criarDemurrageHandoffRouter } from '../../routes/demurrageHandoffRoutes';

/**
 * Produção P1 (Entrega 1), corretiva v1.1 — suíte obrigatória dos 20
 * cenários exigidos pela auditoria (achados #1, #2 e #3 + auditoria de
 * replay). Roda com PostgreSQL real.
 *
 * Os cenários de assinatura HMAC/nonce/timestamp/rotação de credencial em
 * si (item 16) NÃO são reescritos aqui — são a suíte original
 * `handoffProducaoP1.test.ts` (Entrega 1), reexecutada sem alteração e
 * comprovadamente verde depois desta correção (ver relatório v1.1 §/evidência
 * de teste). Este arquivo acrescenta só os cenários NOVOS da v1.1 e um
 * smoke test HTTP de ponta a ponta para reconfirmar o caminho feliz depois
 * da reescrita do serviço.
 */

const url = testDatabaseUrl();
process.env.PRIORA_HANDOFF_CREDENCIAL_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.PRIORA_HANDOFF_CREDENCIAL_KEY_VERSION = '1';
_resetChavesCacheParaTeste();

const T = '2026-09-20T00:00:00Z';

async function setup(pool: Pool): Promise<void> {
  await runMigrations(pool);
  await truncateAll(pool);
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function criarOrg(pool: Pool, slug: string) {
  return new OrganizationRepository(pool).create(`Org ${slug}`, slug);
}

function ctxInterno(organizationId: string) {
  return { organizationId, credencialIdentidade: CREDENCIAL_IDENTIDADE_INTERNA };
}

let seqEvento = 0;
function entradaHandoff(p: {
  numeroProcesso: string; origemProcessoId?: string; origemEventoId?: string;
  containers?: string[]; mbl?: string | null; armador?: string | null; house?: string | null;
  houseFreeTimeDays?: number | null; masterFreeTimeDays?: number | null;
  extra?: Record<string, unknown>;
}): EntradaHandoffV1 & Record<string, unknown> {
  seqEvento += 1;
  return {
    versao: 'demurrage.handoff.v1',
    origemSistema: 'teste-upstream-v11',
    origemProcessoId: p.origemProcessoId ?? `upstream-${p.numeroProcesso}`,
    origemEventoId: p.origemEventoId ?? `evt-v11-${seqEvento}-${randomUUID()}`,
    origemOcorridoEm: T,
    numeroProcesso: p.numeroProcesso,
    mbl: p.mbl ? o(p.mbl, 'master_bl', T) : null,
    house: p.house ? o(p.house, 'house_document', T) : null,
    armador: p.armador ? o(p.armador, 'master_bl', T) : null,
    houseFreeTimeDays: p.houseFreeTimeDays != null ? o(p.houseFreeTimeDays, 'house_document', T) : null,
    masterFreeTimeDays: p.masterFreeTimeDays != null ? o(p.masterFreeTimeDays, 'master_bl', T) : null,
    containers: (p.containers ?? []).map((n) => ({ numero: n, tipoOriginal: null, houseFreeTimeDays: null, masterFreeTimeDays: null })),
    ...(p.extra ?? {}),
  } as EntradaHandoffV1 & Record<string, unknown>;
}

/** Fingerprint das tabelas de NEGÓCIO (processo/contêiner/observação/ledger D10/vínculo) — NUNCA inclui o ledger de identidade do handoff (esse é auditoria, não negócio). */
async function fingerprintNegocio(pool: Pool, organizationId: string) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM processos WHERE organization_id = $1) AS processos,
       (SELECT count(*)::int FROM containers WHERE organization_id = $1) AS containers,
       (SELECT count(*)::int FROM field_observations WHERE organization_id = $1) AS field_observations,
       (SELECT count(*)::int FROM demurrage_registros WHERE organization_id = $1) AS demurrage_registros,
       (SELECT count(*)::int FROM demurrage_handoff_processo_links WHERE organization_id = $1) AS vinculos`,
    [organizationId],
  );
  return rows[0] as { processos: number; containers: number; field_observations: number; demurrage_registros: number; vinculos: number };
}

async function buscarVinculo(pool: Pool, organizationId: string, origemSistema: string, origemProcessoId: string) {
  const { rows } = await pool.query(
    `SELECT processo_id AS "processoId" FROM demurrage_handoff_processo_links
      WHERE organization_id = $1 AND origem_sistema = $2 AND origem_processo_id = $3`,
    [organizationId, origemSistema, origemProcessoId],
  );
  return rows[0]?.processoId ?? null;
}

async function iniciarServidorHandoff(): Promise<{ baseUrl: string; caminho: string; fechar: () => Promise<void> }> {
  const app = express();
  const caminho = '/api/integracoes/demurrage/handoff/processos';
  app.use(caminho, criarDemurrageHandoffRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const porta = (server.address() as { port: number }).port;
      resolve({ baseUrl: `http://127.0.0.1:${porta}${caminho}`, caminho, fechar: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

interface EnvioHandoff { corpo: unknown; credencialId: string; segredo: string; timestamp?: string; nonce?: string }
async function enviarHandoff(baseUrl: string, caminho: string, e: EnvioHandoff): Promise<Response> {
  const corpoTexto = JSON.stringify(e.corpo ?? {});
  const timestamp = e.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = e.nonce ?? randomUUID();
  const stringCanonica = construirStringCanonica({ metodo: 'POST', caminho, timestamp, nonce, corpoBruto: Buffer.from(corpoTexto, 'utf8') });
  const assinatura = calcularAssinatura(e.segredo, stringCanonica);
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-handoff-credencial-id': e.credencialId,
      'x-handoff-timestamp': timestamp, 'x-handoff-nonce': nonce, 'x-handoff-assinatura': assinatura,
    },
    body: corpoTexto,
  });
}

/* ========================================================================= *
 * 1/2/3/4 — vínculo estável do processo (achado #1)
 * ========================================================================= */

test('v1.1 #1: primeiro evento estabelece o vínculo origemProcessoId -> processo interno', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-1');
    const n1 = numeroContainer('VFAA', 1);
    const r = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-001', origemProcessoId: 'UP-001', containers: [n1] }), ctxInterno(org.id), { pool },
    );
    assert.ok(r.resultado === 'APLICADO' || r.resultado === 'ACEITO_COM_PENDENCIA', r.resultado);
    const processoId = (r as any).processoId;
    const vinculado = await buscarVinculo(pool, org.id, 'teste-upstream-v11', 'UP-001');
    assert.equal(vinculado, processoId, 'o vínculo foi estabelecido apontando para o processo recém-criado');
  } finally { await pool.end(); }
});

test('v1.1 #2: evento posterior (mesmo origemProcessoId) atualiza o MESMO processo interno pelo vínculo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-2');
    const n1 = numeroContainer('VFAB', 1);
    const r1 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-002', origemProcessoId: 'UP-002', containers: [n1] }), ctxInterno(org.id), { pool },
    );
    const r2 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-002', origemProcessoId: 'UP-002', containers: [n1], mbl: 'MAEU000000002', armador: 'MAERSK' }),
      ctxInterno(org.id), { pool },
    );
    assert.equal((r2 as any).processoId, (r1 as any).processoId, 'resolvido pelo VÍNCULO, não por numeroProcesso lido de novo a cada chamada');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_processo_links WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, 1, 'nenhum segundo vínculo criado');
  } finally { await pool.end(); }
});

test('v1.1 #3/#4: mesmo origemProcessoId com numeroProcesso diferente conflita, com ZERO escrita de negócio', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-3');
    const r1 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-003', origemProcessoId: 'UP-003' }), ctxInterno(org.id), { pool },
    );
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');
    const fp1 = await fingerprintNegocio(pool, org.id);

    const r2 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-003-OUTRO', origemProcessoId: 'UP-003' }), ctxInterno(org.id), { pool },
    );
    assert.equal(r2.resultado, 'CONFLITO_EVENTO');
    assert.equal((r2 as any).detalhe.motivo, 'processo_vinculado_diferente');
    const fp2 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp2, fp1, 'conflito de identidade de processo não grava NADA de negócio — o D10 nunca é chamado');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 5/6 — concorrência na camada de vínculo
 * ========================================================================= */

test('v1.1 #5: primeiras entregas CONCORRENTES (mesmo origemProcessoId, mesmo numeroProcesso) convergem num único vínculo e processo', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-5');
    const [r1, r2] = await Promise.all([
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-005', origemProcessoId: 'UP-005' }), ctxInterno(org.id), { pool }),
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-005', origemProcessoId: 'UP-005' }), ctxInterno(org.id), { pool }),
    ]);
    assert.ok(['APLICADO', 'ACEITO_COM_PENDENCIA'].includes(r1.resultado), r1.resultado);
    assert.ok(['APLICADO', 'ACEITO_COM_PENDENCIA'].includes(r2.resultado), r2.resultado);
    assert.equal((r1 as any).processoId, (r2 as any).processoId, 'as duas convergem no MESMO processo');
    const { rows: links } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_processo_links WHERE organization_id = $1`, [org.id]);
    assert.equal(links[0].n, 1);
    const { rows: procs } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs[0].n, 1);
  } finally { await pool.end(); }
});

test('v1.1 #6: primeiras entregas CONCORRENTES conflitantes (mesmo origemProcessoId, numeroProcesso diferente) têm um vencedor determinístico, sem escrita extra', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-6');
    const [ra, rb] = await Promise.all([
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-006-A', origemProcessoId: 'UP-006' }), ctxInterno(org.id), { pool }),
      processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-006-B', origemProcessoId: 'UP-006' }), ctxInterno(org.id), { pool }),
    ]);
    const resultados = [ra.resultado, rb.resultado];
    const vencedores = resultados.filter((r) => r === 'APLICADO' || r === 'ACEITO_COM_PENDENCIA').length;
    const conflitos = resultados.filter((r) => r === 'CONFLITO_EVENTO').length;
    assert.equal(vencedores, 1, `exatamente um vencedor: ${resultados.join(',')}`);
    assert.equal(conflitos, 1, `exatamente um conflito: ${resultados.join(',')}`);
    const { rows: links } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_processo_links WHERE organization_id = $1`, [org.id]);
    assert.equal(links[0].n, 1, 'só o vínculo do vencedor existe');
    const { rows: procs } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs[0].n, 1, 'o perdedor NUNCA chega a chamar o D10 — nenhum processo extra foi criado');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 7 — isolamento entre organizações
 * ========================================================================= */

test('v1.1 #7: a mesma identidade a montante (sistema+origemProcessoId) em organizações diferentes não colide', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'v11-7a');
    const orgB = await criarOrg(pool, 'v11-7b');
    const ra = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-007', origemProcessoId: 'UP-007' }), ctxInterno(orgA.id), { pool });
    const rb = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-007', origemProcessoId: 'UP-007' }), ctxInterno(orgB.id), { pool });
    assert.ok(ra.resultado !== 'CONFLITO_EVENTO' && ra.resultado !== 'FALHA', ra.resultado);
    assert.ok(rb.resultado !== 'CONFLITO_EVENTO' && rb.resultado !== 'FALHA', rb.resultado);
    assert.notEqual((ra as any).processoId, (rb as any).processoId);
    const vA = await buscarVinculo(pool, orgA.id, 'teste-upstream-v11', 'UP-007');
    const vB = await buscarVinculo(pool, orgB.id, 'teste-upstream-v11', 'UP-007');
    assert.ok(vA && vB && vA !== vB);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 8/9/10 — identidade imutável do EVENTO (achado #2)
 * ========================================================================= */

test('v1.1 #8: mesmo origemEventoId com origemProcessoId diferente conflita; a linha original NUNCA é atualizada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-8');
    const eventoFixo = 'evt-v11-fixo-8';
    const r1 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-008', origemProcessoId: 'UP-008-A', origemEventoId: eventoFixo }), ctxInterno(org.id), { pool },
    );
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');
    const fp1 = await fingerprintNegocio(pool, org.id);

    const r2 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-008', origemProcessoId: 'UP-008-B', origemEventoId: eventoFixo }), ctxInterno(org.id), { pool },
    );
    assert.equal(r2.resultado, 'CONFLITO_EVENTO');
    assert.equal((r2 as any).detalhe.motivo, 'origem_processo_id_divergente_do_evento_original');
    const fp2 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp2, fp1, 'zero escrita de negócio nesta verificação — nem o D10 nem a reconciliação de SI são chamados');

    const { rows } = await pool.query(
      `SELECT origem_processo_id AS "origemProcessoId" FROM demurrage_handoff_eventos WHERE organization_id = $1 AND origem_evento_id = $2`,
      [org.id, eventoFixo],
    );
    assert.equal(rows[0].origemProcessoId, 'UP-008-A', 'a linha original nunca foi tocada — ainda é UP-008-A');
  } finally { await pool.end(); }
});

test('v1.1 #9: mesmo evento + mesma identidade imutável = replay ESTRITO (zero escrita, zero chamada ao D10)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-9');
    const n1 = numeroContainer('VFAC', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMV-009', origemProcessoId: 'UP-009', containers: [n1], origemEventoId: 'evt-v11-fixo-9' });
    const r1 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');
    const fp1 = await fingerprintNegocio(pool, org.id);

    const r2 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r2.resultado, 'REPLAY_IDEMPOTENTE');
    assert.equal((r2 as any).processoId, (r1 as any).processoId);
    const fp2 = await fingerprintNegocio(pool, org.id);
    assert.deepEqual(fp2, fp1, 'replay estrito não grava absolutamente nada de negócio');
  } finally { await pool.end(); }
});

test('v1.1 #10: a identidade imutável do evento e do vínculo também é protegida por restrições de BANCO (não só validação de aplicação)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-10');
    const r1 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-010', origemProcessoId: 'UP-010', origemEventoId: 'evt-v11-fixo-10' }), ctxInterno(org.id), { pool },
    );
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');

    // Tentar mudar origem_processo_id de uma linha de EVENTO já existente → trigger da migration 0040.
    await assert.rejects(
      () => pool.query(`UPDATE demurrage_handoff_eventos SET origem_processo_id = 'outra' WHERE organization_id = $1 AND origem_evento_id = 'evt-v11-fixo-10'`, [org.id]),
      /identidade do evento e imutavel/,
    );

    // Tentar mudar (ou apagar) o VÍNCULO já estabelecido → trigger forbid_mutation da migration 0041.
    const { rows: vinc } = await pool.query(`SELECT id FROM demurrage_handoff_processo_links WHERE organization_id = $1 AND origem_processo_id = 'UP-010'`, [org.id]);
    assert.equal(vinc.length, 1);
    await assert.rejects(
      () => pool.query(`UPDATE demurrage_handoff_processo_links SET processo_id = gen_random_uuid() WHERE id = $1`, [vinc[0].id]),
      /append-only/i,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM demurrage_handoff_processo_links WHERE id = $1`, [vinc[0].id]),
      /append-only/i,
    );
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 11 — processo FINAL permanece retido, exige reabertura
 * ========================================================================= */

test('v1.1 #11: evento para processo FINAL (vínculo já estabelecido) permanece retido e exige reabertura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-11');
    const r1 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-011', origemProcessoId: 'UP-011' }), ctxInterno(org.id), { pool },
    );
    const processoId = (r1 as any).processoId;
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL' WHERE id = $1`, [processoId]);

    const r2 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-011', origemProcessoId: 'UP-011', mbl: 'MAEU000000011' }), ctxInterno(org.id), { pool },
    );
    assert.equal(r2.resultado, 'EXIGE_REABERTURA');

    const { rows } = await pool.query(`SELECT apuracao_status FROM processos WHERE id = $1`, [processoId]);
    assert.equal(rows[0].apuracao_status, 'FINAL', 'projeção FINAL nunca mutada silenciosamente');
    const vinculoAinda = await buscarVinculo(pool, org.id, 'teste-upstream-v11', 'UP-011');
    assert.equal(vinculoAinda, processoId, 'o vínculo original permanece intacto — nada foi reatribuído');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 12 — reconciliação de SI não é chamada em conflito
 * ========================================================================= */

function espiarQuerySiReaplicar(pool: Pool): string[] {
  const chamadas: string[] = [];
  const original = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = ((...args: unknown[]) => {
    const texto = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
    if (typeof texto === 'string' && texto.includes('si_versoes') && texto.includes('ultimas')) chamadas.push(texto);
    return (original as (...a: unknown[]) => unknown)(...args);
  }) as typeof pool.query;
  return chamadas;
}

test('v1.1 #12: a reconciliação de backlog de SI NÃO é chamada quando o evento conflita (identidade de processo OU de evento)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-12');
    await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-012', origemProcessoId: 'UP-012' }), ctxInterno(org.id), { pool });

    const chamadas = espiarQuerySiReaplicar(pool);

    const conflitoProcesso = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-012-OUTRO', origemProcessoId: 'UP-012' }), ctxInterno(org.id), { pool },
    );
    assert.equal(conflitoProcesso.resultado, 'CONFLITO_EVENTO');
    assert.equal(chamadas.length, 0, 'conflito de vínculo de processo não chamou a reconciliação de SI');

    const eventoFixo = 'evt-v11-fixo-12';
    await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-012-B', origemProcessoId: 'UP-012-B', origemEventoId: eventoFixo }), ctxInterno(org.id), { pool });
    const chamadasAntesDoConflitoDeEvento = chamadas.length; // a chamada de sucesso ACIMA legitimamente incrementou o espião
    const conflitoEvento = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMV-012-B', origemProcessoId: 'UP-012-C', origemEventoId: eventoFixo }), ctxInterno(org.id), { pool },
    );
    assert.equal(conflitoEvento.resultado, 'CONFLITO_EVENTO');
    assert.equal(chamadas.length, chamadasAntesDoConflitoDeEvento, 'conflito de identidade de evento também não chamou a reconciliação de SI');

    // Sanidade: um sucesso real CHAMA a reconciliação (prova que o espião funciona e não é um falso negativo).
    await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMV-012-D', origemProcessoId: 'UP-012-D' }), ctxInterno(org.id), { pool });
    assert.ok(chamadas.length > 0, 'uma aplicação bem-sucedida DEVE chamar a reconciliação — confirma que o espião captura a query certa');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 13/14/15 — achado #3: nenhum segredo/valor recebido em persistência, log ou resposta
 * ========================================================================= */

test('v1.1 #13a (unitário): classificarFalhaHandoff nunca devolve o conteúdo de um erro injetado com um segredo', () => {
  const segredoMarcador = `SEGREDO-MARCADOR-${randomUUID()}`;
  const casos: unknown[] = [
    new Error(`falha ao conectar: senha ${segredoMarcador} inválida`),
    { name: 'DatabaseError', message: `duplicate key (x)=(${segredoMarcador})`, code: 'XXNAO' },
    { message: segredoMarcador },
    segredoMarcador,
    undefined,
  ];
  const CODIGOS_FECHADOS = new Set([
    'CONTRATO_D10_INVALIDO', 'CONTRATO_D10_FONTE_NAO_ACEITA', 'CONTRATO_D10_CONTAINER_EM_OUTRO_PROCESSO',
    'CONTRATO_D10_ORGANIZACAO_INEXISTENTE', 'CONTRATO_D10_MANUAL_FALLBACK_INVALIDO', 'CONTRATO_D10_CHAVE_IDEMPOTENCIA_REUTILIZADA',
    'CONTRATO_D10_PROCESSO_FINAL', 'POS_COMMIT_PENDENTE', 'BANCO_DADOS_RESTRICAO_INTEGRIDADE', 'BANCO_DADOS_ERRO', 'FALHA_INESPERADA',
  ]);
  for (const caso of casos) {
    const codigo = classificarFalhaHandoff(caso);
    assert.ok(CODIGOS_FECHADOS.has(codigo), `código fora do conjunto fechado: ${codigo}`);
    assert.ok(!codigo.includes(segredoMarcador), 'o código nunca pode conter o marcador do segredo');
  }
});

test('v1.1 #13b/#14: falha real (FK inválida) nunca persiste nem loga o segredo da credencial ou o valor recebido', { skip: !url }, async () => {
  const pool = testPool();
  const logs: string[] = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-13');
    const prov = await provisionarCredencial(pool, org.id, 'cred-v11-13');
    const membershipInexistente = randomUUID();
    const eventoId = 'evt-v11-falha-13';
    const entrada = entradaHandoff({
      numeroProcesso: 'IMV-013', origemProcessoId: 'UP-013', origemEventoId: eventoId,
      extra: { responsavelOperacionalMembershipId: o(membershipInexistente, 'outro', T) },
    });
    const r = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r.resultado, 'FALHA');

    const { rows } = await pool.query(
      `SELECT falha_sanitizada AS "falhaSanitizada" FROM demurrage_handoff_eventos WHERE organization_id = $1 AND origem_evento_id = $2`,
      [org.id, eventoId],
    );
    const persistido = rows[0].falhaSanitizada as string;
    assert.ok(!persistido.includes(membershipInexistente), 'o UUID recebido nunca aparece no falha_sanitizada persistido');
    assert.ok(!persistido.includes(prov.segredo), 'o segredo da credencial (nem usado nesta chamada) nunca aparece');
    assert.equal(persistido, 'BANCO_DADOS_RESTRICAO_INTEGRIDADE', 'classificação fixa — violação de FK do Postgres');

    const tudo = logs.join('\n');
    assert.ok(!tudo.includes(membershipInexistente), 'o UUID recebido nunca aparece em log');
    assert.ok(!tudo.includes(prov.segredo), 'o segredo da credencial nunca aparece em log');
  } finally {
    console.log = origLog; console.error = origErr;
    await pool.end();
  }
});

test('v1.1 #15: erro inesperado na rota HTTP devolve só a resposta genérica — nenhum marcador do erro escapa', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  const logs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-15');
    const prov = await provisionarCredencial(pool, org.id, 'cred-v11-15');
    const marcador = `MARCADOR-INESPERADO-${randomUUID()}`;

    // Pool real para a credencial (autenticação precisa funcionar), mas que
    // lança um erro contendo o marcador exatamente no INSERT de registro do
    // evento (camada A) — simula uma falha de banco verdadeiramente
    // inesperada, FORA de todo o try/catch de negócio do serviço, que só a
    // rota (adaptador fino) chega a capturar.
    const original = pool.query.bind(pool);
    (pool as unknown as { query: unknown }).query = ((...args: unknown[]) => {
      const texto = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (typeof texto === 'string' && texto.includes('INSERT INTO demurrage_handoff_eventos')) {
        throw new Error(`falha inesperada simulada: ${marcador}`);
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as typeof pool.query;

    const servidorComPoolQuebrado = await (async () => {
      const app = express();
      const caminho = '/api/integracoes/demurrage/handoff/processos';
      app.use(caminho, criarDemurrageHandoffRouter({ pool: () => pool }));
      return new Promise<{ baseUrl: string; caminho: string; fechar: () => Promise<void> }>((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
          const porta = (server.address() as { port: number }).port;
          resolve({ baseUrl: `http://127.0.0.1:${porta}${caminho}`, caminho, fechar: () => new Promise<void>((r) => server.close(() => r())) });
        });
      });
    })();

    try {
      const res = await enviarHandoff(servidorComPoolQuebrado.baseUrl, servidorComPoolQuebrado.caminho, {
        corpo: entradaHandoff({ numeroProcesso: 'IMV-015' }), credencialId: prov.id, segredo: prov.segredo,
      });
      assert.equal(res.status, 500);
      const corpo = await res.text();
      assert.ok(!corpo.includes(marcador), 'o corpo da resposta HTTP nunca contém o marcador do erro inesperado');
      assert.ok(!corpo.includes(prov.segredo), 'o corpo da resposta nunca contém o segredo');
      const parsed = JSON.parse(corpo);
      assert.equal(parsed.resultado, 'FALHA');
      assert.ok(typeof parsed.detalhe?.motivo === 'string' && !parsed.detalhe.motivo.includes(marcador));

      const tudo = logs.join('\n');
      assert.ok(!tudo.includes(marcador), 'o marcador do erro nunca aparece em log — a rota não loga o erro bruto');
    } finally {
      await servidorComPoolQuebrado.fechar();
    }
  } finally {
    console.error = origErr;
    await servidor.fechar();
    await pool.end();
  }
});

/* ========================================================================= *
 * 16 — smoke test HTTP (HMAC/nonce/timestamp/rotação continuam verdes na
 * suíte original; aqui só reconfirma o caminho feliz ponta a ponta depois
 * da reescrita do serviço).
 * ========================================================================= */

test('v1.1 #16: round-trip HTTP com HMAC válido continua funcionando depois da reescrita do serviço', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-16');
    const prov = await provisionarCredencial(pool, org.id, 'cred-v11-16');
    const res = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMV-016', origemProcessoId: 'UP-016' }), credencialId: prov.id, segredo: prov.segredo,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.resultado === 'APLICADO' || body.resultado === 'ACEITO_COM_PENDENCIA', body.resultado);
    const vinculado = await buscarVinculo(pool, org.id, 'teste-upstream-v11', 'UP-016');
    assert.equal(vinculado, body.processoId);
  } finally { await servidor.fechar(); await pool.end(); }
});

/* ========================================================================= *
 * 17/18 — migração: limpa 0001→0041; upgrade 0040→0041 com eventos existentes
 * ========================================================================= */

test('v1.1 #17: migração limpa 0001→0041 aplica a 0041 e cria o vínculo + a coluna de retrato, vazios', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await resetSchema(pool);
    const r = await runMigrations(pool);
    assert.ok(r.applied.includes('0041_handoff_vinculo_processo.sql'));
    const { rows: linksVazio } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_processo_links`);
    assert.equal(linksVazio[0].n, 0);
    const { rows: coluna } = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'demurrage_handoff_eventos' AND column_name = 'resposta_aplicada'`,
    );
    assert.equal(coluna.length, 1, 'coluna resposta_aplicada existe');
  } finally { await pool.end(); }
});

test('v1.1 #18: upgrade 0040→0041 com um evento PRÉ-EXISTENTE (sem retrato, sem vínculo) continua replayable — cai para a reaplicação, que o D10 trata como ja_registrado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await resetSchema(pool);
    await runMigrations(pool, { until: '0040_handoff_demurrage.sql' });

    const org = await criarOrg(pool, 'v11-18');
    const n1 = numeroContainer('VFAD', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMV-018', origemProcessoId: 'UP-018', containers: [n1], origemEventoId: 'evt-v11-pre-existente-18' });

    // Simula um evento aplicado ANTES desta corretiva (schema em 0040, sem
    // `demurrage_handoff_processo_links` e sem a coluna `resposta_aplicada`
    // — nenhuma das duas existe ainda): registra via o PRÓPRIO D10 (frozen),
    // exatamente como o handoff v1.0 fazia, com a MESMA `chaveIdempotencia`
    // que o handoff deriva, e insere a linha do ledger de identidade (camada
    // A) manualmente, no formato exato de 0040.
    const norm = validarEntradaHandoff(entrada);
    const entradaD10: RegistroProcessoDemurrageV1 = {
      versao: CONTRATO_REGISTRO_DEMURRAGE_V1,
      organizationId: org.id,
      numeroProcesso: norm.numeroProcesso,
      chaveIdempotencia: `handoff:${norm.origemSistema}:${norm.origemEventoId}`,
      origem: { sistema: norm.origemSistema, referencia: norm.origemProcessoId },
      cliente: null, house: null, mbl: null, armador: null, condicaoComercial: null,
      responsavelOperacionalMembershipId: null, houseFreeTimeDays: null, masterFreeTimeDays: null,
      containers: norm.containers.map((c) => ({ numero: c.numero, tipoOriginal: null, houseFreeTimeDays: null, masterFreeTimeDays: null })),
    };
    const r0 = await registrarProcessoDemurrage(entradaD10, { pool });
    await pool.query(
      `INSERT INTO demurrage_handoff_eventos (organization_id, credencial_identidade, origem_sistema, origem_processo_id, origem_evento_id, origem_ocorrido_em, payload_hash, processo_id, resultado, concluido_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'APLICADO', now())`,
      [org.id, CREDENCIAL_IDENTIDADE_INTERNA, norm.origemSistema, norm.origemProcessoId, norm.origemEventoId, norm.origemOcorridoEm, norm.payloadHash, r0.processoId],
    );

    const r1 = await runMigrations(pool);
    assert.ok(r1.applied.includes('0041_handoff_vinculo_processo.sql'));

    const { rows: antes } = await pool.query(
      `SELECT resposta_aplicada AS "respostaAplicada" FROM demurrage_handoff_eventos WHERE organization_id = $1 AND origem_evento_id = 'evt-v11-pre-existente-18'`,
      [org.id],
    );
    assert.equal(antes[0].respostaAplicada, null, 'migração aditiva — não inventa um retrato retroativo para dados pré-existentes');
    const vinculoAntes = await buscarVinculo(pool, org.id, 'teste-upstream-v11', 'UP-018');
    assert.equal(vinculoAntes, null, 'nenhum vínculo retroativo foi inventado para dados pré-existentes');

    // Replay do evento pré-existente, já sob o schema 0041: sem retrato, cai
    // para a reaplicação normal — resolverVinculoProcesso estabelece o
    // vínculo AGORA (primeira vez que esta identidade passa pelo código
    // novo) e o D10 reconhece a MESMA chaveIdempotencia como já registrada.
    const r2 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r2.resultado, 'REPLAY_IDEMPOTENTE');
    assert.equal((r2 as any).processoId, r0.processoId);
    const vinculoDepois = await buscarVinculo(pool, org.id, 'teste-upstream-v11', 'UP-018');
    assert.equal(vinculoDepois, r0.processoId, 'o vínculo foi estabelecido retroativamente na primeira passagem pelo código novo');

    const { rows: procs } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs[0].n, 1, 'nenhum processo duplicado durante o upgrade');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * Auditoria de replay (revisão obrigatória, não um item numerado isolado):
 * prova que um replay de um evento concluído NUNCA toca o outbox pós-commit,
 * mesmo que o outbox ainda tenha trabalho pendente para aquele processo.
 * ========================================================================= */

test('auditoria de replay: replay de evento concluído NUNCA toca o outbox pós-commit (prova do retrato persistido)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'v11-replay-audit');
    const n1 = numeroContainer('VFAE', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMV-AUDIT', origemProcessoId: 'UP-AUDIT', containers: [n1] });
    const r1 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');
    const processoId = (r1 as any).processoId;

    // Reintroduz artificialmente um estado "ainda pendente" no outbox pós-
    // commit do D10 — simula um processo cujo reparo pós-commit não tinha
    // terminado quando o evento do handoff foi concluído.
    await pool.query(`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente', tentativas = 0, concluido_em = NULL WHERE processo_id = $1`, [processoId]);
    const { rows: outboxAntes } = await pool.query(`SELECT estado FROM demurrage_pos_commit_outbox WHERE processo_id = $1`, [processoId]);
    assert.equal(outboxAntes[0].estado, 'pendente');

    const r2 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r2.resultado, 'REPLAY_IDEMPOTENTE');

    const { rows: outboxDepois } = await pool.query(`SELECT estado, tentativas FROM demurrage_pos_commit_outbox WHERE processo_id = $1`, [processoId]);
    assert.equal(outboxDepois[0].estado, 'pendente', 'o replay NUNCA chamou o D10 de novo — o outbox pendente continua exatamente como estava');
    assert.equal(outboxDepois[0].tentativas, 0);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 19 — nenhum arquivo de frontend foi alterado (confirmado também no
 * relatório via `git status`, reafirmado aqui como lembrete executável).
 * ========================================================================= */

test('v1.1 #19: nenhum arquivo de frontend (public/, .dc.html, apresentação) está entre as mudanças não commitadas desta correção', () => {
  const { execSync } = require('child_process');
  const saida = execSync('git status --porcelain', { cwd: __dirname + '/../../..', encoding: 'utf8' });
  const caminhosProibidos = saida
    .split('\n')
    .map((linha: string) => linha.slice(3))
    .filter((caminho: string) => caminho.startsWith('public/') || caminho.endsWith('.html') || caminho.endsWith('.css'));
  assert.deepEqual(caminhosProibidos, [], `arquivos de frontend não deveriam estar entre as mudanças: ${caminhosProibidos.join(', ')}`);
});

/* ========================================================================= *
 * Nota sobre o item 20 (regressão completa): a suíte completa do
 * Demurrage Engine (D10–D16 + Entrega 1 + esta corretiva v1.1), V1, D13 UI,
 * tsc e build são executados em sequência fora deste arquivo, conforme o
 * relatório final.
 * ========================================================================= */
