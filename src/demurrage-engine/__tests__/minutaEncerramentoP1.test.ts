import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
// Produção P1 (filas pessoais): helper de atribuição do responsável (ações e leituras pessoais do ANALYST).
import { testPool, testDatabaseUrl, truncateAll, atribuirResponsavelDeTeste } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { MinutaRepository } from '../persistence/minutaRepository';
import { registrarProcessoDemurrage } from '../registro/registrarProcessoDemurrage';
import { recalcularApuracaoContainer } from '../apuracao/recalcularApuracao';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ClosingService } from '../closing/closingService';
import { reavaliarMinutasDoProcesso, registrarMinutaTecnica } from '../closing/minutaTecnica';
import { avaliarMinutaTecnicamente } from '../closing/minutaValidation';
import { varrerEncerramentoAutomatico } from '../closing/encerramentoAutomatico';
import { montarGestaoOperacional } from '../leitura/gestao/operacional';
import { buscarComposicaoIndicador } from '../leitura/gestao/drilldown';
import { executarTickDemurrage } from '../../demurrage/schedulerBootstrap';
import { seedArmadorTables } from '../tariffs/seed/armadorTables';
import { seedRocketTermoPorEmbarque } from '../tariffs/seed/rocketTermoPorEmbarque';
import { criarDemurrageAcoesRouter } from '../../routes/demurrageAcoesRoutes';
import { criarDemurrageV2Router } from '../../routes/demurrageV2Routes';
import { confirmarResponsabilidadeClienteIntegral } from './responsabilidadeTestHelper';
import { containerContrato, contratoRegistro, ingerirTrackingDoContainer, numeroContainer, o, resultadoTracking } from './registroDemurrageHelpers';

/**
 * Produção P1 — REABERTURA CONTROLADA (correção de minuta, documento e
 * encerramento automático). Os 18 testes exigidos (+2 de regra), PostgreSQL
 * real. Cada defeito foi REPRODUZIDO antes no baseline d0c8569 (ver
 * docs/demurrage-producao-p1-correcao-minuta-encerramento.md §1.2):
 *  - analista não conseguia tornar a minuta válida (exigia MANAGER/ADMIN);
 *  - minuta sem devolução no tracking FABRICAVA a devolução; o gestor podia
 *    substituir a data do tracking pela da minuta;
 *  - nada encerrava sozinho (finalização manual obrigatória);
 *  - processo FINAL continuava na fila padrão e nos contadores;
 *  - segunda minuta em processo FINAL violava `minutas_validada_ativa_unica`
 *    → HTTP 500 e um item "aguardando validação" irremovível.
 */

const url = testDatabaseUrl();
const T = '2026-08-20T00:00:00Z';
const HOJE = '2026-10-01';
const cfg = { hoje: HOJE };

/* ------------------------------------------------------------------ *
 * Infraestrutura (mesmo padrão HTTP da Entrega 2/3: RBAC real).
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
  app.use('/v2', criarDemurrageV2Router({ pool: () => pool, requireAuthMiddleware: requireAuthDeTeste }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { base, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}

interface Membro { home: string; membershipId: string; usuarioId: string }
async function membro(pool: Pool, orgId: string, papel: 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CLIENT'): Promise<Membro> {
  const home = `home-${randomUUID()}`;
  const u = await new UsuarioRepository(pool).create(`${papel} ${randomUUID().slice(0, 6)}`, `${randomUUID()}@rocket.example`, home);
  const m = await new OrganizationMembershipRepository(pool).create(orgId, u.id, papel);
  return { home, membershipId: m.id, usuarioId: u.id };
}

function post(base: string, caminho: string, body: unknown, home: string, chave?: string): Promise<Response> {
  return fetch(`${base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-home-account-id': home, ...(chave ? { 'idempotency-key': chave } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}
function get(base: string, caminho: string, home: string): Promise<Response> {
  return fetch(`${base}${caminho}`, { headers: { 'x-test-home-account-id': home } });
}

/** Referência auditável de um arquivo real fictício (o sistema guarda referência + hash, nunca o binário). */
function doc(tag: string) {
  return {
    origem: 'email_anexo', referencia: `graph:message/${tag}/attachment/1`, nomeArquivo: `minuta-${tag}.pdf`,
    tipoConteudo: 'application/pdf', tamanhoBytes: 48213, hashConteudo: createHash('sha256').update(tag).digest('hex'),
  };
}

/* ------------------------------------------------------------------ *
 * Cenários de domínio (contrato real de registro + tracking real).
 * ------------------------------------------------------------------ */

async function seedArmadorTabelaNormalizada(pool: Pool) {
  const { rows: arm } = await pool.query(`SELECT id FROM armadores WHERE codigo_interno='MAERSK'`);
  const { rows: tab } = await pool.query(
    `INSERT INTO tariff_tables (organization_id, tipo, armador_id, versao, vigencia_inicio, qualidade_fonte, day_count_basis, fonte, verificada_em)
     VALUES (NULL, 'armador', $1, 2, '2026-01-01', 'PUBLICA_ESTIMATIVA', 'since_discharge_absolute', 'Referência de teste P1 (40HC)', '2026-08-01T00:00:00Z')
     RETURNING id`,
    [arm[0].id],
  );
  await pool.query(`INSERT INTO tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial, dia_final, valor_dia, moeda) VALUES ($1, '40HC', 1, NULL, 80, 'USD')`, [tab[0].id]);
  await pool.query(`UPDATE tariff_tables SET ativada_em = now() WHERE id = $1`, [tab[0].id]);
}

let seqContainer = 1;
interface Cenario { orgId: string; processoId: string; containers: Array<{ id: string; numero: string }> }

/**
 * Processo com N contêineres, descarga 2026-09-01 já ingerida pelo tracking.
 * `comDemurrage`: Free Time 3/5 dias + condição comercial e tabelas → uma
 * devolução em 09-10 gera demurrage com valores ESTIMATED nos dois lados.
 * Sem demurrage: Free Time 20/20 — devolução em 09-10 fica dentro do prazo.
 */
async function cenario(pool: Pool, opts: { orgId?: string; numeroProcesso: string; n?: number; comDemurrage: boolean }): Promise<Cenario> {
  const orgId = opts.orgId ?? (await new OrganizationRepository(pool).create('Rocket', `rk-${randomUUID().slice(0, 8)}`)).id;
  let condicaoComercial: any = null;
  if (opts.comDemurrage) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM tariff_tables WHERE fonte = 'Referência de teste P1 (40HC)'`);
    if (rows[0].n === 0) await seedArmadorTabelaNormalizada(pool);
    const { rows: existente } = await pool.query(`SELECT id FROM tariff_tables WHERE organization_id = $1 AND tipo = 'rocket_cliente' LIMIT 1`, [orgId]);
    const tabelaEmbarque = existente[0]?.id ?? await seedRocketTermoPorEmbarque(pool, { organizationId: orgId });
    condicaoComercial = o({ termoTipo: 'embarque', tabelaId: tabelaEmbarque }, 'shipping_instructions', T);
  }
  const numeros = Array.from({ length: opts.n ?? 1 }, () => numeroContainer('PUMC', seqContainer++));
  const r = await registrarProcessoDemurrage(contratoRegistro({
    organizationId: orgId, numeroProcesso: opts.numeroProcesso,
    containers: numeros.map((n) => containerContrato(n, { tipoOriginal: o('40HC', 'house_document', T) })),
    mbl: o(`MBL${opts.numeroProcesso.replace(/[^A-Z0-9]/gi, '')}`, 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
    condicaoComercial,
    houseFreeTimeDays: o(opts.comDemurrage ? 3 : 20, 'house_document', T), masterFreeTimeDays: o(opts.comDemurrage ? 5 : 20, 'master_bl', T),
  }), { pool, hojeReferencia: '2026-08-25' });
  const containers = r.containers.map((c: any, i: number) => ({ id: c.containerId, numero: numeros[i] }));
  await ingerirTrackingDoContainer(pool, containers[0].id, resultadoTracking({
    containers: containers.map((c) => ({ numero: c.numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: null } as any)),
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: containers[0].numero }],
  }), '2026-09-02');
  return { orgId, processoId: r.processoId, containers };
}

/** Devolução OFICIAL pelo tracking (ingestão real — dispara o gatilho de encerramento automático). */
async function devolverPeloTracking(pool: Pool, c: Cenario, devolucoes: Record<string, string | null>, hoje = HOJE) {
  await ingerirTrackingDoContainer(pool, c.containers[0].id, resultadoTracking({
    containers: c.containers.map((x) => ({
      numero: x.numero, tipo: '40HC', dischargeDate: '2026-09-01', availableDate: null, gateOut: null, emptyReturn: devolucoes[x.numero] ?? null,
    } as any)),
    events: [{ date: '2026-09-01', status: 'Discharge', location: 'Santos', type: 'discharge', container: c.containers[0].numero }],
  }), hoje);
}

const statusProcesso = (pool: Pool, id: string) =>
  pool.query(`SELECT apuracao_status, fechado_por, encerramento_bloqueio, encerramento_bloqueio_container_id FROM processos WHERE id = $1`, [id]).then((r) => r.rows[0]);
const minutasDo = (pool: Pool, containerId: string) =>
  pool.query(`SELECT * FROM minutas WHERE container_id = $1 ORDER BY criado_em, id`, [containerId]).then((r) => r.rows);
const pendenciasDo = (pool: Pool, containerId: string) =>
  pool.query(`SELECT tipo, estado, contexto, resolvido_por FROM demurrage_pendencias WHERE container_id = $1 AND tipo LIKE 'minuta_%' ORDER BY criado_em`, [containerId]).then((r) => r.rows);
const contagens = (pool: Pool) => pool.query(
  `SELECT (SELECT count(*) FROM minutas)::int AS minutas, (SELECT count(*) FROM documentos)::int AS documentos,
          (SELECT count(*) FROM closing_events)::int AS eventos, (SELECT count(*) FROM demurrage_pendencias)::int AS pendencias,
          (SELECT count(*) FROM fechamentos)::int AS fechamentos`,
).then((r) => r.rows[0]);

function corpoMinuta(numero: string, data: string | null, tag: string) {
  return { numeroInformado: numero, dataInformada: data, documento: doc(tag) };
}

/* ================================================================== *
 * Pura — verificação técnica automática.
 * ================================================================== */

test('P1 pura: verificação técnica — ACEITA, DIVERGENTE, INCONSISTENTE e RECEBIDA (nunca fabrica devolução)', () => {
  const base = { numeroInformado: 'PUMC0000011', numeroContainer: 'PUMC0000011', dataInformada: '2026-09-10', dischargeDate: '2026-09-01', gateOutDate: null, hoje: HOJE };
  assert.deepEqual(avaliarMinutaTecnicamente({ ...base, trackingReturnDate: '2026-09-10' }), { estado: 'ACEITA', dataTracking: '2026-09-10' });
  assert.deepEqual(avaliarMinutaTecnicamente({ ...base, trackingReturnDate: '2026-09-08' }), { estado: 'DIVERGENTE', dataMinuta: '2026-09-10', dataTracking: '2026-09-08' });
  assert.deepEqual(avaliarMinutaTecnicamente({ ...base, numeroInformado: 'OUTRO0000001', trackingReturnDate: '2026-09-10' }), { estado: 'INCONSISTENTE', motivo: 'NUMERO_DIVERGENTE' });
  assert.deepEqual(avaliarMinutaTecnicamente({ ...base, dataInformada: null, trackingReturnDate: '2026-09-10' }), { estado: 'INCONSISTENTE', motivo: 'DATA_ILEGIVEL' });
  assert.deepEqual(avaliarMinutaTecnicamente({ ...base, trackingReturnDate: null }), { estado: 'RECEBIDA', aguardando: 'DEVOLUCAO_TRACKING' });
  assert.deepEqual(avaliarMinutaTecnicamente({ ...base, dischargeDate: null, trackingReturnDate: '2026-09-10' }), { estado: 'RECEBIDA', aguardando: 'DESCARGA' });
});

/* ================================================================== *
 * #1 / #2 — encerramento automático e minuta obrigatória só com demurrage.
 * ================================================================== */

test('P1 #1: contêiner devolvido pelo tracking DENTRO do Free Time conclui AUTOMATICAMENTE — sem minuta, tarifa, responsabilidade ou gestor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-01', comDemurrage: false });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN');

    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });

    const p = await statusProcesso(pool, c.processoId);
    assert.equal(p.apuracao_status, 'FINAL', 'o tracking confirmou a devolução no prazo → FINAL sem ação humana');
    assert.equal(p.fechado_por, null, 'encerramento automático não tem autor humano');
    const f = (await pool.query(`SELECT origem, realizado_por, justificativa FROM fechamentos WHERE processo_id = $1`, [c.processoId])).rows;
    assert.deepEqual(f, [{ origem: 'automatico', realizado_por: null, justificativa: 'encerramento_automatico' }]);
    const ev = (await pool.query(`SELECT origem, ator_usuario_id FROM closing_events WHERE processo_id = $1 AND tipo_evento = 'FECHAMENTO_FINAL'`, [c.processoId])).rows;
    assert.deepEqual(ev, [{ origem: 'automatico', ator_usuario_id: null }]);
    assert.equal((await minutasDo(pool, c.containers[0].id)).length, 0, 'nenhuma minuta foi necessária');
    const membros = (await pool.query(`SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id = $1`, [c.orgId])).rows[0].n;
    assert.equal(membros, 0, 'nenhum gestor (nem membro algum) existe na organização — e mesmo assim encerrou');
  } finally { await pool.end(); }
});

test('P1 #2: contêiner COM demurrage não conclui sem minuta — bloqueio nomeado (comprovacao_pendente) registrado na avaliação automática', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-02', comDemurrage: true });
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.containers[0].id, hoje: HOJE });

    const r = await new ClosingService(pool).avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg });
    assert.deepEqual(r, { resultado: 'bloqueado', motivo: 'comprovacao_pendente', containerId: c.containers[0].id });
    const p = await statusProcesso(pool, c.processoId);
    assert.equal(p.apuracao_status, 'OPEN');
    assert.equal(p.encerramento_bloqueio, 'comprovacao_pendente');
    assert.equal(p.encerramento_bloqueio_container_id, c.containers[0].id);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM fechamentos`)).rows[0].n, 0);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #3 / #4 / #8 — aceite técnico sem gestor; analista registra; FINAL automático.
 * ================================================================== */

test('P1 #3/#4: ANALISTA registra a minuta coerente → ACEITA por verificação técnica, sem gestor; nenhum campo de aprovação humana é escrito', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-03', comDemurrage: true });
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const cliente = await membro(pool, c.orgId, 'CLIENT');

    // CLIENT nunca registra (barreira G6) — e nada é escrito.
    const antes = await contagens(pool);
    const rCliente = await post(app.base, `/a/containers/${c.containers[0].id}/minutas`, corpoMinuta(c.containers[0].numero, '2026-09-10', 'cli'), cliente.home, 'p1-03-cli');
    assert.equal(rCliente.status, 403);
    assert.deepEqual(await contagens(pool), antes);

    const resp = await post(app.base, `/a/containers/${c.containers[0].id}/minutas`, corpoMinuta(c.containers[0].numero, '2026-09-10', 'a1'), analista.home, 'p1-03-a1');
    assert.equal(resp.status, 201);
    const corpo = await resp.json();
    assert.equal(corpo.estado, 'ACEITA');
    assert.equal(corpo.versao, 1);
    assert.equal(corpo.avaliacao.regra, 'minuta.tecnica.v1');
    assert.equal(corpo.avaliacao.dataTrackingComparada, '2026-09-10');
    assert.equal(corpo.pendencia, null);
    assert.ok(corpo.documento?.id, 'documento vinculado');

    const [m] = await minutasDo(pool, c.containers[0].id);
    assert.equal(m.estado_minuta, 'ACEITA');
    assert.equal(m.validada_por, null, 'nenhuma aprovação humana');
    assert.equal(m.data_validada, null);
    assert.equal(m.recebida_por, analista.usuarioId, 'autor real da sessão');
    const ev = (await pool.query(`SELECT origem FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_ACEITA'`, [c.containers[0].id])).rows;
    assert.deepEqual(ev, [{ origem: 'automatico' }], 'o aceite é um evento AUTOMÁTICO, não humano');
    const d = (await pool.query(`SELECT * FROM documentos WHERE minuta_id = $1`, [m.id])).rows[0];
    assert.equal(d.organization_id, c.orgId);
    assert.equal(d.processo_id, c.processoId);
    assert.equal(d.container_id, c.containers[0].id);
    assert.equal(d.incluido_por, analista.usuarioId);
    assert.equal(d.incluido_por_membership_id, analista.membershipId);
    assert.equal(d.versao_minuta, 1);
    assert.equal(d.hash_conteudo, doc('a1').hashConteudo);
    const linha = (await pool.query(`SELECT effective_return_date, tracking_return_date FROM containers WHERE id = $1`, [c.containers[0].id])).rows[0];
    assert.deepEqual(linha, { effective_return_date: null, tracking_return_date: '2026-09-10' }, 'a minuta nunca escreve a devolução');
    // Ainda OPEN só porque a responsabilidade não foi decidida.
    assert.deepEqual(corpo.encerramento, { resultado: 'bloqueado', motivo: 'responsabilidade_em_analise', containerId: c.containers[0].id });
  } finally { await app.close(); await pool.end(); }
});

test('P1 #8: quando o último gate é liberado (decisão de responsabilidade pela rota), TODOS os contêineres elegíveis → FINAL automático', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-08', comDemurrage: true, n: 2 });
    const [a, b] = c.containers;
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const gestor = await membro(pool, c.orgId, 'MANAGER');

    await devolverPeloTracking(pool, c, { [a.numero]: '2026-09-10', [b.numero]: null });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN', 'B ainda não devolvido');
    await devolverPeloTracking(pool, c, { [a.numero]: '2026-09-10', [b.numero]: '2026-09-12' });

    for (const [x, data, tag] of [[a, '2026-09-10', 'a'], [b, '2026-09-12', 'b']] as const) {
      const r = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, data, `p1-08-${tag}`), analista.home, `p1-08-${tag}`);
      assert.equal(r.status, 201);
      assert.equal((await r.json()).estado, 'ACEITA');
    }
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: a.id, hoje: HOJE });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN');

    // Último gate liberado pela ROTA de responsabilidade → avaliação automática na mesma resposta.
    const rel = (await pool.query(`SELECT primeiro_dia_demurrage, data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [b.id])).rows[0];
    const resp = await post(app.base, `/a/containers/${b.id}/responsabilidade`, {
      status: 'CONFIRMADA_CLIENTE', baseRelogio: 'RELOGIO_CLIENTE', justificativa: 'Atraso do cliente na devolução.', evidenciaRef: 'ticket:p1-08',
      periodos: [{ lado: 'CLIENTE', inicio: rel.primeiro_dia_demurrage, fim: rel.data_final_apuracao }],
    }, gestor.home);
    assert.equal(resp.status, 200);
    assert.deepEqual((await resp.json()).encerramento, { resultado: 'finalizado' });

    const p = await statusProcesso(pool, c.processoId);
    assert.equal(p.apuracao_status, 'FINAL');
    assert.equal((await pool.query(`SELECT origem FROM fechamentos WHERE processo_id = $1`, [c.processoId])).rows[0].origem, 'automatico');
    const abertos = (await pool.query(
      `SELECT count(*)::int AS n FROM valores_apurados va JOIN containers c ON c.id = va.container_id WHERE c.processo_id = $1 AND va.calculation_status = 'OPEN'`,
      [c.processoId],
    )).rows[0].n;
    assert.equal(abertos, 0, 'valores ativos congelados (FINAL) na mesma transação');
  } finally { await app.close(); await pool.end(); }
});

test('P1 regra 1: minuta registrada ANTES do tracking não fabrica devolução — fica RECEBIDA e é aceita quando o tracking confirma', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R1', comDemurrage: false });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r = await new ClosingService(pool).registrarMinuta({
      containerId: c.containers[0].id, membershipId: analista.membershipId, numeroInformado: c.containers[0].numero,
      dataInformada: '2026-09-10', documento: doc('r1'), config: cfg,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.minuta.estado, 'RECEBIDA');
    assert.equal(r.minuta.aguardando, 'DEVOLUCAO_TRACKING');
    assert.deepEqual(r.encerramento, { resultado: 'bloqueado', motivo: 'conteiner_nao_devolvido', containerId: c.containers[0].id });
    const linha = (await pool.query(`SELECT effective_return_date, tracking_return_date FROM containers WHERE id = $1`, [c.containers[0].id])).rows[0];
    assert.deepEqual(linha, { effective_return_date: null, tracking_return_date: null }, 'nenhuma devolução fabricada');

    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    const [m] = await minutasDo(pool, c.containers[0].id);
    assert.equal(m.estado_minuta, 'ACEITA', 'o tracking confirmou a devolução → aceite técnico automático');
    assert.equal(m.data_tracking_comparada, '2026-09-10');
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #5 / #6 — divergência e inconsistência: pendência do analista, resolvida
 * por minuta substituta coerente (nunca por gestor).
 * ================================================================== */

test('P1 #5/#6: divergência abre pendência e bloqueia; inconsistência idem; a substituta coerente resolve, preserva histórico e encerra', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-05', comDemurrage: true });
    const x = c.containers[0];
    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: x.id, hoje: HOJE });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): minuta e leitura da fila são pessoais — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);

    // #5 — DIVERGENTE: coerente, mas a data difere da devolução oficial.
    let resp = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, '2026-09-12', 'div'), analista.home, 'p1-05-div');
    assert.equal(resp.status, 201);
    let corpo = await resp.json();
    assert.equal(corpo.estado, 'DIVERGENTE');
    assert.equal(corpo.pendencia, 'minuta_divergente_tracking');
    assert.deepEqual(corpo.encerramento, { resultado: 'bloqueado', motivo: 'divergencia_pendente', containerId: x.id });
    let pend = await pendenciasDo(pool, x.id);
    assert.equal(pend.length, 1);
    assert.equal(pend[0].estado, 'aberta');
    assert.equal(pend[0].contexto.dataMinuta, '2026-09-12');
    assert.equal(pend[0].contexto.dataTracking, '2026-09-10');
    const linha = (await pool.query(`SELECT tracking_return_date, effective_return_date FROM containers WHERE id = $1`, [x.id])).rows[0];
    assert.deepEqual(linha, { tracking_return_date: '2026-09-10', effective_return_date: null }, 'o tracking continua oficial');

    // A pendência é uma ação do analista responsável, na fila PESSOAL dele.
    // Produção P1 (filas pessoais): o ANALYST não lê mais a fila da equipe — o
    // escopo padrão (e único) dele é MINHA_FILA; a constante 'fila_da_equipe' deixou de existir.
    const lista = await (await get(app.base, '/v2/minutas', analista.home)).json();
    assert.equal(lista.contrato, 'demurrage.leitura.minutas.v2');
    assert.equal(lista.escopo, 'MINHA_FILA');
    assert.equal(lista.itens.length, 1);
    assert.equal(lista.itens[0].acaoNecessaria, 'registrar_minuta_substituta');
    assert.ok(!('podeValidar' in lista.itens[0]), 'não existe mais "pode validar"');

    // Resolução manual genérica NÃO se aplica a pendência de minuta (fora do catálogo).
    const pid = (await pool.query(`SELECT id FROM demurrage_pendencias WHERE container_id = $1 AND estado = 'aberta'`, [x.id])).rows[0].id;
    const manual = await post(app.base, `/a/pendencias/${pid}/resolver`, { familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'minuta_divergente_tracking', motivo: 'x' }, analista.home);
    assert.equal(manual.status, 400);

    // INCONSISTENTE: número de outro contêiner → substitui a divergente e troca a pendência.
    resp = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta('MSCU1234565', '2026-09-10', 'inc'), analista.home, 'p1-05-inc');
    corpo = await resp.json();
    assert.equal(corpo.estado, 'INCONSISTENTE');
    assert.equal(corpo.avaliacao.motivoInconsistencia, 'NUMERO_DIVERGENTE');
    assert.equal(corpo.pendencia, 'minuta_inconsistente');
    assert.deepEqual(corpo.encerramento, { resultado: 'bloqueado', motivo: 'minuta_inconsistente', containerId: x.id });
    pend = await pendenciasDo(pool, x.id);
    assert.deepEqual(pend.map((p: any) => [p.tipo, p.estado]), [['minuta_divergente_tracking', 'resolvida'], ['minuta_inconsistente', 'aberta']]);

    // #6 — substituta coerente: ACEITA, pendências resolvidas automaticamente, FINAL.
    resp = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, '2026-09-10', 'ok'), analista.home, 'p1-05-ok');
    corpo = await resp.json();
    assert.equal(corpo.estado, 'ACEITA');
    assert.equal(corpo.versao, 3);
    assert.equal(corpo.substituidas.length, 1);
    assert.deepEqual(corpo.encerramento, { resultado: 'finalizado' });
    pend = await pendenciasDo(pool, x.id);
    assert.ok(pend.every((p: any) => p.estado === 'resolvida' && p.resolvido_por === null), 'resolvidas pelo sistema, sem gestor');

    const hist = await minutasDo(pool, x.id);
    assert.deepEqual(hist.map((m: any) => m.estado_minuta), ['SUBSTITUIDA', 'SUBSTITUIDA', 'ACEITA'], 'histórico completo preservado');
    assert.equal(hist[0].substituida_por_id, hist[1].id);
    assert.equal(hist[1].substituida_por_id, hist[2].id);
    assert.equal(hist[2].supersedes_id, hist[1].id);
    const subst = (await pool.query(`SELECT count(*)::int AS n FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_SUBSTITUIDA'`, [x.id])).rows[0].n;
    assert.equal(subst, 2);
    assert.equal((await (await get(app.base, '/v2/minutas', analista.home)).json()).itens.length, 0, 'nenhum item irremovível');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * #7 — segunda minuta: nunca viola índice, nunca 500.
 * ================================================================== */

test('P1 #7: segunda minuta (inclusive em processo FINAL e sobre VALIDADA legada) nunca viola o índice nem devolve 500; divergência pós-FINAL registra fato material', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-07', comDemurrage: false });
    const x = c.containers[0];
    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);

    // Legado: uma VALIDADA do fluxo antigo, como o baseline deixava.
    const legada = await new MinutaRepository(pool).criarRecebida({ containerId: x.id, numeroInformado: x.numero, dataInformada: '2026-09-10' });
    await new MinutaRepository(pool).marcarValidada(legada.id, '2026-09-10', false, null);

    for (const tag of ['s1', 's2']) {
      const r = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, '2026-09-10', tag), analista.home, `p1-07-${tag}`);
      assert.equal(r.status, 201, `${tag}: nunca 500`);
      const corpo = await r.json();
      assert.equal(corpo.estado, 'ACEITA');
      assert.equal(corpo.exigeReabertura, false);
      assert.deepEqual(corpo.encerramento, { resultado: 'ja_final' });
    }
    const hist = await minutasDo(pool, x.id);
    assert.deepEqual(hist.map((m: any) => m.estado_minuta), ['SUBSTITUIDA', 'SUBSTITUIDA', 'ACEITA']);
    assert.equal(hist[0].validada_por, null);
    assert.equal(hist[0].data_validada, '2026-09-10', 'a linha legada mantém o que o fluxo antigo gravou');
    const vigentes = hist.filter((m: any) => m.substituida_por_id === null);
    assert.equal(vigentes.length, 1);

    // Divergência pós-FINAL: registrada como fato material, exige reabertura, sem 500.
    const r3 = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, '2026-09-25', 's3'), analista.home, 'p1-07-s3');
    assert.equal(r3.status, 201);
    const c3 = await r3.json();
    assert.equal(c3.estado, 'DIVERGENTE');
    assert.equal(c3.exigeReabertura, true);
    const fato = (await pool.query(`SELECT payload FROM closing_events WHERE container_id = $1 AND tipo_evento = 'FATO_MATERIAL_POS_FINAL'`, [x.id])).rows;
    assert.equal(fato.length, 1);
    assert.equal(fato[0].payload.valorAnterior, '2026-09-10');
    assert.equal(fato[0].payload.valorNovo, '2026-09-25');
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL', 'o estado congelado nunca muda sem reabertura');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * #9 — um contêiner bloqueado impede o encerramento.
 * ================================================================== */

test('P1 #9: um único contêiner bloqueado (minuta divergente) impede o encerramento do processo inteiro', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-09', comDemurrage: true, n: 2 });
    const [a, b] = c.containers;
    await devolverPeloTracking(pool, c, { [a.numero]: '2026-09-10', [b.numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const svc = new ClosingService(pool);
    for (const x of [a, b]) await confirmarResponsabilidadeClienteIntegral(pool, { containerId: x.id, hoje: HOJE });
    const ra = await svc.registrarMinuta({ containerId: a.id, membershipId: analista.membershipId, numeroInformado: a.numero, dataInformada: '2026-09-10', documento: doc('9a'), config: cfg });
    assert.ok(ra.ok && ra.minuta.estado === 'ACEITA');
    const rb = await svc.registrarMinuta({ containerId: b.id, membershipId: analista.membershipId, numeroInformado: b.numero, dataInformada: '2026-09-11', documento: doc('9b'), config: cfg });
    assert.ok(rb.ok && rb.minuta.estado === 'DIVERGENTE');
    assert.deepEqual(rb.ok && rb.encerramento, { resultado: 'bloqueado', motivo: 'divergencia_pendente', containerId: b.id });
    const p = await statusProcesso(pool, c.processoId);
    assert.equal(p.apuracao_status, 'OPEN');
    assert.equal(p.encerramento_bloqueio_container_id, b.id);
    // Varredura periódica chega à mesma decisão (idempotente, sem escrever FINAL).
    const v = await varrerEncerramentoAutomatico(pool, { hoje: HOJE });
    assert.equal(v.finalizados, 0);
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #10 / #11 — concorrência e idempotência.
 * ================================================================== */

test('P1 #10: concorrência — avaliações simultâneas nunca fecham duas vezes; registros simultâneos nunca deixam duas minutas vigentes', { skip: !url, timeout: 60000 }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // (a) processo elegível ainda OPEN (devolução gravada direto, sem o gatilho da ingestão).
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-10', comDemurrage: false });
    await new ContainerRepository(pool).applyObservation({
      containerId: c.containers[0].id, organizationId: c.orgId, campo: 'trackingReturnDate', valor: '2026-09-10',
      fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
    });
    await recalcularApuracaoContainer(pool, c.containers[0].id, { dataReferencia: HOJE });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN', 'sem gatilho: elegível, mas ainda OPEN');
    const gestor = await membro(pool, c.orgId, 'MANAGER');
    const svc = new ClosingService(pool);
    const resultados = await Promise.all([
      svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg }),
      svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg }),
      svc.finalizarProcesso({ processoId: c.processoId, membershipId: gestor.membershipId, config: cfg }),
      varrerEncerramentoAutomatico(pool, { hoje: HOJE }),
    ]);
    const fechados = (await pool.query(`SELECT count(*)::int AS n FROM fechamentos WHERE processo_id = $1`, [c.processoId])).rows[0].n;
    assert.equal(fechados, 1, `exatamente um fechamento: ${JSON.stringify(resultados)}`);
    const finais = (await pool.query(`SELECT count(*)::int AS n FROM closing_events WHERE processo_id = $1 AND tipo_evento = 'FECHAMENTO_FINAL'`, [c.processoId])).rows[0].n;
    assert.equal(finais, 1);

    // (b) registros simultâneos no MESMO contêiner (chaves diferentes).
    const d = await cenario(pool, { orgId: c.orgId, numeroProcesso: 'IM-P1-10B', comDemurrage: true });
    await devolverPeloTracking(pool, d, { [d.containers[0].numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, d.processoId, analista.membershipId);
    const regs = await Promise.all([1, 2, 3, 4].map((i) => registrarMinutaTecnica(pool, {
      containerId: d.containers[0].id, membershipId: analista.membershipId, numeroInformado: d.containers[0].numero,
      dataInformada: i % 2 ? '2026-09-10' : '2026-09-11', documento: doc(`c${i}`), hoje: HOJE,
    })));
    assert.ok(regs.every((r) => r.ok), 'nenhum conflito de domínio vira erro');
    const hist = await minutasDo(pool, d.containers[0].id);
    assert.equal(hist.length, 4);
    assert.equal(hist.filter((m: any) => m.substituida_por_id === null).length, 1, 'exatamente UMA vigente');
    assert.deepEqual(hist.map((m: any) => m.versao).sort(), [1, 2, 3, 4], 'versões distintas e sequenciais');
    const abertas = (await pool.query(`SELECT count(*)::int AS n FROM demurrage_pendencias WHERE container_id = $1 AND estado = 'aberta'`, [d.containers[0].id])).rows[0].n;
    const vig = hist.find((m: any) => m.substituida_por_id === null);
    assert.equal(abertas, vig.estado_minuta === 'DIVERGENTE' ? 1 : 0, 'pendência espelha exatamente a vigente');

    // (c) a MESMA chave em paralelo nunca duplica.
    const idem = { organizationId: c.orgId, rota: 'registrar_minuta', chave: 'p1-10-mesma', hash: 'h'.repeat(64) };
    const mesmas = await Promise.all([1, 2, 3].map(() => registrarMinutaTecnica(pool, {
      containerId: d.containers[0].id, membershipId: analista.membershipId, numeroInformado: d.containers[0].numero,
      dataInformada: '2026-09-10', documento: doc('mesma'), hoje: HOJE, idempotencia: idem,
    })));
    assert.ok(mesmas.every((r) => r.ok));
    const ids = new Set(mesmas.map((r) => (r.ok ? r.minuta.id : '')));
    assert.equal(ids.size, 1);
    assert.equal(mesmas.filter((r) => r.ok && r.novo).length, 1);
  } finally { await pool.end(); }
});

test('P1 #11: repetição idempotente (mesma Idempotency-Key, mesmo corpo) devolve o MESMO resultado e não escreve nada; corpo diferente é 409', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-11', comDemurrage: true });
    const x = c.containers[0];
    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const corpo = corpoMinuta(x.numero, '2026-09-12', 'idem');

    const r1 = await post(app.base, `/a/containers/${x.id}/minutas`, corpo, analista.home, 'p1-11');
    assert.equal(r1.status, 201);
    const b1 = await r1.json();
    const depois1 = await contagens(pool);
    const r2 = await post(app.base, `/a/containers/${x.id}/minutas`, corpo, analista.home, 'p1-11');
    assert.equal(r2.status, 200);
    const b2 = await r2.json();
    assert.equal(b2.minutaId, b1.minutaId);
    assert.equal(b2.estado, b1.estado);
    assert.equal(b2.versao, b1.versao);
    assert.deepEqual(b2.documento, b1.documento);
    assert.deepEqual(await contagens(pool), depois1, 'réplica sem nenhuma escrita');

    const outro = await post(app.base, `/a/containers/${x.id}/minutas`, { ...corpo, documento: doc('outro-arquivo') }, analista.home, 'p1-11');
    assert.equal(outro.status, 409);
    assert.equal((await outro.json()).error, 'idempotency_key_reutilizada');
    assert.deepEqual(await contagens(pool), depois1);

    // Acionamento administrativo repetido também é idempotente.
    const gestor = await membro(pool, c.orgId, 'MANAGER');
    const f1 = await post(app.base, `/a/processos/${c.processoId}/finalizar`, {}, gestor.home);
    assert.equal(f1.status, 409, 'nunca contorna o gate (minuta divergente)');
    assert.equal((await f1.json()).error, 'divergencia_pendente');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * #12 / #13 / #14 — FINAL fora da fila ativa; filtro explícito; contadores.
 * ================================================================== */

test('P1 #12/#13/#14: FINAL sai da fila padrão e dos contadores; filtro explícito, busca, paginação e detalhe direto encontram finalizados', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    // Dois FINAL com demurrage (estado de contêiner DEVOLVIDO_AGUARDANDO_TRATAMENTO — o caso do defeito) + um OPEN.
    const org = (await new OrganizationRepository(pool).create('Rocket', 'rk-fila')).id;
    const leitor = await membro(pool, org, 'ANALYST');
    const finais: Cenario[] = [];
    for (const n of ['IM-P1-12A', 'IM-P1-12B']) {
      const c = await cenario(pool, { orgId: org, numeroProcesso: n, comDemurrage: true });
      // Produção P1 (filas pessoais): o ANALYST só registra minuta e só lê (fila/detalhe/filtros)
      // processos atribuídos a ele — todos os processos do cenário são dele.
      await atribuirResponsavelDeTeste(pool, c.processoId, leitor.membershipId);
      await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
      await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.containers[0].id, hoje: HOJE });
      await new ClosingService(pool).registrarMinuta({
        containerId: c.containers[0].id, membershipId: leitor.membershipId, numeroInformado: c.containers[0].numero,
        dataInformada: '2026-09-10', documento: doc(n), config: cfg,
      });
      assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
      finais.push(c);
    }
    const aberto = await cenario(pool, { orgId: org, numeroProcesso: 'IM-P1-12C', comDemurrage: true });
    // Produção P1 (filas pessoais): o OPEN também é do ANALYST leitor (fila pessoal).
    await atribuirResponsavelDeTeste(pool, aberto.processoId, leitor.membershipId);
    await devolverPeloTracking(pool, aberto, { [aberto.containers[0].numero]: '2026-09-10' });

    // #12 — fila padrão (mesmo incluindo silenciosos): só o OPEN.
    for (const q of ['', '?incluirSilenciosos=true']) {
      const fila = await (await get(app.base, `/v2/processos${q}`, leitor.home)).json();
      // Produção P1 (filas pessoais): o escopo padrão (e único) do ANALYST é MINHA_FILA;
      // a constante 'fila_da_equipe' deixou de existir.
      assert.equal(fila.escopo, 'MINHA_FILA');
      assert.equal(fila.apuracaoStatus, 'OPEN');
      assert.deepEqual(fila.itens.map((i: any) => i.processo.id), [aberto.processoId]);
      assert.equal(fila.total, 1);
      assert.equal(fila.itens[0].apuracaoStatus, 'OPEN');
      assert.equal(fila.itens[0].encerramento.modo, 'automatico');
    }
    // Busca padrão não traz finalizado...
    const buscaPadrao = await (await get(app.base, `/v2/processos?busca=IM-P1-12A`, leitor.home)).json();
    assert.equal(buscaPadrao.total, 0);

    // #13 — filtro explícito FINAL, busca, paginação e detalhe direto.
    const finalPag1 = await (await get(app.base, `/v2/processos?apuracaoStatus=FINAL&incluirSilenciosos=true&limite=1`, leitor.home)).json();
    assert.equal(finalPag1.total, 2);
    assert.equal(finalPag1.itens.length, 1);
    assert.equal(finalPag1.itens[0].apuracaoStatus, 'FINAL');
    assert.ok(finalPag1.itens[0].fechadoEm);
    const finalPag2 = await (await get(app.base, `/v2/processos?apuracaoStatus=FINAL&incluirSilenciosos=true&limite=1&cursor=${encodeURIComponent(finalPag1.cursor)}`, leitor.home)).json();
    assert.equal(finalPag2.itens.length, 1);
    assert.deepEqual(new Set([finalPag1.itens[0].processo.id, finalPag2.itens[0].processo.id]), new Set(finais.map((f) => f.processoId)));
    assert.equal(finalPag2.cursor, null);
    // Cursor de uma situação não serve para a outra.
    const cruzado = await get(app.base, `/v2/processos?incluirSilenciosos=true&limite=1&cursor=${encodeURIComponent(finalPag1.cursor)}`, leitor.home);
    assert.equal(cruzado.status, 400);
    const buscaFinal = await (await get(app.base, `/v2/processos?apuracaoStatus=FINAL&busca=IM-P1-12A`, leitor.home)).json();
    assert.deepEqual(buscaFinal.itens.map((i: any) => i.processo.id), [finais[0].processoId]);
    const todos = await (await get(app.base, `/v2/processos?apuracaoStatus=TODOS&incluirSilenciosos=true`, leitor.home)).json();
    assert.equal(todos.total, 3);
    assert.equal((await get(app.base, `/v2/processos?apuracaoStatus=final`, leitor.home)).status, 400, 'valor fora da lista fechada');
    const det = await (await get(app.base, `/v2/processos/${finais[0].processoId}`, leitor.home)).json();
    assert.equal(det.apuracaoStatus, 'FINAL');
    assert.equal(det.fechamento.origem, 'automatico');
    assert.equal(det.fechamento.realizadoPor, null);

    // #14 — contadores da visão ativa excluem FINAL.
    const filtros = await (await get(app.base, `/v2/filtros`, leitor.home)).json();
    assert.equal(filtros.apuracaoStatus, 'OPEN');
    assert.deepEqual(filtros.apuracao, { abertos: 1, finalizados: 2 });
    assert.equal(filtros.estados.reduce((s: number, e: any) => s + e.total, 0), 1);
    assert.equal(filtros.baldes.reduce((s: number, e: any) => s + e.total, 0), 1);
    const filtrosFinal = await (await get(app.base, `/v2/filtros?apuracaoStatus=FINAL`, leitor.home)).json();
    assert.equal(filtrosFinal.estados.reduce((s: number, e: any) => s + e.total, 0), 2);
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * #15 / #16 — RBAC e isolamento.
 * ================================================================== */

test('P1 #15: ANALYST não ganha poder de gestor — finalizar/autorizar reabertura seguem MANAGER/ADMIN; a rota de validação foi removida para todos', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-15', comDemurrage: true });
    const x = c.containers[0];
    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta e solicitar reabertura são ações pessoais — o
    // ANALYST é o responsável do processo (e mesmo assim não finaliza nem autoriza reabertura).
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const gestor = await membro(pool, c.orgId, 'MANAGER');
    const legada = await new MinutaRepository(pool).criarRecebida({ containerId: x.id, numeroInformado: x.numero, dataInformada: '2026-09-10' });

    const antes = await contagens(pool);
    const fin = await post(app.base, `/a/processos/${c.processoId}/finalizar`, {}, analista.home);
    assert.equal(fin.status, 403);
    for (const quem of [analista, gestor]) {
      const v = await post(app.base, `/a/minutas/${legada.id}/validar`, { aceitarDivergencia: true }, quem.home);
      assert.equal(v.status, 410, 'nem gestor valida minuta — o aceite é técnico');
      assert.equal((await v.json()).error, 'rota_removida');
    }
    assert.deepEqual(await contagens(pool), antes, 'nenhuma escrita');
    assert.equal((await minutasDo(pool, x.id))[0].estado_minuta, 'RECEBIDA');

    // Reabertura: analista solicita (já permitido), mas não autoriza.
    const service = new ClosingService(pool);
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: x.id, hoje: HOJE });
    const reg = await service.registrarMinuta({ containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-10', documento: doc('15'), config: cfg });
    assert.ok(reg.ok);
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
    const sol = await (await post(app.base, `/a/processos/${c.processoId}/reabertura/solicitar`, { justificativa: 'Corrigir devolução.' }, analista.home)).json();
    const aut = await post(app.base, `/a/reaberturas/${sol.reaberturaId}/autorizar`, {}, analista.home);
    assert.equal(aut.status, 403);

    // Auditoria estática: nenhum caminho de produção escreve a aprovação humana antiga.
    const raiz = path.resolve(__dirname, '..', '..');
    // (`validarMinuta` não entra: é também o nome da checagem estrutural PURA,
    // reusada pela verificação técnica; o método de serviço não existe mais e
    // o compilador barraria qualquer chamada a ele.)
    const proibidas = new Set(['marcarValidada', 'marcarRejeitada']);
    const achados: string[] = [];
    const visitar = (dir: string) => {
      for (const nome of fs.readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (fs.statSync(p).isDirectory()) { if (nome !== '__tests__' && nome !== 'frontend-tests') visitar(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
        const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true);
        const v = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const alvo = n.expression;
            const nomeF = ts.isIdentifier(alvo) ? alvo.text : (ts.isPropertyAccessExpression(alvo) && ts.isIdentifier(alvo.name)) ? alvo.name.text : undefined;
            if (nomeF && proibidas.has(nomeF)) achados.push(`${path.relative(raiz, p)}:${nomeF}`);
          }
          ts.forEachChild(n, v);
        };
        v(sf);
      }
    };
    visitar(raiz);
    assert.deepEqual(achados, [], 'chamadas de produção à aprovação humana de minuta');
  } finally { await app.close(); await pool.end(); }
});

test('P1 #16: outra organização nunca lê nem altera documento, minuta ou processo (404 idêntico a inexistente, zero escrita)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const a = await cenario(pool, { numeroProcesso: 'IM-P1-16A', comDemurrage: true });
    const xa = a.containers[0];
    await devolverPeloTracking(pool, a, { [xa.numero]: '2026-09-10' });
    const analistaA = await membro(pool, a.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta e ler o documento são pessoais — o ANALYST A é o responsável.
    await atribuirResponsavelDeTeste(pool, a.processoId, analistaA.membershipId);
    const ra = await post(app.base, `/a/containers/${xa.id}/minutas`, corpoMinuta(xa.numero, '2026-09-12', '16a'), analistaA.home, 'p1-16-a');
    const minutaA = (await ra.json()).minutaId;

    const orgB = (await new OrganizationRepository(pool).create('Outra', 'rk-outra')).id;
    const analistaB = await membro(pool, orgB, 'ANALYST');
    const gestorB = await membro(pool, orgB, 'ADMIN');
    const antes = await contagens(pool);

    const doc200 = await get(app.base, `/v2/minutas/${minutaA}/documento`, analistaA.home);
    assert.equal(doc200.status, 200);
    const corpoDoc = await doc200.json();
    assert.equal(corpoDoc.referencia, doc('16a').referencia);
    assert.equal(corpoDoc.versaoMinuta, 1);
    assert.equal(corpoDoc.incluidoPor.membershipId, analistaA.membershipId);

    const r404 = [
      await get(app.base, `/v2/minutas/${minutaA}/documento`, analistaB.home),
      await get(app.base, `/v2/minutas/${randomUUID()}/documento`, analistaB.home),
      await get(app.base, `/v2/processos/${a.processoId}`, analistaB.home),
      await post(app.base, `/a/containers/${xa.id}/minutas`, corpoMinuta(xa.numero, '2026-09-10', '16b'), analistaB.home, 'p1-16-b'),
      await post(app.base, `/a/processos/${a.processoId}/finalizar`, {}, gestorB.home),
    ];
    for (const r of r404) assert.equal(r.status, 404);
    const listaB = await (await get(app.base, `/v2/minutas?estado=DIVERGENTE`, analistaB.home)).json();
    assert.equal(listaB.itens.length, 0);
    const filaB = await (await get(app.base, `/v2/processos?apuracaoStatus=TODOS&incluirSilenciosos=true`, analistaB.home)).json();
    assert.equal(filaB.total, 0);
    // Serviço chamado direto com membership de OUTRA organização: recusado, zero escrita.
    const direto = await registrarMinutaTecnica(pool, {
      containerId: xa.id, membershipId: analistaB.membershipId, numeroInformado: xa.numero, dataInformada: '2026-09-10', documento: doc('16c'), hoje: HOJE,
    });
    assert.deepEqual(direto, { ok: false, motivo: 'ator_nao_autorizado' });
    assert.deepEqual(await contagens(pool), antes);
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== *
 * #17 — falha do documento não deixa transição parcial.
 * ================================================================== */

test('P1 #17: falha ao gravar o documento desfaz TUDO — nenhuma minuta, substituição, pendência ou evento parcial; o retry com a mesma chave funciona', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-17', comDemurrage: true });
    const x = c.containers[0];
    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const svc = new ClosingService(pool);
    const primeira = await svc.registrarMinuta({ containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-12', documento: doc('17a'), config: cfg });
    assert.ok(primeira.ok && primeira.minuta.estado === 'DIVERGENTE');
    const antes = await contagens(pool);
    const pendAntes = await pendenciasDo(pool, x.id);

    const idem = { organizationId: c.orgId, rota: 'registrar_minuta', chave: 'p1-17', hash: 'a'.repeat(64) };
    await assert.rejects(() => registrarMinutaTecnica(pool, {
      containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-10',
      documento: doc('17b'), hoje: HOJE, idempotencia: idem,
      _testeFalhaAoGravarDocumento: () => { throw new Error('armazenamento indisponível'); },
    }), /armazenamento indisponível/);
    assert.deepEqual(await contagens(pool), antes);
    assert.deepEqual(await pendenciasDo(pool, x.id), pendAntes);
    const hist = await minutasDo(pool, x.id);
    assert.deepEqual(hist.map((m: any) => [m.estado_minuta, m.substituida_por_id]), [['DIVERGENTE', null]], 'a vigente anterior NÃO foi substituída');

    // Defesa do banco: minuta do fluxo técnico sem documento nunca comita.
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      await cli.query(`UPDATE minutas SET estado_minuta = 'SUBSTITUIDA', substituida_por_id = $2, substituida_em = now() WHERE id = $1`, [hist[0].id, '00000000-0000-4000-8000-0000000000aa']);
      await cli.query(
        `INSERT INTO minutas (id, container_id, estado_minuta, numero_informado, data_informada, regra_avaliacao, versao)
         VALUES ('00000000-0000-4000-8000-0000000000aa', $1, 'RECEBIDA', $2, '2026-09-10', 'minuta.tecnica.v1', 9)`,
        [x.id, x.numero],
      );
      await assert.rejects(() => cli.query('COMMIT'), /exige documento/);
    } finally { cli.release(); }
    assert.deepEqual(await contagens(pool), antes);

    const retry = await registrarMinutaTecnica(pool, {
      containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-10', documento: doc('17b'), hoje: HOJE, idempotencia: idem,
    });
    assert.ok(retry.ok && retry.novo && retry.minuta.estado === 'ACEITA');
  } finally { await pool.end(); }
});

/* ================================================================== *
 * #18 — legado legível e com semântica preservada; migração aditiva.
 * ================================================================== */

test('P1 #18: registros LEGADOS (RECEBIDA/VALIDADA/REJEITADA do fluxo antigo) continuam legíveis, com a semântica antiga até serem substituídos', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-18', comDemurrage: true, n: 2 });
    const [a, b] = c.containers;
    // Devolução registrada SEM o gatilho (estado legado típico) e legado montado pelos métodos antigos
    // (validação humana antiga gravava effective_return_date a partir da minuta).
    const repo = new MinutaRepository(pool);
    for (const x of [a, b]) {
      await new ContainerRepository(pool).applyObservation({
        containerId: x.id, organizationId: c.orgId, campo: 'trackingReturnDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z'),
      });
    }
    const rej = await repo.criarRecebida({ containerId: a.id, numeroInformado: 'XXXX', dataInformada: '2026-09-10' });
    await repo.marcarRejeitada(rej.id, 'NUMERO_DIVERGENTE', null);
    const val = await repo.criarRecebida({ containerId: a.id, numeroInformado: a.numero, dataInformada: '2026-09-10' });
    await repo.marcarValidada(val.id, '2026-09-10', false, null);
    await pool.query(`UPDATE containers SET effective_return_date = '2026-09-10', effective_return_minuta_id = $2 WHERE id = $1`, [a.id, val.id]);
    for (const x of [a, b]) {
      await recalcularApuracaoContainer(pool, x.id, { dataReferencia: HOJE });
      await confirmarResponsabilidadeClienteIntegral(pool, { containerId: x.id, hoje: HOJE });
    }
    const recDiv = await repo.criarRecebida({ containerId: b.id, numeroInformado: b.numero, dataInformada: '2026-09-15' });
    await pool.query(`UPDATE minutas SET divergente_do_tracking = true WHERE id = $1`, [recDiv.id]);
    const leitor = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): detalhe, listas, timeline e minuta do ANALYST são pessoais — ele é o responsável.
    await atribuirResponsavelDeTeste(pool, c.processoId, leitor.membershipId);

    // Legível: detalhe, lista por estado legado e lista padrão (RECEBIDA legada exige ação).
    const det = await (await get(app.base, `/v2/containers/${a.id}`, leitor.home)).json();
    assert.deepEqual(det.minutas.map((m: any) => [m.estado, m.legado, m.vigente]), [['REJEITADA', true, true], ['VALIDADA', true, true]]);
    const valid = await (await get(app.base, `/v2/minutas?estado=VALIDADA`, leitor.home)).json();
    assert.equal(valid.itens.length, 1);
    assert.equal(valid.itens[0].legado, true);
    const padrao = await (await get(app.base, `/v2/minutas`, leitor.home)).json();
    assert.deepEqual(padrao.itens.map((i: any) => [i.minutaId, i.acaoNecessaria]), [[recDiv.id, 'registrar_minuta_substituta']]);

    // Semântica legada preservada no gate: RECEBIDA divergente legada bloqueia.
    const r1 = await new ClosingService(pool).avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg });
    assert.deepEqual(r1, { resultado: 'bloqueado', motivo: 'divergencia_pendente', containerId: b.id });

    // A ação do analista: registrar a substituta coerente — substitui o legado
    // (sem apagar), e a devolução efetiva legada perde a base (volta o tracking).
    const ra = await post(app.base, `/a/containers/${a.id}/minutas`, corpoMinuta(a.numero, '2026-09-10', '18a'), leitor.home, 'p1-18-a');
    assert.equal((await ra.json()).estado, 'ACEITA');
    const linhaA = (await pool.query(`SELECT effective_return_date, effective_return_minuta_id, tracking_return_date FROM containers WHERE id = $1`, [a.id])).rows[0];
    assert.deepEqual(linhaA, { effective_return_date: null, effective_return_minuta_id: null, tracking_return_date: '2026-09-10' }, 'a devolução efetiva legada perde a base; o tracking é a oficial');
    const histA = await minutasDo(pool, a.id);
    assert.deepEqual(histA.map((m: any) => m.estado_minuta), ['SUBSTITUIDA', 'SUBSTITUIDA', 'ACEITA']);
    assert.equal(histA[1].data_validada, '2026-09-10', 'o que o gestor gravou no fluxo antigo continua na linha');
    const evLegado = (await pool.query(`SELECT payload FROM closing_events WHERE container_id = $1 AND tipo_evento = 'MINUTA_SUBSTITUIDA' ORDER BY criado_em`, [a.id])).rows;
    assert.deepEqual(evLegado.map((e: any) => [e.payload.estadoAnterior, e.payload.legado]), [['REJEITADA', true], ['VALIDADA', true]]);

    const rb = await post(app.base, `/a/containers/${b.id}/minutas`, corpoMinuta(b.numero, '2026-09-10', '18b'), leitor.home, 'p1-18-b');
    const corpoB = await rb.json();
    assert.equal(corpoB.estado, 'ACEITA');
    assert.deepEqual(corpoB.encerramento, { resultado: 'finalizado' });
    const tl = await (await get(app.base, `/v2/processos/${c.processoId}/timeline?limite=200`, leitor.home)).json();
    assert.ok(tl.eventos.some((e: any) => e.tipo === 'MINUTA_ACEITA' && /verificação técnica automática/.test(e.resumo)));
    assert.ok(tl.eventos.some((e: any) => e.tipo === 'MINUTA_SUBSTITUIDA'));
  } finally { await app.close(); await pool.end(); }
});

test('P1 #18b: migration 0048 é ADITIVA — aplica sobre um banco na 0047 com dados legados preservados; reexecução é no-op', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    const ate47 = await runMigrations(pool, { until: '0047_handoff_controle_capacidade.sql' });
    assert.equal(ate47.applied[ate47.applied.length - 1], '0047_handoff_controle_capacidade.sql');
    const org = await new OrganizationRepository(pool).create('Legado', 'legado');
    const proc = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: 'IM-LEG', clienteId: null });
    const c = await new ContainerRepository(pool).create(org.id, proc.id, 'LEGU0000013');
    for (const estado of ['RECEBIDA', 'VALIDADA', 'REJEITADA']) {
      await pool.query(`INSERT INTO minutas (container_id, estado_minuta, data_informada, data_validada) VALUES ($1, $2, '2026-09-10', $3)`, [c.id, estado, estado === 'VALIDADA' ? '2026-09-10' : null]);
    }
    const antes = (await pool.query(`SELECT id, estado_minuta, data_validada FROM minutas ORDER BY id`)).rows;

    const up = await runMigrations(pool);
    // Produção P1 (filas pessoais): a 0049 (sessões/identidade/atribuição, aditiva) vem junto num upgrade a partir da 0047; auditoria final: também a 0050 e a 0051 (aditivas).
    assert.deepEqual(up.applied, ['0048_minuta_aceite_tecnico_encerramento_automatico.sql', '0049_sessoes_identidade_atribuicao.sql', '0050_avisos_redirecionamento_responsavel.sql', '0051_integracao_microsoft_organizacao.sql', '0052_administracao_tarifaria.sql' /* Produção P1 (administração tarifária): aditiva */]);
    const depois = (await pool.query(`SELECT id, estado_minuta, data_validada, regra_avaliacao, substituida_por_id FROM minutas ORDER BY id`)).rows;
    assert.deepEqual(depois.map((m: any) => ({ id: m.id, estado_minuta: m.estado_minuta, data_validada: m.data_validada })), antes, 'nenhuma linha legada reescrita');
    assert.ok(depois.every((m: any) => m.regra_avaliacao === null && m.substituida_por_id === null));
    const f = await pool.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'fechamentos' AND column_name = 'origem'`);
    assert.match(f.rows[0].column_default, /humano/);
    const rerun = await runMigrations(pool);
    assert.deepEqual(rerun.applied, []);
  } finally { await pool.end(); }
});

/* ================================================================== *
 * Revisão adversarial (antes do commit) — um teste por achado confirmado.
 * ================================================================== */

/** Processo sem demurrage, contêiner único, FINAL pelo gatilho do tracking (devolução 09-10). */
async function finalSemDemurrage(pool: Pool, numeroProcesso: string) {
  const c = await cenario(pool, { numeroProcesso, comDemurrage: false });
  const x = c.containers[0];
  await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
  assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
  return { c, x };
}

async function reabrir(pool: Pool, processoId: string, gestor: Membro) {
  const svc = new ClosingService(pool);
  const s = await svc.solicitarReabertura({ processoId, membershipId: gestor.membershipId, justificativa: 'correção pós-FINAL' });
  assert.ok(s.ok, JSON.stringify(s));
  const a = await svc.autorizarReabertura({ reaberturaId: s.ok ? s.reaberturaId : '', membershipId: gestor.membershipId, config: cfg });
  assert.deepEqual(a, { ok: true });
  assert.equal((await statusProcesso(pool, processoId)).apuracao_status, 'OPEN');
}

test('P1 revisão #1: devolução efetiva LEGADA de minuta substituída em processo FINAL não sobrevive à reabertura — o re-encerramento usa a devolução do tracking', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R1', comDemurrage: false });
    const x = c.containers[0];
    // Fluxo antigo: o gestor aprovou uma minuta de 09-05 e a data dela virou a devolução efetiva.
    const repo = new MinutaRepository(pool);
    const legada = await repo.criarRecebida({ containerId: x.id, numeroInformado: x.numero, dataInformada: '2026-09-05' });
    await repo.marcarValidada(legada.id, '2026-09-05', false, null);
    await pool.query(`UPDATE containers SET effective_return_date = '2026-09-05', effective_return_minuta_id = $2 WHERE id = $1`, [x.id, legada.id]);
    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    // Devolução vinda de minuta (≠ tracking): o automático nunca a congela; o gestor fecha, como no fluxo antigo.
    const st0 = await statusProcesso(pool, c.processoId);
    assert.equal(st0.apuracao_status, 'OPEN');
    assert.equal(st0.encerramento_bloqueio, 'devolucao_efetiva_legada');
    const gestor = await membro(pool, c.orgId, 'MANAGER');
    assert.deepEqual(await new ClosingService(pool).finalizarProcesso({ processoId: c.processoId, membershipId: gestor.membershipId, config: cfg }), { ok: true });
    const relogioFinal = () => pool.query(`SELECT data_final_apuracao FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [x.id]).then((r) => r.rows[0].data_final_apuracao);
    assert.equal(await relogioFinal(), '2026-09-05', 'premissa: o FINAL legado congelou a data da minuta antiga');

    // Analista registra a minuta igual ao tracking com o processo FINAL: fato material, exige reabertura.
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r = await new ClosingService(pool).registrarMinuta({
      containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-10', documento: doc('r1'), config: cfg,
    });
    assert.ok(r.ok && r.minuta.estado === 'ACEITA' && r.exigeReabertura === true);
    assert.equal((await pool.query(`SELECT effective_return_date FROM containers WHERE id = $1`, [x.id])).rows[0].effective_return_date, '2026-09-05', 'FINAL é congelado');

    await reabrir(pool, c.processoId, gestor);
    // Já na autorização da reabertura: a minuta legada substituída deixou de sustentar a devolução.
    const linha = (await pool.query(`SELECT effective_return_date, effective_return_minuta_id FROM containers WHERE id = $1`, [x.id])).rows[0];
    assert.deepEqual(linha, { effective_return_date: null, effective_return_minuta_id: null }, 'a minuta legada substituída deixou de sustentar a devolução');
    assert.equal(await relogioFinal(), '2026-09-10', 'o recálculo da reabertura já usa a devolução OFICIAL (tracking)');
    const res = await new ClosingService(pool).avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg });
    assert.deepEqual(res, { resultado: 'finalizado' });
    assert.equal(await relogioFinal(), '2026-09-10', 'relógios e valores re-congelados na devolução OFICIAL (tracking)');
    const ev = (await pool.query(`SELECT payload FROM closing_events WHERE container_id = $1 AND tipo_evento = 'RECALCULO' AND payload->>'motivo' = 'devolucao_efetiva_legada_substituida'`, [x.id])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.effectiveAnterior, '2026-09-05');
    assert.equal(ev[0].payload.minutaLegadaId, legada.id);
  } finally { await pool.end(); }
});

test('P1 revisão #3: o encerramento reavalia a minuta NA MESMA transação — nunca fecha sobre ACEITA desatualizada; processo FINAL nunca é reavaliado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    // (a) OPEN: a minuta ficou ACEITA; depois o Gate Out mudou para DEPOIS da data da minuta
    //     (fato comitado entre avaliações). O encerramento precisa enxergar isso sob o lock.
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R3A', comDemurrage: false });
    const x = c.containers[0];
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const svc = new ClosingService(pool);
    const r = await registrarMinutaTecnica(pool, {
      containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-10', documento: doc('r3a'), hoje: HOJE,
    });
    assert.ok(r.ok && r.minuta.estado === 'RECEBIDA');
    await pool.query(`UPDATE containers SET tracking_return_date = '2026-09-10' WHERE id = $1`, [x.id]);
    await pool.query(
      `UPDATE minutas SET estado_minuta = 'ACEITA', aguardando = NULL, data_tracking_comparada = '2026-09-10', avaliada_em = now(),
              fatos_avaliacao = jsonb_build_object('tracking', '2026-09-10', 'descarga', '2026-09-01', 'gateOut', NULL) WHERE id = $1`,
      [r.ok && r.minuta.id],
    );
    await pool.query(`UPDATE containers SET gate_out_date = '2026-09-11' WHERE id = $1`, [x.id]);
    const res = await svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg });
    assert.deepEqual(res, { resultado: 'bloqueado', motivo: 'minuta_inconsistente', containerId: x.id });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN');
    assert.equal((await minutasDo(pool, x.id))[0].estado_minuta, 'INCONSISTENTE', 'a reavaliação persiste mesmo com o encerramento bloqueado');
    assert.deepEqual((await pendenciasDo(pool, x.id)).map((p: any) => [p.tipo, p.estado]), [['minuta_inconsistente', 'aberta']]);

    // (b) FINAL: fatos "mudados" depois do FINAL nunca reabrem a avaliação da minuta por fora da reabertura.
    const { c: cf, x: xf } = await finalSemDemurrage(pool, 'IM-P1-R3B');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    const analistaF = await membro(pool, cf.orgId, 'ANALYST');
    await atribuirResponsavelDeTeste(pool, cf.processoId, analistaF.membershipId);
    const rf = await registrarMinutaTecnica(pool, {
      containerId: xf.id, membershipId: analistaF.membershipId, numeroInformado: xf.numero, dataInformada: '2026-09-10', documento: doc('r3b'), hoje: HOJE,
    });
    assert.ok(rf.ok && rf.minuta.estado === 'ACEITA');
    await pool.query(`UPDATE containers SET gate_out_date = '2026-09-11' WHERE id = $1`, [xf.id]);
    const antes = await contagens(pool);
    assert.deepEqual(await reavaliarMinutasDoProcesso(pool, cf.processoId, HOJE), { reavaliadas: 0 });
    assert.equal((await minutasDo(pool, xf.id))[0].estado_minuta, 'ACEITA');
    assert.deepEqual(await contagens(pool), antes, 'nenhuma escrita (nem pendência) em processo FINAL');
    assert.deepEqual(await svc.finalizarProcesso({ processoId: cf.processoId, membershipId: (await membro(pool, cf.orgId, 'MANAGER')).membershipId, config: cfg }), { ok: false, motivo: 'ja_final' });
    assert.deepEqual(await contagens(pool), antes);
  } finally { await pool.end(); }
});

test('P1 revisão #4: falha inesperada da avaliação automática fica registrada no processo — ele sai do topo da varredura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R4', comDemurrage: false, n: 2 });
    // A ingestão da descarga no cenário já avaliou uma vez (bloqueado: contêiner não devolvido).
    const antes = (await pool.query(`SELECT encerramento_bloqueio, encerramento_avaliado_em FROM processos WHERE id = $1`, [c.processoId])).rows[0];
    assert.equal(antes.encerramento_bloqueio, 'conteiner_nao_devolvido');
    const svc = new ClosingService(pool);
    (svc as any).avaliarEncerramentoAutomatico = async () => { throw Object.assign(new Error('falha simulada'), { code: 'XX000' }); };
    assert.deepEqual(await svc.avaliarEncerramentoAutomaticoSeguro({ processoId: c.processoId, config: cfg }), { resultado: 'avaliacao_adiada' });
    const p = (await pool.query(`SELECT apuracao_status, encerramento_bloqueio, encerramento_avaliado_em FROM processos WHERE id = $1`, [c.processoId])).rows[0];
    assert.equal(p.apuracao_status, 'OPEN');
    assert.equal(p.encerramento_bloqueio, 'falha_avaliacao');
    assert.ok(p.encerramento_avaliado_em > antes.encerramento_avaliado_em, 'avaliado_em atualizado: a ordem da varredura (NULLS FIRST, mais antigo primeiro) passa adiante');
  } finally { await pool.end(); }
});

test('P1 revisão #5: a varredura nunca re-encerra processo com reabertura aberta — conferido sob o lock, não só na seleção', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const { c } = await finalSemDemurrage(pool, 'IM-P1-R5');
    await reabrir(pool, c.processoId, await membro(pool, c.orgId, 'MANAGER'));
    // A leitura diz por que ele não fecha sozinho (nunca "avaliado, sem bloqueio" com a data do fechamento anterior).
    assert.equal((await statusProcesso(pool, c.processoId)).encerramento_bloqueio, 'reabertura_em_andamento');
    const svc = new ClosingService(pool);
    // Mesmo chamado diretamente (como se tivesse sido selecionado antes da reabertura):
    assert.deepEqual(
      await svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg, respeitarReabertura: true }),
      { resultado: 'bloqueado', motivo: 'reabertura_em_andamento', containerId: null },
    );
    assert.deepEqual(await varrerEncerramentoAutomatico(pool, { hoje: HOJE }), { avaliados: 0, finalizados: 0, bloqueados: 0, falhas: 0 });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN');
    // Um gatilho de ação/fato (sem a restrição da varredura) re-encerra, com histórico.
    assert.deepEqual(await svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg }), { resultado: 'finalizado' });
    const ev = (await pool.query(`SELECT tipo_evento FROM closing_events WHERE processo_id = $1 AND tipo_evento IN ('FECHAMENTO_FINAL', 'REFECHAMENTO') ORDER BY criado_em`, [c.processoId])).rows;
    assert.deepEqual(ev.map((e: any) => e.tipo_evento), ['FECHAMENTO_FINAL', 'REFECHAMENTO']);
    assert.equal((await pool.query(`SELECT estado FROM reaberturas WHERE processo_id = $1`, [c.processoId])).rows[0].estado, 'REFECHADA');
  } finally { await pool.end(); }
});

test('P1 revisão #6: réplica idempotente reproduz exigeReabertura e substituidas da resposta original (resposta perdida nunca vira "não precisa reabrir")', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const { c, x } = await finalSemDemurrage(pool, 'IM-P1-R6');
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r1 = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, '2026-09-10', 'r6a'), analista.home, 'p1-r6-a');
    const b1 = await r1.json();
    assert.equal(b1.exigeReabertura, false);
    const corpo = corpoMinuta(x.numero, '2026-09-25', 'r6b');
    const r2 = await post(app.base, `/a/containers/${x.id}/minutas`, corpo, analista.home, 'p1-r6-b');
    assert.equal(r2.status, 201);
    const b2 = await r2.json();
    assert.equal(b2.exigeReabertura, true);
    assert.deepEqual(b2.substituidas, [b1.minutaId]);
    const antes = await contagens(pool);
    const r3 = await post(app.base, `/a/containers/${x.id}/minutas`, corpo, analista.home, 'p1-r6-b');
    assert.equal(r3.status, 200);
    const b3 = await r3.json();
    assert.equal(b3.minutaId, b2.minutaId);
    assert.equal(b3.exigeReabertura, true);
    assert.deepEqual(b3.substituidas, [b1.minutaId]);
    assert.deepEqual(await contagens(pool), antes, 'réplica sem nenhuma escrita');
    // A primeira continua respondendo o que respondeu.
    const r4 = await post(app.base, `/a/containers/${x.id}/minutas`, corpoMinuta(x.numero, '2026-09-10', 'r6a'), analista.home, 'p1-r6-a');
    const b4 = await r4.json();
    assert.equal(b4.exigeReabertura, false);
    assert.deepEqual(b4.substituidas, []);
  } finally { await app.close(); await pool.end(); }
});

test('P1 revisão #7: minuta que segue DIVERGENTE com o tracking em outra data troca a pendência (contexto nunca fica velho; histórico preservado)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R7', comDemurrage: false, n: 2 });
    const [a, b] = c.containers;
    await devolverPeloTracking(pool, c, { [a.numero]: '2026-09-10', [b.numero]: null });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r = await registrarMinutaTecnica(pool, {
      containerId: a.id, membershipId: analista.membershipId, numeroInformado: a.numero, dataInformada: '2026-09-12', documento: doc('r7'), hoje: HOJE,
    });
    assert.ok(r.ok && r.minuta.estado === 'DIVERGENTE');
    const sem = async () => (await pendenciasDo(pool, a.id)).map((p: any) => [p.tipo, p.estado, p.contexto.dataTracking, p.contexto.minutaId]);
    assert.deepEqual(await sem(), [['minuta_divergente_tracking', 'aberta', '2026-09-10', r.ok && r.minuta.id]]);

    await pool.query(`UPDATE containers SET tracking_return_date = '2026-09-11' WHERE id = $1`, [a.id]);
    assert.deepEqual(await reavaliarMinutasDoProcesso(pool, c.processoId, HOJE), { reavaliadas: 1 });
    assert.deepEqual(await sem(), [
      ['minuta_divergente_tracking', 'resolvida', '2026-09-10', r.ok && r.minuta.id],
      ['minuta_divergente_tracking', 'aberta', '2026-09-11', r.ok && r.minuta.id],
    ]);
    // Sem mudança de fato: no-op estrito.
    const antes = await contagens(pool);
    assert.deepEqual(await reavaliarMinutasDoProcesso(pool, c.processoId, HOJE), { reavaliadas: 0 });
    assert.deepEqual(await contagens(pool), antes);
  } finally { await pool.end(); }
});

test('P1 revisão #8: /minutas padrão é trabalho de processo OPEN — RECEBIDA legada esquecida em processo FINAL não exige ação; filtro explícito ainda a mostra', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const { c, x } = await finalSemDemurrage(pool, 'IM-P1-R8');
    const repo = new MinutaRepository(pool);
    const esquecida = await repo.criarRecebida({ containerId: x.id, numeroInformado: x.numero, dataInformada: '2026-09-10' });
    const aberto = await cenario(pool, { orgId: c.orgId, numeroProcesso: 'IM-P1-R8B', comDemurrage: false });
    const pendente = await repo.criarRecebida({ containerId: aberto.containers[0].id, numeroInformado: aberto.containers[0].numero, dataInformada: '2026-09-10' });
    const leitor = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): /minutas do ANALYST é a fila pessoal — os dois processos são dele.
    await atribuirResponsavelDeTeste(pool, c.processoId, leitor.membershipId);
    await atribuirResponsavelDeTeste(pool, aberto.processoId, leitor.membershipId);

    const padrao = await (await get(app.base, `/v2/minutas`, leitor.home)).json();
    assert.deepEqual(padrao.itens.map((i: any) => [i.minutaId, i.acaoNecessaria]), [[pendente.id, 'registrar_minuta_substituta']]);
    const explicito = await (await get(app.base, `/v2/minutas?estado=RECEBIDA`, leitor.home)).json();
    const porId = new Map(explicito.itens.map((i: any) => [i.minutaId, i.acaoNecessaria]));
    assert.equal(porId.get(esquecida.id), null, 'processo FINAL: visível, mas sem ação pendente');
    assert.equal(porId.get(pendente.id), 'registrar_minuta_substituta');
  } finally { await app.close(); await pool.end(); }
});

test('P1 revisão #9: registros concorrentes no mesmo processo nunca travam o pool (nenhuma segunda conexão pedida com a primeira retida)', { skip: !url, timeout: 60000 }, async () => {
  const pool = testPool();
  // Pool mínimo permitido em produção (DEMURRAGE_DATABASE_POOL_MAX >= 2): com
  // N registros concorrentes num pool de N conexões, quem comitasse e pedisse
  // outra conexão esperaria para sempre pelas conexões retidas pelos demais.
  const pequeno = new Pool({ connectionString: testDatabaseUrl()!, max: 2 });
  const comPrazo = <T>(p: Promise<T>, ms: number, o: string) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`travou: ${o}`)), ms))]);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R9', comDemurrage: false, n: 2 });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const registros = c.containers.flatMap((x, i) => [0, 1].map((k) => registrarMinutaTecnica(pequeno, {
      containerId: x.id, membershipId: analista.membershipId, numeroInformado: x.numero, dataInformada: '2026-09-10',
      documento: doc(`r9-${i}-${k}`), hoje: HOJE,
      idempotencia: { organizationId: c.orgId, rota: 'teste.r9', chave: `r9-${i}-${k}`, hash: `h-${i}-${k}` },
    })));
    const rs = await comPrazo(Promise.all(registros), 20000, 'registros concorrentes');
    assert.ok(rs.every((r) => r.ok));
    for (const x of c.containers) {
      const vig = (await minutasDo(pool, x.id)).filter((m: any) => m.substituida_por_id === null);
      assert.equal(vig.length, 1, 'uma única vigente por contêiner');
    }
  } finally {
    await comPrazo(pequeno.end(), 5000, 'encerrar pool').catch(() => undefined);
    await pool.end();
  }
});

test('P1 revisão #10: filtro explícito FINAL encontra o encerrado SEM demurrage (balde silencioso) — lista, busca e /filtros concordam', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const { c } = await finalSemDemurrage(pool, 'IM-P1-R10');
    const leitor = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): lista e /filtros do ANALYST são da fila pessoal — o processo é dele.
    await atribuirResponsavelDeTeste(pool, c.processoId, leitor.membershipId);
    const filtrosFinal = await (await get(app.base, `/v2/filtros?apuracaoStatus=FINAL`, leitor.home)).json();
    assert.deepEqual(filtrosFinal.apuracao, { abertos: 0, finalizados: 1 });
    for (const q of ['apuracaoStatus=FINAL', 'apuracaoStatus=FINAL&busca=IM-P1-R10', 'apuracaoStatus=TODOS']) {
      const fila = await (await get(app.base, `/v2/processos?${q}`, leitor.home)).json();
      assert.deepEqual(fila.itens.map((i: any) => i.processo.id), [c.processoId], q);
      assert.equal(fila.total, 1, q);
      assert.equal(fila.incluiuSilenciosos, true, `${q}: o valor efetivo é informado`);
    }
    // Pedido explícito continua valendo; a fila ativa padrão segue sem o finalizado.
    const semSilenciosos = await (await get(app.base, `/v2/processos?apuracaoStatus=FINAL&incluirSilenciosos=false`, leitor.home)).json();
    assert.equal(semSilenciosos.total, 0);
    assert.equal((await (await get(app.base, `/v2/processos`, leitor.home)).json()).total, 0);
  } finally { await app.close(); await pool.end(); }
});

test('P1 revisão #2: pendência que põe em dúvida um fato do relógio (conflito da mesma fonte no Free Time) bloqueia o encerramento automático; o ANALISTA resolve e o processo encerra', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R2', comDemurrage: false });
    const x = c.containers[0];
    // A mesma fonte, no mesmo instante, diz 20 e 7 dias: o 20 (primeiro) segue selecionado, nunca revisado.
    // Com 7 dias, uma devolução em 09-10 (descarga 09-01) teria demurrage.
    const quando = new Date(T);
    await new ContainerRepository(pool).applyObservation({ containerId: x.id, organizationId: c.orgId, campo: 'houseFreeTimeDays', valor: 7, fonte: 'house_document', observadoEm: quando });
    const pend = (await pool.query(`SELECT id, estado FROM demurrage_pendencias WHERE container_id = $1 AND tipo = 'conflito_mesma_fonte'`, [x.id])).rows;
    assert.deepEqual(pend.map((p: any) => p.estado), ['aberta'], 'premissa: conflito registrado');

    await devolverPeloTracking(pool, c, { [x.numero]: '2026-09-10' });
    const st = await statusProcesso(pool, c.processoId);
    assert.equal(st.apuracao_status, 'OPEN', 'nunca congela automaticamente um Free Time sob revisão');
    assert.equal(st.encerramento_bloqueio, 'conflito_mesma_fonte_pendente');
    assert.equal(st.encerramento_bloqueio_container_id, x.id);
    const gestor = await membro(pool, c.orgId, 'MANAGER');
    const f = await post(app.base, `/a/processos/${c.processoId}/finalizar`, {}, gestor.home);
    assert.equal(f.status, 409, 'o acionamento administrativo também não contorna');
    assert.equal((await f.json()).error, 'conflito_mesma_fonte_pendente');

    // O analista revisa (motivo obrigatório) — sem gestor — e a resolução dispara o encerramento.
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): resolver pendência manual é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r = await post(app.base, `/a/pendencias/${pend[0].id}/resolver`, {
      familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'conflito_mesma_fonte', motivo: 'Documento House revisado: 20 dias é o valor correto.',
    }, analista.home);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).encerramento, { resultado: 'finalizado' });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
  } finally { await app.close(); await pool.end(); }
});

test('P1 revisão #11: devolução efetiva LEGADA sem tracking (data de minuta do fluxo antigo) nunca é congelada pelo automático — só o gestor fecha, como antes', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R11', comDemurrage: false });
    const x = c.containers[0];
    const repo = new MinutaRepository(pool);
    const legada = await repo.criarRecebida({ containerId: x.id, numeroInformado: x.numero, dataInformada: '2026-09-05' });
    await repo.marcarValidada(legada.id, '2026-09-05', false, null);
    await pool.query(`UPDATE containers SET effective_return_date = '2026-09-05', effective_return_minuta_id = $2 WHERE id = $1`, [x.id, legada.id]);
    await recalcularApuracaoContainer(pool, x.id, { dataReferencia: HOJE });

    assert.deepEqual(await varrerEncerramentoAutomatico(pool, { hoje: HOJE }), { avaliados: 1, finalizados: 0, bloqueados: 1, falhas: 0 });
    const st = await statusProcesso(pool, c.processoId);
    assert.equal(st.apuracao_status, 'OPEN');
    assert.equal(st.encerramento_bloqueio, 'devolucao_efetiva_legada');
    assert.equal(st.encerramento_bloqueio_container_id, x.id);
    // Semântica legada preservada: o acionamento administrativo (humano) encerra.
    const gestor = await membro(pool, c.orgId, 'MANAGER');
    assert.deepEqual(await new ClosingService(pool).finalizarProcesso({ processoId: c.processoId, membershipId: gestor.membershipId, config: cfg }), { ok: true });
    assert.equal((await pool.query(`SELECT origem FROM fechamentos WHERE processo_id = $1`, [c.processoId])).rows[0].origem, 'humano');
  } finally { await pool.end(); }
});

test('P1 revisão #12: texto que o banco recusaria (U+0000, surrogate isolado) e documento malformado são 400 — nunca 500, nada gravado', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R12', comDemurrage: false });
    const x = c.containers[0];
    const analista = await membro(pool, c.orgId, 'ANALYST');
    const antes = await contagens(pool);
    const casos: Array<[unknown, number, string, string]> = [
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12a'), numeroInformado: `${x.numero}\u0000` }, 400, 'valor_invalido', 'numeroInformado'],
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12b'), dataInformada: '2026-09-1\uD800' }, 400, 'valor_invalido', 'dataInformada'],
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12c'), evidenciaRef: 'obs\u0000' }, 400, 'valor_invalido', 'evidenciaRef'],
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12d'), documento: { ...doc('r12d'), nomeArquivo: 'minuta\u0000.pdf' } }, 400, 'documento_invalido', 'nomeArquivo'],
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12e'), documento: { ...doc('r12e'), referencia: 'graph:\uDC00' } }, 400, 'documento_invalido', 'referencia'],
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12f'), documento: { ...doc('r12f'), hashConteudo: 'XYZ' } }, 400, 'documento_invalido', 'hashConteudo'],
      [{ ...corpoMinuta(x.numero, '2026-09-10', 'r12g'), documento: 'graph:message/1' }, 400, 'documento_invalido', 'documento'],
    ];
    for (const [i, [corpo, status, erro, campo]] of casos.entries()) {
      const r = await post(app.base, `/a/containers/${x.id}/minutas`, corpo, analista.home, `p1-r12-${i}`);
      assert.equal(r.status, status, `caso ${i}`);
      const b = await r.json();
      assert.equal(b.error, erro, `caso ${i}`);
      assert.equal(b.campo ?? b.detalhe?.campo, campo, `caso ${i}`);
    }
    assert.deepEqual(await contagens(pool), antes, 'nenhuma escrita');
  } finally { await app.close(); await pool.end(); }
});

test('P1 revisão #13: pendência de minuta nunca oferece podeResolver (a rota de resolução sempre a recusa — a ação é a minuta substituta)', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R13', comDemurrage: false, n: 2 });
    const [a] = c.containers;
    await devolverPeloTracking(pool, c, { [a.numero]: '2026-09-10' });
    const analista = await membro(pool, c.orgId, 'ANALYST');
    // Produção P1 (filas pessoais): minuta, pendências do processo e resolução são pessoais — o ANALYST é o responsável.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r = await post(app.base, `/a/containers/${a.id}/minutas`, corpoMinuta(a.numero, '2026-09-12', 'r13'), analista.home, 'p1-r13');
    assert.equal((await r.json()).estado, 'DIVERGENTE');
    const lista = await (await get(app.base, `/v2/processos/${c.processoId}/pendencias`, analista.home)).json();
    const minuta = lista.itens.find((i: any) => i.tipo === 'minuta_divergente_tracking');
    assert.ok(minuta);
    assert.equal(minuta.podeResolver, false);
    const recusa = await post(app.base, `/a/pendencias/${minuta.pendenciaId}/resolver`, {
      familia: 'demurrage_pendencia', acao: 'resolver', tipo: 'minuta_divergente_tracking', motivo: 'tentativa',
    }, analista.home);
    assert.equal(recusa.status, 400, 'coerente com a leitura: a rota recusa');
  } finally { await app.close(); await pool.end(); }
});

test('P1 revisão #14: indicador gerencial G-A9 ("aguardando tratamento") e sua composição nunca contam processo FINAL', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const org = (await new OrganizationRepository(pool).create('Rocket', 'rk-ga9')).id;
    const analista = await membro(pool, org, 'ANALYST');
    const fechado = await cenario(pool, { orgId: org, numeroProcesso: 'IM-P1-R14A', comDemurrage: true });
    // Produção P1 (filas pessoais): registrar minuta é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, fechado.processoId, analista.membershipId);
    await devolverPeloTracking(pool, fechado, { [fechado.containers[0].numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: fechado.containers[0].id, hoje: HOJE });
    await new ClosingService(pool).registrarMinuta({
      containerId: fechado.containers[0].id, membershipId: analista.membershipId, numeroInformado: fechado.containers[0].numero,
      dataInformada: '2026-09-10', documento: doc('r14'), config: cfg,
    });
    assert.equal((await statusProcesso(pool, fechado.processoId)).apuracao_status, 'FINAL');
    const aberto = await cenario(pool, { orgId: org, numeroProcesso: 'IM-P1-R14B', comDemurrage: true });
    await devolverPeloTracking(pool, aberto, { [aberto.containers[0].numero]: '2026-09-10' });
    const estados = (await pool.query(`SELECT id, estado_mais_relevante FROM processos WHERE organization_id = $1`, [org])).rows;
    assert.ok(estados.every((e: any) => e.estado_mais_relevante === 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'), 'premissa: os dois no mesmo estado persistido');

    const g = await montarGestaoOperacional(pool, org, {}, HOJE as any);
    assert.equal(g.indicadores.find((i) => i.id === 'G-A9')!.valor, 1);
    const comp = await buscarComposicaoIndicador(pool, org, 'G-A9');
    assert.equal(comp.total, 1);
    assert.deepEqual(comp.itens.map((i: any) => i.processoId ?? i.id), [aberto.processoId]);
  } finally { await pool.end(); }
});

test('P1 revisão #15: o tick do scheduler roda a varredura e encerra o processo elegível que nenhum gatilho avaliou', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const c = await cenario(pool, { numeroProcesso: 'IM-P1-R15', comDemurrage: false });
    const x = c.containers[0];
    // Devolução gravada SEM o gatilho (ex.: caminho que não dispara a avaliação): só a varredura fecha.
    await pool.query(`UPDATE containers SET tracking_return_date = '2026-09-10' WHERE id = $1`, [x.id]);
    await recalcularApuracaoContainer(pool, x.id, { dataReferencia: HOJE });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'OPEN');

    const t = await executarTickDemurrage({
      pool, workerId: 'tick-r15',
      port: { async enrich(ref: string) { return resultadoTracking({ reference: ref }); } } as any,
      transport: { async enviar() { return { ok: true } as any; } } as any,
    }, HOJE);
    assert.equal(t.encerramento.erro, null);
    assert.equal(t.encerramento.finalizados, 1);
    const st = await statusProcesso(pool, c.processoId);
    assert.equal(st.apuracao_status, 'FINAL');
    assert.equal(st.fechado_por, null);
    assert.equal((await pool.query(`SELECT origem FROM fechamentos WHERE processo_id = $1`, [c.processoId])).rows[0].origem, 'automatico');
  } finally { await pool.end(); }
});

test('P1 revisão #16: o fallback manual de Free Time pela rota libera o último gate e o processo encerra na MESMA resposta', { skip: !url }, async () => {
  const pool = testPool();
  const app = await subirApp(pool);
  try {
    await setup(pool);
    const orgId = (await new OrganizationRepository(pool).create('Rocket', `rk-${randomUUID().slice(0, 8)}`)).id;
    const numero = numeroContainer('PUMC', seqContainer++);
    // Sem House Free Time de nenhuma fonte: relógio do cliente INDETERMINADO.
    const reg = await registrarProcessoDemurrage(contratoRegistro({
      organizationId: orgId, numeroProcesso: 'IM-P1-R16',
      containers: [containerContrato(numero, { tipoOriginal: o('40HC', 'house_document', T) })],
      mbl: o('MBLIMP1R16', 'master_bl', T), armador: o('MAERSK', 'shipping_instructions', T),
      masterFreeTimeDays: o(20, 'master_bl', T),
    }), { pool, hojeReferencia: '2026-08-25' });
    const c: Cenario = { orgId, processoId: reg.processoId, containers: [{ id: reg.containers[0].containerId, numero }] };
    await devolverPeloTracking(pool, c, { [numero]: '2026-09-10' });
    const st = await statusProcesso(pool, c.processoId);
    assert.equal(st.apuracao_status, 'OPEN');
    assert.equal(st.encerramento_bloqueio, 'apuracao_indeterminada');

    const analista = await membro(pool, orgId, 'ANALYST');
    // Produção P1 (filas pessoais): o fallback manual (autor D10) é ação pessoal — o ANALYST é o responsável do processo.
    await atribuirResponsavelDeTeste(pool, c.processoId, analista.membershipId);
    const r = await post(app.base, `/a/containers/${c.containers[0].id}/fallback-manual`, {
      campo: 'house', valorDias: 20, observadoEm: T, evidenciaRef: 'evid://house-r16', justificativa: 'Confirmado por e-mail do cliente.',
    }, analista.home);
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.resultado, 'aplicado');
    assert.deepEqual(corpo.encerramento, { resultado: 'finalizado' });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
  } finally { await app.close(); await pool.end(); }
});
