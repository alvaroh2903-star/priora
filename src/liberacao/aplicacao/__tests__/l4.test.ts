import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, contar } from '../../../operacional/__tests__/cenario';
import { servir } from '../../../operacional/__tests__/http';
import { resetCourierStore } from '../../../couriers/courierStore';
import { fatosCourierDoProcesso } from '../../../couriers/fatos/courierFatos';
import { criarAuditoriaRouter } from '../../../routes/auditoriaRoutes';
import { ProjecaoLiberacao, canonico, obterLiberacaoDoProcesso, recalcularLiberacaoProcesso } from '..';
import {
  cenarioConfirmado, conferir, envelope, eventos, fatosDeps, gatilhos, idDoProcesso, msg, preparar, processo, projecao, semInvencao,
  vincular,
} from './apoio';

/**
 * L4 — Vertical 1: fatos de Courier e Auditoria com propagação, provados com
 * dados PERSISTIDOS pelos donos (S1, S2, S6) e lidos pela projeção L2. Sem
 * Graph, sem OCR real, sem app.
 */

const url = testDatabaseUrl();

const resolucao = (p: ProjecaoLiberacao) => p.avaliacao.master.resolucao;
const via = (p: ProjecaoLiberacao) => (resolucao(p).tipo === 'RESOLVIDO' ? (resolucao(p) as { via: string }).via : null);
const operacional = (p: ProjecaoLiberacao) => canonico([p.avaliacao.etapa, p.avaliacao.bloqueador, p.avaliacao.proximaAcao]);

/** Auditoria real (rota) com caixa postal e OCR falsos que contam as chamadas. */
async function auditoria(pool: Pool, c: Cenario, ref: string, mbl: string) {
  const ocr: string[] = [];
  const persistencias: Promise<unknown>[] = [];
  const router = criarAuditoriaRouter({
    auth: (_req, _res, next) => next(),
    graph: {
      searchLogisticsMessages: async () => [{ ...msg('pa', `Pre-alert ${ref}`, 'MBL attached'), hasAttachments: true }],
      listRecentSummaries: async () => [],
      getFullMessage: async () => ({
        id: 'pa', internetMessageId: '<pa@agente.com>', conversationId: 'c-pa', subject: `Pre-alert ${ref}`,
        from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: '2026-09-01T08:00:00Z',
        body: { contentType: 'text', content: 'MBL attached' }, bodyPreview: 'MBL', hasAttachments: true,
        attachments: [{ id: 'a-mbl', name: 'MBL.pdf', contentType: 'application/pdf', size: 10, isInline: false }],
      }),
    } as any,
    extrair: async (_t: string, m: string, a: string, nome: string, tipo: any) => {
      ocr.push(`${m}/${a}`);
      return {
        nome, tipo, tipoDetectado: 'MBL', conhecimento: mbl, portoOrigem: null, portoDestino: null, navio: null, shipper: null,
        consignee: null, notify: null, freteValor: null, freteMoeda: null, thcValor: null, cliente: null, containers: [], legivel: true,
      } as any;
    },
    resumir: async () => ({ resumo: 'ok' } as any),
    iaConfigurada: () => true,
    modelo: () => 'modelo-teste',
    fatos: fatosDeps(pool, c),
    aoPersistir: (p) => { persistencias.push(p); },
  });
  const srv = await servir(router, () => ({ homeAccountId: c.homePessoa }));
  return { ...srv, ocr, concluir: () => Promise.all(persistencias.splice(0)) };
}

test('L4 — fatos de Courier e Auditoria com propagação (dados persistidos)', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await preparar(pool);

    await t.test('1. MBL conferido como recebido no Courier resolve o Master físico', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-mbl');
      const p = await processo(pool, a, 'IM8001-26');
      await envelope(pool, a, 'DHL 8001', 'Recebido');
      const mbl = await conferir(pool, a, 'DHL 8001', 'IM8001-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      const { rows: [linha] } = await pool.query(`SELECT associacao, valor, autor_membership_id FROM courier_fatos WHERE id = $1`, [mbl]);
      assert.deepEqual(linha, { associacao: 'CITADA', valor: 'RECEBIDO', autor_membership_id: a.membershipPessoa }, 'fato persistido pelo S1');
      const pr = await projecao(pool, a, p);
      assert.equal(via(pr), 'CONFERENCIA_DO_PROPRIO_PROCESSO');
      assert.equal(resolucao(pr).tipo === 'RESOLVIDO' && (resolucao(pr) as any).evidencia.ref, `courier_fato:${mbl}`);
      assert.deepEqual(pr.avaliacao.progresso.map((m) => m.marco), ['MASTER_RESOLVIDO']);
      assert.deepEqual(pr.avaliacao.divergencias, []);
      semInvencao(pr);
    });

    await t.test('2. HBL original recebido e conferido resolve a House pelo caminho B (sem foto do cliente)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-hbl');
      const p = await processo(pool, a, 'IM8002-26');
      await envelope(pool, a, 'DHL 8002', 'Recebido');
      const hbl = await conferir(pool, a, 'DHL 8002', 'IM8002-26', 'HBL_ORIGINAL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, hbl);
      const { house, progresso } = (await projecao(pool, a, p)).avaliacao;
      assert.equal(house.tipo, 'RESOLVIDO');
      if (house.tipo === 'RESOLVIDO') {
        assert.equal(house.caminho, 'B_ORIGINAL_RECEBIDO_PELA_ROCKET');
        assert.equal(house.evidencia.ref, `courier_fato:${hbl}`);
      }
      assert.deepEqual(progresso.map((m) => m.marco), ['HOUSE_RESOLVIDO']);
    });

    await t.test('3. vínculo Processo↔Master propaga o fato do Master; House e etapa seguem individuais (cenário 11)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-propaga');
      for (const [ref, msgId] of [['IM8003-26', 'p1'], ['IM8004-26', 'p2'], ['IM8005-26', 'p3']]) {
        await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, ref, 'MEDU8003001', { messageId: msgId }));
      }
      const [p1, p2, p3] = [await idDoProcesso(pool, a, 'IM8003-26'), await idDoProcesso(pool, a, 'IM8004-26'), await idDoProcesso(pool, a, 'IM8005-26')];
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8004', 'IM8004-26', 'HBL_ORIGINAL', 'RECEBIDO'));
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8003', 'IM8003-26', 'MBL', 'RECEBIDO'));
      const [r1, r2, r3] = [await projecao(pool, a, p1), await projecao(pool, a, p2), await projecao(pool, a, p3)];
      assert.deepEqual([via(r1), via(r2), via(r3)], ['CONFERENCIA_DO_PROPRIO_PROCESSO', 'MASTER_VINCULADO', 'MASTER_VINCULADO']);
      assert.deepEqual([r2.avaliacao.house.tipo, r3.avaliacao.house.tipo], ['RESOLVIDO', 'NAO_DETERMINAVEL'], 'House é de cada processo');
      assert.notEqual(operacional(r2), operacional(r3), 'etapa individual');
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (processo_id) processo_id, gatilho FROM liberacao_avaliacao_eventos
          WHERE processo_id = ANY($1::uuid[]) ORDER BY processo_id, sequencia DESC`, [[p2, p3]]);
      assert.deepEqual(rows.map((r) => r.gatilho), ['MASTER_COMPARTILHADO', 'MASTER_COMPARTILHADO']);
    });

    await t.test('4. vínculo tardio herda o fato vigente do Master com o instante original, sem culpa retroativa', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-tardio');
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM8006-26', 'MEDU8006001', { messageId: 'cedo' }));
      const p1 = await idDoProcesso(pool, a, 'IM8006-26');
      const mbl = await conferir(pool, a, 'DHL 8006', 'IM8006-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      // Vinculado hoje a partir de um e-mail antigo.
      await gatilhos(pool).extracoesPersistidas(a.orgId,
        await vincular(pool, a, 'IM8007-26', 'MEDU8006001', { messageId: 'antigo', recebidaEm: '2026-01-05T00:00:00Z' }));
      const p2 = await idDoProcesso(pool, a, 'IM8007-26');
      const { rows: [v] } = await pool.query(`SELECT observado_em, vinculado_em FROM processo_master_vinculos WHERE processo_id = $1`, [p2]);
      const { rows: [c] } = await pool.query(`SELECT registrado_em FROM courier_fatos WHERE id = $1`, [mbl]);
      const pr = await projecao(pool, a, p2);
      const res = resolucao(pr);
      assert.equal(via(pr), 'MASTER_VINCULADO');
      if (res.tipo === 'RESOLVIDO') {
        assert.equal(res.resolvidoEm, new Date(c.registrado_em).toISOString(), 'instante original da ação');
        assert.equal(res.vinculoTardio?.acaoEm, new Date(c.registrado_em).toISOString());
        assert.equal(res.vinculoTardio?.vinculadoEm, new Date(v.vinculado_em).toISOString(), 'quando a Priora vinculou');
        assert.notEqual(res.vinculoTardio?.vinculadoEm, new Date(v.observado_em).toISOString(), 'nunca a data antiga do documento');
        assert.deepEqual(res.vinculoTardio?.processosVinculadosNaAcao, [p1]);
      }
      assert.notEqual(pr.avaliacao.bloqueador.tipo, 'CONHECIDO', 'sem culpa retroativa');
      assert.ok(!JSON.stringify(pr.avaliacao).includes('OVERRIDE'), 'sem override retroativo');
    });

    await t.test('5. Courier indisponível depois da confirmação não apaga o fato; sem observação = não confirmável (cenário 12)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-fonte');
      const p = await processo(pool, a, 'IM8008-26');
      const q = await processo(pool, a, 'IM8009-26');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8008', 'IM8008-26', 'MBL', 'RECEBIDO'));
      await recalcularLiberacaoProcesso(pool, a.orgId, q);
      const antes = await projecao(pool, a, p);
      await pool.query(`UPDATE email_caixas SET token_estado = 'indisponivel', token_verificado_em = now() WHERE id = $1`, [a.caixaId]);
      for (const id of [p, q]) await recalcularLiberacaoProcesso(pool, a.orgId, id);
      const [pp, pq] = [await projecao(pool, a, p), await projecao(pool, a, q)];
      assert.equal(resolucao(pp).tipo, 'RESOLVIDO', 'fato confirmado permanece');
      assert.equal((resolucao(pp) as any).resolvidoEm, (resolucao(antes) as any).resolvidoEm, 'mesmo instante da confirmação');
      assert.equal(pp.avaliacao.master.fonteCourier.disponivel, false, 'só a disponibilidade mudou');
      assert.deepEqual(resolucao(pq), {
        tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'FONTE_INDISPONIVEL', indisponivelDesde: (resolucao(pq) as any).indisponivelDesde,
      });
      for (const pr of [pp, pq]) {
        assert.notEqual(pr.avaliacao.bloqueador.tipo, 'CONHECIDO', 'nunca "não recebido"');
        semInvencao(pr);
      }
    });

    await t.test('6. evidência válida contrária ao Recebido abre divergência e não sobrescreve o fato oficial (cap. 22, N-14, N-16)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-diverg');
      const p = await processo(pool, a, 'IM8010-26');
      await envelope(pool, a, 'DHL 8010', 'Recebido');
      const oficial = await conferir(pool, a, 'DHL 8010', 'IM8010-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, oficial);
      const antes = await projecao(pool, a, p);
      assert.equal(await eventos(pool, p), 1);

      // A mesma linha (envelope, MBL, processo) marcada como ausente, por uma linha sem proveniência oficial.
      const contraria = await conferir(pool, a, 'DHL 8010', 'IM8010-26', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, contraria);
      const s1 = await fatosCourierDoProcesso(pool, a.orgId, p);
      assert.deepEqual([s1.mbl?.valor, s1.mbl?.evidencia.ref], ['RECEBIDO', `courier_fato:${oficial}`], 'o S1 mantém o oficial');
      const pr = await projecao(pool, a, p);
      assert.equal(via(pr), 'CONFERENCIA_DO_PROPRIO_PROCESSO', 'o Master continua resolvido');
      assert.equal((resolucao(pr) as any).evidencia.ref, `courier_fato:${oficial}`);
      assert.equal(operacional(pr), operacional(antes), 'nenhuma saída operacional muda');
      assert.equal(pr.avaliacao.divergencias.length, 1);
      const [d] = pr.avaliacao.divergencias;
      assert.deepEqual([d.documento, d.oficial?.valor, d.oficial?.evidencia.ref], ['MBL', 'RECEBIDO', `courier_fato:${oficial}`]);
      assert.deepEqual([d.divergencia.estado, d.divergencia.valorDivergente, d.divergencia.evidencia.ref],
        ['ABERTA', 'AUSENTE_NA_CONFERENCIA', `courier_fato:${contraria}`]);
      assert.equal(await eventos(pool, p), 2, 'abrir a divergência é mudança material: um evento');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos WHERE id = ANY($1::uuid[])`, [[oficial, contraria]]), 2, 'as duas evidências preservadas');

      // N-16(a): reconfirmar o mesmo valor oficial não resolve; nova evidência igual não abre outra.
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8010', 'IM8010-26', 'MBL', 'RECEBIDO'));
      await gatilhos(pool).conferenciaRegistrada(a.orgId,
        await conferir(pool, a, 'DHL 8010', 'IM8010-26', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'NAO_VERIFICADA'));
      let atual = await projecao(pool, a, p);
      assert.deepEqual(atual.avaliacao.divergencias.map((x) => x.divergencia.estado), ['ABERTA'], 'a mesma divergência continua aberta');
      assert.equal((resolucao(atual) as any).resolvidoEm, (resolucao(pr) as any).resolvidoEm, 'o fato vale desde a primeira confirmação');
      assert.equal(await eventos(pool, p), 2, 'reconfirmação e evidência repetida não geram evento');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'SEM_MUDANCA_MATERIAL');

      // Só uma nova observação da fonte de verdade (marca oficial) muda o fato e resolve a divergência.
      await gatilhos(pool).conferenciaRegistrada(a.orgId,
        await conferir(pool, a, 'DHL 8010', 'IM8010-26', 'MBL', 'AUSENTE_NA_CONFERENCIA'));
      atual = await projecao(pool, a, p);
      assert.equal(resolucao(atual).tipo, 'NAO_RESOLVIDO', 'mudança oficial (N-16b)');
      assert.deepEqual(atual.avaliacao.divergencias.map((x) => x.divergencia.estado), ['RESOLVIDA_PELA_FONTE_DE_VERDADE']);
      assert.equal(await eventos(pool, p), 3);

      // Toda marca não oficial (ambígua, Clara, não verificada) é evidência: diverge, nunca sobrescreve.
      for (const [i, assoc] of (['AMBIGUA', 'CLARA', 'NAO_VERIFICADA'] as const).entries()) {
        const ref = `IM801${i + 1}-26`;
        const q = await processo(pool, a, ref);
        const of = await conferir(pool, a, `DHL 801${i + 1}`, ref, 'HBL_ORIGINAL', 'RECEBIDO');
        await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, `DHL 801${i + 1}`, ref, 'HBL_ORIGINAL', 'AUSENTE_NA_CONFERENCIA', assoc));
        const pq = await projecao(pool, a, q);
        assert.equal(pq.avaliacao.house.tipo === 'RESOLVIDO' && pq.avaliacao.house.evidencia.ref, `courier_fato:${of}`, `${assoc}: House mantida`);
        assert.deepEqual(pq.avaliacao.divergencias.map((x) => [x.documento, x.divergencia.estado, x.divergencia.valorDivergente]),
          [['HBL_ORIGINAL', 'ABERTA', 'AUSENTE_NA_CONFERENCIA']]);
      }

      // Sem fato oficial no mesmo envelope não há contra o que divergir; desmarcar sem proveniência não retrai.
      const r = await processo(pool, a, 'IM8014-26');
      const rOficial = await conferir(pool, a, 'DHL 8014', 'IM8014-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 8015', 'IM8014-26', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8014', 'IM8014-26', 'MBL', 'DESMARCADO', 'NAO_VERIFICADA'));
      const pr2 = await projecao(pool, a, r);
      assert.equal((resolucao(pr2) as any).evidencia?.ref, `courier_fato:${rOficial}`, 'retração não oficial não apaga o Recebido');
      assert.deepEqual(pr2.avaliacao.divergencias, [], 'ausência em OUTRO envelope não contradiz o recebido');
    });

    await t.test('7. troca de conta, de caixa ou de identidade não apaga fatos duráveis', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-conta');
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM8016-26', 'MEDU8016001'));
      const p = await idDoProcesso(pool, a, 'IM8016-26');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8016', 'IM8016-26', 'MBL', 'RECEBIDO'));
      const antes = await projecao(pool, a, p);
      const fatos = await contar(pool, `SELECT count(*) n FROM courier_fatos`);

      resetCourierStore(); // o que a troca/desconexão da conta Microsoft faz com o JSON legado
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'SEM_MUDANCA_MATERIAL');

      // A caixa monitorada é trocada (a antiga removida, outra vinculada e confirmada).
      await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [a.caixaId]);
      const { rows: [nova] } = await pool.query(
        `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id, token_estado, token_verificado_em)
         VALUES ($1, 'home-nova-caixa-l4', 'nova@l4.com', $2, 'disponivel', now()) RETURNING id`, [a.orgId, a.membershipCaixa]);
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const depois = await projecao(pool, a, p);
      assert.equal(depois.impressaoMaterial, antes.impressaoMaterial, 'mesma avaliação material');
      assert.deepEqual(depois.fontes.caixaIds, [nova.id]);
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), fatos, 'nada durável apagado');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos WHERE caixa_id = $1`, [a.caixaId]), fatos, 'fatos da caixa antiga continuam');

      // Identidade: conferência feita antes de o processo existir (pendência no S6) passa a valer quando ele é criado.
      const b: Cenario = { ...a, caixaId: nova.id, ctx: { ...a.ctx, caixaId: nova.id } }; // escritas novas já pela caixa nova
      await conferir(pool, b, 'DHL 8017', 'IM8017-26', 'MBL', 'RECEBIDO');
      assert.equal(await contar(pool, `SELECT count(*) n FROM identidade_pendencias`), 1);
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, b, 'IM8017-26', 'MSCU8017001'));
      const criado = await idDoProcesso(pool, a, 'IM8017-26');
      assert.equal(via(await projecao(pool, a, criado)), 'CONFERENCIA_DO_PROPRIO_PROCESSO', 'fato anterior preservado e agora usado');
    });

    await t.test('8–9. reprocessar Auditoria e Courier é idempotente; a Liberação faz zero chamadas de OCR', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenarioConfirmado(pool, 'l4-idem');
      const srv = await auditoria(pool, a, 'IM8018-26', 'MEDU8018001');
      try {
        for (let i = 0; i < 3; i++) assert.equal((await srv.chamar('GET', '/IM8018/auditoria')).status, 200);
        await srv.concluir();
        assert.deepEqual(srv.ocr, ['pa/a-mbl'], 'OCR uma vez, pela Auditoria (cache depois)');
      } finally {
        await srv.fechar();
      }
      const p = await idDoProcesso(pool, a, 'IM8018-26');
      assert.deepEqual([
        await contar(pool, `SELECT count(*) n FROM auditoria_extracoes`), await contar(pool, `SELECT count(*) n FROM processo_master_vinculos`),
        await eventos(pool, p),
      ], [1, 1, 1], 'Auditoria repetida: uma extração, um vínculo, um evento');

      await envelope(pool, a, 'DHL 8018', 'Recebido');
      const mbl = await conferir(pool, a, 'DHL 8018', 'IM8018-26', 'MBL', 'RECEBIDO');
      for (let i = 0; i < 3; i++) await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      const { registrarConferenciaCourier } = await import('../../../couriers/fatos/courierFatos');
      const repetida = await registrarConferenciaCourier(pool, a.ctx, {
        trackingBruto: 'DHL 8018', processoRef: 'IM8018-26', documento: 'MBL', valor: 'RECEBIDO',
        proveniencia: { associacao: 'CITADA', brutas: ['IM8018-26'], emitidaEm: new Date() },
      });
      assert.equal(repetida.status, 'SEM_MUDANCA', 'Courier repetido: o S1 não grava');
      assert.equal(await eventos(pool, p), 2, 'só a conferência nova gerou evento');

      // Liberação lendo, recalculando e reconstruindo: nenhuma chamada de OCR a mais.
      for (let i = 0; i < 3; i++) await recalcularLiberacaoProcesso(pool, a.orgId, p);
      await obterLiberacaoDoProcesso(pool, a.orgId, p);
      assert.deepEqual(srv.ocr, ['pa/a-mbl']);
      assert.equal(await eventos(pool, p), 2);
      // E o código da Liberação não importa extração, OCR, IA nem Graph.
      const raiz = path.join(__dirname, '..', '..');
      const arquivos = ['dominio', 'aplicacao'].flatMap((d) => fs.readdirSync(path.join(raiz, d)).filter((f) => f.endsWith('.ts')).map((f) => path.join(raiz, d, f)));
      for (const arq of arquivos) {
        const imports = fs.readFileSync(arq, 'utf8').split('\n').filter((l) => /^\s*import\b|require\(/.test(l)).join('\n');
        assert.ok(!/docExtractor|extracao|\/ai\/|gemini|graph|msal|extrair/i.test(imports), `${path.basename(arq)} não importa OCR/IA/Graph`);
      }
    });

    await t.test('10. nenhuma inferência por processBase: IM8019 e IM8019-26 são processos distintos', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-base');
      const base = await processo(pool, a, 'IM8019');
      const sufixo = await processo(pool, a, 'IM8019-26');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 8019', 'IM8019', 'MBL', 'RECEBIDO'));
      await recalcularLiberacaoProcesso(pool, a.orgId, sufixo);
      assert.equal(via(await projecao(pool, a, base)), 'CONFERENCIA_DO_PROPRIO_PROCESSO');
      assert.deepEqual(resolucao(await projecao(pool, a, sufixo)), { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' },
        'a base nunca alimenta o código com sufixo');
      // Vínculo documental de IM8019-27 não toca IM8019 (nem cria por base).
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM8019-27', 'MEDU8019001'));
      const { rows } = await pool.query(`SELECT numero_processo FROM processos WHERE organization_id = $1 ORDER BY 1`, [a.orgId]);
      assert.deepEqual(rows.map((r) => r.numero_processo), ['IM8019', 'IM8019-26', 'IM8019-27']);
      assert.equal(await contar(pool, `SELECT count(*) n FROM processo_master_vinculos WHERE processo_id = ANY($1::uuid[])`, [[base, sufixo]]), 0);
      // Nenhum caminho de leitura da L4 usa processBase.
      const dirs = ['liberacao/dominio', 'liberacao/aplicacao', 'couriers/fatos', 'auditoria/fatos'].map((d) => path.join(__dirname, '..', '..', '..', d));
      for (const dir of dirs) {
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
          assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('processBase'), `${f} não usa processBase`);
        }
      }
    });
  } finally {
    await pool.end();
  }
});
