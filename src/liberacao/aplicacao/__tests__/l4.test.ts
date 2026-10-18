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
import { ValorConferencia, fatosCourierDoProcesso, registrarConferenciaCourier } from '../../../couriers/fatos/courierFatos';
import { AssociacaoVerificada } from '../../../couriers/fatos/linha';
import { compararInstantes } from '../../dominio';
import { invalidarEvidenciaDeReferencia, registrarAliasProcesso } from '../../../identidade';
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

const resolucao = (p: ProjecaoLiberacao) => p.avaliacao.master.l1a.resolucao;
const via = (p: ProjecaoLiberacao) => (resolucao(p).tipo === 'RESOLVIDO' ? (resolucao(p) as { via: string }).via : null);
const operacional = (p: ProjecaoLiberacao) => canonico([p.avaliacao.etapa, p.avaliacao.bloqueador, p.avaliacao.proximaAcao]);

/** Alias comprovado no S6 (o único caminho de identidade por outra referência). */
async function aliasDe(pool: Pool, c: Cenario, processoId: string, referencia: string): Promise<string> {
  const r = await registrarAliasProcesso(pool, c.orgId, {
    referencia, processoId, evidencia: { fonte: 'teste', evidenciaRef: `alias:${referencia}`, observadoEm: new Date('2026-09-02T00:00:00Z') },
    registradoPorMembershipId: c.membershipPessoa,
  });
  assert.equal(r.status, 'ALIAS_REGISTRADO');
  return (r as { aliasId: string }).aliasId;
}

const referenciasDoAssunto = async (pool: Pool, c: Cenario, processoId: string) =>
  (await fatosCourierDoProcesso(pool, c.orgId, processoId)).assuntos.map((a) => [a.trackingChave, a.documento, a.linhas.map((l) => l.processoRef)]);

/** Escrita pelo S1 com o resultado completo (status, valor anterior, identidade). */
const marcar = (pool: Pool, c: Cenario, tracking: string, ref: string, valor: ValorConferencia, associacao: AssociacaoVerificada = 'CITADA') =>
  registrarConferenciaCourier(pool, c.ctx, {
    trackingBruto: tracking, processoRef: ref, documento: 'MBL', valor,
    proveniencia: { associacao, brutas: associacao === 'CITADA' ? [ref] : [], emitidaEm: new Date() },
  });

/**
 * Marca gravada com um instante EXATO do banco (microssegundos), para provar a
 * ordem dentro do mesmo milissegundo — a escrita normal usa now() e não permite
 * escolher o instante. Mesmas restrições da tabela; nada é alterado depois.
 */
async function gravarNoInstante(pool: Pool, c: Cenario, l: {
  tracking: string; ref: string; valor: ValorConferencia; associacao: AssociacaoVerificada; sequencia: number; em: string;
}): Promise<string> {
  const { rows: [r] } = await pool.query(
    `INSERT INTO courier_fatos
       (organization_id, caixa_id, tracking_bruto, tracking_chave, tipo, documento, processo_ref_bruta, processo_ref, associacao,
        valor, sequencia, autor_membership_id, registrado_em)
     VALUES ($1, $2, $3, $3, 'CONFERENCIA_DOCUMENTO', 'MBL', $4, $4, $5, $6, $7, $8, $9::timestamptz) RETURNING id`,
    [c.orgId, c.caixaId, l.tracking, l.ref, l.associacao, l.valor, l.sequencia, c.membershipPessoa, l.em]);
  return r.id;
}

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
      const { house: { l1a: house }, progresso } = (await projecao(pool, a, p)).avaliacao;
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
      assert.deepEqual([r2.avaliacao.house.l1a.tipo, r3.avaliacao.house.l1a.tipo], ['RESOLVIDO', 'NAO_DETERMINAVEL'], 'House é de cada processo');
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
      assert.equal(pp.avaliacao.master.l1a.fonteCourier.disponivel, false, 'só a disponibilidade mudou');
      assert.deepEqual(resolucao(pq), {
        tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'FONTE_INDISPONIVEL', indisponivelDesde: (resolucao(pq) as any).indisponivelDesde,
      });
      // Nunca "não recebido": P tem o Master resolvido pela própria conferência, mas sem vínculo publicado no S2 — a L1b
      // aponta só isso (sem responsável, ação nem classe); Q fica sem bloqueio conhecido.
      assert.equal(pp.avaliacao.bloqueador.tipo, 'CONHECIDO');
      if (pp.avaliacao.bloqueador.tipo === 'CONHECIDO') {
        const i = pp.avaliacao.bloqueador.item;
        assert.deepEqual([i.motivo, i.responsavel, i.acao, i.classe], ['VINCULO_COM_MASTER_NAO_PUBLICADO', null, null, null]);
      }
      assert.notEqual(pq.avaliacao.bloqueador.tipo, 'CONHECIDO');
      for (const pr of [pp, pq]) semInvencao(pr);
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
        assert.equal(pq.avaliacao.house.l1a.tipo === 'RESOLVIDO' && pq.avaliacao.house.l1a.evidencia.ref, `courier_fato:${of}`, `${assoc}: House mantida`);
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

    await t.test('11. sujeito = Processo: oficial RECEBIDO pelo código + marca não oficial contrária por alias → uma divergência, oficial mantido', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-alias-diverg');
      const p = await processo(pool, a, 'IM9001-26');
      await aliasDe(pool, a, p, 'IM9001-026');
      await envelope(pool, a, 'DHL 9001', 'Recebido');
      const oficial = await conferir(pool, a, 'DHL 9001', 'IM9001-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, oficial);
      const contraria = await conferir(pool, a, 'DHL 9001', 'IM9001-026', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, contraria);
      assert.deepEqual(await referenciasDoAssunto(pool, a, p), [['DHL9001', 'MBL', ['IM9001-26', 'IM9001-026']]], 'um só assunto');
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p)).mbl?.evidencia.ref, `courier_fato:${oficial}`);
      const pr = await projecao(pool, a, p);
      assert.equal((resolucao(pr) as any).evidencia.ref, `courier_fato:${oficial}`, 'o oficial continua RECEBIDO');
      assert.deepEqual(pr.avaliacao.divergencias.map((d) => [d.documento, d.oficial?.valor, d.divergencia.estado, d.divergencia.evidencia.ref]),
        [['MBL', 'RECEBIDO', 'ABERTA', `courier_fato:${contraria}`]]);
      const { rows: [ev] } = await pool.query(`SELECT processo_ref, associacao FROM courier_fatos WHERE id = $1`, [contraria]);
      assert.deepEqual(ev, { processo_ref: 'IM9001-026', associacao: 'INFERIDA' }, 'a evidência guarda a referência usada; nenhuma promoção');
    });

    await t.test('12. sujeito = Processo: CITADA AUSENTE por alias depois de RECEBIDO pelo código → mudança oficial (N-16), sem autodivergência', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-alias-oficial');
      const p = await processo(pool, a, 'IM9002-26');
      await aliasDe(pool, a, p, 'IM9002-026');
      const recebido = await conferir(pool, a, 'DHL 9002', 'IM9002-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, recebido);
      const ausente = await conferir(pool, a, 'DHL 9002', 'IM9002-026', 'MBL', 'AUSENTE_NA_CONFERENCIA');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, ausente);
      const s1 = await fatosCourierDoProcesso(pool, a.orgId, p);
      assert.deepEqual([s1.mbl?.valor, s1.mbl?.evidencia.ref], ['AUSENTE_NA_CONFERENCIA', `courier_fato:${ausente}`], 'oficial passa a AUSENTE');
      const pr = await projecao(pool, a, p);
      assert.notEqual(resolucao(pr).tipo, 'RESOLVIDO');
      assert.equal(pr.avaliacao.master.l1a.fisicoDoProcesso.mbl?.valor, 'AUSENTE_NA_CONFERENCIA');
      assert.deepEqual(pr.avaliacao.divergencias, [], 'mudança da própria fonte não é divergência com o próprio histórico');
      assert.equal(await eventos(pool, p), 2, 'uma mudança oficial: um evento');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos WHERE id = $1 AND valor = 'RECEBIDO'`, [recebido]), 1,
        'o RECEBIDO anterior segue no histórico imutável');
    });

    await t.test('13. sujeito = Processo: reconfirmar o mesmo valor por alias avança o frescor, não o vigenteDesde', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-alias-reconf');
      const p = await processo(pool, a, 'IM9003-26');
      await aliasDe(pool, a, p, 'IM9003-026');
      const primeiro = await conferir(pool, a, 'DHL 9003', 'IM9003-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, primeiro);
      // Uma marca contrária não oficial entra no meio; a reconfirmação oficial vem depois, pelo alias.
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9003', 'IM9003-026', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA'));
      const antes = await projecao(pool, a, p);
      const reconf = await conferir(pool, a, 'DHL 9003', 'IM9003-026', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, reconf);
      const tempo = async (id: string) => new Date((await pool.query(`SELECT registrado_em FROM courier_fatos WHERE id = $1`, [id])).rows[0].registrado_em);
      const s1 = await fatosCourierDoProcesso(pool, a.orgId, p);
      assert.deepEqual([s1.mbl?.vigenteDesde.getTime(), s1.mbl?.confirmadoEm.getTime(), s1.mbl?.evidencia.ref],
        [(await tempo(primeiro)).getTime(), (await tempo(reconf)).getTime(), `courier_fato:${primeiro}`]);
      const depois = await projecao(pool, a, p);
      const r = resolucao(depois) as any;
      assert.equal(r.resolvidoEm, (resolucao(antes) as any).resolvidoEm, 'vigenteDesde não se move');
      assert.equal(r.ultimaConfirmacaoEm, (await tempo(reconf)).toISOString(), 'frescor avança');
      assert.deepEqual(depois.avaliacao.divergencias.map((d) => d.divergencia.estado), ['ABERTA'], 'reconfirmar não resolve (N-16a)');
      assert.equal(depois.impressaoMaterial, antes.impressaoMaterial);
      assert.equal(await eventos(pool, p), 2, 'reconfirmação não é mudança material');
    });

    await t.test('14. alias invalidado no S6 deixa de participar no recálculo; nenhuma linha de origem muda', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-alias-invalido');
      const p = await processo(pool, a, 'IM9004-26');
      const aliasId = await aliasDe(pool, a, p, 'IM9004-026');
      const recebido = await conferir(pool, a, 'DHL 9004', 'IM9004-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 9004', 'IM9004-026', 'MBL', 'AUSENTE_NA_CONFERENCIA');
      await conferir(pool, a, 'DHL 9004', 'IM9004-026', 'HBL_ORIGINAL', 'RECEBIDO', 'INFERIDA');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal((await projecao(pool, a, p)).avaliacao.master.l1a.fisicoDoProcesso.mbl?.valor, 'AUSENTE_NA_CONFERENCIA', 'pelo alias vigente');
      const origem = (await pool.query(`SELECT * FROM courier_fatos ORDER BY id`)).rows;

      await invalidarEvidenciaDeReferencia(pool, a.orgId, {
        referencia: { aliasId }, justificativa: 'o alias era de outro embarque', evidencia: { fonte: 'documento_original', evidenciaRef: 'prova-1' },
        membershipId: a.membershipPessoa,
      });
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(r.status, 'MUDANCA_MATERIAL');
      assert.deepEqual(await referenciasDoAssunto(pool, a, p), [['DHL9004', 'MBL', ['IM9004-26']]], 'só o código vigente participa');
      const pr = await projecao(pool, a, p);
      assert.equal((resolucao(pr) as any).evidencia?.ref, `courier_fato:${recebido}`, 'volta a valer o RECEBIDO do código');
      assert.equal(pr.avaliacao.house.l1a.tipo, 'NAO_DETERMINAVEL', 'a marca feita só pelo alias deixou de participar');
      assert.deepEqual(pr.avaliacao.divergencias, []);
      assert.deepEqual((await pool.query(`SELECT * FROM courier_fatos ORDER BY id`)).rows, origem, 'nenhuma linha do Courier mudou');
    });

    await t.test('15. referências de processos diferentes continuam completamente separadas', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-alias-separado');
      const p1 = await processo(pool, a, 'IM9005-26');
      const p2 = await processo(pool, a, 'IM9006-26');
      await aliasDe(pool, a, p2, 'IM9006-026');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9005', 'IM9005-26', 'MBL', 'RECEBIDO'));
      const antes = await projecao(pool, a, p1);
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9005', 'IM9006-026', 'MBL', 'AUSENTE_NA_CONFERENCIA'));
      await gatilhos(pool).conferenciaRegistrada(a.orgId,
        await conferir(pool, a, 'DHL 9005', 'IM9006-026', 'HBL_ORIGINAL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA'));
      assert.deepEqual(await referenciasDoAssunto(pool, a, p1), [['DHL9005', 'MBL', ['IM9005-26']]]);
      assert.deepEqual((await referenciasDoAssunto(pool, a, p2)).map((x) => x[2]), [['IM9006-026'], ['IM9006-026']]);
      assert.deepEqual(await projecao(pool, a, p1), antes, 'o mesmo envelope com outro processo não toca P1');
      const pr2 = await projecao(pool, a, p2);
      assert.equal(pr2.avaliacao.master.l1a.fisicoDoProcesso.mbl?.valor, 'AUSENTE_NA_CONFERENCIA');
      assert.deepEqual([antes.avaliacao.divergencias, pr2.avaliacao.divergencias], [[], []], 'nenhuma divergência cruzada entre processos');
    });

    await t.test('16. a referência bruta usada continua preservada na evidência e no histórico', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-alias-bruta');
      const p = await processo(pool, a, 'IM9008-26');
      await aliasDe(pool, a, p, 'IM9008-026');
      await conferir(pool, a, 'DHL 9008', 'IM9008-26', 'MBL', 'RECEBIDO');
      const r = await registrarConferenciaCourier(pool, a.ctx, {
        trackingBruto: 'DHL 9008', processoRef: 'IM 9008-026', documento: 'MBL', valor: 'AUSENTE_NA_CONFERENCIA',
        proveniencia: { associacao: 'CLARA', brutas: ['IM 9008-026'], emitidaEm: new Date() },
      });
      assert.equal(r.status, 'REGISTRADO');
      const contraria = (r as { fatoId: string }).fatoId;
      await gatilhos(pool).conferenciaRegistrada(a.orgId, contraria);
      const { rows: [linha] } = await pool.query(`SELECT processo_ref, processo_ref_bruta FROM courier_fatos WHERE id = $1`, [contraria]);
      assert.deepEqual(linha, { processo_ref: 'IM9008-026', processo_ref_bruta: 'IM 9008-026' });
      const [assunto] = (await fatosCourierDoProcesso(pool, a.orgId, p)).assuntos;
      assert.deepEqual(assunto.linhas.map((l) => [l.processoRef, l.associacao]), [['IM9008-26', 'CITADA'], ['IM9008-026', 'CLARA']]);
      assert.equal(assunto.processoId, p);
      const [d] = (await projecao(pool, a, p)).avaliacao.divergencias;
      assert.equal(d.divergencia.evidencia.ref, `courier_fato:${contraria}`, 'a evidência aponta a linha com a referência usada');
    });

    await t.test('17. escrita no assunto do Processo: desmarcar pelo alias retrai a marca oficial feita pelo código', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-w-desmarca');
      const p = await processo(pool, a, 'IM9201-26');
      await aliasDe(pool, a, p, 'IM9201-026');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, await conferir(pool, a, 'DHL 9201', 'IM9201-26', 'MBL', 'RECEBIDO'));
      const r = await marcar(pool, a, 'DHL 9201', 'IM9201-026', 'DESMARCADO');
      assert.equal(r.status, 'REGISTRADO', 'não é "nada a desmarcar" só porque a marca usou outra referência');
      assert.equal(r.status === 'REGISTRADO' && r.valorAnterior, 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, (r as { fatoId: string }).fatoId);
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p)).mbl, null, 'o assunto oficial foi retraído');
      assert.notEqual(resolucao(await projecao(pool, a, p)).tipo, 'RESOLVIDO');
      const { rows } = await pool.query(`SELECT processo_ref, valor, sequencia FROM courier_fatos ORDER BY registrado_em`);
      assert.deepEqual(rows.map((x) => [x.processo_ref, x.valor, x.sequencia]), [['IM9201-26', 'RECEBIDO', 1], ['IM9201-026', 'DESMARCADO', 1]],
        'a referência enviada é preservada; a sequência continua por referência');
    });

    await t.test('18. escrita no assunto do Processo: o mesmo valor pelo alias é idempotente; a promoção a oficial continua', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-w-idem');
      const p = await processo(pool, a, 'IM9202-26');
      await aliasDe(pool, a, p, 'IM9202-026');
      const oficial = await conferir(pool, a, 'DHL 9202', 'IM9202-26', 'MBL', 'RECEBIDO');
      assert.deepEqual(await marcar(pool, a, 'DHL 9202', 'IM9202-026', 'RECEBIDO'), { status: 'SEM_MUDANCA', fatoId: oficial, sequencia: 1 });
      assert.equal((await marcar(pool, a, 'DHL 9202', 'IM9202-026', 'RECEBIDO', 'INFERIDA')).status, 'SEM_MUDANCA');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 1);
      // Promoção: a mesma marca, antes não oficial pelo alias, vira linha nova quando chega oficial pelo código.
      const q = await processo(pool, a, 'IM9203-26');
      await aliasDe(pool, a, q, 'IM9203-026');
      assert.equal((await marcar(pool, a, 'DHL 9203', 'IM9203-026', 'RECEBIDO', 'INFERIDA')).status, 'REGISTRADO');
      const promovida = await marcar(pool, a, 'DHL 9203', 'IM9203-26', 'RECEBIDO');
      assert.equal(promovida.status, 'REGISTRADO');
      assert.equal((await marcar(pool, a, 'DHL 9203', 'IM9203-026', 'RECEBIDO', 'INFERIDA')).status, 'SEM_MUDANCA', 'nunca o contrário');
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, q)).mbl?.evidencia.ref, `courier_fato:${(promovida as { fatoId: string }).fatoId}`);
    });

    await t.test('19. escrita no assunto do Processo: mudança oficial pelo alias registra o valor anterior do assunto', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-w-anterior');
      const p = await processo(pool, a, 'IM9204-26');
      await aliasDe(pool, a, p, 'IM9204-026');
      await conferir(pool, a, 'DHL 9204', 'IM9204-26', 'MBL', 'RECEBIDO');
      const r = await marcar(pool, a, 'DHL 9204', 'IM9204-026', 'AUSENTE_NA_CONFERENCIA');
      assert.deepEqual([r.status, r.status === 'REGISTRADO' && r.valorAnterior, r.status === 'REGISTRADO' && r.identidade],
        ['REGISTRADO', 'RECEBIDO', { tipo: 'RESOLVIDA', processoId: p, via: 'ALIAS' }]);
      const { rows: [linha] } = await pool.query(`SELECT valor_anterior, processo_ref, sequencia FROM courier_fatos WHERE id = $1`,
        [(r as { fatoId: string }).fatoId]);
      assert.deepEqual(linha, { valor_anterior: 'RECEBIDO', processo_ref: 'IM9204-026', sequencia: 1 });
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p)).mbl?.valor, 'AUSENTE_NA_CONFERENCIA');
    });

    await t.test('20. escrita: alias invalidado no S6 deixa de participar do assunto do Processo', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-w-invalido');
      const p = await processo(pool, a, 'IM9205-26');
      const aliasId = await aliasDe(pool, a, p, 'IM9205-026');
      await conferir(pool, a, 'DHL 9205', 'IM9205-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 9205', 'IM9205-026', 'MBL', 'AUSENTE_NA_CONFERENCIA');
      assert.equal((await marcar(pool, a, 'DHL 9205', 'IM9205-26', 'AUSENTE_NA_CONFERENCIA')).status, 'SEM_MUDANCA', 'com o alias vigente: já é AUSENTE');
      await invalidarEvidenciaDeReferencia(pool, a.orgId, {
        referencia: { aliasId }, justificativa: 'o alias era de outro embarque', evidencia: { fonte: 'documento_original', evidenciaRef: 'prova-w' },
        membershipId: a.membershipPessoa,
      });
      const r = await marcar(pool, a, 'DHL 9205', 'IM9205-26', 'AUSENTE_NA_CONFERENCIA');
      assert.deepEqual([r.status, r.status === 'REGISTRADO' && r.valorAnterior], ['REGISTRADO', 'RECEBIDO'], 'sem o alias, o assunto era RECEBIDO');
      // A referência invalidada, sozinha, volta a ser só a referência exata: pendência, nunca processo criado.
      const pelaInvalidada = await marcar(pool, a, 'DHL 9205', 'IM9205-026', 'RECEBIDO');
      assert.equal(pelaInvalidada.status === 'REGISTRADO' && pelaInvalidada.identidade.tipo, 'PENDENTE');
      assert.equal(await contar(pool, `SELECT count(*) n FROM processos WHERE numero_processo = 'IM9205-026'`), 0);
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p)).mbl?.valor, 'AUSENTE_NA_CONFERENCIA');
    });

    await t.test('21. escritas concorrentes pelo código e pelo alias serializam na mesma trava do assunto', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-w-concorrencia');
      const p = await processo(pool, a, 'IM9206-26');
      await aliasDe(pool, a, p, 'IM9206-026');
      for (const valor of ['RECEBIDO', 'AUSENTE_NA_CONFERENCIA'] as const) {
        const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => marcar(pool, a, 'DHL 9206', i % 2 ? 'IM9206-026' : 'IM9206-26', valor)));
        assert.equal(rs.filter((r) => r.status === 'REGISTRADO').length, 1, `${valor}: uma única linha nova para o assunto`);
      }
      const { rows } = await pool.query(`SELECT valor, valor_anterior FROM courier_fatos ORDER BY registrado_em`);
      assert.deepEqual(rows.map((x) => [x.valor, x.valor_anterior]), [['RECEBIDO', null], ['AUSENTE_NA_CONFERENCIA', 'RECEBIDO']]);
    });

    await t.test('22. processos distintos no mesmo envelope continuam independentes na escrita', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-w-distintos');
      const p1 = await processo(pool, a, 'IM9207-26');
      const p2 = await processo(pool, a, 'IM9208-26');
      await aliasDe(pool, a, p2, 'IM9208-026');
      await conferir(pool, a, 'DHL 9207', 'IM9207-26', 'MBL', 'RECEBIDO');
      assert.deepEqual(await marcar(pool, a, 'DHL 9207', 'IM9208-026', 'DESMARCADO'), { status: 'SEM_MUDANCA', fatoId: null, sequencia: null },
        'nada de P2 a desmarcar');
      const r = await marcar(pool, a, 'DHL 9207', 'IM9208-26', 'RECEBIDO');
      assert.deepEqual([r.status, r.status === 'REGISTRADO' && r.valorAnterior], ['REGISTRADO', null], 'o RECEBIDO de P1 não conta para P2');
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p1)).mbl?.valor, 'RECEBIDO');
    });

    await t.test('23. instante exato: duas marcas oficiais no mesmo milissegundo seguem a ordem real dos microssegundos', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-us-ordem');
      const p = await processo(pool, a, 'IM9302-26');
      await aliasDe(pool, a, p, 'IM9302-026');
      // Gravadas fora de ordem; a referência que perderia no desempate é a mais antiga de fato.
      await gravarNoInstante(pool, a, { tracking: 'DHL9302', ref: 'IM9302-026', valor: 'RECEBIDO', associacao: 'CITADA', sequencia: 1, em: '2026-10-13 10:00:00.123700+00' });
      await gravarNoInstante(pool, a, { tracking: 'DHL9302', ref: 'IM9302-26', valor: 'AUSENTE_NA_CONFERENCIA', associacao: 'CITADA', sequencia: 1, em: '2026-10-13 10:00:00.123200+00' });
      const [assunto] = (await fatosCourierDoProcesso(pool, a.orgId, p)).assuntos;
      assert.deepEqual(assunto.linhas.map((l) => [l.instante, l.valor]),
        [['2026-10-13T10:00:00.123200Z', 'AUSENTE_NA_CONFERENCIA'], ['2026-10-13T10:00:00.123700Z', 'RECEBIDO']]);
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p)).mbl?.valor, 'RECEBIDO', 'o posterior real decide');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(resolucao(await projecao(pool, a, p)).tipo, 'RESOLVIDO');
      // E a escrita vê o mesmo assunto: o RECEBIDO pelo código é o mesmo valor → idempotente.
      assert.equal((await marcar(pool, a, 'DHL 9302', 'IM9302-26', 'RECEBIDO')).status, 'SEM_MUDANCA');
    });

    await t.test('24. instante exato: valor oficial diferente, posterior no mesmo milissegundo, NÃO é descartado pela L1a', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-us-mudanca');
      const p = await processo(pool, a, 'IM9303-26');
      const base = { tracking: 'DHL9303', ref: 'IM9303-26' };
      await gravarNoInstante(pool, a, { ...base, valor: 'RECEBIDO', associacao: 'CITADA', sequencia: 1, em: '2026-10-13 10:00:00.123100+00' });
      const contraria = await gravarNoInstante(pool, a, { ...base, valor: 'AUSENTE_NA_CONFERENCIA', associacao: 'INFERIDA', sequencia: 2, em: '2026-10-13 10:00:00.123300+00' });
      const oficial = await gravarNoInstante(pool, a, { ...base, valor: 'AUSENTE_NA_CONFERENCIA', associacao: 'CITADA', sequencia: 3, em: '2026-10-13 10:00:00.123700+00' });
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const [d] = (await projecao(pool, a, p)).avaliacao.divergencias;
      assert.equal(d.divergencia.evidencia.ref, `courier_fato:${contraria}`);
      assert.equal(d.divergencia.estado, 'RESOLVIDA_PELA_FONTE_DE_VERDADE', 'a mudança oficial 0,4 ms depois foi aplicada');
      assert.deepEqual([d.oficial?.valor, d.oficial?.evidencia.ref, d.oficial?.vigenteDesde],
        ['AUSENTE_NA_CONFERENCIA', `courier_fato:${oficial}`, '2026-10-13T10:00:00.123700Z']);
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, p)).mbl?.valor, 'AUSENTE_NA_CONFERENCIA', 'S1 e L1a concordam');
    });

    await t.test('25. instante exato: reconfirmação no mesmo milissegundo avança o frescor exato, não o vigenteDesde', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-us-reconf');
      const p = await processo(pool, a, 'IM9304-26');
      const base = { tracking: 'DHL9304', ref: 'IM9304-26' };
      await gravarNoInstante(pool, a, { ...base, valor: 'RECEBIDO', associacao: 'CITADA', sequencia: 1, em: '2026-10-13 10:00:00.123100+00' });
      await gravarNoInstante(pool, a, { ...base, valor: 'AUSENTE_NA_CONFERENCIA', associacao: 'INFERIDA', sequencia: 2, em: '2026-10-13 10:00:00.123300+00' });
      await gravarNoInstante(pool, a, { ...base, valor: 'RECEBIDO', associacao: 'CITADA', sequencia: 3, em: '2026-10-13 10:00:00.123600+00' });
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const [d] = (await projecao(pool, a, p)).avaliacao.divergencias;
      assert.equal(d.divergencia.estado, 'ABERTA', 'reconfirmar não resolve (N-16a)');
      assert.deepEqual([d.oficial?.vigenteDesde, d.oficial?.ultimaConfirmacaoEm], ['2026-10-13T10:00:00.123100Z', '2026-10-13T10:00:00.123600Z']);
    });

    await t.test('26–27. instante exato: fuso equivalente é o mesmo instante; marcas comuns em ms seguem iguais', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l4-us-fuso');
      const p = await processo(pool, a, 'IM9305-26');
      // Gravado com outro fuso: o banco guarda o instante absoluto; a leitura devolve o mesmo instante em UTC.
      await gravarNoInstante(pool, a, { tracking: 'DHL9305', ref: 'IM9305-26', valor: 'RECEBIDO', associacao: 'CITADA', sequencia: 1, em: '2026-10-13 07:00:00.123456-03' });
      const [l] = (await fatosCourierDoProcesso(pool, a.orgId, p)).assuntos[0].linhas;
      assert.equal(l.instante, '2026-10-13T10:00:00.123456Z');
      assert.equal(compararInstantes(l.instante, '2026-10-13T07:00:00.123456-03:00'), 0);
      // Marca comum (now() da escrita normal): o instante preciso e o Date em ms apontam o mesmo milissegundo.
      const comum = await conferir(pool, a, 'DHL 9306', 'IM9305-26', 'HBL_ORIGINAL', 'RECEBIDO');
      const linhaComum = (await fatosCourierDoProcesso(pool, a.orgId, p)).assuntos.flatMap((x) => x.linhas).find((x) => x.fatoId === comum)!;
      assert.equal(Date.parse(linhaComum.instante), linhaComum.registradoEm.getTime());
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.house.l1a.tipo, 'RESOLVIDO');
      assert.equal((resolucao(pr) as any).resolvidoEm, '2026-10-13T10:00:00.123Z', 'a projeção visível continua em ms');
    });
  } finally {
    await pool.end();
  }
});
