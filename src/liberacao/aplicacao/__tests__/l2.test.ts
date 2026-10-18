import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { testDatabaseUrl, testPool, truncateAll } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { servir } from '../../../operacional/__tests__/http';
import { resetCourierStore } from '../../../couriers/courierStore';
import { vinculoDoProcesso } from '../../../auditoria/fatos/vinculos';
import { criarCourierRouter } from '../../../routes/courierRoutes';
import { avaliarProcesso, decidirProcesso, projetarNaL1a } from '../../dominio';
import {
  FonteTerminal, GatilhosLiberacao, ProjecaoLiberacao, avaliarLiberacao, canonico, carregarEntrada, disponibilidadeDoCourier, entradaDaDecisao,
  gatilhosLiberacaoPadrao, impressaoMaterial, obterLiberacaoDoProcesso, recalcularLiberacaoProcesso, vistaMaterial,
} from '..';
import {
  cenarioConfirmado, conferir, envelope, eventos, fatosDeps, gatilhos, idDoProcesso, msg, poolQueFalhaNaLinhaAtual, poolQuebrado,
  preparar, processo, projecao, routerLiberacao, semInvencao, sessaoDePessoa, vincular,
} from './apoio';

const url = testDatabaseUrl();

/* ========================================================================================= */

test('L2 — projeção real da Liberação', { skip: !url }, async (t) => {
  const pool = testPool();
  try {
    await preparar(pool);

    await t.test('1. processo sem fatos utilizáveis → projeção segura, não determinável, sem nada inventado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-vazio');
      const p = await processo(pool, a, 'IM7001-26');
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(r.status, 'PRIMEIRA_AVALIACAO');
      const pr = await projecao(pool, a, p);
      const av = pr.avaliacao;
      assert.deepEqual(av.master.l1a.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' });
      assert.equal(av.master.masterId, null);
      assert.deepEqual(av.house.l1a, { tipo: 'NAO_DETERMINAVEL', semFonteIntegrada: ['PORTAL_FOTO_HBL', 'EMAIL_TELEX'], fontesIndisponiveis: [] });
      assert.deepEqual(av.progresso, []);
      assert.equal(av.etapa.tipo, 'NAO_DETERMINAVEL');
      assert.equal(av.bloqueador.tipo, 'NAO_DETERMINAVEL', 'nenhum bloqueador conhecido inventado');
      assert.equal(av.proximaAcao.tipo, 'NAO_DETERMINAVEL');
      assert.deepEqual(pr.fontes, {
        vinculo: { situacao: 'SEM_VINCULO' },
        courier: { mblFatoId: null, hblOriginalFatoId: null, envelopeFatoId: null, naoPublicadosFatoIds: [] },
        masterFisico: null, caixaIds: [a.caixaId], disponibilidadeCourier: 'DISPONIVEL',
      });
      assert.equal(pr.terminal, false);
      semInvencao(pr);
      assert.equal(await eventos(pool, p), 1, 'primeira avaliação → um evento');
      // É a decisão da L1b para os fatos vigentes, sem "melhorar" nada; projetada na L1a congelada, é a própria L1a.
      const c = (await carregarEntrada(pool, a.orgId, p))!;
      assert.equal(canonico(av), canonico({ ...decidirProcesso(entradaDaDecisao(c, av.agora)), divergencias: [] }));
      assert.equal(canonico(av), canonico(avaliarLiberacao(c, av.agora)));
      assert.equal(canonico(projetarNaL1a(av)), canonico(avaliarProcesso(c.entrada)));
    });

    await t.test('2. MBL físico recebido no Courier → Master resolvido refletido (via gatilho do S1)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-mbl');
      const p = await processo(pool, a, 'IM7002-26');
      await envelope(pool, a, 'DHL 7002', 'Recebido');
      const mbl = await conferir(pool, a, 'DHL 7002', 'IM7002-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      const pr = await projecao(pool, a, p);
      const res = pr.avaliacao.master.l1a.resolucao;
      assert.equal(res.tipo, 'RESOLVIDO');
      if (res.tipo === 'RESOLVIDO') {
        assert.equal(res.via, 'CONFERENCIA_DO_PROPRIO_PROCESSO');
        assert.deepEqual(res.evidencia, { fonte: 'courier', ref: `courier_fato:${mbl}` });
      }
      assert.deepEqual(pr.avaliacao.progresso.map((m) => m.marco), ['MASTER_RESOLVIDO']);
      assert.equal(pr.fontes.courier.mblFatoId, mbl);
      assert.equal(pr.avaliacao.master.l1a.fisicoDoProcesso.envelope?.valor, 'ENTREGUE');
      const { rows: [ev] } = await pool.query(`SELECT gatilho, acionado_por_membership_id FROM liberacao_avaliacao_eventos WHERE processo_id = $1`, [p]);
      assert.deepEqual(ev, { gatilho: 'COURIER_CONFERENCIA', acionado_por_membership_id: null }, 'recálculo interno sem ator humano');
    });

    await t.test('3. envelope recebido sem conferência do MBL → nenhum fato negativo inventado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-env');
      // (a) Envelope recebido, só o HBL conferido: o MBL não foi observado.
      const p = await processo(pool, a, 'IM7003-26');
      await envelope(pool, a, 'DHL 7003', 'Recebido');
      await conferir(pool, a, 'DHL 7003', 'IM7003-26', 'HBL_ORIGINAL', 'RECEBIDO');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.master.l1a.fisicoDoProcesso.envelope?.valor, 'ENTREGUE');
      assert.equal(pr.avaliacao.master.l1a.fisicoDoProcesso.mbl, null);
      assert.deepEqual(pr.avaliacao.master.l1a.resolucao, { tipo: 'NAO_RESOLVIDO' });
      assert.equal(pr.avaliacao.bloqueador.tipo, 'NAO_DETERMINAVEL', 'não é "Master físico não recebido"');
      assert.ok(!JSON.stringify(pr.avaliacao.master).includes('AUSENTE'));
      semInvencao(pr);
      // (b) Envelope só "Identificado" (V-2): não é trânsito nem entrega.
      const q = await processo(pool, a, 'IM7004-26');
      await envelope(pool, a, 'DHL 7004', 'Identificado');
      await conferir(pool, a, 'DHL 7004', 'IM7004-26', 'HBL_ORIGINAL', 'AUSENTE_NA_CONFERENCIA');
      await recalcularLiberacaoProcesso(pool, a.orgId, q);
      const pq = await projecao(pool, a, q);
      assert.equal(pq.avaliacao.master.l1a.fisicoDoProcesso.envelope, null, 'Identificado não vira EM_TRANSITO');
      assert.deepEqual(pq.avaliacao.master.l1a.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' });
      assert.equal(pq.fontes.courier.envelopeFatoId, null);
      semInvencao(pq);
    });

    await t.test('4. MBL ausente na conferência → bloqueador conhecido só quando a decisão o legitima', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-ausente');
      const p = await processo(pool, a, 'IM7005-26');
      await envelope(pool, a, 'DHL 7005', 'Recebido');
      const aus = await conferir(pool, a, 'DHL 7005', 'IM7005-26', 'MBL', 'AUSENTE_NA_CONFERENCIA');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.master.l1a.fisicoDoProcesso.mbl?.valor, 'AUSENTE_NA_CONFERENCIA', 'conhecimento positivo preservado');
      assert.deepEqual(pr.avaliacao.master.l1a.resolucao, { tipo: 'NAO_RESOLVIDO' });
      assert.equal(pr.avaliacao.master.modalidadeIdentificada, null, 'a L2 não inventa modalidade');
      assert.equal(pr.avaliacao.bloqueador.tipo, 'NAO_DETERMINAVEL', 'sem modalidade física identificada não há bloqueador conhecido');
      assert.equal(pr.fontes.courier.mblFatoId, aus);
      // A mesma entrada, com a modalidade física identificada (fonte futura), é o que a L1b exige para o bloqueador.
      const c = (await carregarEntrada(pool, a.orgId, p))!;
      assert.equal(c.entrada.fatosDoMaster.length, 0);
      const vinculo = { processoId: p, masterId: 'm-futuro', vinculadoEm: '2026-09-01T00:00:00.000Z', evidencia: { fonte: 'teste', ref: 'v' } };
      const comModalidade = decidirProcesso({
        ...entradaDaDecisao(c, pr.avaliacao.agora), vinculo: { tipo: 'VINCULADO', vinculo },
        fatosDoMasterL1a: [{ tipo: 'MODALIDADE_IDENTIFICADA', masterId: 'm-futuro', modalidade: 'FISICO', acaoEm: '2026-09-01T00:00:00.000Z', evidencia: { fonte: 'teste', ref: 'mod' } }],
      });
      assert.equal(comModalidade.bloqueador.tipo, 'CONHECIDO');
      // Marca de linha não oficial (inferida) não publica fato negativo.
      const q = await processo(pool, a, 'IM7006-26');
      const inferida = await conferir(pool, a, 'DHL 7006', 'IM7006-26', 'MBL', 'AUSENTE_NA_CONFERENCIA', 'INFERIDA');
      await recalcularLiberacaoProcesso(pool, a.orgId, q);
      const pq = await projecao(pool, a, q);
      assert.equal(pq.avaliacao.master.l1a.fisicoDoProcesso.mbl, null);
      assert.deepEqual(pq.fontes.courier.naoPublicadosFatoIds, [inferida]);
    });

    await t.test('5. HBL original recebido e conferido → House resolvida pelo caminho B', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-hbl');
      const p = await processo(pool, a, 'IM7007-26');
      await envelope(pool, a, 'DHL 7007', 'Em Conferência');
      const hbl = await conferir(pool, a, 'DHL 7007', 'IM7007-26', 'HBL_ORIGINAL', 'RECEBIDO');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.house.l1a.tipo, 'RESOLVIDO');
      if (pr.avaliacao.house.l1a.tipo === 'RESOLVIDO') {
        assert.equal(pr.avaliacao.house.l1a.caminho, 'B_ORIGINAL_RECEBIDO_PELA_ROCKET');
        assert.deepEqual(pr.avaliacao.house.l1a.evidencia, { fonte: 'courier', ref: `courier_fato:${hbl}` });
      }
      assert.deepEqual(pr.avaliacao.progresso.map((m) => m.marco), ['HOUSE_RESOLVIDO']);
      assert.equal(pr.fontes.courier.hblOriginalFatoId, hbl);
    });

    await t.test('6. fonte indisponível depois de fato confirmado → o fato fica; só muda a disponibilidade', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-fonte');
      const p = await processo(pool, a, 'IM7008-26');
      const q = await processo(pool, a, 'IM7009-26');
      await conferir(pool, a, 'DHL 7008', 'IM7008-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 7009', 'IM7009-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 7009', 'IM7009-26', 'HBL_ORIGINAL', 'RECEBIDO');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      await recalcularLiberacaoProcesso(pool, a.orgId, q);

      await pool.query(`UPDATE email_caixas SET token_estado = 'indisponivel', token_verificado_em = now() WHERE id = $1`, [a.caixaId]);
      // P (House ainda não determinável): a indisponibilidade muda uma saída da L1a → um evento.
      const rp = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(rp.status, 'MUDANCA_MATERIAL');
      const pp = await projecao(pool, a, p);
      assert.equal(pp.avaliacao.master.l1a.resolucao.tipo, 'RESOLVIDO', 'o fato confirmado permanece');
      assert.equal(pp.avaliacao.master.l1a.fonteCourier.disponivel, false);
      assert.deepEqual(pp.avaliacao.house.l1a.tipo === 'NAO_DETERMINAVEL' && pp.avaliacao.house.l1a.fontesIndisponiveis, ['COURIER']);
      assert.equal(await eventos(pool, p), 2);
      // Q (Master e House resolvidos): só o eco da disponibilidade muda → linha atualizada, sem evento.
      const rq = await recalcularLiberacaoProcesso(pool, a.orgId, q);
      assert.deepEqual([rq.status, rq.status === 'SEM_MUDANCA_MATERIAL' && rq.atualizada], ['SEM_MUDANCA_MATERIAL', true]);
      const pq = await projecao(pool, a, q);
      assert.equal(pq.avaliacao.master.l1a.fonteCourier.disponivel, false);
      assert.equal(pq.avaliacao.master.l1a.resolucao.tipo, 'RESOLVIDO');
      assert.equal(pq.avaliacao.house.l1a.tipo, 'RESOLVIDO');
      assert.equal(await eventos(pool, q), 1);
      // De volta disponível: P volta (um evento); Q segue sem evento.
      await pool.query(`UPDATE email_caixas SET token_estado = 'disponivel', token_verificado_em = now() WHERE id = $1`, [a.caixaId]);
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'MUDANCA_MATERIAL');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, q)).status, 'SEM_MUDANCA_MATERIAL');
      assert.deepEqual([await eventos(pool, p), await eventos(pool, q)], [3, 1]);
      // Caixa pausada também é indisponível (estado do servidor, não do cliente).
      await pool.query(`UPDATE email_caixas SET estado = 'pausada' WHERE id = $1`, [a.caixaId]);
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal((await projecao(pool, a, p)).avaliacao.master.l1a.fonteCourier.disponivel, false);
    });

    await t.test('7. vínculo Processo↔Master válido alimenta a decisão (via gatilho da Auditoria)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-vinc');
      const res = await vincular(pool, a, 'IM7010-26', 'MEDU7010001');
      await gatilhos(pool).extracoesPersistidas(a.orgId, res);
      const p = await idDoProcesso(pool, a, 'IM7010-26');
      const sit = await vinculoDoProcesso(pool, a.orgId, p);
      assert.equal(sit.tipo, 'VINCULADO');
      const pr = await projecao(pool, a, p);
      if (sit.tipo === 'VINCULADO') {
        assert.equal(pr.avaliacao.master.masterId, sit.masterId);
        assert.deepEqual(pr.fontes.vinculo, {
          situacao: 'VINCULADO', masterId: sit.masterId, vinculoIds: sit.evidencias.map((e) => e.vinculoId),
          extracaoIds: sit.evidencias.map((e) => e.extracaoId),
        });
        const { entrada } = (await carregarEntrada(pool, a.orgId, p))!;
        assert.deepEqual(entrada.vinculo, {
          processoId: p, masterId: sit.masterId, vinculadoEm: sit.vinculadoEm.toISOString(), evidencia: sit.evidencia,
        });
      }
      const { rows: [ev] } = await pool.query(`SELECT gatilho FROM liberacao_avaliacao_eventos WHERE processo_id = $1`, [p]);
      assert.equal(ev.gatilho, 'AUDITORIA_VINCULO');
      // Mesma extração de novo (cache da Auditoria): nada muda, nenhum evento novo.
      await gatilhos(pool).extracoesPersistidas(a.orgId, await vincular(pool, a, 'IM7010-26', 'MEDU7010001'));
      assert.equal(await eventos(pool, p), 1);
    });

    await t.test('8. vínculo em CONFLITO → nenhum Master escolhido', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-conflito');
      // Outro processo no Master M1, com o MBL físico recebido: não pode chegar ao processo em conflito.
      await vincular(pool, a, 'IM7012-26', 'MEDU7011001', { messageId: 'outro' });
      await conferir(pool, a, 'DHL 7012', 'IM7012-26', 'MBL', 'RECEBIDO');
      await vincular(pool, a, 'IM7011-26', 'MEDU7011001', { messageId: 'e1' });
      await vincular(pool, a, 'IM7011-26', 'MSCU7011002', { messageId: 'e2' });
      const p = await idDoProcesso(pool, a, 'IM7011-26');
      assert.equal((await vinculoDoProcesso(pool, a.orgId, p)).tipo, 'CONFLITO');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.master.masterId, null, 'nem o mais novo, nem o mais antigo, nem o primeiro');
      assert.notEqual(pr.avaliacao.master.l1a.resolucao.tipo, 'RESOLVIDO');
      assert.deepEqual(pr.avaliacao.progresso, []);
      assert.equal(pr.fontes.vinculo.situacao, 'CONFLITO');
      if (pr.fontes.vinculo.situacao === 'CONFLITO') assert.equal(pr.fontes.vinculo.masterIds.length, 2);
      assert.equal(pr.fontes.masterFisico, null);
      const c = (await carregarEntrada(pool, a.orgId, p))!;
      assert.deepEqual([c.entrada.vinculo, c.entrada.fatosDoMaster], [null, []]);
      // A L1b recebe o CONFLITO como tal (P3): Preparação para Liberação, conflito de identidade, Rocket, classe C.
      assert.deepEqual(c.vinculo, { tipo: 'CONFLITO', masterIds: pr.fontes.vinculo.situacao === 'CONFLITO' ? pr.fontes.vinculo.masterIds : [] });
      assert.deepEqual(pr.avaliacao.etapa, { tipo: 'DETERMINADA', etapa: 'PREPARACAO_PARA_LIBERACAO' });
      assert.equal(pr.avaliacao.bloqueador.tipo, 'CONHECIDO');
      if (pr.avaliacao.bloqueador.tipo === 'CONHECIDO') {
        const i = pr.avaliacao.bloqueador.item;
        assert.deepEqual([i.motivo, i.responsavel, i.acao, i.classe], ['CONFLITO_DE_IDENTIDADE_DO_MASTER', 'ROCKET', 'RESOLVER_CONFLITO_DE_IDENTIDADE_DO_MASTER', 'C']);
      }
      assert.deepEqual([pr.avaliacao.masterId, pr.avaliacao.master.resolucoes, c.vinculados], [null, [], []], 'nada propaga a partir dos candidatos');
    });

    await t.test('9. vínculo tardio preserva observadoEm (documento) × vinculadoEm (Priora) — N-15', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-tardio');
      await vincular(pool, a, 'IM7013-26', 'MEDU7013001', { messageId: 'e-cedo' });
      const p1 = await idDoProcesso(pool, a, 'IM7013-26');
      const mbl = await conferir(pool, a, 'DHL 7013', 'IM7013-26', 'MBL', 'RECEBIDO');
      // Hoje a Priora vincula P2 ao mesmo Master a partir de um e-mail ANTIGO.
      await vincular(pool, a, 'IM7014-26', 'MEDU7013001', { messageId: 'e-antigo', recebidaEm: '2026-01-05T00:00:00Z' });
      const p2 = await idDoProcesso(pool, a, 'IM7014-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, p2);
      const pr = await projecao(pool, a, p2);
      const { rows: [v2] } = await pool.query(`SELECT observado_em, vinculado_em, extracao_id FROM processo_master_vinculos WHERE processo_id = $1`, [p2]);
      const { rows: [c1] } = await pool.query(`SELECT registrado_em FROM courier_fatos WHERE id = $1`, [mbl]);
      assert.equal(new Date(v2.observado_em).toISOString(), '2026-01-05T00:00:00.000Z', 'data do documento continua no S2');
      const res = pr.avaliacao.master.l1a.resolucao;
      assert.equal(res.tipo, 'RESOLVIDO');
      if (res.tipo === 'RESOLVIDO') {
        assert.equal(res.via, 'MASTER_VINCULADO');
        assert.ok(res.vinculoTardio, 'o fato do Master é anterior ao vínculo deste processo');
        assert.equal(res.vinculoTardio!.vinculadoEm, new Date(v2.vinculado_em).toISOString(), 'vinculadoEm = quando a Priora vinculou');
        assert.notEqual(res.vinculoTardio!.vinculadoEm, '2026-01-05T00:00:00.000Z', 'nunca a data antiga do e-mail');
        assert.equal(res.vinculoTardio!.acaoEm, new Date(c1.registrado_em).toISOString(), 'instante original da ação');
        assert.deepEqual(res.vinculoTardio!.processosVinculadosNaAcao, [p1], 'P2 não estava vinculado na ação');
        assert.deepEqual(res.vinculoTardio!.evidenciaDoVinculo, { fonte: 'auditoria', ref: `auditoria_extracao:${v2.extracao_id}` });
      }
      assert.equal(pr.avaliacao.progresso[0].em, new Date(c1.registrado_em).toISOString(), 'marco no instante da ação, não do vínculo');
      assert.notEqual(pr.avaliacao.bloqueador.tipo, 'CONHECIDO', 'sem culpa retroativa');
      assert.deepEqual(pr.fontes.masterFisico, {
        courierFatoId: mbl, origemProcessoId: p1,
        origemVinculoIds: (await pool.query(`SELECT id FROM processo_master_vinculos WHERE processo_id = $1`, [p1])).rows.map((r) => r.id),
      });
    });

    await t.test('10–11. recálculo idêntico → nada; mudança material → exatamente um evento; frescor → sem evento', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-mudanca');
      const p = await processo(pool, a, 'IM7015-26');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'PRIMEIRA_AVALIACAO');
      const antes = await projecao(pool, a, p);
      for (let i = 0; i < 3; i++) {
        const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
        assert.deepEqual([r.status, r.status === 'SEM_MUDANCA_MATERIAL' && r.atualizada], ['SEM_MUDANCA_MATERIAL', false]);
      }
      assert.deepEqual(await projecao(pool, a, p), antes, 'nada regravado (nem o instante da avaliação)');
      assert.equal(await eventos(pool, p), 1);

      await envelope(pool, a, 'DHL 7015', 'Recebido');
      const mbl = await conferir(pool, a, 'DHL 7015', 'IM7015-26', 'MBL', 'RECEBIDO');
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p, { gatilho: 'COURIER_CONFERENCIA' });
      assert.equal(r.status, 'MUDANCA_MATERIAL');
      assert.equal(await eventos(pool, p), 2);
      const { rows: evs } = await pool.query(
        `SELECT sequencia, impressao_anterior, impressao_nova, avaliacao_anterior, avaliacao_nova FROM liberacao_avaliacao_eventos
          WHERE processo_id = $1 ORDER BY sequencia`, [p]);
      assert.equal(evs[1].impressao_anterior, evs[0].impressao_nova, 'cadeia de impressões');
      assert.equal(canonico(evs[1].avaliacao_anterior), canonico(antes.avaliacao), 'projeção anterior preservada');
      assert.equal(evs[1].avaliacao_nova.master.l1a.resolucao.evidencia.ref, `courier_fato:${mbl}`);
      assert.equal((await projecao(pool, a, p)).sequencia, 2);

      // Recebido → Em Conferência → Concluído: o envelope continua entregue desde a mesma confirmação → sem evento.
      await envelope(pool, a, 'DHL 7015', 'Em Conferência');
      const fr = await recalcularLiberacaoProcesso(pool, a.orgId, p, { gatilho: 'COURIER_ENVELOPE' });
      assert.deepEqual([fr.status, fr.status === 'SEM_MUDANCA_MATERIAL' && fr.atualizada], ['SEM_MUDANCA_MATERIAL', true], 'só frescor');
      await envelope(pool, a, 'DHL 7015', 'Concluído');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(await eventos(pool, p), 2);
      // Desmarcar o MBL é mudança oficial → mais um evento.
      await conferir(pool, a, 'DHL 7015', 'IM7015-26', 'MBL', 'DESMARCADO');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'MUDANCA_MATERIAL');
      assert.equal(await eventos(pool, p), 3);
    });

    await t.test('12. retentativa depois de falha é idempotente (queda no meio, concorrência, gatilho com banco fora)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-retry');
      const p = await processo(pool, a, 'IM7016-26');
      await assert.rejects(recalcularLiberacaoProcesso(poolQueFalhaNaLinhaAtual(pool), a.orgId, p), /queda simulada/);
      assert.equal(await eventos(pool, p), 0, 'o evento foi desfeito junto (mesma transação)');
      assert.equal(await obterLiberacaoDoProcesso(pool, a.orgId, p), null);
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'PRIMEIRA_AVALIACAO');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'SEM_MUDANCA_MATERIAL');
      assert.equal(await eventos(pool, p), 1);

      // Gatilho com o banco fora: nunca lança; o fato de origem fica; a próxima chamada recupera.
      const mbl = await conferir(pool, a, 'DHL 7016', 'IM7016-26', 'MBL', 'RECEBIDO');
      await gatilhosLiberacaoPadrao(() => poolQuebrado()).conferenciaRegistrada(a.orgId, mbl);
      assert.equal(await eventos(pool, p), 1);
      // Retentativas concorrentes do mesmo gatilho: um único evento.
      await Promise.all([1, 2, 3, 4].map(() => gatilhos(pool).conferenciaRegistrada(a.orgId, mbl)));
      assert.equal(await eventos(pool, p), 2);
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      assert.equal(await eventos(pool, p), 2);
    });

    await t.test('13. fato do processo A não altera o processo B (nem de outra organização)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-iso-a');
      const b = await cenarioConfirmado(pool, 'l2-iso-b');
      const pa = await processo(pool, a, 'IM7017-26');
      const pb = await processo(pool, a, 'IM7018-26');
      const outraOrg = await processo(pool, b, 'IM7017-26');
      for (const [c, id] of [[a, pa], [a, pb], [b, outraOrg]] as const) await recalcularLiberacaoProcesso(pool, c.orgId, id);
      const antesB = await projecao(pool, a, pb);
      const antesOutra = await projecao(pool, b, outraOrg);
      const mbl = await conferir(pool, a, 'DHL 7017', 'IM7017-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      assert.equal((await projecao(pool, a, pa)).avaliacao.master.l1a.resolucao.tipo, 'RESOLVIDO');
      assert.deepEqual(await projecao(pool, a, pb), antesB, 'B intocado');
      assert.deepEqual(await projecao(pool, b, outraOrg), antesOutra, 'mesmo código em outra organização intocado');
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, pb)).status, 'SEM_MUDANCA_MATERIAL');
      assert.equal((await recalcularLiberacaoProcesso(pool, b.orgId, outraOrg)).status, 'SEM_MUDANCA_MATERIAL');
      assert.deepEqual([await eventos(pool, pb), await eventos(pool, outraOrg)], [1, 1]);
      assert.equal((await recalcularLiberacaoProcesso(pool, b.orgId, pa)).status, 'PROCESSO_NAO_ENCONTRADO', 'processo de outra organização');
    });

    await t.test('14. fato de Master compartilhado chega aos vinculados e cada processo mantém a própria etapa', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-compart');
      await vincular(pool, a, 'IM7019-26', 'MEDU7019001', { messageId: 'p1' });
      await vincular(pool, a, 'IM7020-26', 'MEDU7019001', { messageId: 'p2' });
      await vincular(pool, a, 'IM7021-26', 'MSCU7021001', { messageId: 'p3' });
      const [p1, p2, p3] = [await idDoProcesso(pool, a, 'IM7019-26'), await idDoProcesso(pool, a, 'IM7020-26'), await idDoProcesso(pool, a, 'IM7021-26')];
      await conferir(pool, a, 'DHL 7020', 'IM7020-26', 'HBL_ORIGINAL', 'RECEBIDO');
      for (const p of [p1, p2, p3]) await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const antes3 = await projecao(pool, a, p3);

      const mbl = await conferir(pool, a, 'DHL 7019', 'IM7019-26', 'MBL', 'RECEBIDO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, mbl);
      const [r1, r2] = [await projecao(pool, a, p1), await projecao(pool, a, p2)];
      const via = (p: ProjecaoLiberacao) => (p.avaliacao.master.l1a.resolucao.tipo === 'RESOLVIDO' ? p.avaliacao.master.l1a.resolucao.via : null);
      assert.deepEqual([via(r1), via(r2)], ['CONFERENCIA_DO_PROPRIO_PROCESSO', 'MASTER_VINCULADO']);
      assert.deepEqual([r1.avaliacao.house.l1a.tipo, r2.avaliacao.house.l1a.tipo], ['NAO_DETERMINAVEL', 'RESOLVIDO'], 'House é de cada processo');
      // Etapa e bloqueador são de cada processo (decididos um a um, N-13): sem armador integrado, os dois ficam
      // "não determinável — armador"; o que falta a cada um continua individual (a House de P1 ainda não tem fonte).
      for (const r of [r1, r2]) {
        const c = (await carregarEntrada(pool, a.orgId, r.processoId))!;
        assert.equal(canonico(vistaMaterial(r.avaliacao)), canonico(vistaMaterial(avaliarLiberacao(c, r.avaliacao.agora))));
      }
      assert.notEqual(canonico(r1.avaliacao.indeterminacao), canonico(r2.avaliacao.indeterminacao), 'informação que falta é de cada processo');
      assert.notEqual(canonico(r1.avaliacao.bloqueador), canonico(r2.avaliacao.bloqueador));
      const gatilhoDe = async (p: string) => (await pool.query(
        `SELECT gatilho FROM liberacao_avaliacao_eventos WHERE processo_id = $1 ORDER BY sequencia DESC LIMIT 1`, [p])).rows[0].gatilho;
      assert.deepEqual([await gatilhoDe(p1), await gatilhoDe(p2)], ['COURIER_CONFERENCIA', 'MASTER_COMPARTILHADO']);
      assert.deepEqual(await projecao(pool, a, p3), antes3, 'outro Master: intocado');
    });

    await t.test('15. ponteiros correspondem a linhas reais do S1/S2 (mesma organização)', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-ponteiros');
      await vincular(pool, a, 'IM7022-26', 'MEDU7022001');
      const p = await idDoProcesso(pool, a, 'IM7022-26');
      const inicio = await envelope(pool, a, 'DHL 7022', 'Recebido');
      await envelope(pool, a, 'DHL 7022', 'Em Conferência');
      await conferir(pool, a, 'DHL 7022', 'IM7022-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 7022', 'IM7022-26', 'HBL_ORIGINAL', 'RECEBIDO');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const { fontes, avaliacao } = await projecao(pool, a, p);
      const linha = async (tabela: string, id: string) =>
        (await pool.query(`SELECT * FROM ${tabela} WHERE id = $1 AND organization_id = $2`, [id, a.orgId])).rows[0];
      const mbl = await linha('courier_fatos', fontes.courier.mblFatoId!);
      assert.deepEqual([mbl.tipo, mbl.documento, mbl.valor, mbl.processo_ref], ['CONFERENCIA_DOCUMENTO', 'MBL', 'RECEBIDO', 'IM7022-26']);
      const hbl = await linha('courier_fatos', fontes.courier.hblOriginalFatoId!);
      assert.deepEqual([hbl.documento, hbl.valor], ['HBL_ORIGINAL', 'RECEBIDO']);
      assert.equal(fontes.courier.envelopeFatoId, inicio, 'a linha que confirmou a chegada');
      assert.deepEqual([(await linha('courier_fatos', inicio)).tipo, (await linha('courier_fatos', inicio)).valor], ['ESTADO_ENVELOPE', 'Recebido']);
      assert.equal(fontes.vinculo.situacao, 'VINCULADO');
      if (fontes.vinculo.situacao === 'VINCULADO') {
        for (const id of fontes.vinculo.vinculoIds) {
          const v = await linha('processo_master_vinculos', id);
          assert.deepEqual([v.processo_id, v.master_id], [p, fontes.vinculo.masterId]);
        }
        for (const id of fontes.vinculo.extracaoIds) assert.ok(await linha('auditoria_extracoes', id));
      }
      assert.equal(fontes.masterFisico?.courierFatoId, fontes.courier.mblFatoId);
      for (const id of fontes.caixaIds) assert.ok(await linha('email_caixas', id));
      // As evidências dentro da avaliação apontam para as mesmas linhas.
      const refs = JSON.stringify(avaliacao).match(/courier_fato:[0-9a-f-]{36}/g)!;
      for (const ref of new Set(refs)) assert.ok(await linha('courier_fatos', ref.split(':')[1]));
    });

    await t.test('16. nenhum fato de origem é duplicado numa tabela de verdade da L2', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-sem-copia');
      await vincular(pool, a, 'IM7023-26', 'MEDU7023001');
      const p = await idDoProcesso(pool, a, 'IM7023-26');
      await conferir(pool, a, 'DHL 7023', 'IM7023-26', 'MBL', 'RECEBIDO');
      const ORIGEM = ['courier_fatos', 'auditoria_extracoes', 'processo_master_vinculos', 'processos', 'masters', 'master_referencias',
        'processo_referencias', 'identidade_pendencias', 'email_caixas'];
      const contagens = async () => Promise.all(ORIGEM.map((t) => contar(pool, `SELECT count(*) n FROM ${t}`)));
      const antes = await contagens();
      for (let i = 0; i < 2; i++) await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.deepEqual(await contagens(), antes, 'recalcular não grava nada nos donos');
      const { rows: tabelas } = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'liberacao%' ORDER BY 1`);
      assert.deepEqual(tabelas.map((r) => r.table_name), ['liberacao_avaliacao_eventos', 'liberacao_avaliacoes'], 'sem liberacao_processos');
      const { rows: colunas } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'liberacao%'`);
      const PROIBIDAS = ['tracking_chave', 'tracking_bruto', 'documento', 'valor', 'processo_ref', 'numero_processo', 'mbl_bruto',
        'conhecimento', 'master_id', 'extracao_id', 'caixa_id', 'observado_em', 'vinculado_em', 'estado', 'associacao'];
      assert.deepEqual(colunas.filter((c) => PROIBIDAS.includes(c.column_name)), []);
      // O código da L2 só escreve nas próprias tabelas.
      const dir = path.join(__dirname, '..');
      for (const arq of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        const fonte = fs.readFileSync(path.join(dir, arq), 'utf8');
        for (const m of fonte.matchAll(/\b(INSERT\s+INTO|(?<!DO\s)UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)) {
          assert.ok(m[2].startsWith('liberacao_'), `${arq}: escrita fora da L2 (${m[0]})`);
        }
      }
    });

    await t.test('17–18. leitura: CLIENT fora; sessão legada fora; organização nunca vem da requisição; chave desligada', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-rota-a');
      const b = await cenarioConfirmado(pool, 'l2-rota-b');
      const pa = await processo(pool, a, 'IM7024-26');
      const pb = await processo(pool, b, 'IM7025-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, pa);
      await recalcularLiberacaoProcesso(pool, b.orgId, pb);
      let sessao: Record<string, unknown> = await sessaoDePessoa(pool, a.homePessoa);
      const srv = await routerLiberacao(pool, a, () => sessao);
      try {
        let r = await srv.chamar('GET', `/liberacao/processos/${pa}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.projecao.processoId, pa);
        assert.equal(r.body.projecao.organizationId, a.orgId);
        assert.equal(r.body.projecao.avaliacao.etapa.tipo, 'NAO_DETERMINAVEL');

        // 18: organização de outro lugar (query, corpo) é ignorada; o processo de B não existe para A.
        r = await srv.chamar('GET', `/liberacao/processos/${pb}?organizationId=${b.orgId}`);
        assert.equal(r.status, 404);
        const eventosB = await eventos(pool, pb);
        r = await srv.chamar('POST', `/liberacao/processos/${pb}/recalcular`, { organizationId: b.orgId });
        assert.equal(r.status, 404);
        assert.equal(await eventos(pool, pb), eventosB, 'nada gravado em B');
        await conferir(pool, a, 'DHL 7024', 'IM7024-26', 'MBL', 'RECEBIDO');
        r = await srv.chamar('POST', `/liberacao/processos/${pa}/recalcular`, { organizationId: b.orgId, processoId: pb });
        assert.equal(r.status, 200);
        assert.deepEqual([r.body.status, r.body.projecao.organizationId, r.body.projecao.processoId], ['MUDANCA_MATERIAL', a.orgId, pa]);
        const { rows: [ev] } = await pool.query(
          `SELECT gatilho, acionado_por_membership_id, organization_id FROM liberacao_avaliacao_eventos WHERE processo_id = $1 ORDER BY sequencia DESC LIMIT 1`, [pa]);
        assert.deepEqual(ev, { gatilho: 'RECONSTRUCAO_MANUAL', acionado_por_membership_id: a.membershipPessoa, organization_id: a.orgId },
          'reconstrução manual com a pessoa do S4');
        r = await srv.chamar('GET', '/liberacao/processos/nao-e-uuid');
        assert.equal(r.status, 404);

        // 17: CLIENT não lê nem reconstrói a projeção operacional.
        sessao = await sessaoDePessoa(pool, a.homeCliente);
        r = await srv.chamar('GET', `/liberacao/processos/${pa}`);
        assert.deepEqual([r.status, r.body.motivo], [403, 'PAPEL_SEM_ACESSO_OPERACIONAL']);
        assert.equal(r.body.projecao, undefined);
        r = await srv.chamar('POST', `/liberacao/processos/${pa}/recalcular`);
        assert.equal(r.status, 403);
        // Sessão legada (a conta da sessão É a caixa): não há pessoa → sem acesso à L2.
        sessao = { homeAccountId: a.homeCaixa };
        r = await srv.chamar('GET', `/liberacao/processos/${pa}`);
        assert.deepEqual([r.status, r.body.motivo], [403, 'PESSOA_NECESSARIA']);
        // Pessoa sem membership na organização da caixa.
        sessao = await sessaoDePessoa(pool, b.homePessoa);
        r = await srv.chamar('GET', `/liberacao/processos/${pb}`);
        assert.deepEqual([r.status, r.body.motivo], [403, 'SEM_MEMBERSHIP']);
      } finally {
        await srv.fechar();
      }
      // Chave de rollout desligada: 404 antes de qualquer autenticação ou banco.
      const desligado = await routerLiberacao(poolQuebrado(), a, () => ({}), false);
      try {
        const r = await desligado.chamar('GET', `/liberacao/processos/${pa}`);
        assert.deepEqual([r.status, r.body.motivo], [404, 'LIBERACAO_DESLIGADA']);
      } finally {
        await desligado.fechar();
      }
    });

    await t.test('19. entrada terminal não é reaberta', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-terminal');
      const p = await processo(pool, a, 'IM7026-26');
      await conferir(pool, a, 'DHL 7026', 'IM7026-26', 'MBL', 'RECEBIDO');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      // Produtor terminal de fase posterior (L5/SISCARGA), simulado só aqui: a L2 não calcula LIBERADO.
      const terminal: FonteTerminal = async () => ({ em: '2026-10-10T00:00:00.000Z', evidencia: { fonte: 'teste', ref: 'terminal:1' } });
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p, { terminal });
      assert.equal(r.status, 'MUDANCA_MATERIAL');
      const liberado = await projecao(pool, a, p);
      assert.deepEqual([liberado.terminal, liberado.avaliacao.etapa], [true, { tipo: 'DETERMINADA', etapa: 'LIBERADO' }]);
      const n = await eventos(pool, p);
      // Fatos posteriores (MBL desmarcado) e recálculos sem o produtor terminal não reabrem.
      const desmarcado = await conferir(pool, a, 'DHL 7026', 'IM7026-26', 'MBL', 'DESMARCADO');
      await gatilhos(pool).conferenciaRegistrada(a.orgId, desmarcado);
      const r2 = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.equal(r2.status, 'TERMINAL_PRESERVADO');
      assert.deepEqual(await projecao(pool, a, p), liberado);
      assert.equal(await eventos(pool, p), n);
      // Nem por SQL direto.
      await assert.rejects(pool.query(
        `UPDATE liberacao_avaliacoes SET terminal = false, avaliacao = jsonb_set(avaliacao, '{etapa}', '{"tipo":"NAO_DETERMINAVEL"}') WHERE processo_id = $1`, [p]),
      /não pode ser reaberta/);
      await assert.rejects(pool.query(`DELETE FROM liberacao_avaliacoes WHERE processo_id = $1`, [p]), /não pode ser reaberta nem removida/);
      await assert.rejects(pool.query(`UPDATE liberacao_avaliacao_eventos SET gatilho = 'RECONSTRUCAO' WHERE processo_id = $1`, [p]));
    });

    await t.test('20. reconstruir a partir dos fatos reproduz a mesma projeção, sem histórico duplicado', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-rebuild');
      await vincular(pool, a, 'IM7027-26', 'MEDU7027001', { messageId: 'r1' });
      await vincular(pool, a, 'IM7028-26', 'MEDU7027001', { messageId: 'r2', recebidaEm: '2026-01-01T00:00:00Z' });
      const [p1, p2] = [await idDoProcesso(pool, a, 'IM7027-26'), await idDoProcesso(pool, a, 'IM7028-26')];
      await envelope(pool, a, 'DHL 7027', 'Recebido');
      await conferir(pool, a, 'DHL 7027', 'IM7027-26', 'MBL', 'RECEBIDO');
      await conferir(pool, a, 'DHL 7027', 'IM7027-26', 'HBL_ORIGINAL', 'RECEBIDO');
      for (const p of [p1, p2]) await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const originais = [await projecao(pool, a, p1), await projecao(pool, a, p2)];
      const nEventos = [await eventos(pool, p1), await eventos(pool, p2)];

      // A projeção é derivada: apagada, volta igual a partir dos fatos.
      await pool.query(`DELETE FROM liberacao_avaliacoes WHERE organization_id = $1`, [a.orgId]);
      for (const [i, p] of [p1, p2].entries()) {
        const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
        assert.deepEqual([r.status, r.status === 'SEM_MUDANCA_MATERIAL' && r.atualizada], ['SEM_MUDANCA_MATERIAL', true]);
        const nova = await projecao(pool, a, p);
        // Mesmo significado; só o relógio da nova avaliação (`agora`) é outro.
        assert.equal(canonico(vistaMaterial(nova.avaliacao)), canonico(vistaMaterial(originais[i].avaliacao)));
        assert.equal(canonico(nova.fontes), canonico(originais[i].fontes));
        assert.deepEqual([nova.impressaoMaterial, nova.sequencia, nova.alteradoEm], [originais[i].impressaoMaterial, originais[i].sequencia, originais[i].alteradoEm]);
        // E é exatamente o que a L1b decide hoje para os fatos vigentes, a qualquer hora.
        assert.equal(impressaoMaterial(avaliarLiberacao((await carregarEntrada(pool, a.orgId, p))!, '2030-01-01T00:00:00.000Z')), nova.impressaoMaterial);
      }
      assert.deepEqual([await eventos(pool, p1), await eventos(pool, p2)], nEventos, 'reconstrução não duplica histórico');
    });

    await t.test('21. disponibilidade do Courier: confirmada → disponível; indisponível explícita → não; desconhecida → NÃO disponível', async () => {
      await truncateAll(pool);
      // Caixa recém-vinculada: token nunca verificado (`desconhecido`, o padrão).
      const a = await cenario(pool, 'l2-disp');
      const estado = async () => {
        const d = await disponibilidadeDoCourier(pool, a.orgId);
        return [d.estado, d.fonte.disponivel];
      };
      const tokenDaCaixa = (token: string, id = a.caixaId) =>
        pool.query(`UPDATE email_caixas SET token_estado = $2, token_verificado_em = now() WHERE id = $1`, [id, token]);
      assert.deepEqual(await estado(), ['DESCONHECIDO', false], 'desconhecido nunca é disponível');

      // Desconhecido nunca chega à L1a como fonte positivamente disponível.
      const p = await processo(pool, a, 'IM7031-26');
      await recalcularLiberacaoProcesso(pool, a.orgId, p);
      const { entrada } = (await carregarEntrada(pool, a.orgId, p))!;
      assert.equal(entrada.courier.fonte.disponivel, false);
      let pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.master.l1a.fonteCourier.disponivel, false);
      assert.equal(pr.avaliacao.master.l1a.resolucao.tipo === 'NAO_CONFIRMAVEL' && pr.avaliacao.master.l1a.resolucao.motivo, 'FONTE_INDISPONIVEL');
      assert.deepEqual(pr.avaliacao.house.l1a.tipo === 'NAO_DETERMINAVEL' && pr.avaliacao.house.l1a.fontesIndisponiveis, ['COURIER']);
      assert.deepEqual([pr.fontes.disponibilidadeCourier, pr.fontes.caixaIds], ['DESCONHECIDO', [a.caixaId]]);
      semInvencao(pr);
      // Um fato oficial já confirmado continua valendo, sem tornar a fonte disponível.
      const q = await processo(pool, a, 'IM7032-26');
      await conferir(pool, a, 'DHL 7032', 'IM7032-26', 'MBL', 'RECEBIDO');
      await recalcularLiberacaoProcesso(pool, a.orgId, q);
      const pq = await projecao(pool, a, q);
      assert.deepEqual([pq.avaliacao.master.l1a.resolucao.tipo, pq.avaliacao.master.l1a.fonteCourier.disponivel], ['RESOLVIDO', false]);

      // Confirmada → disponível: a L1a passa a distinguir "sem observação".
      await tokenDaCaixa('disponivel');
      assert.deepEqual(await estado(), ['DISPONIVEL', true]);
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'MUDANCA_MATERIAL');
      pr = await projecao(pool, a, p);
      assert.deepEqual(pr.avaliacao.master.l1a.resolucao, { tipo: 'NAO_CONFIRMAVEL', fonte: 'COURIER', motivo: 'SEM_OBSERVACAO' });
      assert.equal(pr.fontes.disponibilidadeCourier, 'DISPONIVEL');

      // Indisponível explícita → indisponível.
      await tokenDaCaixa('indisponivel');
      assert.deepEqual(await estado(), ['INDISPONIVEL', false]);
      assert.equal((await recalcularLiberacaoProcesso(pool, a.orgId, p)).status, 'MUDANCA_MATERIAL');
      pr = await projecao(pool, a, p);
      assert.equal(pr.avaliacao.master.l1a.resolucao.tipo === 'NAO_CONFIRMAVEL' && pr.avaliacao.master.l1a.resolucao.motivo, 'FONTE_INDISPONIVEL');
      assert.equal(pr.fontes.disponibilidadeCourier, 'INDISPONIVEL');
      // De volta a desconhecido: mesma saída da L1a (indisponível) → só metadados, sem evento.
      const n = await eventos(pool, p);
      await pool.query(`UPDATE email_caixas SET token_estado = 'desconhecido', token_verificado_em = NULL WHERE id = $1`, [a.caixaId]);
      const r = await recalcularLiberacaoProcesso(pool, a.orgId, p);
      assert.deepEqual([r.status, r.status === 'SEM_MUDANCA_MATERIAL' && r.atualizada], ['SEM_MUDANCA_MATERIAL', true]);
      assert.equal((await projecao(pool, a, p)).fontes.disponibilidadeCourier, 'DESCONHECIDO');
      assert.equal(await eventos(pool, p), n);

      // Caixa pausada, mesmo com token confirmado → indisponível.
      await tokenDaCaixa('disponivel');
      await pool.query(`UPDATE email_caixas SET estado = 'pausada' WHERE id = $1`, [a.caixaId]);
      assert.deepEqual(await estado(), ['INDISPONIVEL', false]);
      // Duas caixas ativas: uma desconhecida não basta; uma confirmada basta.
      await pool.query(`UPDATE email_caixas SET estado = 'ativa' WHERE id = $1`, [a.caixaId]);
      await tokenDaCaixa('desconhecido');
      const { rows: [outra] } = await pool.query(
        `INSERT INTO email_caixas (organization_id, home_account_id, username, vinculada_por_membership_id)
         VALUES ($1, 'home-outra-caixa-l2-disp', 'outra@l2-disp.com', $2) RETURNING id`, [a.orgId, a.membershipCaixa]);
      assert.deepEqual(await estado(), ['DESCONHECIDO', false]);
      await tokenDaCaixa('disponivel', outra.id);
      assert.deepEqual(await estado(), ['DISPONIVEL', true]);
      assert.deepEqual((await disponibilidadeDoCourier(pool, a.orgId)).caixaIds, [outra.id]);
      // Organização sem caixa → indisponível.
      const { rows: [semCaixa] } = await pool.query(`INSERT INTO organizations (nome, slug) VALUES ('sem', 'l2-sem-caixa') RETURNING id`);
      const d = await disponibilidadeDoCourier(pool, semCaixa.id);
      assert.deepEqual([d.estado, d.fonte.disponivel, d.caixaIds], ['INDISPONIVEL', false, []]);
    });

    await t.test('seam S1 (rota do Courier): conferência CITADA → projeção recalculada; nada com a chave desligada', async () => {
      await truncateAll(pool);
      resetCourierStore();
      const a = await cenarioConfirmado(pool, 'l2-seam-courier');
      const p = await processo(pool, a, 'IM7029-26');
      const router = criarCourierRouter({
        auth: (_req, _res, next) => next(),
        graph: {
          searchLogisticsMessages: async () => [msg('m-l2', 'Original documents sent via DHL 4444444444',
            'Dear, original documents couriered via DHL 4444444444.\nIM7029-26 OMBL')],
          listRecentSummaries: async () => [],
          getItemAttachmentTexts: async () => [],
          getConversationFull: async () => [],
        } as any,
        ia: { configurada: () => false },
        fatos: fatosDeps(pool, a),
        caixaMonitorada: () => a.homeCaixa,
        segredoLinha: () => 'segredo-de-teste',
      });
      const srv = await servir(router, () => ({ homeAccountId: a.homePessoa }));
      try {
        const { body } = await srv.chamar('GET', '/');
        const env = body.couriers.find((x: any) => x.tracking === '4444444444');
        assert.ok(env?.linhas?.['IM7029-26'], 'linha emitida pelo servidor');
        let r = await srv.chamar('POST', '/4444444444/estado', { estado: 'Recebido' });
        assert.equal(r.status, 200);
        assert.equal(await obterLiberacaoDoProcesso(pool, a.orgId, p), null, 'envelope sem conferência do processo: nada a recalcular');
        r = await srv.chamar('POST', '/4444444444/conferencia', { processo: 'IM7029-26', documento: 'mbl', status: 'recebido', linha: env.linhas['IM7029-26'] });
        assert.deepEqual([r.status, r.body.duravel.proveniencia], [200, 'CITADA']);
        const pr = await projecao(pool, a, p);
        assert.equal(pr.avaliacao.master.l1a.resolucao.tipo, 'RESOLVIDO');
        assert.equal(pr.avaliacao.master.l1a.fisicoDoProcesso.envelope?.valor, 'ENTREGUE');
        // Estado do envelope muda depois: gatilho do envelope; só frescor → nenhum evento novo.
        r = await srv.chamar('POST', '/4444444444/estado', { estado: 'Em Conferência' });
        assert.equal(r.status, 200);
        assert.equal(await eventos(pool, p), 1);
        // Mesma marca de novo: o S1 não grava; nenhum recálculo é necessário.
        r = await srv.chamar('POST', '/4444444444/conferencia', { processo: 'IM7029-26', documento: 'mbl', status: 'recebido', linha: env.linhas['IM7029-26'] });
        assert.equal(r.body.duravel.gravado, false);
        assert.equal(await eventos(pool, p), 1);
      } finally {
        await srv.fechar();
      }
      // Chave de rollout desligada: caminho legado (JSON), nenhuma chamada à L2.
      const chamadas: string[] = [];
      const desligado = await servir(criarCourierRouter({
        auth: (_req, _res, next) => next(),
        graph: { searchLogisticsMessages: async () => [], listRecentSummaries: async () => [] } as any,
        ia: { configurada: () => false },
        fatos: { ...fatosDeps(pool, a), habilitado: () => false },
        liberacao: {
          conferenciaRegistrada: async () => { chamadas.push('conferencia'); },
          envelopeRegistrado: async () => { chamadas.push('envelope'); },
          extracoesPersistidas: async () => { chamadas.push('auditoria'); },
        },
      }), () => ({ homeAccountId: a.homePessoa }));
      try {
        const antes = await contar(pool, `SELECT count(*) n FROM liberacao_avaliacao_eventos`);
        assert.equal((await desligado.chamar('POST', '/5555555555/estado', { estado: 'Recebido' })).status, 200);
        assert.equal((await desligado.chamar('POST', '/5555555555/conferencia', { processo: 'IM7029-26', documento: 'mbl', status: 'nao_recebido' })).status, 200);
        assert.deepEqual(chamadas, []);
        assert.equal(await contar(pool, `SELECT count(*) n FROM liberacao_avaliacao_eventos`), antes);
      } finally {
        await desligado.fechar();
      }
    });

    await t.test('seam S2 (rota da Auditoria): depois de persistir, chama a L2 com a organização do servidor e o resultado do dono', async () => {
      await truncateAll(pool);
      const a = await cenarioConfirmado(pool, 'l2-seam-auditoria');
      const chamadas: Array<[string, number]> = [];
      const espiao: GatilhosLiberacao = {
        conferenciaRegistrada: async () => {}, envelopeRegistrado: async () => {},
        extracoesPersistidas: async (org, resultados) => {
          chamadas.push([org, resultados.length]);
          await gatilhos(pool).extracoesPersistidas(org, resultados);
        },
      };
      const { criarAuditoriaRouter } = await import('../../../routes/auditoriaRoutes');
      const persistencias: Promise<unknown>[] = [];
      const router = criarAuditoriaRouter({
        auth: (_req, _res, next) => next(),
        graph: {
          searchLogisticsMessages: async () => [{ ...msg('pa', 'Pre-alert IM7030-26', 'MBL attached'), hasAttachments: true }],
          listRecentSummaries: async () => [],
          getFullMessage: async () => ({
            id: 'pa', internetMessageId: '<pa@x>', conversationId: 'c-pa', subject: 'Pre-alert IM7030-26',
            from: { emailAddress: { name: 'Agente', address: 'agente@agente.com' } }, receivedDateTime: '2026-09-01T08:00:00Z',
            body: { contentType: 'text', content: 'MBL attached' }, bodyPreview: 'MBL', hasAttachments: true,
            attachments: [{ id: 'a1', name: 'MBL.pdf', contentType: 'application/pdf', size: 10, isInline: false }],
          }),
        } as any,
        extrair: async (_t: string, _m: string, _a: string, nome: string, tipo: any) => ({
          nome, tipo, tipoDetectado: 'MBL', conhecimento: 'MEDU7030001', portoOrigem: null, portoDestino: null, navio: null, shipper: null,
          consignee: null, notify: null, freteValor: null, freteMoeda: null, thcValor: null, cliente: null, containers: [], legivel: true,
        } as any),
        resumir: async () => ({ resumo: 'ok' } as any),
        iaConfigurada: () => true,
        modelo: () => 'modelo-teste',
        fatos: fatosDeps(pool, a),
        aoPersistir: (pr) => { persistencias.push(pr); },
        liberacao: espiao,
      });
      const srv = await servir(router, () => ({ homeAccountId: a.homePessoa }));
      try {
        const r = await srv.chamar('GET', '/IM7030/auditoria');
        assert.equal(r.status, 200);
        const [res] = await Promise.all(persistencias) as Array<{ persistido: boolean }>;
        assert.deepEqual(chamadas, [[a.orgId, 1]], 'a L2 recebe a organização do servidor e o resultado do S2');
        assert.equal(res.persistido, true);
        assert.equal(await contar(pool, `SELECT count(*) n FROM processo_master_vinculos`), 1, 'o fato de origem foi gravado pelo dono');
        const p = await idDoProcesso(pool, a, 'IM7030-26');
        const pr = await projecao(pool, a, p);
        assert.equal(pr.fontes.vinculo.situacao, 'VINCULADO');
        assert.notEqual(pr.avaliacao.master.masterId, null);
      } finally {
        await srv.fechar();
      }
    });
  } finally {
    await pool.end();
  }
});
