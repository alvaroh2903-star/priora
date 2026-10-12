import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { runMigrations } from '../../../demurrage-engine/db/migrate';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { LogisticsSummary, FullEmailMessage } from '../../../graph/graphService';
import { registrarReferenciaProcesso, Origem } from '../../../identidade';
import {
  ErroContextoOperacional, fatosDuraveisHabilitados, resolverContextoOperacional,
} from '../../../operacional/contexto';
import { FatosDuraveisDeps } from '../../../operacional/requisicao';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { cargaDaLinha, servir } from '../../../operacional/__tests__/http';
import { criarCourierRouter } from '../../../routes/courierRoutes';
import { getAllConferencias, getAllEstados, resetCourierStore, setConferenciaDoc } from '../../courierStore';
import {
  ErroFatoCourier, EntradaConferencia, fatosCourierDoProcesso, projecaoCourierParaTela, registrarConferenciaCourier,
  registrarEstadoEnvelope,
} from '../courierFatos';
import { NAO_VERIFICADA, ProvenienciaLinha } from '../linha';

const url = testDatabaseUrl();
const EM = new Date('2026-10-01T12:00:00Z');
const doc = (ref: string): Origem => ({ tipo: 'DOCUMENTAL', fonte: 'auditoria_extracao', evidenciaRef: ref, observadoEm: EM });
const citada = (...brutas: string[]): ProvenienciaLinha => ({ associacao: 'CITADA', brutas, emitidaEm: EM });

const conf = (p: Partial<EntradaConferencia> & { processoRef: string }): EntradaConferencia => ({
  trackingBruto: '1234567890', documento: 'MBL', valor: 'RECEBIDO', proveniencia: citada(), ...p,
});

async function preparar(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
}

/* ---------------------- caixa postal falsa (sem Graph real) ---------------------- */

function msg(id: string, conversationId: string, subject: string, body: string, quando = '2026-10-01T10:00:00Z'): LogisticsSummary {
  return {
    id, conversationId, subject, bodyPreview: body.slice(0, 40), body: { contentType: 'text', content: body },
    from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: quando,
    isRead: true, hasAttachments: false, webLink: `https://outlook/${id}`,
  };
}

const CAIXA_POSTAL: LogisticsSummary[] = [
  // Um envelope, um tracking, três processos citados com sufixos diferentes.
  msg('m-env', 'c-env', 'Original documents sent via DHL 1234567890',
    'Dear, original documents couriered via DHL 1234567890.\nIM2151 OMBL\nIM2151-26 OHBL\nIM 2151-026 OMBL'),
  // Uma conversa com DOIS trackings citando o mesmo processo: qual envelope? → ambíguo.
  msg('m-multi', 'c-multi', 'Two couriers sent: DHL 1111111111 and DHL 2222222222',
    'Dear, documents couriered via DHL 1111111111 and DHL 2222222222.\nIM5555 OMBL'),
  // Envelope sem processo citado; resolvido por referência cruzada (HBL) → inferido.
  msg('m-orf', 'c-orf', 'Original HBL sent via DHL 9876543210',
    'Dear, original HBL SHYY26073818 couriered via DHL 9876543210.'),
  // E-mail "elo" que liga o HBL ao processo.
  msg('m-elo', 'c-elo', 'Shipping instructions IM8888', 'Process IM8888\nHBL: SHYY26073818'),
  // Telex: regra do Courier (resolução detectada no texto do envelope) — nunca vira fato durável.
  msg('m-telex', 'c-telex', 'Original MBL sent via DHL 5555555555', 'Dear, OMBL couriered via DHL 5555555555.\nIM9999 OMBL\nHBL send via TELEX RELEASE'),
];

const CONVERSAS: Record<string, FullEmailMessage[]> = {
  'c-env': [{
    id: 'm-env', conversationId: 'c-env', subject: 'Original documents sent via DHL 1234567890', hasAttachments: false,
    receivedDateTime: '2026-10-01T10:00:00Z', body: { contentType: 'text', content: 'Envelope:\nIM2151-26 OHBL\nIM2151-026 OMBL' },
  }],
};

function graphFalso() {
  return {
    searchLogisticsMessages: async () => CAIXA_POSTAL.map((m) => ({ ...m })),
    listRecentSummaries: async () => [],
    getItemAttachmentTexts: async () => [],
    getConversationFull: async (_t: string, cid: string) => (CONVERSAS[cid] || []).map((m) => ({ ...m })),
  };
}

const analiseClara = (processNumbers: string[]) => async () => ({
  processNumbers, documents: [], evidences: [], hblResolution: null, confidence: 0.9, externalReferences: [],
} as any);

function fatosDeps(pool: Pool, c: Cenario, ligado = true, contadorPool?: { n: number }): FatosDuraveisDeps {
  return {
    habilitado: () => ligado,
    pool: () => { if (contadorPool) contadorPool.n++; return pool; },
    // Runtime de teste com a pessoa SEPARADA da caixa (o que o S4 trará): a sessão é a pessoa.
    contexto: (req) => resolverContextoOperacional(pool, {
      caixaHomeAccountId: c.homeCaixa,
      pessoa: req.session?.homeAccountId ? { homeAccountId: req.session.homeAccountId } : null,
    }),
  };
}

async function routerCourier(pool: Pool, c: Cenario, sessao: { homeAccountId?: string }, opcoes: { ligado?: boolean; contador?: { n: number } } = {}) {
  const router = criarCourierRouter({
    auth: (_req, _res, next) => next(),
    graph: graphFalso() as any,
    ia: { configurada: () => true, analisar: analiseClara(['IM2151', 'IM2151-26', 'IM7777']) },
    fatos: fatosDeps(pool, c, opcoes.ligado ?? true, opcoes.contador),
    caixaMonitorada: () => c.homeCaixa,
    segredoLinha: () => 'segredo-de-teste',
  });
  return servir(router, () => sessao);
}

test('S1 — Courier durável', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await preparar(pool);

    await t.test('chave de ativação: desligada por padrão; só "on" liga', () => {
      assert.equal(fatosDuraveisHabilitados({}), false);
      assert.equal(fatosDuraveisHabilitados({ PRIORA_FATOS_DURAVEIS: 'true' }), false);
      assert.equal(fatosDuraveisHabilitados({ PRIORA_FATOS_DURAVEIS: 'on' }), true);
    });

    await t.test('contexto: organização vem da caixa; pessoa e caixa são identidades separadas', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'ctx-a');
      const b = await cenario(pool, 'ctx-b');
      const r = await resolverContextoOperacional(pool, { caixaHomeAccountId: a.homeCaixa, pessoa: { homeAccountId: a.homePessoa } });
      assert.deepEqual(r, { ok: true, contexto: a.ctx });
      assert.notEqual(a.ctx.membershipId, a.membershipCaixa, 'a autora é a pessoa, nunca a conta da caixa');
      // Runtime atual: a sessão É a conta da caixa → não há autoria confiável → nada durável.
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: a.homeCaixa, pessoa: { homeAccountId: a.homeCaixa } }),
        { ok: false, motivo: 'ATOR_INDISTINGUIVEL_DA_CAIXA' });
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: a.homeCaixa, pessoa: null }),
        { ok: false, motivo: 'SEM_IDENTIDADE_HUMANA' });
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: a.homeCaixa, pessoa: { homeAccountId: b.homePessoa } }),
        { ok: false, motivo: 'ATOR_SEM_MEMBERSHIP' }, 'membro da org B não age na caixa da org A');
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: a.homeCaixa, pessoa: { homeAccountId: a.homeCliente } }),
        { ok: false, motivo: 'ATOR_SEM_PERMISSAO' });
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: 'caixa-desconhecida', pessoa: { homeAccountId: a.homePessoa } }),
        { ok: false, motivo: 'CAIXA_SEM_ORGANIZACAO' });
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: null, pessoa: { homeAccountId: a.homePessoa } }),
        { ok: false, motivo: 'SEM_CAIXA_MONITORADA' });
      await pool.query(`UPDATE email_caixas SET estado = 'removida', removida_em = now() WHERE id = $1`, [b.caixaId]);
      assert.deepEqual(await resolverContextoOperacional(pool, { caixaHomeAccountId: b.homeCaixa, pessoa: { homeAccountId: b.homePessoa } }),
        { ok: false, motivo: 'CAIXA_SEM_ORGANIZACAO' });
    });

    await t.test('serviço: ator e caixa são entradas separadas e validadas; nada é gravado com contexto inválido', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'srv-a');
      const b = await cenario(pool, 'srv-b');
      const casos: Array<[typeof a.ctx, string]> = [
        [{ ...a.ctx, membershipId: a.membershipCaixa }, 'ATOR_INDISTINGUIVEL_DA_CAIXA'],
        [{ ...a.ctx, membershipId: a.membershipCliente }, 'ATOR_SEM_PERMISSAO'],
        [{ ...a.ctx, membershipId: b.membershipPessoa }, 'ATOR_SEM_MEMBERSHIP'],
        [{ ...a.ctx, caixaId: b.caixaId }, 'CAIXA_SEM_ORGANIZACAO'],
      ];
      for (const [ctx, motivo] of casos) {
        await assert.rejects(registrarConferenciaCourier(pool, ctx, conf({ processoRef: 'IM2151' })),
          (e) => e instanceof ErroContextoOperacional && e.motivo === motivo, motivo);
        await assert.rejects(registrarEstadoEnvelope(pool, ctx, { trackingBruto: '1234567890', estado: 'Recebido' }),
          (e) => e instanceof ErroContextoOperacional && e.motivo === motivo, motivo);
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 0);
      assert.equal(await contar(pool, `SELECT count(*) n FROM identidade_pendencias`), 0);
    });

    await t.test('identidade exata: OPERACIONAL resolve ou abre pendência, nunca cria processo; IM2151 ≠ IM2151-26 ≠ IM2151-026', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'id-a');
      const existente = await registrarReferenciaProcesso(pool, a.orgId, 'IM2151-26', doc('auditoria_extracao:x'));
      assert.equal(existente.status, 'RESOLVIDO');
      const r26 = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151-26', proveniencia: citada('IM2151-26') }));
      const r = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151', proveniencia: citada('IM2151') }));
      const r026 = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151-026', proveniencia: citada('IM 2151-026') }));
      const rLonga = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151-2611', proveniencia: citada('IM2151-2611') }));
      assert.equal(r26.status, 'REGISTRADO');
      assert.deepEqual(r26.status === 'REGISTRADO' && r26.identidade,
        { tipo: 'RESOLVIDA', processoId: existente.status === 'RESOLVIDO' && existente.processoId, via: 'CODIGO' });
      for (const [res, motivo] of [[r, 'PROCESSO_NAO_ENCONTRADO'], [r026, 'PROCESSO_NAO_ENCONTRADO'], [rLonga, 'REFERENCIA_INCOMPLETA']] as const) {
        assert.equal(res.status === 'REGISTRADO' && res.identidade.tipo, 'PENDENTE');
        assert.equal(res.status === 'REGISTRADO' && res.identidade.tipo === 'PENDENTE' && res.identidade.motivo, motivo);
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM processos`), 1, 'observação operacional não cria processo');
      const { rows } = await pool.query(
        `SELECT processo_ref, processo_ref_bruta, processo_id IS NOT NULL AS resolvido, identidade_pendencia_id IS NOT NULL AS pendente
           FROM courier_fatos ORDER BY registrado_em, processo_ref`);
      assert.deepEqual(rows.map((x) => [x.processo_ref, x.processo_ref_bruta, x.resolvido, x.pendente]).sort(), [
        ['IM2151', 'IM2151', false, true], ['IM2151-026', 'IM 2151-026', false, true],
        ['IM2151-26', 'IM2151-26', true, false], ['IM2151-2611', 'IM2151-2611', false, true],
      ], 'quatro assuntos distintos; a forma bruta preservada');
      // A pendência do S6 aponta para o próprio fato como evidência.
      const { rows: pend } = await pool.query(
        `SELECT p.fonte, p.evidencia_ref, f.id FROM identidade_pendencias p JOIN courier_fatos f ON f.identidade_pendencia_id = p.id`);
      assert.equal(pend.length, 3);
      for (const p of pend) assert.deepEqual([p.fonte, p.evidencia_ref], ['courier_conferencia', `courier_fato:${p.id}`]);
      // Referência que não é exatamente UMA referência capturável → recusada antes de gravar.
      for (const ruim of ['FOO', 'IM2151 IM2152', 'IM2151-26A']) {
        await assert.rejects(registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: ruim })),
          (e) => e instanceof ErroFatoCourier && e.codigo === 'REFERENCIA_NAO_RECONHECIDA', ruim);
      }
      await assert.rejects(registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151-26', proveniencia: citada('IM2151') })),
        (e) => e instanceof ErroFatoCourier && e.codigo === 'BRUTA_INCOERENTE', 'forma bruta de outro processo');
    });

    await t.test('idempotência, correção e histórico append-only', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'hist-a');
      const um = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3000' }));
      const repetido = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3000' }));
      assert.deepEqual(repetido, { status: 'SEM_MUDANCA', fatoId: um.status === 'REGISTRADO' && um.fatoId, sequencia: 1 });
      const ausente = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3000', valor: 'AUSENTE_NA_CONFERENCIA' }));
      assert.equal(ausente.status === 'REGISTRADO' && ausente.valorAnterior, 'RECEBIDO');
      const desmarcado = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3000', valor: 'DESMARCADO' }));
      assert.equal(desmarcado.status === 'REGISTRADO' && desmarcado.identidade.tipo, 'NAO_APLICAVEL', 'retração não passa pelo S6');
      assert.equal((await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3000', valor: 'DESMARCADO' }))).status, 'SEM_MUDANCA');
      assert.deepEqual(await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3001', valor: 'DESMARCADO' })),
        { status: 'SEM_MUDANCA', fatoId: null, sequencia: null }, 'nada a desmarcar');
      const { rows } = await pool.query(`SELECT sequencia, valor, valor_anterior FROM courier_fatos WHERE processo_ref = 'IM3000' ORDER BY sequencia`);
      assert.deepEqual(rows.map((x) => [x.sequencia, x.valor, x.valor_anterior]),
        [[1, 'RECEBIDO', null], [2, 'AUSENTE_NA_CONFERENCIA', 'RECEBIDO'], [3, 'DESMARCADO', 'AUSENTE_NA_CONFERENCIA']]);

      // Mesma marca: só vira linha nova quando a proveniência passa a ser oficial (nunca o contrário).
      const nv = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3002', proveniencia: NAO_VERIFICADA }));
      const up = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3002', proveniencia: citada('IM3002') }));
      const down = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM3002', proveniencia: NAO_VERIFICADA }));
      assert.deepEqual([nv.status, up.status, down.status], ['REGISTRADO', 'REGISTRADO', 'SEM_MUDANCA']);

      // Estado do envelope: mesmo estado e nota → nada; nota nova → linha nova.
      const e1 = await registrarEstadoEnvelope(pool, a.ctx, { trackingBruto: '1234 5678 90', estado: 'Recebido' });
      const e2 = await registrarEstadoEnvelope(pool, a.ctx, { trackingBruto: '1234567890', estado: 'Recebido' });
      const e3 = await registrarEstadoEnvelope(pool, a.ctx, { trackingBruto: '1234567890', estado: 'Recebido', nota: 'faltou OHBL' });
      assert.deepEqual([e1.status, e2.status, e3.status], ['REGISTRADO', 'SEM_MUDANCA', 'REGISTRADO']);

      for (const sql of [`UPDATE courier_fatos SET valor = 'RECEBIDO'`, `DELETE FROM courier_fatos`]) {
        await assert.rejects(pool.query(sql), /append-only/);
      }
    });

    await t.test('falha depois da operação no S6 desfaz as duas (sem evidência pendurada)', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'tx-a');
      await pool.query(`CREATE FUNCTION teste_falha_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER teste_falha BEFORE INSERT ON courier_fatos FOR EACH ROW EXECUTE FUNCTION teste_falha_insert()`);
      try {
        await assert.rejects(registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM4000' })), /falha simulada/);
      } finally {
        await pool.query(`DROP TRIGGER teste_falha ON courier_fatos; DROP FUNCTION teste_falha_insert();`);
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM identidade_pendencias`), 0, 'a pendência aberta no S6 foi desfeita');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 0);
      const ok = await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM4000' }));
      assert.equal(ok.status, 'REGISTRADO', 'a nova tentativa grava fato e pendência juntos');
      assert.equal(await contar(pool, `SELECT count(*) n FROM identidade_pendencias`), 1);
    });

    await t.test('troca/desconexão de conta: resetCourierStore apaga o JSON; os fatos duráveis continuam; isolamento por organização', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'reset-a');
      const b = await cenario(pool, 'reset-b');
      await registrarEstadoEnvelope(pool, a.ctx, { trackingBruto: '1234567890', estado: 'Recebido' });
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151-26' }));
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM2151', documento: 'HBL_ORIGINAL', valor: 'AUSENTE_NA_CONFERENCIA' }));
      setConferenciaDoc('1234567890', 'IM2151-26', 'mbl', 'recebido');
      const antes = await contar(pool, `SELECT count(*) n FROM courier_fatos`);
      resetCourierStore();
      assert.deepEqual([getAllConferencias(), getAllEstados()], [{}, {}], 'o JSON legado foi apagado');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), antes, 'nada durável foi apagado');
      const proj = await projecaoCourierParaTela(pool, a.orgId, ['1234567890']);
      assert.equal(proj.estados['1234567890'].estado, 'Recebido');
      assert.deepEqual(proj.conferencias['1234567890'], { 'IM2151-26': { mbl: 'recebido' }, IM2151: { hbl: 'nao_recebido' } });
      assert.deepEqual(await projecaoCourierParaTela(pool, b.orgId, ['1234567890']), { estados: {}, conferencias: {} },
        'outra organização não vê os fatos');
    });

    await t.test('contrato por processo: só linha CITADA publica; identidade resolvida na leitura; recebido prevalece entre envelopes', async () => {
      await truncateAll(pool);
      const a = await cenario(pool, 'contrato-a');
      // Fatos antes de o processo existir: ficam com pendência, preservados.
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM6000', trackingBruto: 'TRKA', valor: 'AUSENTE_NA_CONFERENCIA' }));
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM6000', trackingBruto: 'TRKB', valor: 'RECEBIDO' }));
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM6000', trackingBruto: 'TRKC', documento: 'HBL_ORIGINAL',
        proveniencia: { associacao: 'INFERIDA', brutas: [], emitidaEm: EM } }));
      await registrarEstadoEnvelope(pool, a.ctx, { trackingBruto: 'TRKB', estado: 'Em Conferência' });
      // Uma base distinta (IM6000-26) nunca alimenta IM6000.
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM6000-26', trackingBruto: 'TRKD' }));
      // O S2 cria o processo depois (DOCUMENTAL): a pendência é resolvida e os fatos passam a valer, sem regravar nada.
      const criado = await registrarReferenciaProcesso(pool, a.orgId, 'IM6000', doc('auditoria_extracao:y'));
      assert.equal(criado.status === 'RESOLVIDO' && criado.via, 'CRIADO');
      const processoId = criado.status === 'RESOLVIDO' ? criado.processoId : '';
      const f = await fatosCourierDoProcesso(pool, a.orgId, processoId);
      assert.equal(f.mbl?.valor, 'RECEBIDO', 'recebido no envelope B prevalece sobre ausente no A');
      assert.equal(f.mbl?.trackingChave, 'TRKB');
      assert.equal(f.hblOriginal, null, 'HBL só tem marca de linha inferida → não oficial');
      assert.deepEqual(f.naoPublicados.map((n) => [n.trackingChave, n.documento, n.associacao]), [['TRKC', 'HBL_ORIGINAL', 'INFERIDA']]);
      assert.deepEqual(f.envelopes.map((e) => [e.trackingChave, e.estado, e.recebido]), [['TRKA', null, false], ['TRKB', 'Em Conferência', true]]);
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos WHERE processo_ref = 'IM6000-26'`), 1);
      // Retração: desmarcar em B → só resta o ausente de A.
      await registrarConferenciaCourier(pool, a.ctx, conf({ processoRef: 'IM6000', trackingBruto: 'TRKB', valor: 'DESMARCADO' }));
      assert.equal((await fatosCourierDoProcesso(pool, a.orgId, processoId)).mbl?.valor, 'AUSENTE_NA_CONFERENCIA');
    });

    await t.test('rota: IM2151, IM2151-26 e IM2151-026 são linhas distintas; proveniência emitida pelo servidor', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenario(pool, 'rota-a');
      const srv = await routerCourier(pool, a, { homeAccountId: a.homePessoa });
      try {
        const { status, body } = await srv.chamar('GET', '/');
        assert.equal(status, 200);
        const porTracking = Object.fromEntries(body.couriers.map((c: any) => [c.tracking, c]));
        const env = porTracking['1234567890'];
        assert.deepEqual(env.processos, ['IM2151', 'IM2151-26', 'IM2151-026'], 'uma linha por referência exata; nenhuma base funde linhas');
        assert.deepEqual(env.processosDiretos, ['IM2151', 'IM2151-26', 'IM2151-026']);
        const assoc = (c: any) => Object.fromEntries(Object.entries(c.linhas).map(([p, tk]) => [p, cargaDaLinha(tk as string).a]));
        assert.deepEqual(assoc(env), { IM2151: 'CITADA', 'IM2151-26': 'CITADA', 'IM2151-026': 'CITADA' });
        assert.deepEqual(cargaDaLinha(env.linhas['IM2151-026']).b, ['IM 2151-026'], 'forma bruta preservada no identificador');
        assert.deepEqual(assoc(porTracking['1111111111']), { IM5555: 'AMBIGUA' }, 'conversa com dois envelopes → ambíguo');
        assert.deepEqual(assoc(porTracking['2222222222']), { IM5555: 'AMBIGUA' });
        assert.deepEqual(assoc(porTracking['9876543210']), { IM8888: 'INFERIDA' }, 'resolvido por referência cruzada → inferido');
        // Regras do Courier intactas: Telex detectado como antes, pendente antes da chegada, nada gravado só por ler a caixa.
        assert.equal(porTracking['5555555555'].docResolution.telex, true);
        assert.equal(porTracking['1234567890'].docResolution.telex, false);
        assert.equal(env.estado, 'Identificado');
        assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 0, 'ler a caixa não grava fato');

        // Cada linha exata é acionável e vira um assunto próprio.
        for (const p of env.processos) {
          const r = await srv.chamar('POST', '/1234567890/conferencia', { processo: p, documento: 'mbl', status: 'recebido', linha: env.linhas[p] });
          assert.equal(r.status, 200);
          assert.deepEqual([r.body.duravel.gravado, r.body.duravel.proveniencia], [true, 'CITADA']);
        }
        assert.deepEqual((await pool.query(`SELECT processo_ref FROM courier_fatos ORDER BY processo_ref`)).rows.map((x) => x.processo_ref),
          ['IM2151', 'IM2151-026', 'IM2151-26']);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('rota: o navegador não eleva proveniência nem escolhe organização; linha base não vira fato oficial', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenario(pool, 'forja-a');
      const b = await cenario(pool, 'forja-b');
      const srv = await routerCourier(pool, a, { homeAccountId: a.homePessoa });
      try {
        const { body } = await srv.chamar('GET', '/');
        const porTracking = Object.fromEntries(body.couriers.map((c: any) => [c.tracking, c]));
        const linha = porTracking['1234567890'].linhas['IM2151-26'];
        // Corpo declarando proveniência e organização, sem identificador → NAO_VERIFICADA, na organização da caixa.
        let r = await srv.chamar('POST', '/1234567890/conferencia',
          { processo: 'IM2151-26', documento: 'mbl', status: 'recebido', associacao: 'CITADA', organizationId: b.orgId });
        assert.equal(r.body.duravel.proveniencia, 'NAO_VERIFICADA');
        // Identificador de linha inferida → continua inferida.
        r = await srv.chamar('POST', '/9876543210/conferencia',
          { processo: 'IM8888', documento: 'hbl', status: 'recebido', linha: porTracking['9876543210'].linhas.IM8888 });
        assert.equal(r.body.duravel.proveniencia, 'INFERIDA');
        // Identificador forjado (carga trocada para CITADA) → não verificada.
        const [carga, mac] = String(porTracking['9876543210'].linhas.IM8888).split('.');
        const forjada = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
        forjada.a = 'CITADA';
        r = await srv.chamar('POST', '/9876543210/conferencia',
          { processo: 'IM8888', documento: 'mbl', status: 'recebido', linha: `${Buffer.from(JSON.stringify(forjada)).toString('base64url')}.${mac}` });
        assert.equal(r.body.duravel.proveniencia, 'NAO_VERIFICADA');
        // Linha BASE que o servidor não renderizou, usando o identificador da linha IM2151-26 → não verificada.
        r = await srv.chamar('POST', '/1234567890/conferencia', { processo: 'IM2151', documento: 'hbl', status: 'recebido', linha });
        assert.equal(r.body.duravel.proveniencia, 'NAO_VERIFICADA');
        // Ambígua continua ambígua.
        r = await srv.chamar('POST', '/1111111111/conferencia',
          { processo: 'IM5555', documento: 'mbl', status: 'recebido', linha: porTracking['1111111111'].linhas.IM5555 });
        assert.equal(r.body.duravel.proveniencia, 'AMBIGUA');

        assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos WHERE organization_id = $1`, [b.orgId]), 0);
        assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos WHERE associacao = 'CITADA'`), 0,
          'nada manipulado pelo navegador virou proveniência oficial');
        // Nenhuma dessas marcas é fato oficial de processo.
        for (const codigo of ['IM2151-26', 'IM8888', 'IM5555', 'IM2151']) {
          const p = await registrarReferenciaProcesso(pool, a.orgId, codigo, doc(`auditoria_extracao:${codigo}`));
          const f = await fatosCourierDoProcesso(pool, a.orgId, p.status === 'RESOLVIDO' ? p.processoId : '');
          assert.deepEqual([f.mbl, f.hblOriginal], [null, null], codigo);
          assert.ok(f.naoPublicados.length >= 1, `${codigo}: preservado como evidência`);
        }
      } finally {
        await srv.fechar();
      }
    });

    await t.test('rota: Clara só acrescenta códigos escritos por inteiro; classe CLARA nunca é oficial', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenario(pool, 'clara-a');
      const srv = await routerCourier(pool, a, { homeAccountId: a.homePessoa });
      try {
        const { status, body } = await srv.chamar('GET', '/c-env/analysis?tracking=1234567890');
        assert.equal(status, 200);
        // A IA devolveu IM2151 (base truncada), IM2151-26 e IM7777; só IM2151-26 está escrito nas conversas analisadas.
        assert.deepEqual(body.processosClara, ['IM2151-26']);
        assert.equal(cargaDaLinha(body.linhasClara['IM2151-26']).a, 'CLARA');
        assert.deepEqual(body.processosDetalhe.map((d: any) => d.codigo), ['IM2151-26', 'IM2151-026'], 'expectativa por referência exata');
        const r = await srv.chamar('POST', '/1234567890/conferencia',
          { processo: 'IM2151-26', documento: 'hbl', status: 'recebido', linha: body.linhasClara['IM2151-26'] });
        assert.equal(r.body.duravel.proveniencia, 'CLARA');
      } finally {
        await srv.fechar();
      }
    });

    await t.test('rota: estado e conferência duráveis reaparecem na tela depois da troca de conta', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenario(pool, 'reapr-a');
      const srv = await routerCourier(pool, a, { homeAccountId: a.homePessoa });
      try {
        const { body } = await srv.chamar('GET', '/');
        const env = body.couriers.find((c: any) => c.tracking === '1234567890');
        assert.equal(env.estado, 'Identificado', 'pendente antes da chegada (regra do Courier)');
        await srv.chamar('POST', '/1234567890/estado', { estado: 'Recebido' });
        await srv.chamar('POST', '/1234567890/conferencia', { processo: 'IM2151-26', documento: 'mbl', status: 'recebido', linha: env.linhas['IM2151-26'] });
        await srv.chamar('POST', '/1234567890/conferencia', { processo: 'IM2151', documento: 'mbl', status: 'nao_recebido', linha: env.linhas.IM2151 });
        resetCourierStore(); // troca/desconexão da conta Microsoft
        const depois = (await srv.chamar('GET', '/')).body.couriers.find((c: any) => c.tracking === '1234567890');
        assert.equal(depois.estado, 'Recebido');
        assert.deepEqual(depois.conferencia, { 'IM2151-26': { mbl: 'recebido' }, IM2151: { mbl: 'nao_recebido' } });
        // Desmarcar no banco tira a marca da tela, mesmo que o JSON legado ainda a tivesse.
        await srv.chamar('POST', '/1234567890/conferencia', { processo: 'IM2151', documento: 'mbl', status: null, linha: env.linhas.IM2151 });
        setConferenciaDoc('1234567890', 'IM2151', 'mbl', 'nao_recebido');
        const final = (await srv.chamar('GET', '/')).body.couriers.find((c: any) => c.tracking === '1234567890');
        assert.deepEqual(final.conferencia, { 'IM2151-26': { mbl: 'recebido' }, IM2151: {} });
        // Concluído sai da lista principal (regra do Courier), também a partir do estado durável.
        await srv.chamar('POST', '/1234567890/estado', { estado: 'Concluído' });
        resetCourierStore();
        const lista = (await srv.chamar('GET', '/')).body;
        assert.equal(lista.couriers.some((c: any) => c.tracking === '1234567890'), false);
        assert.equal(lista.concluidos, 1);
      } finally {
        await srv.fechar();
      }
    });

    await t.test('rota: banco fora na leitura → a visão do Courier continua (JSON legado), sem quebrar', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenario(pool, 'leitura-a');
      setConferenciaDoc('1234567890', 'IM2151-26', 'mbl', 'recebido');
      const quebrado = { query: async () => { throw new Error('banco fora (simulado)'); } } as unknown as Pool;
      const router = criarCourierRouter({
        auth: (_req, _res, next) => next(),
        graph: graphFalso() as any,
        fatos: { ...fatosDeps(pool, a), pool: () => quebrado },
        caixaMonitorada: () => a.homeCaixa,
        segredoLinha: () => 'segredo-de-teste',
      });
      const srv = await servir(router, () => ({ homeAccountId: a.homePessoa }));
      try {
        const r = await srv.chamar('GET', '/');
        assert.equal(r.status, 200);
        const env = r.body.couriers.find((c: any) => c.tracking === '1234567890');
        assert.deepEqual(env.conferencia, { 'IM2151-26': { mbl: 'recebido' } });
      } finally {
        await srv.fechar();
        resetCourierStore();
      }
    });

    await t.test('rota: runtime atual (sessão = caixa) não grava autoria falsa; chave desligada não toca o banco', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenario(pool, 'runtime-a');
      const mesmo = await routerCourier(pool, a, { homeAccountId: a.homeCaixa });
      try {
        const { body } = await mesmo.chamar('GET', '/');
        assert.equal(body.couriers.some((c: any) => 'linhas' in c), false, 'sem contexto, nenhuma linha oficial é emitida');
        const r = await mesmo.chamar('POST', '/1234567890/conferencia', { processo: 'IM2151-26', documento: 'mbl', status: 'recebido' });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.duravel, { gravado: false, motivo: 'ATOR_INDISTINGUIVEL_DA_CAIXA' });
        assert.deepEqual(r.body.conferencia, { 'IM2151-26': { mbl: 'recebido' } }, 'comportamento atual do Courier (JSON) mantido');
      } finally {
        await mesmo.fechar();
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 0);

      resetCourierStore();
      const contador = { n: 0 };
      const desligado = await routerCourier(pool, a, { homeAccountId: a.homePessoa }, { ligado: false, contador });
      try {
        const { body } = await desligado.chamar('GET', '/');
        assert.equal(body.couriers.some((c: any) => 'linhas' in c), false);
        const r = await desligado.chamar('POST', '/1234567890/conferencia', { processo: 'IM2151-26', documento: 'mbl', status: 'recebido' });
        assert.deepEqual(Object.keys(r.body).sort(), ['conferencia', 'tracking'], 'resposta idêntica à de antes');
        const e = await desligado.chamar('POST', '/1234567890/estado', { estado: 'Recebido' });
        assert.equal('duravel' in e.body, false);
      } finally {
        await desligado.fechar();
      }
      assert.equal(contador.n, 0, 'com a chave desligada o banco não é usado');
      assert.equal(await contar(pool, `SELECT count(*) n FROM courier_fatos`), 0);
    });
  } finally {
    resetCourierStore();
    await pool.end();
  }
});
