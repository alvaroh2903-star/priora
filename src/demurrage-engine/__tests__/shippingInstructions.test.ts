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
  extrairFreeTimeDoCorpo, extrairReferencias, consolidarOcorrencias, avaliarOcr, hashConteudo, primeiraMensagem, MensagemSI, OcrResultadoSI,
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
  const house = extrairFreeTimeDoCorpo('House free time: 7 days').ocorrencias;
  assert.deepEqual(house.map((o) => [o.campo, o.valor]), [['houseFreeTimeDays', 7]], 'House rotulado vai para o House, nunca para o Master');
  assert.deepEqual(extrairFreeTimeDoCorpo('Please book as agreed'), { ocorrencias: [], problemas: [] });
});

test('SI puro: valores distintos no mesmo alcance → ambíguo; exceção por contêiner é preservada', () => {
  const ocs = extrairFreeTimeDoCorpo('Free time: 14 days\nfree time 21 days').ocorrencias;
  const c = consolidarOcorrencias(ocs);
  assert.equal(c.porCampo.masterFreeTimeDays.nivelMbl, null);
  assert.equal(c.problemas[0].tipo, 'free_time_ambiguo');
  const c2 = consolidarOcorrencias(extrairFreeTimeDoCorpo('Free time: 14 days\nFree time 21 days for MSCU1234567').ocorrencias);
  assert.equal(c2.porCampo.masterFreeTimeDays.nivelMbl!.valor, 14);
  assert.equal(c2.porCampo.masterFreeTimeDays.porContainer.get('MSCU1234567')!.valor, 21);
  // House e Master diferentes entre si NÃO são ambiguidade.
  const c3 = consolidarOcorrencias(extrairFreeTimeDoCorpo('FREE TIME HOUSE: 14\nFREE TIME MASTER: 20').ocorrencias);
  assert.deepEqual(c3.problemas, []);
  assert.equal(c3.porCampo.houseFreeTimeDays.nivelMbl!.valor, 14);
  assert.equal(c3.porCampo.masterFreeTimeDays.nivelMbl!.valor, 20);
});

test('SI puro: leitura de anexo só é aceita com confiança >= 0.90, âncora e valor único', () => {
  const anexo = { id: 'a1', name: 'si.pdf', contentType: 'application/pdf', size: 10 };
  const base: OcrResultadoSI = { legivel: true, masterFreeTimeDays: 14, ancoraTexto: 'Free time: 14 days', trecho: 'Free time: 14 days', confianca: 0.95, containers: [], mbl: null, processo: null, multiplosValores: false };
  assert.equal(avaliarOcr(anexo, base).ocorrencias[0].valor, 14);
  assert.equal(avaliarOcr(anexo, { ...base, confianca: 0.89 }).problemas[0].tipo, 'ocr_baixa_confianca');
  assert.equal(avaliarOcr(anexo, { ...base, ancoraTexto: 'Total 14' }).problemas[0].tipo, 'free_time_ambiguo');
  assert.equal(avaliarOcr(anexo, { ...base, multiplosValores: true }).problemas[0].tipo, 'free_time_ambiguo');
  assert.equal(avaliarOcr(anexo, { ...base, masterFreeTimeDays: 2.5 }).problemas[0].tipo, 'free_time_ambiguo');
  assert.equal(avaliarOcr(anexo, { ...base, legivel: false }).problemas[0].tipo, 'ocr_baixa_confianca');
  assert.equal(avaliarOcr(anexo, { ...base, masterFreeTimeDays: 0, ancoraTexto: 'Free time: 0 days' }).ocorrencias[0].valor, 0);
  // House e Master do mesmo anexo, cada um no seu campo.
  const ambos = avaliarOcr(anexo, { ...base, masterFreeTimeDays: 20, ancoraTexto: 'FREE TIME MASTER: 20', houseFreeTimeDays: 20, ancoraHouse: 'FREE TIME HOUSE: 20' });
  assert.deepEqual(ambos.ocorrencias.map((o) => [o.campo, o.valor]), [['masterFreeTimeDays', 20], ['houseFreeTimeDays', 20]]);
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
    await reconhecerDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.mGestor });
    assert.equal(await resolverDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.mGestor, motivo: 'ok' }), true);
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
    await resolverDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.mGestor, motivo: 'ok' });
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

/* =========================== corretiva final =========================== */

test('Migration 0025: banco que já executou a 0024 ORIGINAL recebe só a 0025, com dados preservados', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const ate24 = await runMigrations(pool, { until: '0024_shipping_instructions.sql' });
    assert.equal(ate24.applied[ate24.applied.length - 1], '0024_shipping_instructions.sql');
    const colunas = async (tabela: string) => (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [tabela])).rows.map((r) => r.column_name);
    assert.ok(!(await colunas('si_intencoes')).includes('containers_ref'), '0024 original não tem containers_ref');
    assert.ok(!(await colunas('ft_divergencia_entregas')).includes('claim_token'), '0024 original não tem claim');

    // Dados gravados sob o schema ORIGINAL: divergência com entregas, outbox e intenção.
    // Inserção DIRETA (não via `promoverMasterFreeTime`): o serviço atual depende de
    // tabelas de migrations POSTERIORES à 0025 (ex.: `demurrage_pendencias`, D15-B/R05)
    // — chamá-lo aqui recriaria exatamente a situação que este teste existe para isolar
    // (código atual rodando contra um schema travado em 0024). O que a 0025 precisa
    // preservar é a FORMA dos dados sob aquele schema, não como eles chegaram lá.
    const s = await cenario(pool);
    const c = s.containers.MSCU1234567;
    const obsSi = (await pool.query(
      `INSERT INTO field_observations (organization_id, entidade_tipo, entidade_id, campo, valor, fonte, observado_em)
       VALUES ($1, 'container', $2, 'masterFreeTimeDays', '14', 'shipping_instructions', '2026-08-20T00:00:00Z') RETURNING id`,
      [s.orgId, c],
    )).rows[0];
    const obsMaster = (await pool.query(
      `INSERT INTO field_observations (organization_id, entidade_tipo, entidade_id, campo, valor, fonte, observado_em)
       VALUES ($1, 'container', $2, 'masterFreeTimeDays', '10', 'master_bl', '2026-09-01T00:00:00Z') RETURNING id`,
      [s.orgId, c],
    )).rows[0];
    await pool.query(`UPDATE containers SET master_free_time_days = 10, master_free_time_observation_id = $2 WHERE id = $1`, [c, obsMaster.id]);
    const div = (await pool.query(
      `INSERT INTO ft_divergencias (organization_id, processo_id, container_id, valor_si, obs_si_id, valor_master, obs_master_id, estado, ocorrencia_seq)
       VALUES ($1, $2, $3, 14, $4, 10, $5, 'aberta', 1) RETURNING id`,
      [s.orgId, s.processoId, c, obsSi.id, obsMaster.id],
    )).rows[0];
    await pool.query(
      `INSERT INTO ft_divergencia_entregas (organization_id, divergencia_id, ocorrencia_seq, destinatario_tipo, destinatario_membership_id)
       VALUES ($1, $2, 1, 'responsavel_operacional', $3), ($1, $2, 1, 'gestor', $4)`,
      [s.orgId, div.id, s.mResp, s.mGestor],
    );
    await pool.query(
      `INSERT INTO recalculo_outbox (organization_id, container_id, tipo, chave) VALUES ($1, $2, 'master_free_time', $3), ($1, $2, 'master_free_time', $4)`,
      [s.orgId, c, obsSi.id, obsMaster.id],
    );
    await pool.query(`UPDATE recalculo_outbox SET estado = 'PROCESSING', worker_id = 'w-antigo', expira_em = now() + interval '1 minute' WHERE ctid IN (SELECT ctid FROM recalculo_outbox LIMIT 1)`);
    const v = (await pool.query(
      `INSERT INTO si_versoes (organization_id, conversation_id, message_id, message_received_at, conteudo_hash, estado, expira_em)
       VALUES ($1, 'conv', 'm1', now(), 'h', 'DONE', now()) RETURNING id`, [s.orgId])).rows[0];
    await pool.query(
      `INSERT INTO si_intencoes (organization_id, versao_id, conversation_id, message_id, message_received_at, escopo, valor_dias,
         encontrado_em, trecho_evidencia, metodo_extracao, confianca, conteudo_hash)
       VALUES ($1, $2, 'conv', 'm1', now(), 'mbl', 14, 'corpo', 'Free time: 14 days', 'texto', 1, 'h')`, [s.orgId, v.id]);
    const antes = await count(pool, `SELECT (SELECT count(*) FROM ft_divergencia_entregas) + (SELECT count(*) FROM recalculo_outbox) + (SELECT count(*) FROM si_intencoes) n`);

    const r = await runMigrations(pool, { until: '0025_shipping_instructions_corretiva.sql' });
    assert.deepEqual(r.applied, ['0025_shipping_instructions_corretiva.sql'], 'só a 0025 é aplicada');
    assert.equal(await count(pool, `SELECT (SELECT count(*) FROM ft_divergencia_entregas) + (SELECT count(*) FROM recalculo_outbox) + (SELECT count(*) FROM si_intencoes) n`), antes, 'dados preservados');
    assert.deepEqual((await pool.query(`SELECT containers_ref FROM si_intencoes`)).rows[0].containers_ref, [], 'intenção antiga recebe o default');
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE status = 'PENDING' AND claim_token IS NULL`), 2);
    // Constraints novas valem a partir de agora.
    const e = (await pool.query(`SELECT id FROM ft_divergencia_entregas LIMIT 1`)).rows[0];
    await assert.rejects(pool.query(`UPDATE ft_divergencia_entregas SET status = 'PROCESSING' WHERE id = $1`, [e.id]), /ft_divergencia_entregas_claim/);
    await pool.query(`UPDATE ft_divergencia_entregas SET status = 'PROCESSING', claim_token = gen_random_uuid(), expira_em = now() + interval '1 hour' WHERE id = $1`, [e.id]);
    await assert.rejects(pool.query(`UPDATE recalculo_outbox SET worker_id = NULL WHERE estado = 'PROCESSING'`), /recalculo_outbox_claim/);
    // A funcionalidade opera normalmente sobre o banco migrado.
    const sent = await processarAvisosDivergenciaPendentes({ pool, workerId: 'w', transport: { async enviar() { return { ok: true }; } } });
    assert.equal(sent.enviadas, 1, 'a entrega PENDING restante é enviada');
    // 0026 sobre o banco já migrado até a 0025: intenção antiga vira Master.
    // `until` limita à própria 0026 — este teste é sobre o degrau 0024→0025→0026;
    // migrations aditivas posteriores (captura de pré-alerta) são passo aparte.
    assert.deepEqual((await runMigrations(pool, { until: '0026_shipping_instructions_house_master.sql' })).applied, ['0026_shipping_instructions_house_master.sql']);
    assert.equal((await pool.query(`SELECT campo FROM si_intencoes`)).rows[0].campo, 'masterFreeTimeDays');
    assert.equal((await runMigrations(pool, { until: '0026_shipping_instructions_house_master.sql' })).applied.length, 0, 'idempotente');
  } finally { await pool.end(); }
});

test('Avisos: uma entrega por ciclo — duas instâncias concorrentes e transporte lento não expõem entregas ainda não iniciadas', { skip: !url }, async () => {
  const pool = testPool();
  const observador = testPool();
  try {
    await setup(pool);
    const numeros = ['MSCU1234567', 'TGHU7654321', 'CAIU1112223', 'TCNU4445556'];
    const s = await cenario(pool, { containers: numeros });
    for (const id of Object.values(s.containers)) {
      await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: id, valor: 14, fonte: 'shipping_instructions', observadoEm: new Date('2026-08-20T00:00:00Z'), autor: 'si' });
      await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: id, valor: 10, fonte: 'master_bl', observadoEm: new Date('2026-09-01T00:00:00Z'), autor: 'm' });
    }
    const total = await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas`);
    assert.equal(total, 8, '4 divergências × 2 destinatários');

    let maxProcessing = 0;
    const enviados: string[] = [];
    const transport: AvisoDivergenciaTransport = {
      async enviar(a) {
        // No instante do envio, cada instância detém no máximo UMA posse.
        const n = (await observador.query(`SELECT count(*)::int n FROM ft_divergencia_entregas WHERE status = 'PROCESSING'`)).rows[0].n;
        maxProcessing = Math.max(maxProcessing, n);
        await new Promise((r) => setTimeout(r, 40));
        enviados.push(a.entregaId);
        return { ok: true };
      },
    };
    const [a, b] = await Promise.all([
      processarAvisosDivergenciaPendentes({ pool, transport, workerId: 'A' }),
      processarAvisosDivergenciaPendentes({ pool, transport, workerId: 'B' }),
    ]);
    assert.ok(maxProcessing <= 2, `posse nunca antecipada: no máximo 1 PROCESSING por instância (visto ${maxProcessing})`);
    assert.equal(a.reivindicadas + b.reivindicadas, total, 'cada entrega reivindicada uma vez');
    assert.equal(a.enviadas + b.enviadas, total);
    assert.equal(a.possePerdida + b.possePerdida, 0);
    assert.equal(new Set(enviados).size, total, 'nenhuma entrega enviada duas vezes');
    assert.ok(a.enviadas > 0 && b.enviadas > 0, 'as duas instâncias dividiram o trabalho');
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE status = 'SENT' AND claim_token IS NULL AND expira_em IS NULL`), total);

    // `limite` interrompe o ciclo: nada fica reivindicado além do que foi processado.
    const d = (await pool.query(`SELECT id FROM ft_divergencias ORDER BY id LIMIT 1`)).rows[0];
    await resolverDivergencia(pool, { divergenciaId: d.id, organizationId: s.orgId, autorMembershipId: s.mGestor, motivo: 'ok' });
    const c0 = (await pool.query(`SELECT container_id FROM ft_divergencias WHERE id = $1`, [d.id])).rows[0].container_id;
    await promoverMasterFreeTime(pool, { organizationId: s.orgId, containerId: c0, valor: 11, fonte: 'master_bl', observadoEm: new Date('2026-09-03T00:00:00Z'), autor: 'm' });
    const parcial = await processarAvisosDivergenciaPendentes({ pool, transport: { async enviar() { return { ok: true }; } }, workerId: 'A', limite: 1 });
    assert.equal(parcial.reivindicadas, 1);
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE status = 'PROCESSING'`), 0, 'sem claim pendurado');
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencia_entregas WHERE status = 'PENDING'`), 1, 'a próxima segue PENDING, sem posse');
  } finally { await pool.end(); await observador.end(); }
});

/* =========================== formato real da SI (Rocket) =========================== */

const SI_REAL = [
  'SHIPPING INSTRUCTION: IM3126-26',
  'CARRIER: ZIM',
  'DESTINATION: SANTOS',
  'FREE TIME HOUSE: 20',
  'FREE TIME MASTER: 20',
  'OCEAN FREIGHT 3 X USD 2.450,00 / 40 HIGH CUBE',
].join('\n');
const siReal = (body = SI_REAL) => msg('si-1', '2026-08-20T10:00:00Z', body, [], 'SHIPPING INSTRUCTION - IM3126-26');
const houseFt = (pool: Pool, containerId: string) =>
  pool.query(`SELECT house_free_time_days AS v FROM containers WHERE id = $1`, [containerId]).then((r) => r.rows[0].v as number | null);

test('SI puro (formato real): rótulos House/Master sem "dias", processo integral, sem MBL e sem ISO; tarifas ambíguas', () => {
  const r = extrairFreeTimeDoCorpo(SI_REAL);
  assert.deepEqual(r.ocorrencias.map((o) => [o.campo, o.valor, o.containers]), [['houseFreeTimeDays', 20, []], ['masterFreeTimeDays', 20, []]]);
  assert.deepEqual(r.problemas, []);
  const refs = extrairReferencias(`SHIPPING INSTRUCTION - IM3126-26\n${SI_REAL}`);
  assert.deepEqual(refs, { processos: ['IM3126-26'], mbls: [], containers: [] }, 'IM3126-26 íntegro; "40 HIGH CUBE" não é contêiner');
  assert.deepEqual(extrairReferencias('IM3126-2600').processos, [], 'código mais longo não é reduzido a IM3126');
  for (const [t, campo] of [['MASTER FREE TIME: 20', 'masterFreeTimeDays'], ['HOUSE FREE TIME: 20', 'houseFreeTimeDays'], ['FREE TIME MASTER: 0', 'masterFreeTimeDays']] as const) {
    const o = extrairFreeTimeDoCorpo(t).ocorrencias;
    assert.deepEqual(o.map((x) => x.campo), [campo], t);
  }
  assert.equal(extrairFreeTimeDoCorpo('FREE TIME MASTER: 0').ocorrencias[0].valor, 0);
  for (const t of ['Demurrage: 140', 'Demurrage USD 140', 'Free Time/Demurrage: 140']) {
    const x = extrairFreeTimeDoCorpo(t);
    assert.equal(x.ocorrencias.length, 0, t);
    assert.equal(x.problemas[0]?.tipo, 'free_time_ambiguo', t);
  }
  // Tarifa de demurrage ao lado do rótulo estruturado não torna o Master ambíguo.
  assert.deepEqual(extrairFreeTimeDoCorpo('FREE TIME MASTER: 20\nDemurrage USD 140').problemas, []);
});

test('SI real: IM3126-26 sem MBL e sem contêiner é associada pelo código; contêineres cadastrados depois recebem House e Master sem nova leitura', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, { numero: 'IM3126-26', mbl: null, containers: [] });
    // Processos "vizinhos" na mesma organização: nenhum pode ser confundido.
    const repoP = new ProcessoRepository(pool);
    const vizinho = await repoP.create({ organizationId: s.orgId, numeroProcesso: 'IM3126', clienteId: null });
    const cVizinho = await novoContainer(pool, s.orgId, vizinho.id, 'MSCU9999990');

    const f = portasFake([siReal()]);
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, portas: f.p, modo: 'automatico' });
    assert.equal(r.status, 'concluida', 'sem MBL e sem contêiner: nenhuma pendência');
    assert.equal(await abertas(pool), 0);
    assert.equal(await count(pool, `SELECT count(*) n FROM si_pendencias WHERE tipo IN ('mbl_nao_identificado', 'container_nao_encontrado')`), 0);
    const int = (await pool.query(`SELECT campo, escopo, valor_dias, processos_ref, mbls_ref FROM si_intencoes ORDER BY campo`)).rows;
    assert.deepEqual(int.map((i) => [i.campo, i.escopo, i.valor_dias]), [['houseFreeTimeDays', 'mbl', 20], ['masterFreeTimeDays', 'mbl', 20]]);
    assert.deepEqual(int[0].processos_ref, ['IM3126-26'], 'código integral preservado');
    assert.deepEqual(int[0].mbls_ref, [], 'MBL ausente, não inventado');
    assert.equal((await pool.query(`SELECT mbl FROM processos WHERE id = $1`, [s.processoId])).rows[0].mbl, null);

    // Três contêineres (3 × 40 HIGH CUBE) cadastrados depois.
    const novos = [];
    for (const n of ['ZIMU1111111', 'ZIMU2222222', 'ZIMU3333333']) novos.push(await novoContainer(pool, s.orgId, s.processoId, n));
    const re = await reaplicarIntencoesShippingInstructions({ pool });
    assert.equal(re.promovidos, 6, '3 contêineres × (House + Master)');
    for (const c of novos) {
      assert.equal(await houseFt(pool, c), 20, 'FREE TIME HOUSE: 20 → House 20');
      assert.equal(await masterFt(pool, c), 20, 'FREE TIME MASTER: 20 → Master 20');
    }
    assert.equal(f.chamadas.conversa, 1, 'reaplicação não recarrega a conversa');
    assert.equal(f.chamadas.documento, 0, 'nenhuma leitura documental');
    const pv = (await pool.query(`SELECT DISTINCT campo, associacao_por FROM si_proveniencias ORDER BY campo`)).rows;
    assert.deepEqual(pv.map((x) => [x.campo, x.associacao_por]), [['houseFreeTimeDays', 'numero_processo'], ['masterFreeTimeDays', 'numero_processo']]);
    assert.equal(await count(pool, `SELECT count(*) n FROM field_observations WHERE fonte = 'shipping_instructions'`), 6);
    assert.equal(await count(pool, `SELECT count(*) n FROM recalculo_outbox WHERE tipo = 'house_free_time'`), 3);
    assert.equal(await count(pool, `SELECT count(*) n FROM recalculo_outbox WHERE tipo = 'master_free_time'`), 3);
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencias`), 0, 'House = Master não é divergência');
    assert.equal(await masterFt(pool, cVizinho), null, 'processo IM3126 (sem sufixo) não é tocado');
    assert.equal((await reaplicarIntencoesShippingInstructions({ pool })).promovidos, 0, 'idempotente');
  } finally { await pool.end(); }
});

test('SI real: House e Master diferentes não são divergência; House respeita a hierarquia (house_document prevalece), mas o conflito House-only (house_document × SI) agora abre divergência (D15-B/R36)', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, { numero: 'IM3126-26', mbl: null, containers: ['ZIMU1111111', 'ZIMU2222222'] });
    const [c1, c2] = Object.values(s.containers);
    await new ContainerRepository(pool).applyObservation({ containerId: c2, organizationId: s.orgId, campo: 'houseFreeTimeDays', valor: 10, fonte: 'house_document', observadoEm: new Date('2026-08-01T00:00:00Z') });
    const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([siReal(SI_REAL.replace('FREE TIME HOUSE: 20', 'FREE TIME HOUSE: 14'))]).p });
    assert.equal(r.status, 'concluida');
    assert.equal(await houseFt(pool, c1), 14);
    assert.equal(await masterFt(pool, c1), 20);
    assert.equal(await houseFt(pool, c2), 10, 'house_document (90) prevalece sobre a SI (85)');
    assert.equal(await count(pool, `SELECT count(*) n FROM field_observations WHERE entidade_id = $1 AND campo = 'houseFreeTimeDays' AND fonte = 'shipping_instructions'`, [c2]), 1, 'SI fica no ledger');
    // House = Master (mesma leitura da SI) em c1 não é divergência (COB, R35/pré-D15-B).
    assert.equal(await count(pool, `SELECT count(*) n FROM ft_divergencias WHERE container_id = $1`, [c1]), 0);
    // D15-B (R36): house_document × SI em c2, mesmo campo (houseFreeTimeDays), valores diferentes
    // (10 × 14) — a hierarquia já decide a SELEÇÃO (house_document vence), mas o conflito em si
    // agora é visível à gestão, mesmo mecanismo/tabela do conflito Master×SI (R35, já coberto).
    const divHouse = (await pool.query(`SELECT campo, estado, valor_si, valor_master FROM ft_divergencias WHERE container_id = $1`, [c2])).rows;
    assert.equal(divHouse.length, 1);
    assert.deepEqual([divHouse[0].campo, divHouse[0].estado, divHouse[0].valor_si, divHouse[0].valor_master], ['houseFreeTimeDays', 'aberta', 14, 10]);
  } finally { await pool.end(); }
});

test('SI real: FREE TIME MASTER: 0 é aceito; "Demurrage: 140" isolado é ambíguo e nada promove', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, { numero: 'IM3126-26', mbl: null, containers: ['ZIMU1111111'] });
    const c = s.containers.ZIMU1111111;
    await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([siReal(SI_REAL.replace('FREE TIME MASTER: 20', 'FREE TIME MASTER: 0'))]).p });
    assert.equal(await masterFt(pool, c), 0);

    const t = await cenario(pool, { slug: 'ambigua', numero: 'IM3126-26', mbl: null, containers: ['ZIMU2222222'] });
    const r = await ingerirShippingInstructions({ pool, organizationId: t.orgId, conversationId: 'conv-2', modo: 'automatico',
      portas: portasFake([siReal('SHIPPING INSTRUCTION: IM3126-26\nCARRIER: ZIM\nDemurrage: 140')]).p });
    assert.equal(r.status, 'pendente');
    assert.equal(await count(pool, `SELECT count(*) n FROM si_pendencias WHERE organization_id = $1 AND tipo = 'free_time_ambiguo' AND estado = 'aberta'`, [t.orgId]), 1);
    assert.equal(await masterFt(pool, t.containers.ZIMU2222222), null, 'nenhum valor presumido');
  } finally { await pool.end(); }
});

test('SI real: dois processos no mesmo documento ficam pendentes; processo de outra organização não é associado', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const a = await cenario(pool, { slug: 'org-a', numero: 'IM3126-26', mbl: null, containers: ['ZIMU1111111'] });
    await new ProcessoRepository(pool).create({ organizationId: a.orgId, numeroProcesso: 'IM3126-27', clienteId: null });
    const r = await ingerirShippingInstructions({ pool, organizationId: a.orgId, conversationId: CONV, modo: 'automatico',
      portas: portasFake([siReal(`SHIPPING INSTRUCTION: IM3126-26 / IM3126-27\n${SI_REAL}`)]).p });
    assert.equal(r.status, 'pendente');
    assert.equal(await abertas(pool, 'conversa_multiprocesso'), 1);
    assert.equal(await masterFt(pool, a.containers.ZIMU1111111), null);

    // Org B não tem o IM3126-26; a Org C tem. Ingerir na Org B não alcança a Org C.
    const b = await cenario(pool, { slug: 'org-b', numero: 'IM0001-01', mbl: null, containers: ['ZIMU4444444'] });
    const cOrg = await cenario(pool, { slug: 'org-c', numero: 'IM3126-26', mbl: null, containers: ['ZIMU5555555'] });
    const rb = await ingerirShippingInstructions({ pool, organizationId: b.orgId, conversationId: 'conv-b', modo: 'automatico', portas: portasFake([siReal()]).p });
    assert.equal(rb.status, 'pendente');
    assert.equal(await count(pool, `SELECT count(*) n FROM si_pendencias WHERE organization_id = $1 AND tipo = 'processo_nao_identificado'`, [b.orgId]), 1);
    assert.equal(await masterFt(pool, cOrg.containers.ZIMU5555555), null, 'processo de outra organização intocado');
    assert.equal(await houseFt(pool, cOrg.containers.ZIMU5555555), null);
  } finally { await pool.end(); }
});

test('SI real: falha em uma das promoções (House) desfaz a ingestão inteira, inclusive o Master', { skip: !url }, async () => {
  const pool = testPool();
  try {
    await setup(pool);
    const s = await cenario(pool, { numero: 'IM3126-26', mbl: null, containers: ['ZIMU1111111'] });
    const c = s.containers.ZIMU1111111;
    const snap = () => count(pool, `SELECT (SELECT count(*) FROM field_observations) + (SELECT count(*) FROM si_proveniencias) + (SELECT count(*) FROM si_intencoes)
      + (SELECT count(*) FROM recalculo_outbox) + (SELECT count(*) FROM ft_divergencias) + (SELECT count(*) FROM si_pendencias) n`);
    const antes = await snap();
    await pool.query(`CREATE FUNCTION falha_house() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.campo = 'houseFreeTimeDays' THEN RAISE EXCEPTION 'falha simulada no House'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER falha_house BEFORE INSERT ON field_observations FOR EACH ROW EXECUTE FUNCTION falha_house()`);
    try {
      const r = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, modo: 'automatico', portas: portasFake([siReal()]).p });
      assert.equal(r.status, 'falhou');
      assert.match(r.erro!, /falha simulada no House/);
    } finally {
      await pool.query(`DROP TRIGGER falha_house ON field_observations`);
      await pool.query(`DROP FUNCTION falha_house()`);
    }
    assert.equal(await snap(), antes, 'nada persistido');
    assert.equal(await masterFt(pool, c), null, 'o Master promovido antes da falha também foi desfeito');
    assert.equal(await houseFt(pool, c), null);
    assert.equal((await pool.query(`SELECT estado FROM si_versoes`)).rows[0].estado, 'FAILED');
    // Reprocesso manual depois da falha aplica os dois.
    const ok = await ingerirShippingInstructions({ pool, organizationId: s.orgId, conversationId: CONV, modo: 'manual', portas: portasFake([siReal()]).p });
    assert.equal(ok.status, 'concluida');
    assert.deepEqual([await houseFt(pool, c), await masterFt(pool, c)], [20, 20]);
  } finally { await pool.end(); }
});
