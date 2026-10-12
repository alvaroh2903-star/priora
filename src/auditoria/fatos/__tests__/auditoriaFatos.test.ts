import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { FullEmailMessage, LogisticsSummary } from '../../../graph/graphService';
import { DocTipo, DocumentoExtraido } from '../../playbooks';
import { resolverContextoOperacional } from '../../../operacional/contexto';
import { FatosDuraveisDeps } from '../../../operacional/requisicao';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { servir } from '../../../operacional/__tests__/http';
import { criarAuditoriaRouter } from '../../../routes/auditoriaRoutes';
import { ExtracaoParaPersistir, mblUtilizavel, persistirExtracoesAuditoria } from '../extracoes';
import { vinculoDoProcesso } from '../vinculos';

const url = testDatabaseUrl();

async function preparar(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

/* ------------------------- caixa postal e OCR falsos (sem Graph, sem IA) ------------------------- */

interface Anexo { id: string; nome: string; ocr: Partial<DocumentoExtraido> | 'ERRO' }
interface Email { id: string; assunto: string; corpo: string; recebido: string; anexos: Anexo[] }

function caixaPostal(emails: Email[]) {
  const resumo = (e: Email): LogisticsSummary => ({
    id: e.id, conversationId: `c-${e.id}`, subject: e.assunto, bodyPreview: e.corpo.slice(0, 40),
    body: { contentType: 'text', content: e.corpo }, from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } },
    receivedDateTime: e.recebido, isRead: true, hasAttachments: e.anexos.length > 0, webLink: '',
  });
  const completo = (e: Email): FullEmailMessage => ({
    id: e.id, internetMessageId: `<${e.id}@agente.com>`, conversationId: `c-${e.id}`, subject: e.assunto,
    from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: e.recebido,
    body: { contentType: 'text', content: e.corpo }, bodyPreview: e.corpo.slice(0, 40), hasAttachments: e.anexos.length > 0,
    attachments: e.anexos.map((a) => ({ id: a.id, name: a.nome, contentType: 'application/pdf', size: 10, isInline: false })),
  });
  const ocr = new Map(emails.flatMap((e) => e.anexos.map((a) => [`${e.id}/${a.id}`, a.ocr] as const)));
  const chamadasOcr: string[] = [];
  return {
    chamadasOcr,
    graph: {
      searchLogisticsMessages: async () => emails.map(resumo),
      listRecentSummaries: async () => [],
      getFullMessage: async (_t: string, id: string) => completo(emails.find((e) => e.id === id)!),
    },
    extrair: async (_t: string, messageId: string, attachmentId: string, nome: string, tipo: DocTipo): Promise<DocumentoExtraido> => {
      chamadasOcr.push(`${messageId}/${attachmentId}`);
      const r = ocr.get(`${messageId}/${attachmentId}`);
      if (r === 'ERRO') throw new Error('OCR indisponível');
      return {
        nome, tipo, tipoDetectado: null, conhecimento: null, portoOrigem: 'SHANGHAI', portoDestino: 'ITAJAI', navio: 'MSC X',
        shipper: null, consignee: null, notify: null, freteValor: null, freteMoeda: null, thcValor: null, cliente: null,
        containers: [], legivel: true, ...r,
      };
    },
  };
}

const PRE_ALERTA: Email = {
  id: 'pa1', assunto: 'Pre-alert IM2151-026', corpo: 'Dear, please find attached MBL and HBL.', recebido: '2026-09-01T08:00:00Z',
  anexos: [
    { id: 'a-mbl', nome: 'MBL.pdf', ocr: { tipoDetectado: 'MBL', conhecimento: 'MEDU1234567' } },
    { id: 'a-hbl', nome: 'HBL.pdf', ocr: { tipoDetectado: 'HBL', conhecimento: 'SHYY26073818' } },
  ],
};

/** `escrita`: o pool das gravações (pode simular o banco fora); o contexto é resolvido no pool real. */
function fatosDeps(escrita: () => Pool, contexto: Pool, c: Cenario, ligado = true): FatosDuraveisDeps {
  return {
    habilitado: () => ligado,
    pool: escrita,
    contexto: (req) => resolverContextoOperacional(contexto, {
      caixaHomeAccountId: c.homeCaixa,
      pessoa: req.session?.homeAccountId ? { homeAccountId: req.session.homeAccountId } : null,
    }),
  };
}

async function routerAuditoria(c: Cenario, emails: Email[], opcoes: {
  pool: () => Pool; contexto: Pool; ligado?: boolean; sessao?: string; persistencias?: Promise<unknown>[];
}) {
  const cx = caixaPostal(emails);
  const persistencias = opcoes.persistencias ?? [];
  const router = criarAuditoriaRouter({
    auth: (_req, _res, next) => next(),
    graph: cx.graph as any,
    extrair: cx.extrair,
    resumir: async () => ({ resumo: 'ok' } as any),
    iaConfigurada: () => true,
    modelo: () => 'modelo-teste',
    fatos: fatosDeps(opcoes.pool, opcoes.contexto, c, opcoes.ligado ?? true),
    aoPersistir: (p) => { persistencias.push(p); },
  });
  const srv = await servir(router, () => ({ homeAccountId: opcoes.sessao ?? c.homePessoa }));
  return { ...srv, cx, persistencias, concluir: async () => Promise.all(persistencias.splice(0)) };
}

const PERSISTIDAS = `SELECT count(*) n FROM auditoria_extracoes`;
const VINCULOS = `SELECT count(*) n FROM processo_master_vinculos`;

function poolQuebrado(): Pool {
  const falha = async () => { throw new Error('banco fora (simulado)'); };
  return { connect: falha, query: falha } as unknown as Pool;
}

test('S2-mín — fatos da Auditoria', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await preparar(pool);

    await t.test('cache miss: OCR uma vez por candidato; tudo persistido; processo exato IM2151-026; Master; vínculo; HBL só evidência', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'miss-a');
      const srv = await routerAuditoria(a, [PRE_ALERTA], { pool: () => pool, contexto: pool });
      try {
        // O agrupamento da Auditoria (apresentação) ainda junta IM2151-026 sob IM2151: rota por base, como antes.
        const r = await srv.chamar('GET', '/IM2151/auditoria');
        assert.equal(r.status, 200);
        assert.equal(r.body.semDocumentos, false);
        await srv.concluir();
        assert.deepEqual(srv.cx.chamadasOcr.sort(), ['pa1/a-hbl', 'pa1/a-mbl']);
      } finally {
        await srv.fechar();
      }
      const { rows: ext } = await pool.query(
        `SELECT attachment_id, tipo_por_nome, tipo_detectado, legivel, conhecimento, referencias_processo_brutas, associacao,
                internet_message_id, remetente, mensagem_recebida_em, extrator, extrator_versao, modelo, acionado_por_membership_id, caixa_id
           FROM auditoria_extracoes ORDER BY attachment_id`);
      assert.equal(ext.length, 2);
      for (const e of ext) {
        assert.deepEqual(e.referencias_processo_brutas, ['IM2151-026'], 'referência bruta inteira, nunca IM2151');
        assert.deepEqual([e.associacao, e.internet_message_id, e.remetente, e.extrator, e.extrator_versao, e.modelo],
          ['CITADA', '<pa1@agente.com>', 'agente@agente.com', 'auditoria.docExtractor', '1', 'modelo-teste']);
        assert.equal(new Date(e.mensagem_recebida_em).toISOString(), '2026-09-01T08:00:00.000Z');
        assert.deepEqual([e.acionado_por_membership_id, e.caixa_id], [a.membershipPessoa, a.caixaId], 'pessoa e caixa separadas');
      }
      assert.deepEqual(ext.map((e) => [e.attachment_id, e.tipo_por_nome, e.tipo_detectado, e.conhecimento]),
        [['a-hbl', 'HBL', 'HBL', 'SHYY26073818'], ['a-mbl', 'MBL', 'MBL', 'MEDU1234567']]);

      const { rows: procs } = await pool.query(`SELECT id, numero_processo FROM processos`);
      assert.deepEqual(procs.map((p) => p.numero_processo), ['IM2151-026'], 'IM2151 (base) não foi criado');
      const { rows: refs } = await pool.query(`SELECT mbl_original, armador_codigo FROM master_referencias`);
      assert.deepEqual(refs, [{ mbl_original: 'MEDU1234567', armador_codigo: null }], 'MBL original preservado; armador não inventado');
      const { rows: vs } = await pool.query(
        `SELECT v.processo_ref_bruta, v.processo_via, v.mbl_bruto, v.observado_em, v.vinculado_em, e.attachment_id
           FROM processo_master_vinculos v JOIN auditoria_extracoes e ON e.id = v.extracao_id`);
      assert.equal(vs.length, 1, 'só o MBL vincula; o HBL não');
      assert.deepEqual([vs[0].processo_ref_bruta, vs[0].mbl_bruto, vs[0].attachment_id], ['IM2151-026', 'MEDU1234567', 'a-mbl']);
      assert.ok(['CRIADO', 'CODIGO'].includes(vs[0].processo_via));

      const sit = await vinculoDoProcesso(pool, a.orgId, procs[0].id);
      assert.equal(sit.tipo, 'VINCULADO');
      if (sit.tipo === 'VINCULADO') {
        assert.equal(sit.vinculadoEm.getTime(), new Date(vs[0].vinculado_em).getTime(), 'vinculadoEm = quando a Priora estabeleceu o vínculo');
        assert.equal(sit.observadoEm?.toISOString(), '2026-09-01T08:00:00.000Z', 'data da fonte preservada separadamente');
        assert.ok(sit.vinculadoEm.getTime() > sit.observadoEm!.getTime() + 24 * 3_600_000, 'nunca retroage para a data do e-mail');
        assert.match(sit.evidencia.ref, /^auditoria_extracao:/);
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM identidade_pendencias`), 0);
    });

    await t.test('cache hit: OCR zero vezes; reenvio idempotente não duplica extração nem vínculo', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'hit-a');
      const srv = await routerAuditoria(a, [PRE_ALERTA], { pool: () => pool, contexto: pool });
      try {
        await srv.chamar('GET', '/IM2151/auditoria');
        await srv.concluir();
        const antes = [await contar(pool, PERSISTIDAS), await contar(pool, VINCULOS), await contar(pool, `SELECT count(*) n FROM processos`)];
        for (let i = 0; i < 3; i++) {
          const r = await srv.chamar('GET', '/IM2151/auditoria');
          assert.equal(r.status, 200);
        }
        const resultados = await srv.concluir();
        assert.equal(resultados.length, 3, 'o cache reenviou a extração à persistência a cada hit');
        assert.equal(srv.cx.chamadasOcr.length, 2, 'OCR só no primeiro acesso');
        assert.deepEqual([await contar(pool, PERSISTIDAS), await contar(pool, VINCULOS), await contar(pool, `SELECT count(*) n FROM processos`)], antes);
        assert.deepEqual(antes, [2, 1, 1]);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('banco fora no 1º acesso: a resposta sai igual; o hit seguinte grava sem OCR — uma extração por anexo, no máximo um vínculo', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'falha-a');
      let fora = true;
      const srv = await routerAuditoria(a, [PRE_ALERTA], { pool: () => (fora ? poolQuebrado() : pool), contexto: pool });
      try {
        const r1 = await srv.chamar('GET', '/IM2151/auditoria');
        assert.equal(r1.status, 200, 'persistência não é pré-requisito da resposta');
        const [p1] = await srv.concluir();
        assert.deepEqual(p1, { persistido: false, motivo: 'ERRO' }, 'a gravação falhou (banco fora)');
        assert.equal(await contar(pool, PERSISTIDAS), 0);
        fora = false;
        const r2 = await srv.chamar('GET', '/IM2151/auditoria');
        assert.deepEqual(r2.body, r1.body, 'mesmo resultado, vindo do cache');
        await srv.concluir();
        await srv.chamar('GET', '/IM2151/auditoria');
        await srv.concluir();
        assert.equal(srv.cx.chamadasOcr.length, 2, 'nenhum OCR para recuperar a persistência');
        assert.equal(await contar(pool, PERSISTIDAS), 2);
        assert.equal(await contar(pool, VINCULOS), 1);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('falha na identidade/vínculo depois da extração gravada: nada pendurado; o hit seguinte completa sem OCR', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'falha-vinc-a');
      await pool.query(`CREATE FUNCTION teste_falha_vinculo() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha simulada no vínculo'; END $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER teste_falha BEFORE INSERT ON processo_master_vinculos FOR EACH ROW EXECUTE FUNCTION teste_falha_vinculo()`);
      const srv = await routerAuditoria(a, [PRE_ALERTA], { pool: () => pool, contexto: pool });
      try {
        await srv.chamar('GET', '/IM2151/auditoria');
        const [p1] = await srv.concluir();
        const falhas = (p1 as any).resultados.filter((x: any) => 'falhaVinculacao' in x);
        assert.equal(falhas.length, 1, 'só a extração do MBL tentou vincular');
        assert.equal(await contar(pool, PERSISTIDAS), 2, 'as extrações ficaram gravadas');
        assert.equal(await contar(pool, VINCULOS), 0);
        assert.equal(await contar(pool, `SELECT count(*) n FROM masters`), 0, 'o Master criado na transação que falhou foi desfeito');
        assert.equal(await contar(pool, `SELECT count(*) n FROM processo_referencias WHERE evidencia_ref LIKE 'auditoria_extracao:%'
          AND evidencia_ref = (SELECT 'auditoria_extracao:' || id FROM auditoria_extracoes WHERE attachment_id = 'a-mbl')`), 0);
        await pool.query(`DROP TRIGGER teste_falha ON processo_master_vinculos; DROP FUNCTION teste_falha_vinculo();`);
        await srv.chamar('GET', '/IM2151/auditoria');
        await srv.concluir();
        assert.equal(srv.cx.chamadasOcr.length, 2);
        assert.deepEqual([await contar(pool, PERSISTIDAS), await contar(pool, VINCULOS), await contar(pool, `SELECT count(*) n FROM masters`)], [2, 1, 1]);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('referência mais longa não suportada (IM2151-2611): nunca vira IM2151; pendência do S6, nenhum vínculo', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'longa-a');
      const email: Email = { ...PRE_ALERTA, id: 'pa-longa', assunto: 'Pre-alert IM2151-2611', anexos: [PRE_ALERTA.anexos[0]] };
      const srv = await routerAuditoria(a, [email], { pool: () => pool, contexto: pool });
      try {
        assert.equal((await srv.chamar('GET', '/IM2151/auditoria')).status, 200);
        await srv.concluir();
      } finally {
        await srv.fechar();
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM processos`), 0, 'nenhum processo criado (IM2151 menos ainda)');
      const { rows } = await pool.query(`SELECT motivo, chave, referencia_original FROM identidade_pendencias`);
      assert.deepEqual(rows, [{ motivo: 'REFERENCIA_INCOMPLETA', chave: 'IM2151-2611', referencia_original: 'IM2151-2611' }]);
      assert.equal(await contar(pool, VINCULOS), 0);
      assert.equal(await contar(pool, `SELECT count(*) n FROM masters`), 1, 'o MBL tem identidade própria');
    });

    await t.test('referência cruzada e e-mail com vários processos: extração preservada, nenhum processo nem vínculo', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'cruzada-a');
      const emails: Email[] = [
        { id: 'elo', assunto: 'Booking IM4001', corpo: 'Process IM4001 container MSCU1234567', recebido: '2026-09-02T08:00:00Z', anexos: [] },
        { id: 'cruz', assunto: 'Documents', corpo: 'Container MSCU1234567, see MBL attached.', recebido: '2026-09-03T08:00:00Z',
          anexos: [{ id: 'a1', nome: 'MBL-cruz.pdf', ocr: { tipoDetectado: 'MBL', conhecimento: 'MEDU7654321' } }] },
        { id: 'multi', assunto: 'Docs IM3001 IM3002', corpo: 'MBL attached for IM3001 and IM3002', recebido: '2026-09-04T08:00:00Z',
          anexos: [{ id: 'a2', nome: 'MBL-multi.pdf', ocr: { tipoDetectado: 'MBL', conhecimento: 'MEDU1111111' } }] },
      ];
      const srv = await routerAuditoria(a, emails, { pool: () => pool, contexto: pool });
      try {
        for (const p of ['IM4001', 'IM3001', 'IM3002']) {
          assert.equal((await srv.chamar('GET', `/${p}/auditoria`)).status, 200, p);
        }
        await srv.concluir();
      } finally {
        await srv.fechar();
      }
      const { rows } = await pool.query(`SELECT attachment_id, associacao, referencias_processo_brutas FROM auditoria_extracoes ORDER BY attachment_id`);
      assert.deepEqual(rows.map((r) => [r.attachment_id, r.associacao, r.referencias_processo_brutas]),
        [['a1', 'REFERENCIA_CRUZADA', []], ['a2', 'CITADA', ['IM3001', 'IM3002']]]);
      assert.equal(await contar(pool, `SELECT count(*) n FROM processos`), 0, 'inferência e multiprocesso não criam processo');
      assert.equal(await contar(pool, VINCULOS), 0, 'nenhum vínculo inferido');
    });

    await t.test('falha/timeout do extrator não vira extração; MBL ilegível ou inválido não dá Master', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'ocr-a');
      const email: Email = {
        id: 'pa2', assunto: 'Pre-alert IM7001-26', corpo: 'docs', recebido: '2026-09-05T08:00:00Z',
        anexos: [
          { id: 'x-mbl', nome: 'MBL.pdf', ocr: { tipoDetectado: 'MBL', conhecimento: 'N/A' } },
          { id: 'x-hbl', nome: 'HBL.pdf', ocr: 'ERRO' },
          { id: 'x-ce', nome: 'CE Master.pdf', ocr: { tipoDetectado: 'MBL', conhecimento: 'MEDU9999999', legivel: false } },
        ],
      };
      const srv = await routerAuditoria(a, [email], { pool: () => pool, contexto: pool });
      try {
        await srv.chamar('GET', '/IM7001-26/auditoria');
        await srv.concluir();
      } finally {
        await srv.fechar();
      }
      const { rows } = await pool.query(`SELECT attachment_id, legivel FROM auditoria_extracoes ORDER BY attachment_id`);
      assert.deepEqual(rows.map((r) => [r.attachment_id, r.legivel]), [['x-ce', false], ['x-mbl', true]], 'o anexo cujo OCR falhou não vira extração');
      assert.equal(await contar(pool, `SELECT count(*) n FROM masters`), 0, '"N/A" e MBL ilegível não dão Master');
      assert.deepEqual((await pool.query(`SELECT numero_processo FROM processos`)).rows, [{ numero_processo: 'IM7001-26' }],
        'o MBL legível citando um processo é evidência documental do processo');
      assert.equal(mblUtilizavel('MEDU 123-4567'), 'MEDU 123-4567');
      assert.equal(mblUtilizavel('TBA'), null);
      assert.equal(mblUtilizavel(null), null);
    });

    await t.test('vínculo: mesma evidência idempotente; outra evidência do mesmo Master é preservada; dois Masters → CONFLITO', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'conflito-a');
      const item = (msg: string, anexo: string, mbl: string, recebido: string): ExtracaoParaPersistir => ({
        proveniencia: {
          messageId: msg, internetMessageId: null, attachmentId: anexo, attachmentNome: `${anexo}.pdf`, contentType: 'application/pdf',
          remetente: 'agente@agente.com', recebidaEm: new Date(recebido), referenciasBrutas: ['IM5001'], associacao: 'CITADA',
        },
        resultado: { tipoPorNome: 'MBL', tipoDetectado: 'MBL', legivel: true, conhecimento: mbl },
        modelo: 'modelo-teste', extraidaEm: new Date(recebido),
      });
      const primeiro = await persistirExtracoesAuditoria(pool, a.ctx, [item('m1', 'a1', 'MEDU1234567', '2026-09-01T00:00:00Z')]);
      const repetido = await persistirExtracoesAuditoria(pool, a.ctx, [item('m1', 'a1', 'MEDU1234567', '2026-09-01T00:00:00Z')]);
      assert.equal((repetido[0] as any).nova, false);
      assert.equal((repetido[0] as any).vinculacao.vinculo.novo, false);
      await persistirExtracoesAuditoria(pool, a.ctx, [item('m2', 'a2', 'MEDU 1234567', '2026-09-02T00:00:00Z')]);
      const processoId = (primeiro[0] as any).vinculacao.processo.resultado.processoId;
      const um = await vinculoDoProcesso(pool, a.orgId, processoId);
      assert.equal(um.tipo, 'VINCULADO');
      if (um.tipo === 'VINCULADO') {
        assert.equal(um.evidencias.length, 2, 'a segunda evidência do mesmo Master é preservada');
        assert.equal(um.evidencia.ref, `auditoria_extracao:${(primeiro[0] as any).extracaoId}`, 'vinculadoEm/evidência = a primeira');
      }
      await persistirExtracoesAuditoria(pool, a.ctx, [item('m3', 'a3', 'MEDU7777777', '2026-09-03T00:00:00Z')]);
      const conflito = await vinculoDoProcesso(pool, a.orgId, processoId);
      assert.equal(conflito.tipo, 'CONFLITO', 'dois Masters válidos → nenhum vínculo publicado');
      if (conflito.tipo === 'CONFLITO') assert.equal(conflito.masters.length, 2);
      assert.equal(await contar(pool, VINCULOS), 3, 'toda evidência preservada');
    });

    await t.test('append-only, isolamento por organização e Master nunca a partir de tracking_targets', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'iso-a');
      const b = await cenario(pool, 'iso-b');
      const srvA = await routerAuditoria(a, [PRE_ALERTA], { pool: () => pool, contexto: pool });
      const srvB = await routerAuditoria(b, [PRE_ALERTA], { pool: () => pool, contexto: pool });
      try {
        await srvA.chamar('GET', '/IM2151/auditoria');
        await srvB.chamar('GET', '/IM2151/auditoria');
        await srvA.concluir();
        await srvB.concluir();
      } finally {
        await srvA.fechar();
        await srvB.fechar();
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM auditoria_extracoes WHERE organization_id = $1`, [a.orgId]), 2);
      assert.equal(await contar(pool, `SELECT count(*) n FROM auditoria_extracoes WHERE organization_id = $1`, [b.orgId]), 2);
      assert.equal(await contar(pool, `SELECT count(*) n FROM processos`), 2, 'um IM2151-026 por organização');
      const extB = (await pool.query(`SELECT id FROM auditoria_extracoes WHERE organization_id = $1 LIMIT 1`, [b.orgId])).rows[0].id;
      const { rows: [v] } = await pool.query(`SELECT processo_id, master_id FROM processo_master_vinculos WHERE organization_id = $1`, [a.orgId]);
      await assert.rejects(pool.query(
        `INSERT INTO processo_master_vinculos (organization_id, processo_id, master_id, extracao_id, processo_ref_bruta, processo_via, mbl_bruto, fonte)
         VALUES ($1, $2, $3, $4, 'IM2151-026', 'CODIGO', 'MEDU1234567', 'auditoria_extracao')`, [a.orgId, v.processo_id, v.master_id, extB]),
      /violates foreign key/, 'vínculo não aponta para evidência de outra organização');
      for (const tabela of ['auditoria_extracoes', 'processo_master_vinculos']) {
        await assert.rejects(pool.query(`UPDATE ${tabela} SET organization_id = organization_id`), /append-only/);
        await assert.rejects(pool.query(`DELETE FROM ${tabela}`), /append-only/);
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM tracking_targets`), 0);
      for (const f of ['extracoes.ts', 'vinculos.ts']) {
        assert.equal(/tracking_targets/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), false, `${f} não lê tracking_targets`);
      }
    });

    await t.test('chave desligada ou runtime atual (sessão = caixa): nada persistido, banco intocado, resposta igual', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'off-a');
      let usos = 0;
      const desligado = await routerAuditoria(a, [PRE_ALERTA], { pool: () => { usos++; return pool; }, contexto: pool, ligado: false });
      const mesmaConta = await routerAuditoria(a, [PRE_ALERTA], { pool: () => pool, contexto: pool, sessao: a.homeCaixa });
      try {
        const r1 = await desligado.chamar('GET', '/IM2151/auditoria');
        const [p1] = await desligado.concluir();
        assert.deepEqual(p1, { persistido: false, motivo: 'FATOS_DURAVEIS_DESLIGADOS' });
        assert.equal(usos, 0, 'chave desligada: o banco não é usado');
        const r2 = await mesmaConta.chamar('GET', '/IM2151/auditoria');
        const [p2] = await mesmaConta.concluir();
        assert.deepEqual(p2, { persistido: false, motivo: 'ATOR_INDISTINGUIVEL_DA_CAIXA' });
        assert.deepEqual(r2.body, r1.body);
      } finally {
        await desligado.fechar();
        await mesmaConta.fechar();
      }
      assert.equal(await contar(pool, PERSISTIDAS), 0);
      assert.equal(await contar(pool, `SELECT count(*) n FROM processos`), 0);
    });
  } finally {
    await pool.end();
  }
});
