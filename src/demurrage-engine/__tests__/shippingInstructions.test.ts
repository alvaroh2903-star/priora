import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { testPool, testDatabaseUrl, truncateAll } from './testDb';
import { OrganizationRepository } from '../persistence/organizationRepository';
import { UsuarioRepository } from '../persistence/usuarioRepository';
import { OrganizationMembershipRepository } from '../persistence/organizationMembershipRepository';
import { ProcessoRepository } from '../persistence/processoRepository';
import { ContainerRepository } from '../persistence/containerRepository';
import { FieldObservationRepository, FonteNaoAutorizadaError } from '../persistence/fieldObservationRepository';
import { promoverMasterFreeTime } from '../freeTime/masterFreeTimeService';
import { processarRecalculosPendentes } from '../freeTime/recalculoOutbox';
import {
  processarAvisosDivergenciaPendentes, resolverDivergencia, reconhecerDivergencia, AvisoDivergenciaTransport,
} from '../freeTime/divergenciaAvisos';
import {
  extrairFreeTimeDoCorpo, consolidarOcorrencias, avaliarOcr, hashConteudo, primeiraMensagem, MensagemSI, OcrResultadoSI,
} from '../shippingInstructions/extracaoShippingInstructions';
import {
  ingerirShippingInstructions, reaplicarIntencoesShippingInstructions, PortasShippingInstructions,
} from '../shippingInstructions/ingestaoShippingInstructions';

const url = testDatabaseUrl();
const CONV = 'conv-pre-alerta-1';
const HOJE = '2026-09-20';

/* =========================== puros (extrator) =========================== */

test('SI puro: corpo — zero é válido; negativo, decimal e número sem unidade de dias viram pendência', () => {
  assert.equal(extrairFreeTimeDoCorpo('Free time: 0 days').ocorrencias[0].valor, 0);
  assert.equal(extrairFreeTimeDoCorpo('free time zero days').ocorrencias[0].valor, 0);
  assert.equal(extrairFreeTimeDoCorpo('Free time 14 dias no destino').ocorrencias[0].valor, 14);
  for (const t of ['Free time: -3 days', 'Free time 14.5 days', 'Demurrage: 140']) {
    const r = extrairFreeTimeDoCorpo(t);
    assert.equal(r.ocorrencias.length, 0, t);
    assert.equal(r.problemas[0].tipo, 'free_time_ambiguo', t);
  }
  assert.deepEqual(extrairFreeTimeDoCorpo('House free time: 7 days'), { ocorrencias: [], problemas: [] }, 'House não é Master');
  assert.deepEqual(extrairFreeTimeDoCorpo('Please book as agreed'), { ocorrencias: [], problemas: [] });
});

test('SI puro: valores distintos no mesmo alcance → ambíguo; exceção por contêiner é preservada', () => {
  const ocs = extrairFreeTimeDoCorpo('Free time: 14 days\nfree time 21 days').ocorrencias;
  const c = consolidarOcorrencias(ocs);
  assert.equal(c.nivelMbl, null);
  assert.equal(c.problemas[0].tipo, 'free_time_ambiguo');
  const c2 = consolidarOcorrencias(extrairFreeTimeDoCorpo('Free time: 14 days\nFree time 21 days for MSCU1234567').ocorrencias);
  assert.equal(c2.nivelMbl!.valor, 14);
  assert.equal(c2.porContainer.get('MSCU1234567')!.valor, 21);
});

test('SI puro: leitura de anexo só é aceita com confiança >= 0.90, âncora e valor único', () => {
  const anexo = { id: 'a1', name: 'si.pdf', contentType: 'application/pdf', size: 10 };
  const base: OcrResultadoSI = { legivel: true, masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'Free time: 14 days', confianca: 0.95, containers: [], mbl: null, processo: null, multiplosValores: false };
  assert.equal(avaliarOcr(anexo, base).ocorrencia!.valor, 14);
  assert.equal(avaliarOcr(anexo, { ...base, confianca: 0.89 }).problema!.tipo, 'ocr_baixa_confianca');
  assert.equal(avaliarOcr(anexo, { ...base, ancoraTexto: 'Total 14' }).problema!.tipo, 'free_time_ambiguo');
  assert.equal(avaliarOcr(anexo, { ...base, multiplosValores: true }).problema!.tipo, 'free_time_ambiguo');
  assert.equal(avaliarOcr(anexo, { ...base, masterFreeTimeDays: 2.5 }).problema!.tipo, 'free_time_ambiguo');
  assert.equal(avaliarOcr(anexo, { ...base, legivel: false }).problema!.tipo, 'ocr_baixa_confianca');
  assert.equal(avaliarOcr(anexo, { ...base, masterFreeTimeDays: 0, ancoraTexto: 'Free time: 0 days' }).ocorrencia!.valor, 0);
});

test('SI puro: primeira mensagem cronológica e hash de versão', () => {
  const a = msg('m2', '2026-09-02T10:00:00Z', 'Free time: 21 days');
  const b = msg('m1', '2026-09-01T10:00:00Z', 'Free time: 14 days');
  assert.equal(primeiraMensagem([a, b])!.id, 'm1');
  assert.equal(hashConteudo(b), hashConteudo({ ...b, body: '  Free time:   14 days ' }), 'espaços não mudam a versão');
  assert.notEqual(hashConteudo(b), hashConteudo({ ...b, attachments: [{ id: 'x', name: 'si.pdf', contentType: 'application/pdf', size: 1 }] }));
});

/* =========================== helpers de integração =========================== */

function msg(id: string, quando: string, body: string, attachments: MensagemSI['attachments'] = [], subject = 'Shipping Instructions IM2734'): MensagemSI {
  return { id, conversationId: CONV, receivedDateTime: quando, subject, body, attachments };
}
const PDF = (nome: string) => ({ id: `att-${nome}`, name: nome, contentType: 'application/pdf', size: 100 });
function ocr(over: Partial<OcrResultadoSI> = {}): OcrResultadoSI {
  return { legivel: true, masterFreeTimeDays: null, ancoraTexto: null, trecho: null, confianca: 0.97, containers: [], mbl: null, processo: null, multiplosValores: false, ...over };
}

function portasFake(conversa: MensagemSI[], docs: Record<string, OcrResultadoSI | Error> = {}) {
  const chamadas = { conversa: 0, anexo: 0, documento: 0 };
  const p: PortasShippingInstructions = {
    async carregarConversa() { chamadas.conversa++; return conversa; },
    async lerAnexo(_m, a) { chamadas.anexo++; return { dataBase64: 'eA==', mimeType: a.contentType }; },
    async lerDocumento(d) {
      chamadas.documento++;
      const r = docs[d.nome];
      if (r instanceof Error) throw r;
      return r ?? ocr();
    },
  };
  return { p, chamadas };
}

async function setup(pool: Pool) { await runMigrations(pool); await truncateAll(pool); }

async function cenario(pool: Pool, opts: { slug?: string; numero?: string; mbl?: string | null; containers?: string[] } = {}) {
  const slug = opts.slug ?? 'rocket';
  const org = await new OrganizationRepository(pool).create(`Org ${slug}`, slug);
  const usuarios = new UsuarioRepository(pool);
  const membros = new OrganizationMembershipRepository(pool);
  const uResp = await usuarios.create('Responsável', `resp-${slug}@x.com`, `home-resp-${slug}`);
  const uGestor = await usuarios.create('Gestor', `gestor-${slug}@x.com`, `home-gestor-${slug}`);
  const mResp = await membros.create(org.id, uResp.id, 'ANALYST');
  const mGestor = await membros.create(org.id, uGestor.id, 'MANAGER');
  const p = await new ProcessoRepository(pool).create({ organizationId: org.id, numeroProcesso: opts.numero ?? 'IM2734', clienteId: null, responsavelOperacionalMembershipId: mResp.id });
  const mbl = opts.mbl === undefined ? 'MAEU123456789' : opts.mbl;
  if (mbl) await pool.query(`UPDATE processos SET mbl = $2 WHERE id = $1`, [p.id, mbl]);
  const containers: Record<string, string> = {};
  for (const n of opts.containers ?? ['MSCU1234567']) containers[n] = await novoContainer(pool, org.id, p.id, n);
  return { orgId: org.id, processoId: p.id, containers, mResp: mResp.id, mGestor: mGestor.id, uResp: uResp.id, homeResp: `home-resp-${slug}` };
}

async function novoContainer(pool: Pool, orgId: string, processoId: string, numero: string): Promise<string> {
  const repo = new ContainerRepository(pool);
  const c = await repo.create(orgId, processoId, numero);
  await repo.applyObservation({ containerId: c.id, organizationId: orgId, campo: 'dischargeDate', valor: '2026-09-01', fonte: 'tracking_service', observadoEm: new Date('2026-09-01T00:00:00Z') });
  return c.id;
}

const masterFt = (pool: Pool, containerId: string) =>
  pool.query(`SELECT master_free_time_days AS v FROM containers WHERE id = $1`, [containerId]).then((r) => r.rows[0].v as number | null);
const count = (pool: Pool, sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => Number(r.rows[0].n));
const abertas = (pool: Pool, tipo?: string) =>
  count(pool, `SELECT count(*) n FROM si_pendencias WHERE estado = 'aberta' ${tipo ? 'AND tipo = $1' : ''}`, tipo ? [tipo] : []);

/* =========================== migration / writer =========================== */

test('SI migration: nova fonte aceita; tracking barrado em Free Time no banco; históricos append-only; pendência aberta única', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    // Tracking não grava House/Master FT nem pelo SQL direto (CHECK da 0024).
    await assert.rejects(pool.query(
      `INSERT INTO field_observations (organization_id, entidade_tipo, entidade_id, campo, valor, fonte, observado_em)
       VALUES ($1, 'container', $2, 'masterFreeTimeDays', '14', 'tracking_service', now())`, [s.orgId, c]), /field_observations_tracking_sem_free_time/);
    await pool.query(
      `INSERT INTO field_observations (organization_id, entidade_tipo, entidade_id, campo, valor, fonte, observado_em)
       VALUES ($1, 'container', $2, 'masterFreeTimeDays', '14', 'shipping_instructions', now())`, [s.orgId, c]);
    // Pendência: no máximo UMA aberta por contexto.
    const ins = `INSERT INTO si_pendencias (organization_id, conversation_id, tipo, motivo, contexto_hash) VALUES ($1, 'c', 'free_time_nao_encontrado', 'm', 'h1')`;
    await pool.query(ins, [s.orgId]);
    await assert.rejects(pool.query(ins, [s.orgId]), /si_pendencias_aberta_unica/);
    // Eventos da divergência são append-only.
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-05T00:00:00Z'), autor: 't' });
    const ev = (await pool.query(`SELECT id FROM ft_divergencia_eventos LIMIT 1`)).rows[0];
    await assert.rejects(pool.query(`UPDATE ft_divergencia_eventos SET autor = 'x' WHERE id = $1`, [ev.id]));
    // Entrega em PROCESSING exige token + prazo.
    const e = (await pool.query(`SELECT id FROM ft_divergencia_entregas LIMIT 1`)).rows[0];
    await assert.rejects(pool.query(`UPDATE ft_divergencia_entregas SET status = 'PROCESSING' WHERE id = $1`, [e.id]), /ft_divergencia_entregas_claim/);
  } finally { await pool.end(); }
});

test('SI writer: tracking_service rejeitado para House e Master Free Time pelo repositório público e pelo writer de observações', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    const repo = new ContainerRepository(pool);
    for (const campo of ['houseFreeTimeDays', 'masterFreeTimeDays'] as const) {
      await assert.rejects(repo.applyObservation({ containerId: c, organizationId: s.orgId, campo, valor: 7, fonte: 'tracking_service', observadoEm: new Date() }), FonteNaoAutorizadaError);
      await assert.rejects(new FieldObservationRepository(pool).insert({ organizationId: s.orgId, entidadeTipo: 'container', entidadeId: c, campo, valor: 7, fonte: 'tracking_service', observadoEm: new Date() }), FonteNaoAutorizadaError);
    }
    assert.equal(await masterFt(pool, c), null, 'nada foi gravado');
    // Datas continuam aceitando tracking normalmente.
    assert.equal((await repo.applyObservation({ containerId: c, organizationId: s.orgId, campo: 'gateOutDate', valor: '2026-09-10', fonte: 'tracking_service', observadoEm: new Date('2026-09-10T00:00:00Z') })).outcome, 'promovida');
  } finally { await pool.end(); }
});

/* =========================== ingestão ponta a ponta =========================== */

test('SI: Free Time ZERO é extraído, promovido e o relógio Rocket é recalculado pelo outbox', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'Dear agent,\nMBL: MAEU123456789\nFree time: 0 days')]);
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.status, 'concluida');
    assert.equal(await masterFt(pool, c), 0, 'zero é valor válido');
    assert.equal(await count(pool, `SELECT count(*) n FROM recalculo_outbox WHERE container_id = $1 AND estado = 'PENDING'`, [c]), 1);
    const rec = await processarRecalculosPendentes({ pool, hoje: HOJE, workerId: 'w' });
    assert.equal(rec.concluidos, 1);
    const rel = (await pool.query(`SELECT estado, primeiro_dia_demurrage, dias_demurrage FROM relogios WHERE container_id = $1 AND tipo = 'rocket'`, [c])).rows[0];
    assert.equal(rel.estado, 'OK', 'FT zero não deixa o relógio Rocket pendente');
    assert.equal(rel.primeiro_dia_demurrage, '2026-09-01', 'demurrage começa na própria descarga');
    const cli = (await pool.query(`SELECT estado FROM relogios WHERE container_id = $1 AND tipo = 'cliente'`, [c])).rows[0];
    assert.equal(cli.estado, 'PENDING', 'relógio do cliente não muda sem House Free Time');
    // Proveniência estruturada completa.
    const pv = (await pool.query(`SELECT * FROM si_proveniencias WHERE container_id = $1`, [c])).rows[0];
    assert.equal(pv.conversation_id, CONV);
    assert.equal(pv.message_id, 'm1');
    assert.equal(pv.encontrado_em, 'corpo');
    assert.equal(pv.metodo_extracao, 'texto');
    assert.equal(pv.valor_dias, 0);
    assert.match(pv.trecho_evidencia, /Free time: 0 days/);
  } finally { await pool.end(); }
});

test('SI: só a PRIMEIRA mensagem cronológica é a Shipping Instructions', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const f = portasFake([
      msg('m3', '2026-08-25T10:00:00Z', 'Correção? Free time: 30 days'),
      msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 14 days'),
      msg('m2', '2026-08-21T10:00:00Z', 'Free time: 21 days'),
    ]);
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.messageId, 'm1');
    assert.equal(await masterFt(pool, s.containers.MSCU1234567), 14);
  } finally { await pool.end(); }
});

test('SI: repetição idempotente — mesma versão não relê anexos nem duplica observação, proveniência ou outbox', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789', [PDF('si.pdf')])],
      { 'si.pdf': ocr({ masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'Free time: 14 days' }) });
    const r1 = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r1.status, 'concluida');
    const antes = await count(pool, `SELECT (SELECT count(*) FROM field_observations) + (SELECT count(*) FROM si_proveniencias) + (SELECT count(*) FROM si_intencoes) + (SELECT count(*) FROM recalculo_outbox) n`);
    const r2 = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'manual' });
    assert.equal(r2.status, 'ja_concluida');
    assert.equal(f.chamadas.documento, 1, 'versão concluída não é relida');
    assert.equal(await count(pool, `SELECT (SELECT count(*) FROM field_observations) + (SELECT count(*) FROM si_proveniencias) + (SELECT count(*) FROM si_intencoes) + (SELECT count(*) FROM recalculo_outbox) n`), antes);
    const pv = (await pool.query(`SELECT * FROM si_proveniencias`)).rows[0];
    assert.equal(pv.encontrado_em, 'anexo');
    assert.equal(pv.attachment_nome, 'si.pdf');
    assert.equal(pv.metodo_extracao, 'ocr_visao');
    assert.equal(Number(pv.confianca), 0.97);
  } finally { await pool.end(); }
});

test('SI: concorrência — duas ingestões simultâneas da mesma conversa leem o documento uma vez só', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789', [PDF('si.pdf')])],
      { 'si.pdf': ocr({ masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'x' }) });
    const [a, b] = await Promise.all([
      ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico', workerId: 'A' }),
      ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico', workerId: 'B' }),
    ]);
    assert.ok([a.status, b.status].includes('concluida'));
    assert.ok([a.status, b.status].every((x) => x === 'concluida' || x === 'em_andamento' || x === 'ja_concluida'));
    assert.equal(f.chamadas.documento, 1);
    assert.equal(await count(pool, `SELECT count(*) n FROM si_versoes`), 1);
  } finally { await pool.end(); }
});

test('SI: anexos ambíguos (baixa confiança e valores divergentes) geram pendência e não promovem', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789', [PDF('a.pdf'), PDF('b.pdf'), PDF('c.pdf')])], {
      'a.pdf': ocr({ masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'a' }),
      'b.pdf': ocr({ masterFreeTimeDays: 21, ancoraTexto: 'Free time: 21 days', trecho: 'b' }),
      'c.pdf': ocr({ masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'c', confianca: 0.8 }),
    });
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.status, 'pendente');
    assert.equal(await masterFt(pool, c), null, 'nenhum valor padrão é criado');
    assert.equal(await abertas(pool, 'free_time_ambiguo'), 1);
    assert.equal(await abertas(pool, 'ocr_baixa_confianca'), 1);
    assert.equal(await count(pool, `SELECT count(*) n FROM field_observations WHERE campo = 'masterFreeTimeDays'`), 0);
    // Reprocesso automático não relê versão PENDENTE; reprocesso da mesma versão não duplica pendências.
    assert.equal((await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' })).status, 'aguardando_reprocessamento_manual');
    await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'manual' });
    assert.equal(await abertas(pool), 2);
  } finally { await pool.end(); }
});

test('SI: ausência de Free Time mantém pendência e o relógio Rocket pendente', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nPlease proceed with booking.')]);
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.status, 'pendente');
    assert.equal(await abertas(pool, 'free_time_nao_encontrado'), 1);
    assert.equal(await masterFt(pool, s.containers.MSCU1234567), null);
  } finally { await pool.end(); }
});

test('SI: conversa com múltiplos processos → pendência, nenhuma promoção', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'Processos IM2734 e IM9999\nFree time: 14 days', [], 'SI IM2734 / IM9999')]);
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.status, 'pendente');
    assert.equal(await abertas(pool, 'conversa_multiprocesso'), 1);
    assert.equal(await masterFt(pool, s.containers.MSCU1234567), null);
  } finally { await pool.end(); }
});

test('SI: contêiner criado depois recebe a intenção já extraída sem nova leitura; pendência resolvida', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, { containers: ['MSCU1234567'] });
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nContainers MSCU1234567, TGHU7654321', [PDF('si.pdf')])],
      { 'si.pdf': ocr({ masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'Free time: 14 days' }) });
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.status, 'pendente');
    assert.equal(await masterFt(pool, s.containers.MSCU1234567), 14);
    assert.equal(await abertas(pool, 'container_nao_encontrado'), 1);

    const novo = await novoContainer(pool, s.orgId, s.processoId, 'TGHU7654321');
    const re = await reaplicarIntencoesShippingInstructions({ pool });
    assert.equal(re.promovidos, 1);
    assert.equal(await masterFt(pool, novo), 14);
    assert.equal(f.chamadas.documento, 1, 'nenhuma nova leitura documental');
    const p = (await pool.query(`SELECT estado, resolvido_por FROM si_pendencias WHERE tipo = 'container_nao_encontrado'`)).rows[0];
    assert.equal(p.estado, 'resolvida', 'linha preservada e resolvida');
    assert.match(p.resolvido_por, /si:reaplicacao/);
    assert.equal((await pool.query(`SELECT estado FROM si_versoes`)).rows[0].estado, 'DONE');

    // Versão DONE: um terceiro contêiner do mesmo processo/MBL também recebe (idempotente).
    const terceiro = await novoContainer(pool, s.orgId, s.processoId, 'CAIU1112223');
    assert.equal((await reaplicarIntencoesShippingInstructions({ pool })).promovidos, 1);
    assert.equal(await masterFt(pool, terceiro), 14);
    assert.equal((await reaplicarIntencoesShippingInstructions({ pool })).promovidos, 0, 'reaplicar de novo não duplica');
    assert.equal(await count(pool, `SELECT count(*) n FROM si_proveniencias`), 3);
  } finally { await pool.end(); }
});

test('SI: POST reprocessa versão FAILED sem duplicar versão concluída', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const conversa = [msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789', [PDF('si.pdf')])];
    const falha = portasFake(conversa, { 'si.pdf': new Error('Graph indisponível') });
    const r1 = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: falha.p, modo: 'automatico' });
    assert.equal(r1.status, 'falhou');
    assert.equal((await pool.query(`SELECT estado FROM si_versoes`)).rows[0].estado, 'FAILED');
    assert.equal(await masterFt(pool, s.containers.MSCU1234567), null);

    const ok = portasFake(conversa, { 'si.pdf': ocr({ masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'x' }) });
    const r2 = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: ok.p, modo: 'manual' });
    assert.equal(r2.status, 'concluida');
    assert.equal(r2.versaoId, r1.versaoId, 'mesma versão reivindicada, não outra');
    const r3 = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: ok.p, modo: 'manual' });
    assert.equal(r3.status, 'ja_concluida');
    assert.equal(ok.chamadas.documento, 1);
    assert.equal(await count(pool, `SELECT count(*) n FROM si_versoes`), 1);
  } finally { await pool.end(); }
});

test('SI: falha dentro da transação desfaz observação, proveniência, divergência, avisos e outbox juntos', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-08-19T00:00:00Z'), autor: 'master' });
    const snap = () => count(pool, `SELECT (SELECT count(*) FROM field_observations) + (SELECT count(*) FROM si_proveniencias) + (SELECT count(*) FROM ft_divergencias)
      + (SELECT count(*) FROM ft_divergencia_eventos) + (SELECT count(*) FROM ft_divergencia_entregas) + (SELECT count(*) FROM recalculo_outbox) + (SELECT count(*) FROM si_intencoes) n`);
    const antes = await snap();
    await pool.query(`CREATE FUNCTION falha_teste() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$`);
    await pool.query(`CREATE TRIGGER falha_teste BEFORE INSERT ON si_proveniencias FOR EACH ROW EXECUTE FUNCTION falha_teste()`);
    try {
      const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 14 days')]);
      const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
      assert.equal(r.status, 'falhou');
      assert.match(r.erro!, /falha simulada/);
    } finally {
      await pool.query(`DROP TRIGGER falha_teste ON si_proveniencias`);
      await pool.query(`DROP FUNCTION falha_teste()`);
    }
    assert.equal(await snap(), antes, 'rollback conjunto');
    assert.equal(await masterFt(pool, c), 10);
    assert.equal((await pool.query(`SELECT estado FROM si_versoes`)).rows[0].estado, 'FAILED');
  } finally { await pool.end(); }
});

/* =========================== hierarquia e divergência =========================== */

test('SI antes do Master: Master prevalece, divergência aberta com avisos ao responsável e ao gestor', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 14 days')]).p });
    assert.equal(await masterFt(pool, c), 14);
    // Master BL chega DEPOIS por outro pipeline (a SI não roda de novo).
    const r = await new ContainerRepository(pool).applyObservation({ containerId: c, organizationId: s.orgId, campo: 'masterFreeTimeDays', valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-02T00:00:00Z') });
    assert.equal(r.outcome, 'promovida');
    assert.equal(await masterFt(pool, c), 10, 'Master prevalece');
    const d = (await pool.query(`SELECT * FROM ft_divergencias WHERE container_id = $1`, [c])).rows[0];
    assert.equal(d.estado, 'aberta');
    assert.equal(d.valor_si, 14);
    assert.equal(d.valor_master, 10);
    const ent = (await pool.query(`SELECT destinatario_tipo, destinatario_membership_id FROM ft_divergencia_entregas ORDER BY destinatario_tipo`)).rows;
    assert.deepEqual(ent.map((e) => e.destinatario_tipo), ['gestor', 'responsavel_operacional']);
    assert.equal(await count(pool, `SELECT count(*) n FROM recalculo_outbox WHERE container_id = $1`, [c]), 2, 'SI e Master mudaram o valor selecionado');
    assert.equal(await count(pool, `SELECT count(*) n FROM field_observations WHERE campo = 'masterFreeTimeDays' AND fonte = 'shipping_instructions'`), 1, 'SI permanece no ledger');
  } finally { await pool.end(); }
});

test('Master antes da SI: SI não troca o valor selecionado, não recalcula, mas abre divergência', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-08-15T00:00:00Z'), autor: 'master' });
    const outboxAntes = await count(pool, `SELECT count(*) n FROM recalculo_outbox`);
    await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 14 days')]).p });
    assert.equal(await masterFt(pool, c), 10, 'Master permanece selecionado');
    assert.equal(await count(pool, `SELECT count(*) n FROM recalculo_outbox`), outboxAntes, 'sem mudança efetiva → sem recálculo');
    assert.equal((await pool.query(`SELECT estado FROM ft_divergencias WHERE container_id = $1`, [c])).rows[0].estado, 'aberta');
    // Observação inferior (HeadCargo) também não enfileira recálculo.
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 9, fonte: 'headcargo', observadoEm: new Date('2026-08-25T00:00:00Z'), autor: 'hc' });
    assert.equal(await masterFt(pool, c), 10);
    assert.equal(await count(pool, `SELECT count(*) n FROM recalculo_outbox`), outboxAntes);
  } finally { await pool.end(); }
});

test('Divergência: resolver e reabrir gera nova ocorrência e novos avisos; reprocessar não duplica; convergência resolve', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    const svc = (valor: number, fonte: 'master_bl' | 'shipping_instructions', dia: string) =>
      promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor, fonte, observadoEm: new Date(`${dia}T00:00:00Z`), autor: fonte });
    await svc(14, 'shipping_instructions', '2026-08-20');
    await svc(10, 'master_bl', '2026-09-01');
    const d = (await pool.query(`SELECT id FROM ft_divergencias`)).rows[0];
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE ocorrencia_seq = 1`), 2);
    // Reprocessar a mesma fonte/instante: nada novo.
    await svc(10, 'master_bl', '2026-09-01');
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas`), 2);
    await reconhecerDivergencia(pool, { divergenciaId: d.id, usuario: 'gestor' });
    assert.equal(await resolverDivergencia(pool, { divergenciaId: d.id, usuario: 'gestor', motivo: 'ok' }), true);
    // Mesmo par após resolução manual → continua resolvida.
    await svc(10, 'master_bl', '2026-09-01');
    assert.equal((await pool.query(`SELECT estado FROM ft_divergencias`)).rows[0].estado, 'resolvida');
    // Correção do Master com outro valor → reabre (ocorrência 2) com novos avisos.
    await svc(12, 'master_bl', '2026-09-05');
    const r = (await pool.query(`SELECT estado, ocorrencia_seq FROM ft_divergencias`)).rows[0];
    assert.equal(r.estado, 'reaberta');
    assert.equal(r.ocorrencia_seq, 2);
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE ocorrencia_seq = 2`), 2);
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE ocorrencia_seq = 1`), 2, 'avisos antigos preservados');
    // Correção da SI igualando o Master → resolvida por convergência; histórico preservado.
    await svc(12, 'shipping_instructions', '2026-09-06');
    const fim = (await pool.query(`SELECT estado, resolvida_motivo FROM ft_divergencias`)).rows[0];
    assert.deepEqual([fim.estado, fim.resolvida_motivo], ['resolvida', 'convergencia']);
    const tipos = (await pool.query(`SELECT tipo FROM ft_divergencia_eventos ORDER BY criado_em, id`)).rows.map((x) => x.tipo);
    for (const t of ['aberta', 'aviso_emitido', 'reconhecida', 'resolvida', 'reaberta']) assert.ok(tipos.includes(t), t);
    assert.equal(await masterFt(pool, c), 12, 'Master continua selecionado');
  } finally { await pool.end(); }
});

/* =========================== outbox de recálculo =========================== */

test('Outbox de recálculo: dois workers não processam o mesmo item; falha permite retry; abandono é recuperado com fencing', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, { containers: ['MSCU1234567', 'TGHU7654321'] });
    for (const id of Object.values(s.containers)) {
      await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: id, valor: 14, fonte: 'master_bl', observadoEm: new Date('2026-08-15T00:00:00Z'), autor: 'm' });
    }
    const chamadas: string[] = [];
    const lento = async (_p: Pool, containerId: string) => { chamadas.push(containerId); await new Promise((r) => setTimeout(r, 50)); };
    const [a, b] = await Promise.all([
      processarRecalculosPendentes({ pool, hoje: HOJE, workerId: 'A', recalcular: lento }),
      processarRecalculosPendentes({ pool, hoje: HOJE, workerId: 'B', recalcular: lento }),
    ]);
    assert.equal(a.concluidos + b.concluidos, 2);
    assert.equal(new Set(chamadas).size, chamadas.length, 'nenhum item processado duas vezes');

    // Falha → FAILED → retry → DONE.
    const c = s.containers.MSCU1234567;
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 7, fonte: 'master_bl', observadoEm: new Date('2026-08-16T00:00:00Z'), autor: 'm' });
    const falha = await processarRecalculosPendentes({ pool, hoje: HOJE, workerId: 'A', recalcular: async () => { throw new Error('boom'); } });
    assert.equal(falha.falhados, 1);
    assert.equal((await pool.query(`SELECT estado, erro FROM recalculo_outbox WHERE estado <> 'DONE'`)).rows[0].estado, 'FAILED');
    assert.equal((await processarRecalculosPendentes({ pool, hoje: HOJE, workerId: 'A' })).concluidos, 1);

    // Crash depois do claim: item PROCESSING com prazo vencido é recuperado; o dono antigo não conclui.
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 5, fonte: 'master_bl', observadoEm: new Date('2026-08-17T00:00:00Z'), autor: 'm' });
    await pool.query(`UPDATE recalculo_outbox SET estado = 'PROCESSING', worker_id = 'morto', epoca = epoca + 1, tentativas = tentativas + 1, expira_em = now() - interval '1 minute' WHERE estado = 'PENDING'`);
    const velho = (await pool.query(`SELECT id, epoca FROM recalculo_outbox WHERE worker_id = 'morto'`)).rows[0];
    assert.equal((await processarRecalculosPendentes({ pool, hoje: HOJE, workerId: 'novo' })).concluidos, 1);
    const tardio = await pool.query(`UPDATE recalculo_outbox SET estado = 'DONE' WHERE id = $1 AND worker_id = 'morto' AND epoca = $2 AND estado = 'PROCESSING'`, [velho.id, velho.epoca]);
    assert.equal(tardio.rowCount, 0, 'conclusão do dono antigo é recusada');
  } finally { await pool.end(); }
});

/* =========================== avisos (claim persistente) =========================== */

test('Avisos: envio fora de transação, dois processadores não enviam a mesma entrega, falha externa é retentável', { skip: !url }, async () => {
  const pool = testPool();
  const observador = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 14, fonte: 'shipping_instructions', observadoEm: new Date('2026-08-20T00:00:00Z'), autor: 'si' });
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-01T00:00:00Z'), autor: 'm' });

    const enviados: string[] = [];
    const estadosDuranteEnvio: string[] = [];
    let semTransacaoAberta = true;
    const transport: AvisoDivergenciaTransport = {
      async enviar(a) {
        // Outro processo enxerga o claim já confirmado (PROCESSING) e não há sessão "idle in transaction".
        estadosDuranteEnvio.push((await observador.query(`SELECT status FROM ft_divergencia_entregas WHERE id = $1`, [a.entregaId])).rows[0].status);
        const { rows } = await observador.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
        if (rows[0].n > 0) semTransacaoAberta = false;
        await new Promise((r) => setTimeout(r, 30));
        enviados.push(a.entregaId);
        return { ok: true };
      },
    };
    const [x, y] = await Promise.all([
      processarAvisosDivergenciaPendentes({ pool, transport, workerId: 'A' }),
      processarAvisosDivergenciaPendentes({ pool, transport, workerId: 'B' }),
    ]);
    assert.equal(x.enviadas + y.enviadas, 2);
    assert.equal(new Set(enviados).size, 2, 'cada entrega enviada uma única vez');
    assert.ok(estadosDuranteEnvio.every((e) => e === 'PROCESSING'), 'claim confirmado antes do envio');
    assert.ok(semTransacaoAberta, 'nenhuma transação aberta durante o envio externo');
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE status = 'SENT' AND claim_token IS NULL`), 2);

    // Falha externa → FAILED + evento; retry → SENT.
    const d = (await pool.query(`SELECT id FROM ft_divergencias`)).rows[0];
    await resolverDivergencia(pool, { divergenciaId: d.id, usuario: 'g' });
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 11, fonte: 'master_bl', observadoEm: new Date('2026-09-03T00:00:00Z'), autor: 'm' });
    const falha = await processarAvisosDivergenciaPendentes({ pool, workerId: 'A', transport: { async enviar() { throw new Error('SMTP fora'); } } });
    assert.equal(falha.falhadas, 2);
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_eventos WHERE tipo = 'aviso_falhou'`), 2);
    const retry = await processarAvisosDivergenciaPendentes({ pool, workerId: 'A', transport: { async enviar() { return { ok: true }; } } });
    assert.equal(retry.enviadas, 2);
  } finally { await pool.end(); await observador.end(); }
});

test('Avisos: entrega abandonada após interrupção é recuperada; finalização com token antigo é recusada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 14, fonte: 'shipping_instructions', observadoEm: new Date('2026-08-20T00:00:00Z'), autor: 'si' });
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-01T00:00:00Z'), autor: 'm' });

    // Processo 1 reivindica e "morre" durante o envio: a posse fica PROCESSING.
    let liberar!: () => void;
    const travado = new Promise<void>((r) => { liberar = r; });
    const p1 = processarAvisosDivergenciaPendentes({ pool, workerId: 'morto', ttlMs: 1000, limite: 1,
      transport: { async enviar() { await travado; return { ok: true }; } } });
    await new Promise((r) => setTimeout(r, 100));
    const presa = (await pool.query(`SELECT id, claim_token FROM ft_divergencia_entregas WHERE status = 'PROCESSING'`)).rows;
    assert.equal(presa.length, 1);
    await pool.query(`UPDATE ft_divergencia_entregas SET expira_em = now() - interval '1 second' WHERE id = $1`, [presa[0].id]);

    // Processo 2 recupera a entrega abandonada (novo token) e envia.
    const enviados: string[] = [];
    const r2 = await processarAvisosDivergenciaPendentes({ pool, workerId: 'novo', transport: { async enviar(a) { enviados.push(a.entregaId); return { ok: true }; } } });
    assert.ok(enviados.includes(presa[0].id), 'entrega abandonada recuperada');
    assert.equal(r2.enviadas, 2);

    // O processo antigo volta e tenta finalizar com o token velho: recusado.
    liberar();
    const r1 = await p1;
    assert.equal(r1.possePerdida, 1);
    assert.equal(r1.enviadas, 0);
    assert.equal((await pool.query(`SELECT status FROM ft_divergencia_entregas WHERE id = $1`, [presa[0].id])).rows[0].status, 'SENT');
  } finally { await pool.end(); }
});

/* =========================== rotas e isolamento =========================== */

function resStub() {
  const out: { status: number; body: any } = { status: 200, body: null };
  const res: any = { status(n: number) { out.status = n; return res; }, json(b: unknown) { out.body = b; return res; } };
  return { res, out };
}

test('Rotas: POST reprocessa pelo serviço idempotente; exige membro da organização; GET de análise não grava nada', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const a = await cenario(pool, { slug: 'org-a' });
    const b = await cenario(pool, { slug: 'org-b' });
    const { criarHandlerReprocessarSI, processRouter } = await import('../../routes/processRoutes');
    const f = portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 14 days')]);
    const handler = criarHandlerReprocessarSI({ pool: () => pool, portas: () => f.p });
    const chamar = async (org: string, home: string) => {
      const { res, out } = resStub();
      let erro: unknown = null;
      await handler({ params: { conversationId: CONV }, body: { organizationId: org }, session: { homeAccountId: home }, accessToken: 't' } as any, res, (e: unknown) => { erro = e; });
      if (erro) throw erro;
      return out;
    };
    assert.equal((await chamar(b.orgId, a.homeResp)).status, 403, 'usuário da org A não reprocessa a org B');
    assert.equal((await chamar(a.orgId, 'desconhecido')).status, 403);
    const ok = await chamar(a.orgId, a.homeResp);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'concluida');
    assert.equal(await masterFt(pool, a.containers.MSCU1234567), 14);
    assert.equal(await masterFt(pool, b.containers.MSCU1234567), null, 'isolamento: a org B não é tocada');
    assert.equal(await count(pool, `SELECT count(*) n FROM si_conversas WHERE organization_id = $1`, [a.orgId]), 1);
    assert.equal((await chamar(a.orgId, a.homeResp)).body.status, 'ja_concluida');

    // GET /:conversationId/analysis: somente leitura.
    const graph = require('../../graph/graphService');
    const ai = require('../../ai/geminiClient');
    const parser = require('../../ai/emailParser');
    const orig = { conv: graph.getConversationFull, cfg: ai.isAiConfigured, parse: parser.parseThread };
    graph.getConversationFull = async () => [{ id: 'm1', conversationId: CONV, subject: 's', receivedDateTime: '2026-08-20T10:00:00Z', body: { contentType: 'text', content: 'Free time: 30 days' }, hasAttachments: false }];
    ai.isAiConfigured = () => true;
    parser.parseThread = async () => ({ resumo: 'ok' });
    try {
      const snap = () => count(pool, `SELECT (SELECT count(*) FROM field_observations) + (SELECT count(*) FROM si_versoes) + (SELECT count(*) FROM si_intencoes)
        + (SELECT count(*) FROM si_proveniencias) + (SELECT count(*) FROM si_pendencias) + (SELECT count(*) FROM si_conversas) + (SELECT count(*) FROM ft_divergencias)
        + (SELECT count(*) FROM recalculo_outbox) n`);
      const antes = await snap();
      const layer = (processRouter as any).stack.find((l: any) => l.route?.path === '/:conversationId/analysis' && l.route.methods.get);
      const { res, out } = resStub();
      await layer.route.stack[0].handle({ params: { conversationId: CONV }, accessToken: 't' }, res, (e: unknown) => { if (e) throw e; });
      assert.equal(out.status, 200);
      assert.equal(await snap(), antes, 'GET não grava nada');
      assert.equal(await masterFt(pool, a.containers.MSCU1234567), 14, 'GET não altera o Master Free Time');
    } finally {
      graph.getConversationFull = orig.conv; ai.isAiConfigured = orig.cfg; parser.parseThread = orig.parse;
    }
  } finally { await pool.end(); }
});

test('Isolamento: mesma conversa e mesmo processo em duas organizações não se misturam', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const a = await cenario(pool, { slug: 'iso-a' });
    const b = await cenario(pool, { slug: 'iso-b' });
    await ingerirShippingInstructions({ pool, organizationId: a.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 14 days')]).p });
    await ingerirShippingInstructions({ pool, organizationId: b.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([msg('m1', '2026-08-20T10:00:00Z', 'MBL: MAEU123456789\nFree time: 21 days')]).p });
    assert.equal(await masterFt(pool, a.containers.MSCU1234567), 14);
    assert.equal(await masterFt(pool, b.containers.MSCU1234567), 21);
    assert.equal(await count(pool, `SELECT count(*) n FROM si_versoes`), 2);
    const cruzado = await count(pool, `SELECT count(*) n FROM si_proveniencias pv JOIN containers c ON c.id = pv.container_id WHERE c.organization_id <> pv.organization_id`);
    assert.equal(cruzado, 0);
    // FK composta impede proveniência apontando para contêiner de outra organização.
    const ia = (await pool.query(`SELECT id FROM si_intencoes WHERE organization_id = $1`, [a.orgId])).rows[0];
    const obs = (await pool.query(`SELECT id FROM field_observations WHERE entidade_id = $1 AND campo = 'masterFreeTimeDays'`, [a.containers.MSCU1234567])).rows[0];
    await assert.rejects(pool.query(
      `INSERT INTO si_proveniencias (organization_id, intencao_id, field_observation_id, processo_id, container_id, conversation_id, message_id,
         message_received_at, encontrado_em, trecho_evidencia, valor_dias, metodo_extracao, confianca, conteudo_hash, observado_em)
       VALUES ($1, $2, $3, $4, $5, 'c', 'm', now(), 'corpo', 't', 1, 'texto', 1, 'h', now())`,
      [a.orgId, ia.id, obs.id, a.processoId, b.containers.MSCU1234567]), /si_proveniencias_container_org_fk/);
  } finally { await pool.end(); }
});
