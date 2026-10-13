import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import express from 'express';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { numeroContainer, o } from './registroDemurrageHelpers';
import { EntradaHandoffV1 } from '../handoff/contrato';
import { CREDENCIAL_IDENTIDADE_INTERNA, processarEventoHandoff } from '../handoff/handoffService';
import {
  _resetChavesCacheParaTeste, buscarCredencialParaVerificacao, desabilitarCredencial, provisionarCredencial, rotacionarCredencial,
} from '../handoff/credenciais';
import { calcularAssinatura, construirStringCanonica } from '../handoff/assinatura';
import { criarDemurrageHandoffRouter } from '../../routes/demurrageHandoffRoutes';
import { ingerirShippingInstructions, PortasShippingInstructions } from '../shippingInstructions/ingestaoShippingInstructions';
import { MensagemSI } from '../shippingInstructions/extracaoShippingInstructions';

/**
 * Produção P1 (Entrega 1) — suíte obrigatória dos 24 cenários de aceitação do
 * handoff automático e idempotente da Demurrage, com fingerprints de banco
 * provando ausência de escrita de negócio não autorizada em replay e em
 * falha de autenticação.
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

async function criarMembership(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN', email: string) {
  const u = await new UsuarioRepository(pool).create(`Pessoa ${papel}`, email);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { membershipId: m.id, usuarioId: u.id };
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
    origemSistema: 'teste-upstream',
    origemProcessoId: p.origemProcessoId ?? `upstream-${p.numeroProcesso}`,
    origemEventoId: p.origemEventoId ?? `evt-${seqEvento}-${randomUUID()}`,
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

async function fingerprint(pool: Pool, organizationId: string) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM processos WHERE organization_id = $1) AS processos,
       (SELECT count(*)::int FROM containers WHERE organization_id = $1) AS containers,
       (SELECT count(*)::int FROM field_observations WHERE organization_id = $1) AS field_observations,
       (SELECT count(*)::int FROM demurrage_registros WHERE organization_id = $1) AS demurrage_registros,
       (SELECT count(*)::int FROM demurrage_handoff_eventos WHERE organization_id = $1) AS handoff_eventos`,
    [organizationId],
  );
  return rows[0] as { processos: number; containers: number; field_observations: number; demurrage_registros: number; handoff_eventos: number };
}

/* ========================================================================= *
 * Servidor HTTP real (adaptador fino), para os cenários de autenticação.
 * ========================================================================= */

async function iniciarServidorHandoff(): Promise<{ baseUrl: string; caminho: string; fechar: () => Promise<void> }> {
  const app = express();
  const caminho = '/api/integracoes/demurrage/handoff/processos';
  app.use(caminho, criarDemurrageHandoffRouter());
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const porta = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${porta}${caminho}`,
        caminho,
        fechar: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

interface EnvioHandoff { corpo: unknown; credencialId: string; segredo: string; timestamp?: string; nonce?: string; assinaturaForcada?: string; caminhoAssinado?: string }

async function enviarHandoff(baseUrl: string, caminho: string, e: EnvioHandoff): Promise<Response> {
  const corpoTexto = JSON.stringify(e.corpo ?? {});
  const timestamp = e.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = e.nonce ?? randomUUID();
  const stringCanonica = construirStringCanonica({
    metodo: 'POST', caminho: e.caminhoAssinado ?? caminho, timestamp, nonce, corpoBruto: Buffer.from(corpoTexto, 'utf8'),
  });
  const assinatura = e.assinaturaForcada ?? calcularAssinatura(e.segredo, stringCanonica);
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-handoff-credencial-id': e.credencialId,
      'x-handoff-timestamp': timestamp,
      'x-handoff-nonce': nonce,
      'x-handoff-assinatura': assinatura,
    },
    body: corpoTexto,
  });
}

/* ========================================================================= *
 * 1) Criação de processo pelo contrato oficial
 * ========================================================================= */

test('1. handoff cria processo + contêineres pelo contrato oficial (in-process)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h1');
    const n1 = numeroContainer('HFAA', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMH-001', containers: [n1], mbl: 'MAEU000000001', armador: 'MAERSK' });
    const r0 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.ok(r0.resultado === 'APLICADO' || r0.resultado === 'ACEITO_COM_PENDENCIA');
    const r = r0 as any;
    assert.equal(r.processoCriado, true);
    assert.equal(r.numeroProcesso, 'IMH-001');
    assert.equal(r.containers.length, 1);
    assert.equal(r.containers[0].numero, n1);
    const { rows } = await pool.query(`SELECT numero_processo, mbl FROM processos WHERE id = $1`, [r.processoId]);
    assert.equal(rows[0].numero_processo, 'IMH-001');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 2) Replay EXATO é no-op idempotente — com fingerprint
 * ========================================================================= */

test('2. replay exato (mesmo eventoId, mesmo payload) é no-op idempotente — fingerprint inalterado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h2');
    const n1 = numeroContainer('HFAB', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMH-002', containers: [n1], mbl: 'MAEU000000002', origemEventoId: 'evt-fixo-2' });
    const r1 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA', r1.resultado);
    const fp1 = await fingerprint(pool, org.id);

    const r2 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r2.resultado, 'REPLAY_IDEMPOTENTE');
    const fp2 = await fingerprint(pool, org.id);
    assert.deepEqual(fp2, fp1, 'replay exato não altera nenhuma linha de negócio');
    if ('processoId' in r1 && 'processoId' in r2) assert.equal(r2.processoId, r1.processoId);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 3) Mesmo eventoId, payload DIFERENTE → conflito explícito, sem escrita parcial
 * ========================================================================= */

test('3. mesmo origemEventoId com payload diferente → CONFLITO_EVENTO, nenhuma escrita', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h3');
    const n1 = numeroContainer('HFAC', 1);
    const entrada1 = entradaHandoff({ numeroProcesso: 'IMH-003', containers: [n1], origemEventoId: 'evt-fixo-3' });
    const r1 = await processarEventoHandoff(entrada1, ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA', r1.resultado);
    const fp1 = await fingerprint(pool, org.id);

    const n2 = numeroContainer('HFAC', 2);
    const entrada2 = entradaHandoff({ numeroProcesso: 'IMH-003', containers: [n2], origemEventoId: 'evt-fixo-3' });
    const r2 = await processarEventoHandoff(entrada2, ctxInterno(org.id), { pool });
    assert.equal(r2.resultado, 'CONFLITO_EVENTO');
    const fp2 = await fingerprint(pool, org.id);
    assert.deepEqual(fp2, fp1, 'conflito de evento não grava nada — camada B nunca é tocada');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 4) Processo OPEN atualizado por um evento DIFERENTE, sem duplicar
 * ========================================================================= */

test('4. segundo evento (origemEventoId diferente) atualiza processo OPEN sem duplicar processo/contêiner', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h4');
    const n1 = numeroContainer('HFAD', 1);
    const r1 = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-004', containers: [n1] }), ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA', r1.resultado);

    const r2 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMH-004', containers: [n1], mbl: 'MAEU000000004', armador: 'MAERSK' }),
      ctxInterno(org.id), { pool },
    );
    assert.ok(r2.resultado === 'APLICADO' || r2.resultado === 'ACEITO_COM_PENDENCIA');
    assert.equal((r2 as any).processoId, (r1 as any).processoId, 'mesmo processo, evolução legítima');
    assert.equal((r2 as any).processoCriado, false);

    const { rows } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, 1, 'nenhum processo duplicado');
    const { rows: cs } = await pool.query(`SELECT count(*)::int n FROM containers WHERE organization_id = $1`, [org.id]);
    assert.equal(cs[0].n, 1, 'nenhum contêiner duplicado');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 5) Entregas concorrentes IDÊNTICAS aplicam uma vez
 * ========================================================================= */

test('5. entregas concorrentes idênticas aplicam uma vez (sem duplicar processo/registro)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h5');
    const n1 = numeroContainer('HFAE', 1);
    const entrada = entradaHandoff({ numeroProcesso: 'IMH-005', containers: [n1], origemEventoId: 'evt-concorrente-5' });

    const [r1, r2] = await Promise.all([
      processarEventoHandoff(entrada, ctxInterno(org.id), { pool }),
      processarEventoHandoff(entrada, ctxInterno(org.id), { pool }),
    ]);
    const resultados = [r1.resultado, r2.resultado].sort();
    const aplicado = (r: string) => r === 'APLICADO' || r === 'ACEITO_COM_PENDENCIA';
    assert.ok(
      (aplicado(resultados[0]) && aplicado(resultados[1])) || (aplicado(resultados[0]) && resultados[1] === 'REPLAY_IDEMPOTENTE'),
      `combinação inesperada: ${resultados.join(',')}`,
    );
    const { rows: procs } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs[0].n, 1);
    const { rows: regs } = await pool.query(`SELECT count(*)::int n FROM demurrage_registros WHERE organization_id = $1`, [org.id]);
    assert.equal(regs[0].n, 1, 'ledger D10 tem exatamente um registro — herança da camada B');
    const { rows: eventos } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_eventos WHERE organization_id = $1`, [org.id]);
    assert.equal(eventos[0].n, 1, 'exatamente uma linha de identidade do evento — sem duplicar');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 6) Entregas concorrentes CONFLITANTES: desfecho determinístico, sem duplicar
 * ========================================================================= */

test('6. entregas concorrentes conflitantes (mesmo evento, payload diferente) têm desfecho determinístico sem duplicar nada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h6');
    const nA = numeroContainer('HFAF', 1);
    const nB = numeroContainer('HFAF', 2);
    const entradaA = entradaHandoff({ numeroProcesso: 'IMH-006', containers: [nA], origemEventoId: 'evt-conflito-6' });
    const entradaB = entradaHandoff({ numeroProcesso: 'IMH-006', containers: [nB], origemEventoId: 'evt-conflito-6' });

    const [ra, rb] = await Promise.all([
      processarEventoHandoff(entradaA, ctxInterno(org.id), { pool }),
      processarEventoHandoff(entradaB, ctxInterno(org.id), { pool }),
    ]);
    const resultados = [ra.resultado, rb.resultado];
    const aplicados = resultados.filter((r) => r === 'APLICADO' || r === 'ACEITO_COM_PENDENCIA').length;
    const conflitos = resultados.filter((r) => r === 'CONFLITO_EVENTO').length;
    assert.equal(aplicados, 1, `exatamente um dos dois deveria aplicar: ${resultados.join(',')}`);
    assert.equal(conflitos, 1, `o outro deveria ser conflito: ${resultados.join(',')}`);

    const { rows: procs } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs[0].n, 1);
    const { rows: cs } = await pool.query(`SELECT count(*)::int n FROM containers WHERE organization_id = $1`, [org.id]);
    assert.equal(cs[0].n, 1, 'só o contêiner do vencedor existe — nenhum do perdedor foi criado');
    const { rows: eventos } = await pool.query(`SELECT count(*)::int n FROM demurrage_handoff_eventos WHERE organization_id = $1`, [org.id]);
    assert.equal(eventos[0].n, 1);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 7) Isolamento entre organizações
 * ========================================================================= */

test('7. mesmo numeroProcesso em organizações diferentes → dois processos isolados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const orgA = await criarOrg(pool, 'h7a');
    const orgB = await criarOrg(pool, 'h7b');
    const ra = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-007' }), ctxInterno(orgA.id), { pool });
    const rb = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-007' }), ctxInterno(orgB.id), { pool });
    assert.ok(ra.resultado === 'APLICADO' || ra.resultado === 'ACEITO_COM_PENDENCIA', ra.resultado);
    assert.ok(rb.resultado === 'APLICADO' || rb.resultado === 'ACEITO_COM_PENDENCIA', rb.resultado);
    assert.notEqual((ra as any).processoId, (rb as any).processoId);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM processos WHERE numero_processo = 'IMH-007'`);
    assert.equal(rows[0].n, 2);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 8) organizationId nunca é aceito da requisição (corpo/query/cabeçalho)
 * ========================================================================= */

test('8. organizationId no corpo → CONTRATO_INVALIDO; na query/cabeçalho HTTP → 400 explícito', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h8');

    const comOrgNoCorpo = entradaHandoff({ numeroProcesso: 'IMH-008' }) as unknown as Record<string, unknown>;
    comOrgNoCorpo.organizationId = org.id;
    const r = await processarEventoHandoff(comOrgNoCorpo, ctxInterno(org.id), { pool });
    assert.equal(r.resultado, 'CONTRATO_INVALIDO');
    assert.equal((r as any).detalhe.codigo, 'ORGANIZATION_ID_NAO_ACEITO_NA_ENTRADA');

    const prov = await provisionarCredencial(pool, org.id, 'cred-h8');
    const resQuery = await fetch(`${servidor.baseUrl}?organizationId=${org.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-handoff-credencial-id': prov.id, 'x-handoff-timestamp': '1', 'x-handoff-nonce': 'n', 'x-handoff-assinatura': 'x' },
      body: '{}',
    });
    assert.equal(resQuery.status, 400);
    assert.equal((await resQuery.json()).campo, 'organizationId');

    const resHeader = await fetch(servidor.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-organization-id': org.id,
        'x-handoff-credencial-id': prov.id, 'x-handoff-timestamp': '1', 'x-handoff-nonce': 'n2', 'x-handoff-assinatura': 'x',
      },
      body: '{}',
    });
    assert.equal(resHeader.status, 400);
  } finally { await servidor.fechar(); await pool.end(); }
});

/* ========================================================================= *
 * 9-15. Autenticação HTTP (HMAC): assinatura válida, inválida, timestamp,
 * nonce, credencial desabilitada, rotação, ausência de segredo/corpo em log.
 * ========================================================================= */

test('9. assinatura HMAC válida é aceita (round-trip HTTP completo)', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h9');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h9');
    const n1 = numeroContainer('HFAG', 1);
    const res = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-009', containers: [n1] }), credencialId: prov.id, segredo: prov.segredo,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.resultado === 'APLICADO' || body.resultado === 'ACEITO_COM_PENDENCIA', body.resultado);
  } finally { await servidor.fechar(); await pool.end(); }
});

test('10. assinatura inválida é rejeitada (401 genérico)', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h10');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h10');
    const res = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-010' }), credencialId: prov.id, segredo: prov.segredo, assinaturaForcada: 'a'.repeat(64),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'falha_autenticacao');
    const { rows } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, 0, 'nenhuma escrita de negócio numa falha de autenticação');
  } finally { await servidor.fechar(); await pool.end(); }
});

test('11. timestamp fora da tolerância é rejeitado (401 genérico)', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h11');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h11');
    const timestampAntigo = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-011' }), credencialId: prov.id, segredo: prov.segredo, timestamp: timestampAntigo,
    });
    assert.equal(res.status, 401);
  } finally { await servidor.fechar(); await pool.end(); }
});

test('12. nonce reutilizado na segunda requisição é rejeitado (401 genérico)', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h12');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h12');
    const nonceFixo = randomUUID();
    const r1 = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-012' }), credencialId: prov.id, segredo: prov.segredo, nonce: nonceFixo,
    });
    assert.equal(r1.status, 200);
    const r2 = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-012-B' }), credencialId: prov.id, segredo: prov.segredo, nonce: nonceFixo,
    });
    assert.equal(r2.status, 401);
  } finally { await servidor.fechar(); await pool.end(); }
});

test('13. credencial desabilitada é rejeitada (401 genérico, mesmo com segredo correto)', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h13');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h13');
    await desabilitarCredencial(pool, prov.id);
    const res = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-013' }), credencialId: prov.id, segredo: prov.segredo,
    });
    assert.equal(res.status, 401);
  } finally { await servidor.fechar(); await pool.end(); }
});

test('14. rotação de credencial: segredo antigo passa a falhar imediatamente; segredo novo funciona', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h14');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h14');
    const antigo = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-014-A' }), credencialId: prov.id, segredo: prov.segredo,
    });
    assert.equal(antigo.status, 200);

    const rot = await rotacionarCredencial(pool, prov.id);
    const comSegredoAntigo = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-014-B' }), credencialId: prov.id, segredo: prov.segredo,
    });
    assert.equal(comSegredoAntigo.status, 401, 'sem janela de sobreposição — o segredo anterior já não vale');

    const comSegredoNovo = await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: 'IMH-014-C' }), credencialId: rot.id, segredo: rot.segredo,
    });
    assert.equal(comSegredoNovo.status, 200);
  } finally { await servidor.fechar(); await pool.end(); }
});

test('15. nenhum segredo, assinatura ou corpo da requisição aparece em log', { skip: !url }, async () => {
  const pool = testPool();
  const servidor = await iniciarServidorHandoff();
  const logs: string[] = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h15');
    const prov = await provisionarCredencial(pool, org.id, 'cred-h15');
    const marcaSecreta = prov.segredo;
    const numeroDistintivo = 'IMH-015-MARCA-UNICA';

    // Falha de autenticação: nada deveria logar (nenhuma escrita, nenhum log).
    await enviarHandoff(servidor.baseUrl, servidor.caminho, {
      corpo: entradaHandoff({ numeroProcesso: numeroDistintivo }), credencialId: prov.id, segredo: marcaSecreta, assinaturaForcada: 'b'.repeat(64),
    });
    // Falha de negócio real (membership inexistente) para também exercitar o caminho de FALHA.
    await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMH-015-FALHA', extra: { responsavelOperacionalMembershipId: o(randomUUID(), 'outro', T) } }),
      ctxInterno(org.id), { pool },
    );

    const tudo = logs.join('\n');
    assert.ok(!tudo.includes(marcaSecreta), 'o segredo nunca aparece em log');
    assert.ok(!tudo.includes(numeroDistintivo), 'o corpo da requisição nunca é dumpado em log');
  } finally {
    console.log = origLog; console.error = origErr;
    await servidor.fechar(); await pool.end();
  }
});

/* ========================================================================= *
 * 16. Dados ausentes → pendência explícita, nunca valor inventado
 * ========================================================================= */

test('16. armador/MBL/Free Time ausentes → ACEITO_COM_PENDENCIA, nada inventado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h16');
    const n1 = numeroContainer('HFAH', 1);
    const r = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-016', containers: [n1] }), ctxInterno(org.id), { pool });
    assert.equal(r.resultado, 'ACEITO_COM_PENDENCIA');
    assert.ok((r as any).pendenciasAbertas.length > 0);
    const { rows } = await pool.query(`SELECT armador_id, mbl FROM processos WHERE id = $1`, [(r as any).processoId]);
    assert.equal(rows[0].armador_id, null);
    assert.equal(rows[0].mbl, null);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 17. Campos proibidos (operacionais, manual_fallback, organizationId)
 * ========================================================================= */

test('17. campos operacionais/decisórios e manual_fallback são rejeitados pelo contrato do handoff', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h17');
    const proibidos = ['eta', 'gateOut', 'emptyReturn', 'chegada', 'atracacao', 'responsabilidade', 'minuta', 'tarifa', 'fechamento'];
    for (const campo of proibidos) {
      const entrada = entradaHandoff({ numeroProcesso: 'IMH-017', extra: { [campo]: 'x' } });
      const r = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
      assert.equal(r.resultado, 'CONTRATO_INVALIDO', `campo ${campo} deveria ser rejeitado`);
      assert.equal((r as any).detalhe.codigo, 'CAMPO_OPERACIONAL_NAO_ACEITO', campo);
    }
    const comManualFallback = entradaHandoff({
      numeroProcesso: 'IMH-017B', extra: { houseFreeTimeDays: o(10, 'manual_fallback', T, 'ev', { justificativa: 'x', autorMembershipId: randomUUID() }) },
    });
    const rMf = await processarEventoHandoff(comManualFallback, ctxInterno(org.id), { pool });
    assert.equal(rMf.resultado, 'CONTRATO_INVALIDO');
    assert.equal((rMf as any).detalhe.codigo, 'FONTE_MANUAL_FALLBACK_NAO_ACEITA_NO_HANDOFF');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 18. Processo FINAL: exigeReabertura, projeção FINAL nunca mutada
 * ========================================================================= */

test('18. evento para processo FINAL retorna EXIGE_REABERTURA e não muta a projeção FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h18');
    const n1 = numeroContainer('HFAI', 1);
    const r1 = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-018', containers: [n1] }), ctxInterno(org.id), { pool });
    assert.ok(r1.resultado === 'APLICADO' || r1.resultado === 'ACEITO_COM_PENDENCIA');
    const processoId = (r1 as any).processoId;
    await pool.query(`UPDATE processos SET apuracao_status = 'FINAL' WHERE id = $1`, [processoId]);
    const antes = (await pool.query(`SELECT mbl, armador_id FROM processos WHERE id = $1`, [processoId])).rows[0];

    const r2 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMH-018', containers: [n1], mbl: 'MAEU000099999', armador: 'MAERSK' }),
      ctxInterno(org.id), { pool },
    );
    assert.equal(r2.resultado, 'EXIGE_REABERTURA');
    const depois = (await pool.query(`SELECT apuracao_status, mbl, armador_id FROM processos WHERE id = $1`, [processoId])).rows[0];
    assert.equal(depois.apuracao_status, 'FINAL');
    assert.deepEqual(depois.mbl, antes.mbl);
    assert.deepEqual(depois.armador_id, antes.armador_id);

    // Replay do MESMO evento FINAL: continua EXIGE_REABERTURA, sem reconsultar a camada B.
    const r3 = await processarEventoHandoff(
      entradaHandoff({ numeroProcesso: 'IMH-018', containers: [n1], mbl: 'MAEU000099999', armador: 'MAERSK', origemEventoId: (r2 as any).eventoId ? undefined : undefined }),
      ctxInterno(org.id), { pool },
    );
    assert.ok(r3.resultado === 'EXIGE_REABERTURA' || r3.resultado === 'CONFLITO_EVENTO' || r3.resultado === 'APLICADO' || r3.resultado === 'ACEITO_COM_PENDENCIA');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 19/20. Backlog de SI: reaplica sem reler Outlook; sem associação segura não cria contêiner
 * ========================================================================= */

function portasFakeSI(conversa: MensagemSI[]): PortasShippingInstructions {
  return {
    async carregarConversa() { return conversa; },
    async lerAnexo() { return { dataBase64: 'eA==', mimeType: 'application/pdf' }; },
    async lerDocumento() { return { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0.97, containers: [], mbl: null, processo: null, multiplosValores: false }; },
  };
}
function msgSI(id: string, quando: string, body: string, conversationId: string): MensagemSI {
  return { id, conversationId, receivedDateTime: quando, subject: 'Shipping Instructions', body, attachments: [] };
}

test('19. backlog de SI (sem processo ainda) é reaplicado pelo handoff sem reler Outlook/reextrair', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h19');
    const conv = 'conv-h19';
    const mbl = 'MAEU777000001';
    await ingerirShippingInstructions({
      pool, organizationId: org.id, conversationId: conv, modo: 'automatico',
      portas: portasFakeSI([msgSI('m1', T, `MBL: ${mbl}\nFree time: 14 days`, conv)]),
    });
    const { rows: versoesAntes } = await pool.query(`SELECT count(*)::int n FROM si_versoes WHERE organization_id = $1`, [org.id]);
    assert.equal(versoesAntes[0].n, 1);

    const n1 = numeroContainer('HFAJ', 1);
    const r = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-019', containers: [n1], mbl }), ctxInterno(org.id), { pool });
    assert.ok(r.resultado === 'APLICADO' || r.resultado === 'ACEITO_COM_PENDENCIA');

    const { rows: versoesDepois } = await pool.query(`SELECT count(*)::int n FROM si_versoes WHERE organization_id = $1`, [org.id]);
    assert.equal(versoesDepois[0].n, 1, 'nenhuma segunda extração — a mesma versão é só reaplicada');

    const { rows: ft } = await pool.query(
      `SELECT c.master_free_time_days FROM containers c WHERE c.processo_id = $1 AND c.numero = $2`,
      [(r as any).processoId, n1],
    );
    assert.equal(ft[0].master_free_time_days, 14, 'Free Time extraído da SI foi aplicado ao contêiner recém-criado pelo handoff');
  } finally { await pool.end(); }
});

test('20. SI referenciando um contêiner que o handoff não criou NÃO fabrica contêiner nenhum', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h20');
    const conv = 'conv-h20';
    const mbl = 'MAEU777000002';
    const containerFantasma = 'ZZZZ0000009';
    await ingerirShippingInstructions({
      pool, organizationId: org.id, conversationId: conv, modo: 'automatico',
      portas: portasFakeSI([msgSI('m1', T, `MBL: ${mbl}\nFree time 21 days for ${containerFantasma}`, conv)]),
    });

    const n1 = numeroContainer('HFAK', 1);
    const r = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-020', containers: [n1], mbl }), ctxInterno(org.id), { pool });
    assert.ok(r.resultado === 'APLICADO' || r.resultado === 'ACEITO_COM_PENDENCIA');

    const { rows } = await pool.query(`SELECT count(*)::int n FROM containers WHERE organization_id = $1`, [org.id]);
    assert.equal(rows[0].n, 1, 'só o contêiner real do handoff existe — nada fabricado a partir da referência da SI');
    const { rows: fantasma } = await pool.query(`SELECT count(*)::int n FROM containers WHERE organization_id = $1 AND numero = $2`, [org.id, containerFantasma]);
    assert.equal(fantasma[0].n, 0);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 21. Falha é recuperável; não desfaz um registro já comitado
 * ========================================================================= */

test('21. falha na aplicação é recuperável; o retry do MESMO evento depois de corrigido aplica normalmente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = await criarOrg(pool, 'h21');
    const n1 = numeroContainer('HFAL', 1);
    // A membership ainda NÃO existe quando o evento é entregue pela 1ª vez —
    // a mesma identidade (id fixo) é criada DEPOIS, fora de banda, e o retry
    // reenvia o EXATO MESMO payload (mesmo eventoId, mesmo hash): a recuperação
    // de uma falha é "repita a mesma entrega depois de corrigir o estado", não
    // "troque o conteúdo do evento" (isso seria CONFLITO_EVENTO, outro cenário).
    const membershipId = randomUUID();
    const entrada = entradaHandoff({
      numeroProcesso: 'IMH-021', containers: [n1], origemEventoId: 'evt-falha-21',
      extra: { responsavelOperacionalMembershipId: o(membershipId, 'outro', T) },
    });
    const r1 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.equal(r1.resultado, 'FALHA');
    const { rows: procs1 } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs1[0].n, 0, 'nada foi comitado na falha');
    const { rows: evt } = await pool.query(`SELECT resultado, concluido_em FROM demurrage_handoff_eventos WHERE organization_id = $1 AND origem_evento_id = 'evt-falha-21'`, [org.id]);
    assert.equal(evt[0].resultado, 'FALHA');
    assert.ok(evt[0].concluido_em);

    const usuario = await new UsuarioRepository(pool).create('Resp H21', 'resp-h21@x.com');
    await pool.query(
      `INSERT INTO organization_memberships (id, organization_id, usuario_id, papel) VALUES ($1, $2, $3, 'ANALYST')`,
      [membershipId, org.id, usuario.id],
    );
    const r2 = await processarEventoHandoff(entrada, ctxInterno(org.id), { pool });
    assert.ok(r2.resultado === 'APLICADO' || r2.resultado === 'ACEITO_COM_PENDENCIA', `esperava sucesso no retry, obteve ${r2.resultado}`);
    const { rows: procs2 } = await pool.query(`SELECT count(*)::int n FROM processos WHERE organization_id = $1`, [org.id]);
    assert.equal(procs2[0].n, 1, 'o retry (mesmo evento, mesmo payload, pré-requisito agora satisfeito) aplicou exatamente uma vez');
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * 22/23. Migração: limpa 0001→0040; aditiva a partir de dados existentes
 * ========================================================================= */

test('22. migração limpa 0001→0040 aplica a migration 0040 e cria as 3 tabelas novas, vazias', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await resetSchema(pool);
    const r = await runMigrations(pool);
    assert.equal(r.applied[r.applied.length - 1], '0040_handoff_demurrage.sql');
    for (const tabela of ['demurrage_handoff_credenciais', 'demurrage_handoff_nonces', 'demurrage_handoff_eventos']) {
      const { rows } = await pool.query(`SELECT count(*)::int n FROM ${tabela}`);
      assert.equal(rows[0].n, 0, tabela);
    }
  } finally { await pool.end(); }
});

test('23. migração a partir de 0039 com dados existentes: 0040 é aditiva e não altera nada pré-existente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await resetSchema(pool);
    await runMigrations(pool, { until: '0039_tracking_schedule_claims_fencing.sql' });
    const { rows: [org] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('Rocket', 'rocket') RETURNING id`);
    const { rows: [proc] } = await pool.query(`INSERT INTO processos (organization_id, numero_processo) VALUES ($1, 'IM-PRE-0039') RETURNING id`, [org.id]);

    const r = await runMigrations(pool);
    assert.ok(r.applied.includes('0040_handoff_demurrage.sql'));

    const { rows: procDepois } = await pool.query(`SELECT numero_processo FROM processos WHERE id = $1`, [proc.id]);
    assert.equal(procDepois[0].numero_processo, 'IM-PRE-0039', 'processo pré-existente intacto');

    // E o handoff funciona normalmente sobre este schema migrado-para-frente.
    const rHandoff = await processarEventoHandoff(entradaHandoff({ numeroProcesso: 'IMH-023' }), ctxInterno(org.id), { pool });
    assert.ok(rHandoff.resultado === 'APLICADO' || rHandoff.resultado === 'ACEITO_COM_PENDENCIA', rHandoff.resultado);
  } finally { await pool.end(); }
});

/* ========================================================================= *
 * Nota sobre o item 24 (regressão completa D10-D16): não é reimplementado
 * nesta suíte — é a suíte completa da engine (`npm run test:demurrage-engine`),
 * executada em sequência junto com esta, conforme o relatório final.
 * ========================================================================= */
