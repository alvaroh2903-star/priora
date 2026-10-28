import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { testPool, testDatabaseUrl, atribuirResponsavelDeTeste } from './testDb';
import { ArmazenamentoMemoria } from '../documentos/armazenamentoMemoria';
import { corrigir } from '../documentos/reconciliacao';
import { ClosingService } from '../closing/closingService';
import { confirmarResponsabilidadeClienteIntegral } from './responsabilidadeTestHelper';
import {
  ACOES, base, baixar, cenario, devolverPeloTracking, DOCS, HOJE, inserirMinutaLegadaReferencia, logar, MicrosoftFalsa, Navegador, pdf,
  registrarMinutaHttp, statusProcesso, subirAppArquivos, uploadCompleto, AppArquivos, Base,
} from './arquivosTestHelper';

/**
 * Produção P1 — ARQUIVOS REAIS DAS MINUTAS: integração com a minuta e com o
 * encerramento automático (testes obrigatórios 20–26). PostgreSQL real, app
 * real, armazenamento de objetos em memória. Regras provadas: substituição
 * cria versões e preserva o histórico; o encerramento usa SÓ a versão atual e
 * disponível; divergência abre pendência; nenhuma aprovação de gestor; com
 * demurrage, nada encerra sem o arquivo real; sem demurrage, encerra sem minuta.
 */

const url = testDatabaseUrl();
const cfg = { hoje: HOJE };

interface Ctx { pool: Pool; b: Base; mem: ArmazenamentoMemoria; app: AppArquivos; ms: MicrosoftFalsa; ana: Navegador }

async function comCtx(fn: (x: Ctx) => Promise<void>): Promise<void> {
  const pool = testPool();
  const ms = new MicrosoftFalsa();
  const mem = new ArmazenamentoMemoria();
  let app: AppArquivos | null = null;
  try {
    const b = await base(pool);
    app = await subirAppArquivos(pool, ms, mem);
    const ana = await logar(app, ms, b.ana);
    await fn({ pool, b, mem, app, ms, ana });
  } finally {
    await app?.fechar();
    await pool.end();
  }
}

const docRow = (pool: Pool, id: string) => pool.query(`SELECT * FROM documentos_armazenados WHERE id = $1`, [id]).then((r) => r.rows[0]);
const minutasDo = (pool: Pool, containerId: string) =>
  pool.query(`SELECT id, estado_minuta, versao, substituida_por_id FROM minutas WHERE container_id = $1 ORDER BY criado_em, id`, [containerId]).then((r) => r.rows);
const corpo = (numero: string, data: string, documentoId: string) => ({ numeroInformado: numero, dataInformada: data, documento: { documentoId } });

/* ================================================================== *
 * 20 — Substituição cria novas versões e preserva o histórico.
 * ================================================================== */

test('A#20: substituição — nova minuta com novo arquivo cria versão 2; o documento da versão 1 vira SUBSTITUIDO, continua baixável e nada é apagado; cadeia coerente nos dois lados', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, mem, ana }) => {
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-20', comDemurrage: false });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    const conteudoA = pdf('v1');
    const conteudoB = pdf('v2');
    const docA = await uploadCompleto(ana, c.containers[0].id, conteudoA);
    const m1 = await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', docA));
    assert.equal(m1.status, 201, JSON.stringify(m1.body));
    assert.equal(m1.body.estado, 'RECEBIDA', 'sem devolução no tracking: aguarda');
    const docB = await uploadCompleto(ana, c.containers[0].id, conteudoB);
    const m2 = await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', docB));
    assert.equal(m2.status, 201);
    assert.equal(m2.body.versao, 2);
    assert.deepEqual(m2.body.substituidas, [m1.body.minutaId]);

    const a = await docRow(pool, docA);
    const bb = await docRow(pool, docB);
    assert.deepEqual([a.estado, a.minuta_id, a.versao, a.substituido_por_id], ['SUBSTITUIDO', m1.body.minutaId, 1, docB]);
    assert.deepEqual([bb.estado, bb.minuta_id, bb.versao, bb.substitui_id], ['DISPONIVEL', m2.body.minutaId, 2, docA]);
    assert.deepEqual((await minutasDo(pool, c.containers[0].id)).map((m: any) => [m.versao, m.estado_minuta, m.substituida_por_id]),
      [[1, 'SUBSTITUIDA', m2.body.minutaId], [2, 'RECEBIDA', null]]);
    const dA = await baixar(ana, docA);
    assert.equal(dA.status, 200, 'a versão substituída continua recuperável');
    assert.ok(dA.bytes.equals(conteudoA));
    assert.ok(mem.objetos.has(a.chave_objeto) && mem.objetos.has(bb.chave_objeto));
    assert.equal(mem.apagadas.length, 0, 'substituir nunca apaga');
    const v = await ana.json(`${DOCS}/containers/${c.containers[0].id}/versoes`);
    assert.deepEqual(v.body.documentos.map((d: any) => [d.versao, d.estado, d.substituidoPorDocumentoId, d.substituiDocumentoId]),
      [[1, 'SUBSTITUIDO', docB, null], [2, 'DISPONIVEL', null, docA]]);
    const ev = (await pool.query(`SELECT documento_id, tipo FROM documentos_armazenados_eventos WHERE tipo IN ('VINCULADO_MINUTA', 'SUBSTITUIDO') ORDER BY criado_em, id`)).rows;
    // (eventos da mesma transação têm o mesmo instante: compara como conjunto)
    assert.deepEqual(ev.map((e: any) => `${e.documento_id}:${e.tipo}`).sort(), [`${docA}:VINCULADO_MINUTA`, `${docA}:SUBSTITUIDO`, `${docB}:VINCULADO_MINUTA`].sort());
    // O banco recusa desfazer o histórico.
    await assert.rejects(pool.query(`UPDATE documentos_armazenados SET estado = 'DISPONIVEL', substituido_por_id = NULL, substituido_em = NULL WHERE id = $1`, [docA]));
    await assert.rejects(pool.query(`UPDATE documentos_armazenados SET minuta_id = NULL, versao = NULL, vinculado_em = NULL WHERE id = $1`, [docB]));
    await assert.rejects(pool.query(`DELETE FROM documentos_armazenados WHERE id = $1`, [docA]));
    await assert.rejects(pool.query(`DELETE FROM documentos WHERE id = $1`, [docA]));
  });
});

/* ================================================================== *
 * 21 / 25 — só a versão ATUAL e DISPONÍVEL encerra; com ela, encerra sozinho.
 * ================================================================== */

test('A#21/A#25: encerramento usa só a versão atual — com o arquivo da versão 2 ausente o processo NÃO encerra (a versão 1 disponível não conta); arquivo de volta → encerra automaticamente', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, mem, ana }) => {
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-21', comDemurrage: true });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    // Responsabilidade ainda em análise: as duas versões são registradas sem encerrar.
    const docA = await uploadCompleto(ana, c.containers[0].id, pdf('a'));
    assert.equal((await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', docA))).body.estado, 'ACEITA');
    const docB = await uploadCompleto(ana, c.containers[0].id, pdf('b'));
    assert.equal((await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', docB))).body.estado, 'ACEITA');
    // O arquivo da versão ATUAL some do armazenamento; a reconciliação confirma.
    const chaveB = (await docRow(pool, docB)).chave_objeto;
    const guardado = mem.objetos.get(chaveB)!;
    mem.objetos.delete(chaveB);
    const deps = { pool, armazenamento: mem, naoVinculadoExpiraMs: 30 * 86_400_000 };
    assert.equal((await corrigir(deps, { operador: 'Equipe', motivo: 'teste' })).ausentesMarcados, 1);
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.containers[0].id, hoje: HOJE });

    const svc = new ClosingService(pool);
    const r = await svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg });
    assert.deepEqual(r, { resultado: 'bloqueado', motivo: 'minuta_sem_arquivo_disponivel', containerId: c.containers[0].id });
    assert.equal((await docRow(pool, docA)).estado, 'SUBSTITUIDO', 'a versão anterior disponível nunca substitui a atual no encerramento');
    const p = await statusProcesso(pool, c.processoId);
    assert.deepEqual([p.apuracao_status, p.encerramento_bloqueio], ['OPEN', 'minuta_sem_arquivo_disponivel']);

    // A25: arquivo de volta (restabelecido) + minuta coerente → encerra AUTOMATICAMENTE.
    mem.objetos.set(chaveB, guardado);
    assert.equal((await corrigir(deps, { operador: 'Equipe', motivo: 'restaurado' })).restabelecidos, 1);
    assert.deepEqual(await svc.avaliarEncerramentoAutomatico({ processoId: c.processoId, config: cfg }), { resultado: 'finalizado' });
    const f = (await pool.query(`SELECT origem, realizado_por FROM fechamentos WHERE processo_id = $1`, [c.processoId])).rows;
    assert.deepEqual(f, [{ origem: 'automatico', realizado_por: null }]);
  });
});

test('A#25: processo com demurrage encerra AUTOMATICAMENTE quando o arquivo está disponível e a minuta é coerente — o próprio registro do analista dispara', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, ana }) => {
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-25', comDemurrage: true });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.containers[0].id, hoje: HOJE });
    const doc = await uploadCompleto(ana, c.containers[0].id);
    const m = await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', doc));
    assert.equal(m.status, 201);
    assert.equal(m.body.estado, 'ACEITA');
    assert.equal(m.body.encerramento.resultado, 'finalizado', JSON.stringify(m.body.encerramento));
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL');
  });
});

/* ================================================================== *
 * 22 — Divergência abre pendência.
 * ================================================================== */

test('A#22: minuta com arquivo, mas data divergente do tracking → DIVERGENTE + pendência operacional; não encerra; substituta coerente com novo arquivo resolve a pendência e encerra', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, ana }) => {
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-22', comDemurrage: true });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-08' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.containers[0].id, hoje: HOJE });
    const doc1 = await uploadCompleto(ana, c.containers[0].id);
    const m1 = await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', doc1));
    assert.equal(m1.body.estado, 'DIVERGENTE');
    assert.equal(m1.body.pendencia, 'minuta_divergente_tracking');
    assert.equal(m1.body.encerramento.resultado, 'bloqueado');
    assert.equal(m1.body.encerramento.motivo, 'divergencia_pendente');
    const pend = (await pool.query(`SELECT tipo, estado FROM demurrage_pendencias WHERE container_id = $1 AND tipo LIKE 'minuta_%'`, [c.containers[0].id])).rows;
    assert.deepEqual(pend, [{ tipo: 'minuta_divergente_tracking', estado: 'aberta' }]);

    const doc2 = await uploadCompleto(ana, c.containers[0].id, pdf('corrigida'));
    const m2 = await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-08', doc2));
    assert.equal(m2.body.estado, 'ACEITA');
    assert.equal(m2.body.encerramento.resultado, 'finalizado');
    const pend2 = (await pool.query(`SELECT estado FROM demurrage_pendencias WHERE container_id = $1 AND tipo = 'minuta_divergente_tracking'`, [c.containers[0].id])).rows;
    assert.deepEqual(pend2, [{ estado: 'resolvida' }]);
    assert.equal((await docRow(pool, doc1)).estado, 'SUBSTITUIDO');
  });
});

/* ================================================================== *
 * 23 — Nenhuma aprovação de gestor.
 * ================================================================== */

test('A#23: nenhuma aprovação de gestor — o arquivo e a minuta do ANALISTA encerram o processo sem ação de MANAGER/ADMIN sobre a minuta; a rota de validação continua removida (410)', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, app, ms, ana }) => {
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-23', comDemurrage: true });
    await atribuirResponsavelDeTeste(pool, c.processoId, b.ana.membershipId);
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: c.containers[0].id, hoje: HOJE });
    const doc = await uploadCompleto(ana, c.containers[0].id);
    const m = await registrarMinutaHttp(ana, c.containers[0].id, corpo(c.containers[0].numero, '2026-09-10', doc));
    assert.equal(m.body.encerramento.resultado, 'finalizado');
    const minuta = (await pool.query(`SELECT validada_por, data_validada, estado_minuta FROM minutas WHERE id = $1`, [m.body.minutaId])).rows[0];
    assert.deepEqual(minuta, { validada_por: null, data_validada: null, estado_minuta: 'ACEITA' });
    const ev = (await pool.query(`SELECT DISTINCT ator_membership_id FROM documentos_armazenados_eventos WHERE documento_id = $1`, [doc])).rows;
    assert.deepEqual(ev.map((e: any) => e.ator_membership_id), [b.ana.membershipId], 'todo passo do arquivo foi do próprio analista');
    const gil = await logar(app, ms, b.gil);
    const v = await gil.json(`${ACOES}/minutas/${m.body.minutaId}/validar`, { method: 'POST', body: { decisao: 'VALIDADA' }, headers: { 'idempotency-key': randomUUID() } });
    assert.equal(v.status, 410);
  });
});

/* ================================================================== *
 * 24 — Com demurrage, nada encerra sem arquivo.
 * ================================================================== */

test('A#24: processo com demurrage NÃO encerra sem arquivo — minuta legada só por referência (ACEITA) e aprovação humana antiga (VALIDADA) bloqueiam com minuta_sem_arquivo_disponivel, também no acionamento administrativo; processo FINAL legado não é tocado', { skip: !url }, async () => {
  await comCtx(async ({ pool, b, ana }) => {
    const svc = new ClosingService(pool);
    // (a) legado B: minuta técnica ACEITA com referência externa (sem arquivo).
    const cb = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-24B', comDemurrage: true });
    await atribuirResponsavelDeTeste(pool, cb.processoId, b.ana.membershipId);
    await devolverPeloTracking(pool, cb, { [cb.containers[0].numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: cb.containers[0].id, hoje: HOJE });
    await inserirMinutaLegadaReferencia(pool, { containerId: cb.containers[0].id, numero: cb.containers[0].numero, data: '2026-09-10', membershipId: b.ana.membershipId, usuarioId: b.ana.usuarioId });
    assert.deepEqual(await svc.avaliarEncerramentoAutomatico({ processoId: cb.processoId, config: cfg }),
      { resultado: 'bloqueado', motivo: 'minuta_sem_arquivo_disponivel', containerId: cb.containers[0].id });
    assert.deepEqual(await svc.finalizarProcesso({ processoId: cb.processoId, membershipId: b.gil.membershipId, justificativa: 'tentativa', config: cfg }),
      { ok: false, motivo: 'minuta_sem_arquivo_disponivel' }, 'o acionamento administrativo usa o MESMO gate');

    // (b) legado A: aprovação humana antiga (VALIDADA), sem arquivo nem referência.
    const ca = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-24A', comDemurrage: true });
    await devolverPeloTracking(pool, ca, { [ca.containers[0].numero]: '2026-09-10' });
    await confirmarResponsabilidadeClienteIntegral(pool, { containerId: ca.containers[0].id, hoje: HOJE });
    await pool.query(`INSERT INTO minutas (container_id, estado_minuta, data_informada, data_validada) VALUES ($1, 'VALIDADA', '2026-09-10', '2026-09-10')`, [ca.containers[0].id]);
    assert.deepEqual(await svc.avaliarEncerramentoAutomatico({ processoId: ca.processoId, config: cfg }),
      { resultado: 'bloqueado', motivo: 'minuta_sem_arquivo_disponivel', containerId: ca.containers[0].id });

    // Saída: o analista envia o arquivo real e registra nova versão → encerra.
    const doc = await uploadCompleto(ana, cb.containers[0].id);
    const m = await registrarMinutaHttp(ana, cb.containers[0].id, corpo(cb.containers[0].numero, '2026-09-10', doc));
    assert.equal(m.body.encerramento.resultado, 'finalizado');

    // (c) processo FINAL legado: nada muda (fechamento histórico preservado).
    const fechamentosAntes = (await pool.query(`SELECT id, processo_id, origem FROM fechamentos ORDER BY id`)).rows;
    assert.deepEqual(await svc.avaliarEncerramentoAutomatico({ processoId: cb.processoId, config: cfg }), { resultado: 'ja_final' });
    assert.deepEqual((await pool.query(`SELECT id, processo_id, origem FROM fechamentos ORDER BY id`)).rows, fechamentosAntes);
  });
});

/* ================================================================== *
 * 26 — Sem demurrage, encerra sem minuta (e sem arquivo).
 * ================================================================== */

test('A#26: contêiner sem demurrage encerra sem minuta — e uma minuta legada sem arquivo nele não bloqueia (o arquivo só é exigido como evidência de cobrança)', { skip: !url }, async () => {
  await comCtx(async ({ pool, b }) => {
    const c = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-26', comDemurrage: false });
    await devolverPeloTracking(pool, c, { [c.containers[0].numero]: '2026-09-10' });
    assert.equal((await statusProcesso(pool, c.processoId)).apuracao_status, 'FINAL', 'devolvido no prazo → FINAL sem minuta nem arquivo');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM minutas`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM documentos_armazenados`)).rows[0].n, 0);

    const c2 = await cenario(pool, { orgId: b.orgX, numeroProcesso: 'IM-ARQ-26B', comDemurrage: false });
    await inserirMinutaLegadaReferencia(pool, { containerId: c2.containers[0].id, numero: c2.containers[0].numero, data: '2026-09-10', membershipId: b.ana.membershipId, usuarioId: b.ana.usuarioId });
    await devolverPeloTracking(pool, c2, { [c2.containers[0].numero]: '2026-09-10' });
    assert.equal((await statusProcesso(pool, c2.processoId)).apuracao_status, 'FINAL');
  });
});
