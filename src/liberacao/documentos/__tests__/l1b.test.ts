import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisaoDoProcesso, EntradaDecisao, NAO_INTEGRADA, situacaoDaAgencia } from '../../dominio';
import {
  T, apresentacao, armador, clienteOk, decidir, encaminhado, etapaDe, evento, instante, pagamento, procedimento, viagem,
} from '../../dominio/__tests__/l1b/fixtures';
import {
  AssinaturaRegistrada, DocumentoPreparado, FONTE_DOCUMENTAL, MOTIVO_GRIEG_SEM_FATO_L1B, SituacaoDocumental, TentativaDeEnvio, TipoDocumento,
  acrescentarAoProcedimento, condicaoDaSolicitacaoDeAgendamento, entradaDoCatalogo, fatosDocumentaisParaL1b,
} from '..';
import * as moduloDocumental from '..';

/**
 * Fatos documentais × L1b. A L1b continua pura, congelada e sem alteração:
 * só recebe o que já é do vocabulário dela, e nenhum fato documental prova
 * apresentação.
 */

const doc = (tipo: TipoDocumento, em = T(3), p: Partial<DocumentoPreparado> = {}): DocumentoPreparado => ({
  documentoId: `doc-${tipo}`, tipo, masterId: 'M1', modelo: { modeloId: 'mod', versao: 'v1' }, conteudoSha256: 'c'.repeat(64), arquivoSha256: 'a'.repeat(64),
  gerador: { id: 'g', versao: '1' }, processoIdsNaPreparacao: ['IM100'], preparadoEm: em, preparadoPor: 'ana', signatario: null, selecoes: [], escolhas: [], informados: [],
  conteudo: { tipo, modelo: { modeloId: 'mod', versao: 'v1', arquivoSha256: 'f'.repeat(64) }, masterId: 'M1', campos: [], opcoes: [], blocosFixos: [], assinaturaReservada: null },
  ...p,
});
const assinatura = (documentoId: string, em = T(4), assinaturaId = `ass-${documentoId}`): AssinaturaRegistrada =>
  ({
    assinaturaId, documentoId, arquivoSha256: 'b'.repeat(64), registradoPor: 'ana', registradoEm: em, verificacao: 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO',
    signatarioEsperado: null, substituicao: null,
  });
const enviado = (em = T(5)): TentativaDeEnvio => ({
  envioId: 'envio-1', fluxo: 'AGENDAMENTO_APRESENTACAO_GRIEG', masterId: 'M1', documentoId: 'doc-TERMO_EVERGREEN', assinaturaId: 'ass-doc-TERMO_EVERGREEN', modeloId: 'mod',
  chave: 'k', analista: { membershipId: 'ana', contaMicrosoft: 'conta-ana' }, reenvio: null, estado: 'ENVIO_CONFIRMADO', abertoEm: em, atualizadoEm: em, concluidoEm: em,
  composicao: { assunto: 'a', corpo: 'c', para: ['x@y'], cc: [] }, anexos: [], rascunho: { id: 'r', internetMessageId: '<r@x>', conversationId: 'conv' },
  confirmacao: { enviadaEm: em, internetMessageId: '<r@x>', conversationId: 'conv', conferencia: { tipo: 'CONFORME' } }, falha: null,
});
const TODOS: TipoDocumento[] = ['TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'];

/** Alimenta a entrada da L1b com os fatos documentais pelo adaptador (o que a L8 fará). */
function comDocumentos(p: Partial<EntradaDecisao>, codigo: string, docs: DocumentoPreparado[], ass: AssinaturaRegistrada[] = [], envios: TentativaDeEnvio[] = []): Partial<EntradaDecisao> {
  const arm = armador(codigo);
  const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', arm), docs, ass, envios);
  return { ...p, armador: arm, procedimento: acrescentarAoProcedimento(p.procedimento ?? procedimento([]), fatos) };
}

const marcos = (d: DecisaoDoProcesso) => d.progresso.map((m) => m.marco);
const acoesDe = (d: DecisaoDoProcesso) => d.itens.map((i) => i.acao);

test('[L1B-01] MSC: memorando PREPARADO (PDF preenchido) = PREPARACAO_REGISTRADA ("memorando gerado"), no instante da preparação; a assinatura não muda nem adia', () => {
  const memo = doc('MEMORANDO_MSC');
  const semAss = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('MSC')), [memo], [], []);
  assert.deepEqual([semAss.eventos, semAss.ignorados], [[{
    masterId: 'M1', tipo: 'PREPARACAO_REGISTRADA', em: T(3), evidencia: { fonte: FONTE_DOCUMENTAL, ref: 'documento:doc-MEMORANDO_MSC' },
  }], []]);
  const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('MSC')), [memo], [assinatura(memo.documentoId)], []);
  assert.deepEqual(fatos.eventos, semAss.eventos);
  // Várias versões: vale a PRIMEIRA preparação do memorando do armador.
  const v2 = doc('MEMORANDO_MSC', T(6), { documentoId: 'doc-v2' });
  assert.deepEqual(fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('MSC')), [v2, memo], [], []).eventos, semAss.eventos);
  const sem = decidir({ ...clienteOk(), armador: armador('MSC') });
  const com = decidir(comDocumentos(clienteOk(), 'MSC', [memo], []));
  const manual = decidir({ ...clienteOk(), armador: armador('MSC'), procedimento: procedimento([evento('PREPARACAO_REGISTRADA', T(3))]) });
  assert.ok(acoesDe(sem).includes('PREPARAR_MEMORANDO'));
  assert.ok(acoesDe(com).includes('ENVIAR_PARA_APRESENTACAO'));
  assert.deepEqual([etapaDe(com), acoesDe(com), com.principal?.acao, com.subEtapa], [etapaDe(manual), acoesDe(manual), manual.principal?.acao, manual.subEtapa]);
});

test('[L1B-02] Rochamar: o memorando tem de ser o do armador do Master — Hapag para Hapag, ZIM para ZIM; o do outro é ignorado', () => {
  const hapag = situacaoDaAgencia('M1', armador('HAPAG_LLOYD'));
  const zim = situacaoDaAgencia('M1', armador('ZIM'));
  const mh = doc('MEMORANDO_HAPAG_ROCHAMAR');
  const mz = doc('MEMORANDO_ZIM_ROCHAMAR');
  assert.equal(fatosDocumentaisParaL1b('M1', hapag, [mh], [assinatura(mh.documentoId)], []).eventos.length, 1);
  assert.equal(fatosDocumentaisParaL1b('M1', zim, [mz], [assinatura(mz.documentoId)], []).eventos.length, 1);
  const trocado = fatosDocumentaisParaL1b('M1', hapag, [mz], [assinatura(mz.documentoId)], []);
  assert.deepEqual([trocado.eventos, trocado.ignorados], [[], [{ referencia: 'documento:doc-MEMORANDO_ZIM_ROCHAMAR', motivo: 'MODELO_NAO_CORRESPONDE_AO_ARMADOR' }]]);
  const outroMaster = fatosDocumentaisParaL1b('M1', hapag, [doc('MEMORANDO_HAPAG_ROCHAMAR', T(1), { masterId: 'M2', documentoId: 'm2' })], [assinatura('m2')], []);
  assert.deepEqual([outroMaster.eventos, outroMaster.ignorados], [[], [{ referencia: 'documento:m2', motivo: 'OUTRO_MASTER' }]]);
});

test('[L1B-03] Grieg: termo preparado, termo assinado e solicitação enviada ficam no domínio documental — a decisão da L1b é idêntica à sem documentos', () => {
  const base = { ...clienteOk(), pagamentoArmador: pagamento('PENDENTE', T(2)), viagem: viagem({ eta: instante('2026-10-20T12:00:00.000Z') }) };
  const termo = doc('TERMO_EVERGREEN');
  const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('EVERGREEN')), [termo], [assinatura(termo.documentoId)], [enviado()]);
  assert.deepEqual(fatos.eventos, []);
  assert.deepEqual(fatos.mantidosNoDominioDocumental.map((x) => [x.fato, x.em, x.motivo]), [
    ['TERMO_EVERGREEN_PREPARADO', T(3), MOTIVO_GRIEG_SEM_FATO_L1B], ['TERMO_EVERGREEN_ASSINADO', T(4), MOTIVO_GRIEG_SEM_FATO_L1B],
    ['SOLICITACAO_DE_AGENDAMENTO_ENVIADA', T(5), MOTIVO_GRIEG_SEM_FATO_L1B],
  ]);
  assert.deepEqual(decidir(comDocumentos(base, 'EVERGREEN', [termo], [assinatura(termo.documentoId)], [enviado()])), decidir({ ...base, armador: armador('EVERGREEN') }));
});

test('[L1B-04] nenhum fato documental comprova apresentação: preparado, assinado ou enviado nunca levam a MASTER_APRESENTADO nem a BL encaminhado', () => {
  const docs = TODOS.map((t) => doc(t));
  const ass = docs.map((d) => assinatura(d.documentoId));
  for (const codigo of ['MSC', 'HAPAG_LLOYD', 'ZIM', 'EVERGREEN', 'ONE', 'MAERSK']) {
    const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador(codigo)), docs, ass, [enviado()]);
    assert.ok(fatos.eventos.every((e) => e.tipo === 'PREPARACAO_REGISTRADA'), codigo);
    for (const p of [clienteOk(), { ...clienteOk(), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(2)) }) }]) {
      const d = decidir(comDocumentos(p, codigo, docs, ass, [enviado()]));
      assert.ok(!marcos(d).includes('MASTER_APRESENTADO') && !marcos(d).includes('BL_ENCAMINHADO_PARA_APRESENTACAO'), codigo);
      assert.equal(d.apresentacao, null, codigo);
      assert.ok(!['MASTER_APRESENTADO', 'ACOMPANHANDO_DESBLOQUEIO', 'LIBERADO'].includes(String(etapaDe(d))), `${codigo}: ${etapaDe(d)}`);
      assert.equal(d.subEtapa, null, `${codigo}: documento não abre "apresentação em andamento"`);
    }
  }
});

test('[L1B-05] apresentação comprovada continua obedecendo ao Blueprint (MSC): memorando carimbado + confirmação do Analista', () => {
  const memo = doc('MEMORANDO_MSC');
  const msc = (confirmadaPor: string | null) => decidir(comDocumentos(
    { ...clienteOk(), procedimento: procedimento([], [apresentacao('MEMORANDO_CARIMBADO', T(6), confirmadaPor)], [encaminhado(T(5), 'ana', 'MSC')]) },
    'MSC', [memo], [assinatura(memo.documentoId)],
  ));
  assert.ok(marcos(msc('ana')).includes('MASTER_APRESENTADO'));
  assert.ok(!marcos(msc(null)).includes('MASTER_APRESENTADO'));
});

test('[L1B-06] documentos não tornam observável um procedimento sem fonte; o evento entra uma vez só; sem agência nada vai para a L1b', () => {
  const memo = doc('MEMORANDO_MSC');
  const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('MSC')), [memo], [assinatura(memo.documentoId)], []);
  assert.equal(acrescentarAoProcedimento(NAO_INTEGRADA, fatos), NAO_INTEGRADA);
  const uma = acrescentarAoProcedimento(procedimento([]), fatos);
  assert.equal(uma.tipo === 'INTEGRADA' && uma.valor.eventos.length, 1);
  assert.equal(acrescentarAoProcedimento(uma, fatos), uma);
  const semAgencia = fatosDocumentaisParaL1b('M1', { tipo: 'SEM_MASTER' }, [memo], [assinatura(memo.documentoId)], []);
  assert.deepEqual([semAgencia.eventos, semAgencia.ignorados.map((x) => x.motivo)], [[], ['AGENCIA_NAO_DETERMINADA']]);
});

/** Situação documental mínima (sintética) só com o que a composição lê. */
const situacaoCom = (tipo: TipoDocumento, assinatura: SituacaoDocumental['assinatura']['tipo'] | 'CONFERIDA', representacao: 'NAO_EXIGIDA' | 'NAO_COMPROVADA' = 'NAO_EXIGIDA'): SituacaoDocumental => {
  const documento = doc(tipo);
  const ass = assinaturaRegistrada(documento.documentoId);
  const conf = {
    conferenciaId: 'conf-1', documentoId: documento.documentoId, assinaturaId: ass.assinaturaId, arquivoSha256: ass.arquivoSha256, signatarioEsperado: null, resultado: 'CONFORME' as const,
    constatacao: null, conferidoPor: 'ana', conferidoEm: T(4), observacao: null,
  };
  return {
    masterId: 'M1', modelo: { tipo: 'SELECIONADO', entrada: entradaDoCatalogo(tipo), codigoInformado: 'X' },
    versao: { tipo: 'VIGENTE', versao: {} as never, pendentes: [] }, preenchimento: null, preparo: { tipo: 'PREPARADO', documento },
    assinatura: assinatura === 'CONFERIDA' ? { tipo: 'CONFERIDA', assinatura: ass, conferencia: conf }
      : assinatura === 'AGUARDANDO_CONFERENCIA' ? { tipo: 'AGUARDANDO_CONFERENCIA', assinatura: ass }
        : { tipo: 'PENDENTE_HUMANA', documentoId: documento.documentoId, signatarioEsperado: null },
    representacao: representacao === 'NAO_EXIGIDA' ? { tipo: 'NAO_EXIGIDA' } : { tipo: 'NAO_COMPROVADA', signatario: 'sig-legal-1', fundamento: 'f' },
    atencoes: [], envio: { tipo: 'NAO_APLICAVEL' }, apresentacao: { tipo: 'NAO_E_FATO_DOCUMENTAL', mensagem: '' }, texto: null, pendencias: [], proximoPasso: null,
  } as SituacaoDocumental;
};
const assinaturaRegistrada = (documentoId: string) => assinatura(documentoId);

test('[L1B-07] DOC-31: sem portão documental — "Enviar para apresentação" (MSC/Rochamar) é a ação da L1b, a mesma com o memorando só preparado ou com qualquer outro fato documental; nada a dá por executada', () => {
  // Não existe mais composição que restrinja ação da L1b (o antigo `acaoComCondicaoDocumental` saiu).
  assert.ok(!('acaoComCondicaoDocumental' in moduloDocumental) && !('autorizacaoDoEncaminhamento' in moduloDocumental));
  for (const [tipo, codigo] of [['MEMORANDO_MSC', 'MSC'], ['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM']] as Array<[TipoDocumento, string]>) {
    const memo = doc(tipo);
    const preparado = decidir(comDocumentos(clienteOk(), codigo, [memo]));
    const congelado = JSON.stringify(preparado);
    assert.ok(acoesDe(preparado).includes('ENVIAR_PARA_APRESENTACAO'), tipo);
    // Nova versão, ou registros de assinatura (que a Priora não aceita mais para memorandos): a decisão é a mesma.
    const v2 = doc(tipo, T(6), { documentoId: `${memo.documentoId}-v2` });
    assert.equal(JSON.stringify(decidir(comDocumentos(clienteOk(), codigo, [memo, v2]))), congelado, tipo);
    assert.equal(JSON.stringify(decidir(comDocumentos(clienteOk(), codigo, [memo], [assinatura(memo.documentoId)]))), congelado, tipo);
    // O documento só entrega "memorando gerado": nunca encaminhamento, apresentação ou retorno — a ação não é dada por executada.
    const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador(codigo)), [memo, v2], [assinatura(memo.documentoId)], []);
    assert.deepEqual(fatos.eventos.map((e) => e.tipo), ['PREPARACAO_REGISTRADA'], tipo);
    assert.ok(!marcos(preparado).includes('MASTER_APRESENTADO'), tipo);
  }
});

test('[L1B-08] DOC-28 (§5 15–17): APRESENTAR_EVERGREEN não é sinônimo de agendamento — o termo condiciona só a SOLICITAÇÃO, por composição própria; a L1b não muda', () => {
  const grieg = { ...clienteOk(), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(2)) }) };
  const proc = procedimento([evento('PREPARACAO_REGISTRADA', T(3))]);
  const entrada = { ...grieg, armador: armador('EVERGREEN'), procedimento: proc };
  const antes = decidir(entrada);
  const congelado = JSON.stringify(antes);
  assert.ok(acoesDe(antes).includes('APRESENTAR_EVERGREEN'), 'a L1b recomenda a apresentação (comportamento congelado)');
  for (const estado of ['PENDENTE_HUMANA', 'AGUARDANDO_CONFERENCIA', 'CONFERIDA'] as const) {
    const s = situacaoCom('TERMO_EVERGREEN', estado);
    // A apresentação Evergreen não recebe condição documental do termo (não há portão sobre ações da L1b — DOC-28/DOC-31).
    // A solicitação de agendamento é que exige o termo assinado E conferido.
    const c = condicaoDaSolicitacaoDeAgendamento(s);
    assert.equal(c.tipo, estado === 'CONFERIDA' ? 'TERMO_PRONTO_PARA_A_SOLICITACAO' : 'SOLICITACAO_RESTRITA', estado);
    assert.ok(!('etapa' in c) && !('responsavel' in c) && !('classe' in c) && !('prioridade' in c) && !('acao' in c) && !('acaoDaL1b' in c));
  }
  assert.deepEqual((condicaoDaSolicitacaoDeAgendamento(situacaoCom('TERMO_EVERGREEN', 'CONFERIDA', 'NAO_COMPROVADA')) as { motivos: string[] }).motivos,
    ['PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS']);
  assert.deepEqual(condicaoDaSolicitacaoDeAgendamento(situacaoCom('MEMORANDO_MSC', 'CONFERIDA')), { tipo: 'NAO_APLICAVEL' });
  // Termo preparado, assinado, conferido e solicitação enviada não viram fato da L1b nem apresentação.
  const termo = doc('TERMO_EVERGREEN');
  const conf = [{ conferenciaId: 'conf-1', documentoId: termo.documentoId, assinaturaId: `ass-${termo.documentoId}`, arquivoSha256: 'b'.repeat(64), signatarioEsperado: null,
    resultado: 'CONFORME' as const, constatacao: null, conferidoPor: 'ana', conferidoEm: T(4), observacao: null }];
  const fatos = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('EVERGREEN')), [termo], [assinatura(termo.documentoId)], [enviado()], conf);
  assert.deepEqual(fatos.eventos, []);
  assert.deepEqual(fatos.mantidosNoDominioDocumental.map((x) => x.fato), ['TERMO_EVERGREEN_PREPARADO', 'TERMO_EVERGREEN_ASSINADO', 'TERMO_EVERGREEN_CONFERIDO', 'SOLICITACAO_DE_AGENDAMENTO_ENVIADA']);
  const depois = decidir({ ...entrada, procedimento: acrescentarAoProcedimento(proc, fatos) });
  assert.equal(JSON.stringify(depois), congelado, 'a decisão pura da L1b é idêntica');
  assert.ok(!marcos(depois).includes('MASTER_APRESENTADO'));
  // Conferência NÃO CONFORME (ou de outro arquivo) não vira "termo conferido".
  const fatos2 = fatosDocumentaisParaL1b('M1', situacaoDaAgencia('M1', armador('EVERGREEN')), [termo], [assinatura(termo.documentoId)], [],
    [{ ...conf[0], resultado: 'NAO_CONFORME', constatacao: 'ASSINATURA_INVALIDA', observacao: 'x' }, { ...conf[0], conferenciaId: 'conf-2', arquivoSha256: 'e'.repeat(64) }]);
  assert.ok(!fatos2.mantidosNoDominioDocumental.some((x) => x.fato === 'TERMO_EVERGREEN_CONFERIDO'));
});
