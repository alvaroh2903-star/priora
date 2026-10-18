import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  AssinaturaRegistrada, CORPO_AGENDAMENTO_GRIEG, DocumentoPreparado, EntradaDoEmail, EnvioRespondido, ModeloEmUso, PlanoDePreenchimento, SinalDeRejeicao,
  TIPOS_DE_DOCUMENTO, TentativaDeEnvio, VersaoDoModelo, assuntoAgendamentoGrieg, avaliarEnvio, avaliarSinalDeRejeicao, canonico, conciliar, entradaDoCatalogo,
  modeloVigente, montarRascunho, planejarPreenchimento, podeValidar, selecionarModelo, situacaoDoModelo, situacaoDoPreparo, situacaoDocumental,
  substitutoJaCadastrado, transicaoDoEnvioPermitida, transicaoDoModeloPermitida, ultimoEnvioConfirmado, valorNoFormato, verificarDefinicao,
  ConferenciaDaAssinatura, DefinicaoDoModelo, conferenciaDaAssinatura, assinaturaDoDocumento, DEFINICOES_PROPOSTAS, cadastroValido, signatarioDaOrganizacao,
  valoresDoSignatario, poderesValidos, usoDaRelacaoAnexa, itensDaLista, alteracaoPosteriorA, condicaoDaSolicitacaoDeAgendamento,
} from '..';
import {
  CLAUSULA, MASTER, PODERES_SINTETICOS, SIGNATARIO_SINTETICO, copiaMbl, definicaoEvergreen, definicaoMemorando, destinatarios, layoutSintetico, valor,
} from './fixtures';

/** Domínio documental puro: nenhum banco, Graph, PDF real ou relógio. */

const mbl = (v = 'EGLVTESTE0001', m = MASTER) => valor('MBL', v, 'S6_MASTER', { tipo: 'MASTER', masterId: m });
const navio = (v = 'NAVIO TESTE') => valor('NOME_DO_NAVIO', v, 'S3_VIAGEM', { tipo: 'MASTER', masterId: MASTER });
const data = (v = '2026-10-14') => valor('DATA_DA_GERACAO', v, 'GERACAO', { tipo: 'DOCUMENTO' });
const CTX = { masterId: MASTER, processoIds: ['IM100'], modalidade: { tipo: 'DESCONHECIDA' as const }, signatario: 'sig-legal-1' as string | null };
const FISICO = { tipo: 'UNICA' as const, modalidade: 'FISICO' as const, evidencia: { fonte: 'courier', ref: 'x' } };
const emUso = (definicao = definicaoEvergreen()): ModeloEmUso => ({ modeloId: 'mod-1', versao: 'sintetica-1', arquivoSha256: 'f'.repeat(64), definicao });
const ESCOLHA = (alternativas: string[], por = 'm-analista') => ({ grupo: 'servico', alternativas, por, em: '2026-10-14T12:00:00.000Z' });

const pronto = (r: ReturnType<typeof planejarPreenchimento>): PlanoDePreenchimento => {
  assert.equal(r.tipo, 'PRONTO', JSON.stringify(r));
  return (r as { plano: PlanoDePreenchimento }).plano;
};
const problemas = (r: ReturnType<typeof planejarPreenchimento>) => (r.tipo === 'INCOMPLETO' ? r.problemasDeOpcao : []);

const doc = (p: Partial<DocumentoPreparado> = {}): DocumentoPreparado => ({
  documentoId: 'doc-1', tipo: 'TERMO_EVERGREEN', masterId: MASTER, modelo: { modeloId: 'mod-1', versao: 'sintetica-1' }, conteudoSha256: 'c'.repeat(64),
  arquivoSha256: 'a'.repeat(64), gerador: { id: 'g', versao: '1' }, processoIdsNaPreparacao: ['IM100'], preparadoEm: '2026-10-14T13:00:00.000Z', preparadoPor: 'm-analista',
  signatario: null, selecoes: [], escolhas: [], informados: [],
  conteudo: {
    tipo: p.tipo ?? 'TERMO_EVERGREEN', modelo: { modeloId: 'mod-1', versao: 'sintetica-1', arquivoSha256: 'f'.repeat(64) }, masterId: MASTER, campos: [], opcoes: [],
    blocosFixos: [], assinaturaReservada: null,
  },
  ...p,
});
const assinatura = (p: Partial<AssinaturaRegistrada> = {}): AssinaturaRegistrada => ({
  assinaturaId: 'ass-1', documentoId: 'doc-1', arquivoSha256: 'b'.repeat(64), registradoPor: 'm-analista', registradoEm: '2026-10-14T14:00:00.000Z',
  verificacao: 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO', signatarioEsperado: null, substituicao: null, ...p,
});
const tentativa = (estado: TentativaDeEnvio['estado'], p: Partial<TentativaDeEnvio> = {}): TentativaDeEnvio => ({
  envioId: 'envio-1', fluxo: 'AGENDAMENTO_APRESENTACAO_GRIEG', masterId: MASTER, documentoId: 'doc-1', assinaturaId: 'ass-1', modeloId: 'mod-1', chave: 'k',
  analista: { membershipId: 'm-analista', contaMicrosoft: 'conta-analista' }, reenvio: null, estado, abertoEm: '2026-10-14T15:00:00.000Z',
  atualizadoEm: '2026-10-14T15:00:00.000Z', concluidoEm: ['ENVIO_CONFIRMADO', 'ENVIO_NAO_REALIZADO'].includes(estado) ? '2026-10-14T15:01:00.000Z' : null,
  composicao: { assunto: assuntoAgendamentoGrieg('EGLVTESTE0001'), corpo: CORPO_AGENDAMENTO_GRIEG, para: ['agendamento@agencia.teste'], cc: [] },
  anexos: [{ papel: 'TERMO_EVERGREEN_ASSINADO', nome: 'T.pdf', contentType: 'application/pdf', sha256: 'b'.repeat(64), tamanho: 1, origem: { tipo: 'ASSINATURA', assinaturaId: 'ass-1', documentoId: 'doc-1' } }],
  rascunho: estado === 'PREPARANDO_RASCUNHO' ? null : { id: 'r-1', internetMessageId: '<r-1@x>', conversationId: 'conv-1' },
  confirmacao: estado === 'ENVIO_CONFIRMADO' ? { enviadaEm: '2026-10-14T15:01:00.000Z', internetMessageId: '<r-1@x>', conversationId: 'conv-1', conferencia: { tipo: 'CONFORME' } } : null,
  falha: estado === 'ENVIO_NAO_REALIZADO' ? 'x' : null, ...p,
});
const emailOk = (p: Partial<EntradaDoEmail> = {}): EntradaDoEmail => ({
  masterId: MASTER, mbls: ['EGLVTESTE0001'], preparo: { tipo: 'PREPARADO', documento: doc() }, assinatura: assinatura(), pendenciaDoTermo: null,
  estadoDoModeloDoDocumento: 'VALIDADO',
  candidatosMbl: [copiaMbl()], mblEscolhido: null, destinatarios: destinatarios(), tentativas: [], autorizacao: { tipo: 'PERMITIDA', referencia: 'l1b' }, reenvio: null, ...p,
});
const motivos = (e: EntradaDoEmail) => (avaliarEnvio(e) as { motivos?: string[] }).motivos;

/* ------------------------------------------ catálogo ------------------------------------------ */

test('[UNI-01] seleção pelo armador: Evergreen → termo; MSC, Hapag-Lloyd e ZIM → o memorando PRÓPRIO; sem modelo, nada se improvisa', () => {
  const sel = (codigo: string | null) => {
    const s = selecionarModelo(MASTER, codigo === null ? null : { masterId: MASTER, codigo });
    return s.tipo === 'SELECIONADO' ? s.entrada.tipo : s.tipo;
  };
  assert.deepEqual([sel('EVERGREEN'), sel('MSC'), sel('Hapag-Lloyd'), sel('HAPAG LLOYD'), sel('ZIM')],
    ['TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR']);
  for (const c of ['ONE', 'PIL', 'HMM', 'CMA CGM', 'COSCO', 'OOCL', 'YANG MING', 'MAERSK']) assert.equal(sel(c), 'SEM_MODELO_CONFIGURADO', c);
  assert.equal(sel('WAN HAI'), 'PROCEDIMENTO_NAO_MAPEADO');
  assert.equal(sel('hapag'), 'PROCEDIMENTO_NAO_MAPEADO', 'código de tracking não é o código do armador');
  assert.equal(sel(null), 'ARMADOR_NAO_IDENTIFICADO');
  assert.deepEqual(selecionarModelo(MASTER, { masterId: 'OUTRO', codigo: 'EVERGREEN' }), { tipo: 'ARMADOR_NAO_IDENTIFICADO' });
  assert.equal(new Set(TIPOS_DE_DOCUMENTO.map((t) => entradaDoCatalogo(t).exemploDeReferencia)).size, 4);
  assert.equal(entradaDoCatalogo('MEMORANDO_ZIM_ROCHAMAR').agencia, entradaDoCatalogo('MEMORANDO_HAPAG_ROCHAMAR').agencia);
});

test('[UNI-02] definição: sintética passa; exemplo vazado, sem marcadores, sem fonte, ID repetido, regra sem fundamento ou sem lugar de assinatura são recusados', () => {
  assert.deepEqual(verificarDefinicao(definicaoEvergreen(), 'TERMO_EVERGREEN'), []);
  for (const t of ['MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as const) assert.deepEqual(verificarDefinicao(definicaoMemorando(t), t), []);
  const vazada = definicaoEvergreen({ blocosFixos: [{ id: 'clausula', natureza: 'TEXTO_JURIDICO', texto: `Navio: navio  do exemplo — ${CLAUSULA}` }] });
  assert.deepEqual(verificarDefinicao(vazada, 'TERMO_EVERGREEN'), [{ tipo: 'EXEMPLO_NO_TEXTO_FIXO', bloco: 'clausula', marcador: 'NAVIO DO EXEMPLO' }]);
  assert.deepEqual(verificarDefinicao(definicaoEvergreen({ marcadoresDoExemplo: [] }), 'TERMO_EVERGREEN'), [{ tipo: 'EXEMPLO_SEM_MARCADORES' }]);
  // Decisão 14.9: todos os documentos exigem o lugar da assinatura humana — memorandos inclusive.
  assert.deepEqual(verificarDefinicao(definicaoMemorando('MEMORANDO_MSC', { assinatura: null }), 'MEMORANDO_MSC'), [{ tipo: 'ASSINATURA_EXIGIDA_SEM_LUGAR' }]);
  assert.deepEqual(verificarDefinicao(definicaoEvergreen({ assinatura: { id: 'bl', rotulo: 'x' } }), 'TERMO_EVERGREEN'), [{ tipo: 'ID_DUPLICADO', id: 'bl' }]);
  const semFonte = definicaoEvergreen({ campos: [{ id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: [], escopo: 'MASTER' }] });
  assert.deepEqual(verificarDefinicao(semFonte, 'TERMO_EVERGREEN'), [{ tipo: 'CAMPO_SEM_FONTE', campo: 'bl' }]);
  const regras = (r: Array<{ id: string; grupo: string; alternativa: string; quandoModalidade: 'FISICO' | 'WAVE'; fundamento: string }>) =>
    verificarDefinicao(definicaoMemorando('MEMORANDO_MSC', { regras: r }), 'MEMORANDO_MSC');
  assert.deepEqual(regras([{ id: 'R', grupo: 'servico', alternativa: 'SERVICO_Z', quandoModalidade: 'FISICO', fundamento: 'x' }]),
    [{ tipo: 'REGRA_INVALIDA', regra: 'R', motivo: 'GRUPO_OU_ALTERNATIVA_INEXISTENTE' }]);
  assert.deepEqual(regras([{ id: 'R', grupo: 'servico', alternativa: 'SERVICO_C', quandoModalidade: 'FISICO', fundamento: ' ' }]),
    [{ tipo: 'REGRA_INVALIDA', regra: 'R', motivo: 'SEM_FUNDAMENTO' }]);
  assert.deepEqual(regras([{ id: 'R', grupo: 'servico', alternativa: 'SERVICO_A', quandoModalidade: 'WAVE', fundamento: 'x' }]),
    [{ tipo: 'REGRA_INVALIDA', regra: 'R', motivo: 'ALTERNATIVA_INCOMPATIVEL_COM_A_MODALIDADE' }]);
  // A definição de um memorando nunca serve para outro.
  assert.deepEqual(verificarDefinicao(definicaoMemorando('MEMORANDO_HAPAG_ROCHAMAR'), 'MEMORANDO_ZIM_ROCHAMAR'),
    [{ tipo: 'TIPO_DIFERENTE_DO_CATALOGO', esperado: 'MEMORANDO_ZIM_ROCHAMAR', recebido: 'MEMORANDO_HAPAG_ROCHAMAR' }]);
});

/* ---------------------------------------- preenchimento ---------------------------------------- */

test('[UNI-03] preenchimento só com dados confiáveis, cada valor com a sua fonte; nada do exemplo; assinatura reservada', () => {
  const p = pronto(planejarPreenchimento(emUso(), [mbl(), navio(), data()], [], CTX));
  assert.deepEqual(p.conteudo.campos, [{ campo: 'bl', valor: 'EGLVTESTE0001' }, { campo: 'navio', valor: 'NAVIO TESTE' }, { campo: 'data', valor: '2026-10-14' }]);
  assert.deepEqual(p.conteudo.modelo, { modeloId: 'mod-1', versao: 'sintetica-1', arquivoSha256: 'f'.repeat(64) });
  assert.deepEqual([p.conteudo.blocosFixos, p.conteudo.assinaturaReservada], [['clausula', 'tarifas'], 'assinatura']);
  assert.deepEqual(p.proveniencia.map((x) => [x.campo, x.fontes.map((f) => f.fonte)]), [['bl', ['S6_MASTER']], ['navio', ['S3_VIAGEM']], ['data', ['GERACAO']]]);
  for (const m of definicaoEvergreen().marcadoresDoExemplo) assert.ok(!JSON.stringify(p).toUpperCase().includes(m.toUpperCase()), m);
});

test('[UNI-04] dado ausente nunca é inventado; fonte não aceita, outro Master, processo não vinculado e valor vazio são recusados; divergência não escolhe', () => {
  const falta = planejarPreenchimento(emUso(), [mbl(), data()], [], CTX);
  assert.deepEqual(falta.tipo === 'INCOMPLETO' && falta.faltantes, [{ campo: 'navio', rotulo: 'Navio', dado: 'NOME_DO_NAVIO', fontesAceitas: ['S3_VIAGEM'] }]);
  const r = planejarPreenchimento(emUso(), [valor('MBL', 'X', 'S2_AUDITORIA', { tipo: 'MASTER', masterId: MASTER }), mbl('OUTRO', 'M2'), navio('  '), data()], [], CTX);
  assert.deepEqual(r.recusados.map((x) => x.motivo).sort(), ['FONTE_NAO_ACEITA', 'OUTRO_MASTER', 'VALOR_VAZIO']);
  const porProcesso = emUso(definicaoEvergreen({ campos: [{ id: 'im', rotulo: 'IM', dado: 'CODIGO_DO_PROCESSO', obrigatorio: true, fontesAceitas: ['S6_PROCESSO'], escopo: 'PROCESSO' }] }));
  assert.equal(planejarPreenchimento(porProcesso, [valor('CODIGO_DO_PROCESSO', 'IM999', 'S6_PROCESSO', { tipo: 'PROCESSO', processoId: 'IM999' })], [], CTX).recusados[0].motivo, 'PROCESSO_NAO_VINCULADO');
  const div = planejarPreenchimento(emUso(), [mbl(), navio('A'), { ...navio('B'), evidencia: { fonte: 's3', ref: 'outra' } }, data()], [], CTX);
  assert.deepEqual(div.tipo === 'INCOMPLETO' && div.divergentes[0].valores.map((v) => v.valor), ['A', 'B']);
  // Texto fixo, tabela e assinatura não são alcançáveis por dado nenhum.
  const tentativa = planejarPreenchimento(emUso(), [mbl(), navio(), data(), valor('assinatura', 'ASSINATURA SIMULADA', 'S4_PESSOA', { tipo: 'DOCUMENTO' }), valor('clausula', 'TROCADO', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })], [], CTX);
  assert.deepEqual(tentativa.recusados.map((x) => x.motivo), ['DADO_SEM_CAMPO', 'DADO_SEM_CAMPO']);
  assert.ok(!canonico(pronto(tentativa).conteudo).includes('SIMULADA'));
});

test('[UNI-05] opções: regra explícita + modalidade provada seleciona (com origem); sem regra/evidência, ambígua ou contrária à regra → Analista; incompatíveis recusadas', () => {
  const regra = { id: 'R1', grupo: 'servico', alternativa: 'SERVICO_A', quandoModalidade: 'FISICO' as const, fundamento: 'SINTÉTICA' };
  const d = emUso(definicaoMemorando('MEMORANDO_MSC', { regras: [regra] }));
  const auto = pronto(planejarPreenchimento(d, [mbl()], [], { ...CTX, modalidade: FISICO }));
  assert.deepEqual(auto.selecoes, [{ grupo: 'servico', alternativas: ['SERVICO_A'], origem: { tipo: 'REGRA', regras: [{ id: 'R1', fundamento: 'SINTÉTICA' }], evidencia: FISICO.evidencia } }]);
  assert.deepEqual(auto.escolhas, []);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [], CTX)), [{ tipo: 'ESCOLHA_PENDENTE', grupo: 'servico', motivo: 'SEM_REGRA_OU_EVIDENCIA' }]);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [], { ...CTX, modalidade: { tipo: 'AMBIGUA', modalidades: ['FISICO', 'WAVE'] } })),
    [{ tipo: 'ESCOLHA_PENDENTE', grupo: 'servico', motivo: 'MODALIDADE_AMBIGUA' }]);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_C'])], { ...CTX, modalidade: FISICO })),
    [{ tipo: 'ESCOLHA_DIVERGE_DA_REGRA', grupo: 'servico', determinada: ['SERVICO_A'], escolhida: ['SERVICO_C'] }]);
  const wave = { tipo: 'UNICA' as const, modalidade: 'WAVE' as const, evidencia: { fonte: 'e', ref: 'w' } };
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_A'])], { ...CTX, modalidade: wave })),
    [{ tipo: 'INCOMPATIVEL_COM_A_MODALIDADE', grupo: 'servico', alternativa: 'SERVICO_A', modalidade: 'WAVE' }]);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_A'])], CTX)),
    [{ tipo: 'MODALIDADE_NECESSARIA_PARA_A_ALTERNATIVA', grupo: 'servico', alternativa: 'SERVICO_A' }]);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_A', 'SERVICO_B'])], { ...CTX, modalidade: FISICO })).map((p) => p.tipo),
    ['ALTERNATIVAS_INCOMPATIVEIS', 'ESCOLHA_DIVERGE_DA_REGRA']);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_Z'])], CTX)), [{ tipo: 'ALTERNATIVA_INEXISTENTE', grupo: 'servico', alternativa: 'SERVICO_Z' }]);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_C'], ' ')], CTX)), [{ tipo: 'ESCOLHA_SEM_AUTOR', grupo: 'servico' }]);
  assert.deepEqual(problemas(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_C']), ESCOLHA(['SERVICO_B'], 'm-outro')], CTX)), [{ tipo: 'ESCOLHAS_CONFLITANTES', grupo: 'servico' }]);
  const humano = pronto(planejarPreenchimento(d, [mbl()], [ESCOLHA(['SERVICO_C', 'SERVICO_B'])], CTX));
  assert.deepEqual(humano.selecoes, [{ grupo: 'servico', alternativas: ['SERVICO_B', 'SERVICO_C'], origem: { tipo: 'ANALISTA', por: 'm-analista', em: '2026-10-14T12:00:00.000Z' } }]);
});

test('[UNI-06] conteúdo determinístico: mesma entrada, mesmo texto canônico; proveniência e horários não são conteúdo; versão do modelo é', () => {
  const a = pronto(planejarPreenchimento(emUso(), [mbl(), navio(), data()], [], CTX));
  const b = pronto(planejarPreenchimento(emUso(), [data(), { ...navio(), observadoEm: '2026-10-13T00:00:00.000Z' }, mbl()], [], CTX));
  assert.equal(canonico(a.conteudo), canonico(b.conteudo));
  const outraVersao = pronto(planejarPreenchimento({ ...emUso(), modeloId: 'mod-2', versao: 'v2' }, [mbl(), navio(), data()], [], CTX));
  assert.notEqual(canonico(a.conteudo), canonico(outraVersao.conteudo));
  assert.equal(canonico({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test('[UNI-07] preparo: vigente quando os dados de agora escrevem o mesmo PDF; dado usado no PDF mudou → desatualizado com os itens; sem como comparar → não verificável (DOC-31.B)', () => {
  const d1 = doc({ conteudoSha256: '1'.repeat(64) });
  const nada = { alteracoes: [], naoVerificados: [] };
  assert.deepEqual(situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [], 'x'), { tipo: 'NAO_PREPARADO' });
  assert.equal(situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [d1], '1'.repeat(64)).tipo, 'PREPARADO');
  // Conteúdo diferente, mas o PDF mostraria o mesmo: continua vigente (nenhuma versão nova sem necessidade).
  assert.deepEqual(situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [d1], '2'.repeat(64), () => nada), { tipo: 'PREPARADO', documento: d1 });
  const bl = { alteracoes: [{ tipo: 'CAMPO' as const, campo: 'bl' }], naoVerificados: [] };
  assert.deepEqual(situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [d1], '2'.repeat(64), () => bl), { tipo: 'DESATUALIZADO', documento: d1, motivo: 'CONTEUDO_MUDOU', ...bl });
  // Sem como comparar, ou com dado usado no PDF sem valor confiável: nada é presumido igual.
  const semValor = { alteracoes: [], naoVerificados: [{ tipo: 'CAMPO' as const, campo: 'navio' }] };
  assert.deepEqual(situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [d1], null, () => semValor),
    { tipo: 'DESATUALIZADO', documento: d1, motivo: 'VIGENCIA_NAO_VERIFICAVEL', ...semValor });
  assert.equal((situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [d1], null, () => nada) as { motivo: string }).motivo, 'VIGENCIA_NAO_VERIFICAVEL');
  assert.equal((situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [d1], '2'.repeat(64)) as { motivo: string }).motivo, 'VIGENCIA_NAO_VERIFICAVEL');
  assert.deepEqual(situacaoDoPreparo(MASTER, 'TERMO_EVERGREEN', [doc({ masterId: 'M2' }), doc({ tipo: 'MEMORANDO_MSC' })], 'c'.repeat(64)), { tipo: 'NAO_PREPARADO' });
});

/* -------------------------------------------- e-mail -------------------------------------------- */

test('[UNI-08] solicitação de agendamento: assunto e corpo aprovados; sem destinatário presumido; rascunho possível antes da assinatura', () => {
  const r = montarRascunho(emailOk({ destinatarios: null, assinatura: null }));
  assert.equal(r.assunto, 'Solicitação de agendamento de apresentação de BL – EGLVTESTE0001');
  assert.equal(r.corpo, 'Prezados, boa tarde.\nSegue em anexo o termo Evergreen preenchido e assinado, juntamente com a cópia do MBL, para agendamento de apresentação do BL para desbloqueio.\nAtenciosamente,');
  assert.deepEqual([r.para, r.cc], [[], []]);
  assert.deepEqual(r.anexos[0], { papel: 'TERMO_EVERGREEN_ASSINADO', estado: 'PENDENTE', motivo: 'ASSINATURA_HUMANA_PENDENTE' });
});

test('[UNI-09] trava da tentativa: assinatura, MBL em PDF do Master, destinatário validado, versão não rejeitada e permissão — todos os motivos listados', () => {
  assert.deepEqual(motivos(emailOk({ assinatura: null })), ['ASSINATURA_HUMANA_PENDENTE']);
  assert.deepEqual(motivos(emailOk({ assinatura: assinatura({ documentoId: 'doc-velho' }) })), ['ASSINATURA_HUMANA_PENDENTE']);
  assert.deepEqual(motivos(emailOk({ candidatosMbl: [] })), ['MBL_EM_PDF_AUSENTE']);
  assert.deepEqual(motivos(emailOk({ candidatosMbl: [copiaMbl({ contentType: 'image/jpeg' })] })), ['MBL_EM_PDF_AUSENTE']);
  const duas = [copiaMbl(), copiaMbl({ extracaoId: 'ext-2', messageId: 'msg-2', attachmentId: 'anexo-2' })];
  assert.deepEqual(motivos(emailOk({ candidatosMbl: duas })), ['MBL_AMBIGUO']);
  assert.deepEqual(motivos(emailOk({ candidatosMbl: duas, mblEscolhido: 'ext-9' })), ['ESCOLHA_DE_MBL_INVALIDA']);
  assert.equal(avaliarEnvio(emailOk({ candidatosMbl: duas, mblEscolhido: 'ext-2' })).tipo, 'PODE_PREPARAR_RASCUNHO');
  assert.deepEqual(motivos(emailOk({ estadoDoModeloDoDocumento: 'REJEITADO_PELA_AGENCIA' })), ['MODELO_REJEITADO_PELA_AGENCIA']);
  assert.deepEqual(motivos(emailOk({ destinatarios: null, autorizacao: { tipo: 'NAO_DETERMINADA', motivo: 'x' }, mbls: ['A', 'B'] })),
    ['MBL_DO_MASTER_INDETERMINADO', 'DESTINATARIOS_NAO_VALIDADOS', 'PERMISSAO_DA_ACAO_NAO_DETERMINADA']);
  assert.deepEqual(motivos(emailOk({ autorizacao: { tipo: 'NAO_PERMITIDA', motivo: 'IM101 com Termo pendente' } })), ['ACAO_NAO_PERMITIDA']);
  assert.deepEqual(motivos(emailOk({ preparo: { tipo: 'NAO_PREPARADO' }, assinatura: null })), ['TERMO_NAO_PREPARADO']);
});

test('[UNI-10] tentativas: aberta impede outra; incerta exige conciliação; confirmada só aceita reenvio explícito, do último envio, com motivo e autorizador', () => {
  assert.equal(avaliarEnvio(emailOk({ tentativas: [tentativa('RASCUNHO_DISPONIVEL')] })).tipo, 'TENTATIVA_ABERTA');
  assert.equal(avaliarEnvio(emailOk({ tentativas: [tentativa('ENVIO_SOLICITADO')] })).tipo, 'TENTATIVA_ABERTA');
  assert.equal(avaliarEnvio(emailOk({ tentativas: [tentativa('RESULTADO_INCERTO')] })).tipo, 'CONCILIACAO_NECESSARIA');
  assert.equal(avaliarEnvio(emailOk({ tentativas: [tentativa('ENVIO_NAO_REALIZADO')] })).tipo, 'PODE_PREPARAR_RASCUNHO');
  assert.equal(avaliarEnvio(emailOk({ tentativas: [tentativa('ENVIO_CONFIRMADO')] })).tipo, 'JA_ENVIADO');
  assert.equal(avaliarEnvio(emailOk({ tentativas: [tentativa('ENVIO_CONFIRMADO', { masterId: 'M2' })] })).tipo, 'PODE_PREPARAR_RASCUNHO');
  const confirmada = [tentativa('ENVIO_CONFIRMADO')];
  const ok = avaliarEnvio(emailOk({ tentativas: confirmada, reenvio: { de: 'envio-1', motivo: 'correção pedida', autorizadoPor: 'm-gestor' } }));
  assert.equal(ok.tipo, 'PODE_PREPARAR_RASCUNHO');
  assert.deepEqual(motivos(emailOk({ tentativas: confirmada, reenvio: { de: 'outro', motivo: ' ', autorizadoPor: '' } })),
    ['REENVIO_DESATUALIZADO', 'REENVIO_SEM_MOTIVO', 'REENVIO_SEM_AUTORIZADOR']);
  assert.deepEqual(motivos(emailOk({ reenvio: { de: 'x', motivo: 'm', autorizadoPor: 'g' } })), ['REENVIO_SEM_ENVIO_ANTERIOR']);
  // A chave da intenção muda com o reenvio (não é a mesma intenção do envio original).
  assert.notEqual((ok as { chave: string }).chave, (avaliarEnvio(emailOk()) as { chave: string }).chave);
  // Cadeia de reenvios define o último confirmado, mesmo com o mesmo instante.
  const r2 = tentativa('ENVIO_CONFIRMADO', { envioId: 'envio-0', reenvio: { de: 'envio-1', motivo: 'm', autorizadoPor: 'g' } });
  assert.equal(ultimoEnvioConfirmado(MASTER, 'AGENDAMENTO_APRESENTACAO_GRIEG', [tentativa('ENVIO_CONFIRMADO'), r2])?.envioId, 'envio-0');
});

test('[UNI-11] transições permitidas (o banco aplica as mesmas)', () => {
  assert.ok(transicaoDoEnvioPermitida('PREPARANDO_RASCUNHO', 'RASCUNHO_DISPONIVEL'));
  assert.ok(transicaoDoEnvioPermitida('RASCUNHO_DISPONIVEL', 'ENVIO_CONFIRMADO'), 'enviado pelo Outlook, visto na conciliação');
  assert.ok(transicaoDoEnvioPermitida('RESULTADO_INCERTO', 'ENVIO_NAO_REALIZADO'), 'conciliação humana');
  assert.ok(!transicaoDoEnvioPermitida('PREPARANDO_RASCUNHO', 'ENVIO_CONFIRMADO'), 'sem rascunho não há envio');
  assert.ok(!transicaoDoEnvioPermitida('ENVIO_CONFIRMADO', 'RASCUNHO_DISPONIVEL'));
  assert.ok(!transicaoDoEnvioPermitida('ENVIO_NAO_REALIZADO', 'RASCUNHO_DISPONIVEL'));
  assert.ok(!transicaoDoEnvioPermitida('ENVIO_SOLICITADO', 'ENVIO_NAO_REALIZADO'), 'pedido de envio nunca vira "não realizado" sem conciliar');
  assert.ok(transicaoDoModeloPermitida('PENDENTE_DE_VALIDACAO', 'VALIDADO'));
  assert.ok(transicaoDoModeloPermitida('VALIDADO', 'REJEITADO_PELA_AGENCIA'));
  assert.ok(!transicaoDoModeloPermitida('REJEITADO_PELA_AGENCIA', 'VALIDADO'));
  assert.ok(!transicaoDoModeloPermitida('PENDENTE_DE_VALIDACAO', 'REJEITADO_PELA_AGENCIA'));
});

test('[UNI-12] conciliação: só "enviada com data de envio" confirma; sumida é incerta; rascunho continua rascunho; alteração registrada uma vez', () => {
  const enviada = { tipo: 'ENVIADA' as const, enviadaEm: '2026-10-14T16:00:00.000Z', internetMessageId: '<r-1@x>', conversationId: 'conv-1', assunto: assuntoAgendamentoGrieg('EGLVTESTE0001'),
    para: ['AGENDAMENTO@agencia.teste'], cc: [], anexos: [{ nome: 'T.pdf', sha256: 'b'.repeat(64), tamanho: 1 }] };
  assert.deepEqual(conciliar(tentativa('RASCUNHO_DISPONIVEL'), enviada, null), { tipo: 'TRANSICAO', para: 'ENVIO_CONFIRMADO', evento: 'ENVIO_CONFIRMADO', conferencia: { tipo: 'CONFORME' } });
  const alterada = conciliar(tentativa('RASCUNHO_DISPONIVEL'), { ...enviada, assunto: 'outro', anexos: [{ nome: 'X.pdf', sha256: '9'.repeat(64), tamanho: 1 }] }, null);
  assert.deepEqual(alterada.tipo === 'TRANSICAO' && alterada.conferencia, { tipo: 'DIVERGENTE', divergencias: ['ASSUNTO_ALTERADO', 'ANEXO_AUSENTE:TERMO_EVERGREEN_ASSINADO', 'ANEXO_NAO_PREPARADO:X.pdf'] });
  assert.deepEqual(conciliar(tentativa('RASCUNHO_DISPONIVEL'), { tipo: 'NAO_ENCONTRADA' }, null), { tipo: 'TRANSICAO', para: 'RESULTADO_INCERTO', evento: 'RESULTADO_INCERTO' });
  assert.deepEqual(conciliar(tentativa('RESULTADO_INCERTO'), { tipo: 'NAO_ENCONTRADA' }, null), { tipo: 'SEM_MUDANCA' });
  assert.deepEqual(conciliar(tentativa('ENVIO_SOLICITADO'), { tipo: 'RASCUNHO', changeKey: 'k1' }, 'k1'), { tipo: 'TRANSICAO', para: 'RASCUNHO_DISPONIVEL', evento: 'RASCUNHO_AINDA_NAO_ENVIADO' });
  assert.deepEqual(conciliar(tentativa('RASCUNHO_DISPONIVEL'), { tipo: 'RASCUNHO', changeKey: 'k2' }, 'k1'), { tipo: 'RASCUNHO_ALTERADO', changeKey: 'k2' });
  assert.deepEqual(conciliar(tentativa('RASCUNHO_DISPONIVEL'), { tipo: 'RASCUNHO', changeKey: 'k1' }, 'k1'), { tipo: 'SEM_MUDANCA' });
  assert.deepEqual(conciliar(tentativa('ENVIO_CONFIRMADO'), { tipo: 'NAO_ENCONTRADA' }, null), { tipo: 'SEM_MUDANCA' }, 'confirmado é terminal');
  assert.deepEqual(conciliar(tentativa('PREPARANDO_RASCUNHO'), enviada, null), { tipo: 'SEM_MUDANCA' });
});

/* ---------------------------------------- versões de modelo ---------------------------------------- */

const versao = (p: Partial<VersaoDoModelo> = {}): VersaoDoModelo => ({
  modeloId: 'mod-1', tipo: 'TERMO_EVERGREEN', versao: 'v1', arquivoSha256: 'f'.repeat(64), origem: { tipo: 'CADASTRO', por: 'm-analista' },
  definicao: definicaoEvergreen(), estado: 'VALIDADO', cadastradoEm: '2026-10-01T00:00:00.000Z', validacao: { por: 'm-gestor', em: '2026-10-02T00:00:00.000Z' }, rejeicao: null, ...p,
});

test('[UNI-13] versão vigente: a validada mais recente e não rejeitada; pendente nunca entra em uso; validação exige leitura coerente e autor', () => {
  const v1 = versao();
  const v2 = versao({ modeloId: 'mod-2', versao: 'v2', validacao: { por: 'm-gestor', em: '2026-10-05T00:00:00.000Z' } });
  const pend = versao({ modeloId: 'mod-3', versao: 'v3', estado: 'PENDENTE_DE_VALIDACAO', validacao: null });
  assert.equal(modeloVigente('TERMO_EVERGREEN', [v1, v2, pend])?.modeloId, 'mod-2');
  assert.equal(modeloVigente('TERMO_EVERGREEN', [v1, { ...v2, estado: 'REJEITADO_PELA_AGENCIA' }])?.modeloId, 'mod-1');
  assert.equal(modeloVigente('MEMORANDO_MSC', [v1]), null);
  assert.deepEqual(situacaoDoModelo('TERMO_EVERGREEN', [{ ...v1, estado: 'REJEITADO_PELA_AGENCIA' }, pend]).tipo, 'SEM_VERSAO_VALIDADA');
  assert.deepEqual(podeValidar(pend, 'm-analista'), { tipo: 'PODE_VALIDAR' });
  assert.deepEqual(podeValidar({ ...pend, definicao: null }, 'm-analista'), { tipo: 'NAO_PODE_VALIDAR', motivo: 'SEM_DEFINICAO' });
  assert.deepEqual(podeValidar(pend, ' '), { tipo: 'NAO_PODE_VALIDAR', motivo: 'SEM_AUTOR' });
  assert.deepEqual(podeValidar(v1, 'm-analista'), { tipo: 'NAO_PODE_VALIDAR', motivo: 'NAO_ESTA_PENDENTE' });
  assert.equal(podeValidar({ ...pend, definicao: definicaoEvergreen({ assinatura: null }) }, 'x').tipo, 'NAO_PODE_VALIDAR');
  assert.equal(substitutoJaCadastrado('TERMO_EVERGREEN', 'f'.repeat(64), [v1])?.modeloId, 'mod-1');
  assert.equal(substitutoJaCadastrado('TERMO_EVERGREEN', 'e'.repeat(64), [v1]), null);
});

test('[UNI-14] sinal de rejeição: só inequívoco + resposta a um envio confirmado desta versão + remetente confiável confirma; o resto vai para pessoa', () => {
  const envio: EnvioRespondido = { envioId: 'envio-1', confirmado: true, modeloId: 'mod-1', destinatarios: ['agendamento@agencia.teste'], internetMessageId: '<r-1@x>', conversationId: 'conv-1' };
  const sinal = (p: Partial<SinalDeRejeicao> = {}, email: Partial<SinalDeRejeicao['email']> = {}): SinalDeRejeicao => ({
    sinalId: 's', modeloId: 'mod-1', envioId: 'envio-1', leitura: 'INEQUIVOCA', trecho: 't',
    email: { messageId: 'm', internetMessageId: null, conversationId: null, emRespostaA: '<r-1@x>', remetente: 'Agendamento@Agencia.teste', recebidaEm: '2026-10-15T00:00:00.000Z', ...email }, ...p,
  });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal(), versao(), envio), { tipo: 'REJEICAO_CONFIRMADA' });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { emRespostaA: null, conversationId: 'conv-1' }), versao(), envio), { tipo: 'REJEICAO_CONFIRMADA' });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({ leitura: 'AMBIGUA' }), versao(), envio), { tipo: 'VALIDACAO_HUMANA', motivos: ['LEITURA_AMBIGUA'] });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { remetente: 'x@agencia.teste' }), versao(), envio), { tipo: 'VALIDACAO_HUMANA', motivos: ['REMETENTE_NAO_CONFIAVEL'] });
  // Decisão 4.5: outro funcionário da agência pode responder — só se o domínio/endereço foi VALIDADO e a autenticação do e-mail foi aprovada.
  const validados = { enderecos: [], dominios: ['agencia.teste'] };
  const colega = { remetente: 'Colega@Agencia.Teste' };
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { ...colega, autenticacaoDoRemetente: 'APROVADA' }), versao(), envio, validados), { tipo: 'REJEICAO_CONFIRMADA' });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, colega), versao(), envio, validados), { tipo: 'VALIDACAO_HUMANA', motivos: ['REMETENTE_NAO_CONFIAVEL'] }, 'autenticação desconhecida');
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { ...colega, autenticacaoDoRemetente: 'REPROVADA' }), versao(), envio, validados), { tipo: 'VALIDACAO_HUMANA', motivos: ['REMETENTE_NAO_CONFIAVEL'] });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { remetente: 'x@agencia.teste.falsa.com', autenticacaoDoRemetente: 'APROVADA' }), versao(), envio, validados), { tipo: 'VALIDACAO_HUMANA', motivos: ['REMETENTE_NAO_CONFIAVEL'] }, 'domínio parecido não vale');
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { ...colega, autenticacaoDoRemetente: 'APROVADA' }), versao(), envio, null), { tipo: 'VALIDACAO_HUMANA', motivos: ['REMETENTE_NAO_CONFIAVEL'] }, 'sem configuração validada');
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { remetente: 'gerente@outra.teste', autenticacaoDoRemetente: 'APROVADA' }), versao(), envio, { enderecos: ['Gerente@Outra.teste'], dominios: [] }), { tipo: 'REJEICAO_CONFIRMADA' });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal({}, { emRespostaA: '<outra@x>' }), versao(), envio), { tipo: 'VALIDACAO_HUMANA', motivos: ['NAO_RESPONDE_AO_ENVIO'] });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal(), versao(), { ...envio, confirmado: false }), { tipo: 'VALIDACAO_HUMANA', motivos: ['ENVIO_NAO_CONFIRMADO'] });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal(), versao(), { ...envio, modeloId: 'mod-2' }), { tipo: 'VALIDACAO_HUMANA', motivos: ['ENVIO_DE_OUTRA_VERSAO'] });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal(), versao(), null), { tipo: 'VALIDACAO_HUMANA', motivos: ['ENVIO_NAO_CONFIRMADO'] });
  assert.deepEqual(avaliarSinalDeRejeicao(sinal(), versao({ estado: 'REJEITADO_PELA_AGENCIA' }), envio), { tipo: 'SEM_EFEITO', motivo: 'VERSAO_NAO_ESTA_EM_USO' });
});

test('[UNI-15] sem armador, fora da matriz ou sem modelo da agência: identificar/mapear/configurar — nunca gerar', () => {
  const p = (codigo: string | null) => situacaoDocumental({
    masterId: MASTER, selecao: selecionarModelo(MASTER, codigo ? { masterId: MASTER, codigo } : null), versoes: [], sinaisPendentes: [], preenchimento: null,
    conteudoAtualSha256: null, documentos: [], assinaturas: [], conferencias: [], signatarioLegal: null, poderesDoSignatario: null, email: null,
  }).proximoPasso?.passo;
  assert.deepEqual([p(null), p('WAN HAI'), p('ONE'), p('MAERSK'), p('EVERGREEN'), p('ZIM')], [
    'IDENTIFICAR_ARMADOR_DO_MASTER', 'VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO', 'CONFIGURAR_MODELO_DA_AGENCIA', 'CONFIGURAR_MODELO_DA_AGENCIA',
    'FORNECER_MODELO_OFICIAL', 'FORNECER_MODELO_OFICIAL',
  ]);
});

test('[UNI-16] domínio documental puro: imports só do próprio domínio e do índice da L1b; sem relógio, acaso, ambiente, I/O ou assincronia', () => {
  const dir = path.resolve(__dirname, '..', 'dominio');
  const PROIBIDOS: Array<[RegExp, string]> = [
    [/require\(|import\(/, 'carregamento dinâmico'],
    [/Date\.now\(|new Date\b|(?<![.\w])Date\(/, 'relógio'],
    [/Math\.random|crypto|randomUUID/, 'acaso'],
    [/process\.|globalThis|\bwindow\b|\bdocument\b/, 'ambiente'],
    [/setTimeout|setInterval|setImmediate|queueMicrotask|\bPromise\b|\basync\b|\bawait\b/, 'assincronia'],
    [/fetch\(|XMLHttpRequest|WebSocket|Pool\(|\.query\(|readFile|writeFile|createConnection/, 'I/O'],
    [/console\.|performance\./, 'efeito colateral'],
    [/resolvedOptions|getTimezoneOffset|toLocale|Intl\./, 'fuso do sistema'],
  ];
  // Texto de modelo oficial pode citar "demurrage" (cláusulas, rótulos): a referência proibida é a CÓDIGO de outro módulo.
  const OUTRO_MODULO: [RegExp, string] = [/demurrage|graphService/i, 'outro módulo'];
  const semTextos = (fonte: string) => fonte.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(arquivos.length >= 8);
  for (const f of arquivos) {
    const fonte = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const [, imp] of fonte.matchAll(/(?:from|import)\s+'([^']+)'/g)) assert.match(imp, /^(\.\/[a-zA-Z0-9]+|\.\.\/\.\.\/dominio)$/, `${f} importa ${imp}`);
    for (const [regra, motivo] of PROIBIDOS) assert.doesNotMatch(fonte, regra, `${f}: ${motivo}`);
    assert.doesNotMatch(semTextos(fonte), OUTRO_MODULO[0], `${f}: ${OUTRO_MODULO[1]}`);
  }
});

test('[UNI-17] formatos dos valores: data e hora válidas, CPF/CNPJ só dígitos com verificadores corretos, texto sem controle; layout coerente com a definição', () => {
  assert.ok(valorNoFormato('DATA_POR_EXTENSO', '2024-02-29'));
  for (const d of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '15/10/2026', '2026-10-1']) assert.equal(valorNoFormato('DATA_DD_MM_AAAA', d), false, d);
  assert.ok(valorNoFormato('HORA_HH_MM', '23:59'));
  for (const h of ['24:00', '9:30', '15 30', '12:60']) assert.equal(valorNoFormato('HORA_HH_MM', h), false, h);
  assert.ok(valorNoFormato('CPF', '12345678909'));
  for (const c of ['12345678900', '123.456.789-09', '11111111111', '1234567890']) assert.equal(valorNoFormato('CPF', c), false, c);
  assert.ok(valorNoFormato('CNPJ', '11222333000181'));
  for (const c of ['11222333000180', '11.222.333/0001-81', '00000000000000']) assert.equal(valorNoFormato('CNPJ', c), false, c);
  assert.ok(valorNoFormato('TEXTO', 'LINHA 1\nLINHA 2'));
  for (const t of ['', '   ', 'A\u0000B', 'A\tB']) assert.equal(valorNoFormato('TEXTO', t), false, JSON.stringify(t));
  // Layout: todo campo tem lugar, toda alternativa tem marca, nada sobre a assinatura, prefixo sem dado do exemplo.
  const d = definicaoMemorando('MEMORANDO_MSC');
  const l = d.layout!;
  assert.deepEqual(verificarDefinicao({ ...d, layout: null }, 'MEMORANDO_MSC'), [{ tipo: 'SEM_LAYOUT' }]);
  const { bl: _bl, ...semBl } = l.campos;
  assert.deepEqual(verificarDefinicao({ ...d, layout: { ...l, campos: semBl } }, 'MEMORANDO_MSC'), [{ tipo: 'LAYOUT_INVALIDO', item: 'bl', motivo: 'CAMPO_SEM_LUGAR' }]);
  assert.deepEqual(verificarDefinicao({ ...d, layout: { ...l, opcoes: {} } }, 'MEMORANDO_MSC').map((p) => p.tipo), ['LAYOUT_INVALIDO', 'LAYOUT_INVALIDO', 'LAYOUT_INVALIDO']);
  const sobre = { ...l.campos.bl, pagina: l.assinatura.pagina, x: l.assinatura.area.x + 5, y: l.assinatura.area.y + 10 };
  assert.deepEqual(verificarDefinicao({ ...d, layout: { ...l, campos: { ...l.campos, bl: sobre } } }, 'MEMORANDO_MSC'), [{ tipo: 'LAYOUT_SOBRE_A_ASSINATURA', item: 'bl' }]);
  const vazou = { ...l.campos.bl, prefixo: 'B/L BL-DO-EXEMPLO-0002 ' };
  assert.deepEqual(verificarDefinicao({ ...d, layout: { ...l, campos: { ...l.campos, bl: vazou } } }, 'MEMORANDO_MSC'), [{ tipo: 'EXEMPLO_NO_TEXTO_FIXO', bloco: 'bl', marcador: 'BL-DO-EXEMPLO-0002' }]);
});

/* ------------------------------ DOC-19, DOC-20, DOC-22..27 (domínio) ------------------------------ */

/** Definição SINTÉTICA com o nome do signatário legal (escopo SIGNATARIO) e um dado que o sistema OU o Analista podem fornecer. */
const comSignatario = (p: Partial<DefinicaoDoModelo> = {}): DefinicaoDoModelo => {
  const base = definicaoEvergreen({
    campos: [
      { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
      { id: 'quem', rotulo: 'Quem assina', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
      { id: 'local', rotulo: 'Local', dado: 'LOCAL', obrigatorio: true, fontesAceitas: ['S3_VIAGEM', 'ANALISTA'], escopo: 'DOCUMENTO' },
    ],
    ...p,
  });
  return { ...base, layout: layoutSintetico(base) };
};
const doSignatario = (id: string, v = `NOME DE ${id}`) => valor('SIGNATARIO_NOME', v, 'CADASTRO_DO_SIGNATARIO_LEGAL', { tipo: 'SIGNATARIO', signatarioId: id });
const localDoSistema = (v = 'TERMINAL A') => valor('LOCAL', v, 'S3_VIAGEM', { tipo: 'DOCUMENTO' });
const informado = (v: string) => ({ dado: 'LOCAL', valor: v, por: 'm-analista', em: '2026-10-14T12:00:00.000Z', referencia: 'combinado por telefone' });

test('[UNI-18] DOC-23: quem assina é o signatário legal do cadastro — só os dados DELE preenchem o escopo SIGNATARIO; de outro cadastro, do Analista ou da conta Microsoft são recusados', () => {
  const d = emUso(comSignatario());
  const ok = pronto(planejarPreenchimento(d, [mbl(), doSignatario('sig-legal-1'), doSignatario('sig-outro'), localDoSistema()], [], CTX));
  assert.equal(ok.conteudo.campos.find((c) => c.campo === 'quem')?.valor, 'NOME DE sig-legal-1');
  const r = planejarPreenchimento(d, [mbl(), doSignatario('sig-outro'), localDoSistema()], [], CTX);
  assert.equal(r.tipo, 'INCOMPLETO');
  assert.deepEqual(r.recusados.map((x) => [x.valor.dado, x.motivo]), [['SIGNATARIO_NOME', 'OUTRO_SIGNATARIO']]);
  assert.deepEqual((r as { faltantes: Array<{ campo: string; fontesAceitas: ReadonlyArray<string> }> }).faltantes.map((f) => [f.campo, f.fontesAceitas]),
    [['quem', ['CADASTRO_DO_SIGNATARIO_LEGAL']]]);
  // Dados de quem opera (identidade S4 / conta Microsoft / cadastro do Analista) nunca preenchem quem assina.
  const doAnalista = [
    valor('SIGNATARIO_NOME', 'ANALISTA SINTETICA UM', 'S4_PESSOA', { tipo: 'DOCUMENTO' }),
    valor('SIGNATARIO_NOME', 'ANALISTA SINTETICA UM', 'CADASTRO_DA_ORGANIZACAO', { tipo: 'DOCUMENTO' }),
  ];
  const r2 = planejarPreenchimento(d, [mbl(), ...doAnalista, localDoSistema()], [], CTX);
  assert.deepEqual(r2.recusados.map((x) => x.motivo), ['FONTE_NAO_ACEITA', 'FONTE_NAO_ACEITA']);
  // Signatário não definido: nenhum dado de cadastro de signatário vale.
  assert.equal(planejarPreenchimento(d, [mbl(), doSignatario('sig-legal-1'), localDoSistema()], [], { ...CTX, signatario: null }).tipo, 'INCOMPLETO');
  // A definição não mistura: escopo SIGNATARIO só com o cadastro do signatário legal, e esse cadastro só no escopo SIGNATARIO.
  const misturada = comSignatario({ campos: [{ id: 'quem', rotulo: 'Quem', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DA_ORGANIZACAO'], escopo: 'SIGNATARIO' }] });
  assert.deepEqual(verificarDefinicao(misturada, 'TERMO_EVERGREEN'), [{ tipo: 'ESCOPO_E_FONTE_INCOMPATIVEIS', campo: 'quem' }]);
  const fora = comSignatario({ campos: [{ id: 'quem', rotulo: 'Quem', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'DOCUMENTO' }] });
  assert.deepEqual(verificarDefinicao(fora, 'TERMO_EVERGREEN'), [{ tipo: 'ESCOPO_E_FONTE_INCOMPATIVEIS', campo: 'quem' }]);
  assert.deepEqual(verificarDefinicao(comSignatario({ poderesDeRepresentacao: { fundamento: ' ' } }), 'TERMO_EVERGREEN'), [{ tipo: 'PODERES_SEM_FUNDAMENTO' }]);
});

test('[UNI-21] DOC-23: cadastro do signatário legal — só válido com CPF válido e validação humana com evidência; um só; dados com a evidência do cadastro; poderes do próprio cadastro e vigentes', () => {
  const s = SIGNATARIO_SINTETICO;
  assert.equal(cadastroValido(s), true);
  for (const [caso, x] of [
    ['cpf', { ...s, cpf: '11111111111' }], ['nome', { ...s, nome: ' ' }], ['qualificacao', { ...s, qualificacao: '' }],
    ['validacao', { ...s, cadastro: { ...s.cadastro, validadoPor: '' } }], ['evidencia', { ...s, cadastro: { ...s.cadastro, evidencia: { fonte: 'x', ref: '' } } }],
  ] as const) assert.equal(cadastroValido(x), false, caso);
  assert.deepEqual(signatarioDaOrganizacao([]), { tipo: 'SEM_CADASTRO_VALIDADO' });
  assert.deepEqual(signatarioDaOrganizacao([{ ...s, cpf: '1' }]), { tipo: 'SEM_CADASTRO_VALIDADO' });
  assert.deepEqual(signatarioDaOrganizacao([s, { ...s, signatarioId: 'sig-2' }]), { tipo: 'MAIS_DE_UM_CADASTRO_VIGENTE', signatarioIds: ['sig-2', 'sig-legal-1'] });
  assert.deepEqual(signatarioDaOrganizacao([s, s]).tipo, 'DEFINIDO', 'o mesmo cadastro repetido não é ambiguidade');
  assert.deepEqual(valoresDoSignatario(s).map((v) => [v.dado, v.valor, v.fonte, v.escopo, v.evidencia.ref]), [
    ['SIGNATARIO_NOME', s.nome, 'CADASTRO_DO_SIGNATARIO_LEGAL', { tipo: 'SIGNATARIO', signatarioId: s.signatarioId }, 'signatario-legal-v1#nome'],
    ['SIGNATARIO_CPF', s.cpf, 'CADASTRO_DO_SIGNATARIO_LEGAL', { tipo: 'SIGNATARIO', signatarioId: s.signatarioId }, 'signatario-legal-v1#cpf'],
  ]);
  assert.equal(poderesValidos(s, '2026-10-14'), null);
  assert.deepEqual(poderesValidos({ ...s, poderes: PODERES_SINTETICOS() }, '2026-10-14'), PODERES_SINTETICOS());
  assert.equal(poderesValidos({ ...s, poderes: PODERES_SINTETICOS('sig-outro') }, '2026-10-14'), null);
  assert.equal(poderesValidos({ ...s, poderes: PODERES_SINTETICOS(undefined, '2026-10-13') }, '2026-10-14'), null);
  assert.ok(poderesValidos({ ...s, poderes: PODERES_SINTETICOS(undefined, '2026-10-14') }, '2026-10-14'));
});

test('[UNI-22] DOC-26 (§5 10–11): MSC aceita exatamente uma opção; Hapag-Lloyd e ZIM aceitam várias, nunca zero; nada é escolhido sozinho', () => {
  const ctx = { ...CTX, signatario: null };
  const opcoes = (tipo: 'MEMORANDO_MSC' | 'MEMORANDO_HAPAG_ROCHAMAR' | 'MEMORANDO_ZIM_ROCHAMAR', alternativas: string[] | null) => {
    const def = DEFINICOES_PROPOSTAS[tipo];
    const grupo = def.opcoes[0].id;
    const escolhas = alternativas === null ? [] : [{ grupo, alternativas, por: 'm-analista', em: '2026-10-14T12:00:00.000Z' }];
    const r = planejarPreenchimento(emUso(def), [], escolhas, ctx);
    return r.tipo === 'INCOMPLETO' ? r.problemasDeOpcao.map((p) => p.tipo) : [];
  };
  const msc = DEFINICOES_PROPOSTAS.MEMORANDO_MSC.opcoes[0].alternativas.map((a) => a.id);
  assert.deepEqual(opcoes('MEMORANDO_MSC', null), ['ESCOLHA_PENDENTE'], 'sem escolha: pendente (nada automático)');
  assert.deepEqual(opcoes('MEMORANDO_MSC', []), ['QUANTIDADE_INVALIDA'], 'zero');
  assert.deepEqual(opcoes('MEMORANDO_MSC', msc.slice(0, 2)), ['QUANTIDADE_INVALIDA'], 'duas');
  assert.deepEqual(opcoes('MEMORANDO_MSC', msc.slice(0, 1)), [], 'uma');
  for (const tipo of ['MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as const) {
    const alt = DEFINICOES_PROPOSTAS[tipo].opcoes[0].alternativas.map((a) => a.id);
    assert.deepEqual(opcoes(tipo, null), ['ESCOLHA_PENDENTE'], tipo);
    assert.deepEqual(opcoes(tipo, []), ['QUANTIDADE_INVALIDA'], `${tipo}: zero`);
    assert.deepEqual(opcoes(tipo, alt.slice(0, 1)), [], `${tipo}: uma`);
    assert.deepEqual(opcoes(tipo, alt.slice(0, 3)), [], `${tipo}: várias`);
    assert.deepEqual(opcoes(tipo, ['INVENTADA']), ['ALTERNATIVA_INEXISTENTE'], `${tipo}: nenhuma equivalência inventada`);
    assert.deepEqual(DEFINICOES_PROPOSTAS[tipo].regras, [], `${tipo}: sem regra automática`);
  }
  // Opção de um modelo não vale em outro (sem equivalência entre agências).
  assert.deepEqual(opcoes('MEMORANDO_MSC', ['RETIRADA_E_DESBLOQUEIO']), ['ALTERNATIVA_INEXISTENTE']);
});

test('[UNI-23] DOC-27: lista de contêineres sem repetição; até 6 no quadro; acima disso a relação anexa, com páginas calculadas e aceite da agência pendente', () => {
  assert.equal(valorNoFormato('LISTA', 'TSTU0000001\nTSTU0000002'), true);
  assert.equal(valorNoFormato('LISTA', 'TSTU0000001\ntstu0000001'), false, 'repetido (sem diferença de caixa)');
  assert.equal(valorNoFormato('LISTA', ' \n '), false);
  assert.deepEqual(itensDaLista(' A \n\nB\n'), ['A', 'B']);
  const def = DEFINICOES_PROPOSTAS.TERMO_EVERGREEN;
  const conteiners = (n: number) => [{ campo: 'CONTEINERES', valor: Array.from({ length: n }, (_, i) => `TSTU${String(i + 1).padStart(7, '0')}`).join('\n') }];
  assert.equal(usoDaRelacaoAnexa(def, conteiners(6)), null);
  assert.deepEqual(usoDaRelacaoAnexa(def, conteiners(7)), { itens: 7, paginas: 1, primeiraPagina: 4, aceite: 'PENDENTE_DE_ACEITE_DA_AGENCIA' });
  assert.deepEqual(usoDaRelacaoAnexa(def, conteiners(25))?.paginas, 1);
  assert.deepEqual(usoDaRelacaoAnexa(def, conteiners(26))?.paginas, 2);
  assert.deepEqual(usoDaRelacaoAnexa(def, conteiners(30)), { itens: 30, paginas: 2, primeiraPagina: 4, aceite: 'PENDENTE_DE_ACEITE_DA_AGENCIA' });
  assert.deepEqual(verificarDefinicao(def, 'TERMO_EVERGREEN'), []);
  const l = def.layout!;
  const quebrada = (r: Partial<NonNullable<typeof l.relacaoAnexa>>) => verificarDefinicao({ ...def, layout: { ...l, relacaoAnexa: { ...l.relacaoAnexa!, ...r } } }, 'TERMO_EVERGREEN');
  for (const r of [{ campo: 'NAVIO' }, { maximoNoLugar: 7 }, { itensPorPagina: 41 }, { titulo: ' ' }, { identificacao: [] }, { aceiteDaAgencia: { estado: 'ACEITO_PELA_AGENCIA' } as never }]) {
    assert.deepEqual(quebrada(r), [{ tipo: 'LAYOUT_INVALIDO', item: 'relacaoAnexa', motivo: 'RELACAO_ANEXA_INVALIDA' }], JSON.stringify(r));
  }
});

test('[UNI-24] DOC-25: substituições formam cadeia — vale o último arquivo; alteração posterior é indício dos bytes; conferência nunca é herdada', () => {
  const a1 = assinatura();
  const a2 = assinatura({ assinaturaId: 'ass-2', arquivoSha256: 'd'.repeat(64), registradoEm: '2026-10-14T13:59:00.000Z', substituicao: { de: 'ass-1', motivo: 'OUTRO', justificativa: 'x' } });
  assert.equal(assinaturaDoDocumento('doc-1', [a1, a2])?.assinaturaId, 'ass-2', 'a cadeia decide, não o relógio');
  const base = new TextEncoder().encode('%PDF-1.7 assinado');
  assert.equal(alteracaoPosteriorA([{ assinaturaId: 'ass-1', bytes: base }], new Uint8Array([...base, 1, 2])), 'ass-1');
  assert.equal(alteracaoPosteriorA([{ assinaturaId: 'ass-1', bytes: base }], base), null, 'idêntico não é alteração');
  assert.equal(alteracaoPosteriorA([{ assinaturaId: 'ass-1', bytes: base }], new TextEncoder().encode('%PDF-1.7 outro')), null);
  const conf = { conferenciaId: 'c1', documentoId: 'doc-1', assinaturaId: 'ass-1', arquivoSha256: 'b'.repeat(64), signatarioEsperado: null, resultado: 'CONFORME' as const,
    constatacao: null, conferidoPor: 'm-gestor', conferidoEm: '2026-10-14T14:30:00.000Z', observacao: null };
  assert.equal(conferenciaDaAssinatura(a2, [conf]), null);
  // Defesa em profundidade: mesma versão e mesmo hash, mas conferência de OUTRO registro de arquivo — não vale.
  assert.equal(conferenciaDaAssinatura(a1, [{ ...conf, assinaturaId: 'ass-x' }]), null);
  assert.equal(conferenciaDaAssinatura(a1, [{ ...conf, documentoId: 'doc-x' }]), null);
  assert.equal(conferenciaDaAssinatura(a1, [conf])?.conferenciaId, 'c1');
});

test('[UNI-19] DOC-19: dado confirmado do sistema primeiro; sem ele, o informado (com autor, instante e proveniência); informado diferente do sistema = divergência para resolução, nunca sobrescreve', () => {
  const d = emUso(comSignatario());
  const base = [mbl(), doSignatario('sig-legal-1')];
  const doSistema = pronto(planejarPreenchimento(d, [...base, localDoSistema()], [], CTX));
  assert.deepEqual([doSistema.conteudo.campos.find((c) => c.campo === 'local')?.valor, doSistema.informados], ['TERMINAL A', []]);
  const soInformado = pronto(planejarPreenchimento(d, base, [], CTX, [], [informado('TERMINAL B')]));
  assert.equal(soInformado.conteudo.campos.find((c) => c.campo === 'local')?.valor, 'TERMINAL B');
  assert.deepEqual(soInformado.informados.map((i) => [i.por, i.referencia]), [['m-analista', 'combinado por telefone']]);
  assert.deepEqual(soInformado.proveniencia.find((p) => p.campo === 'local')?.fontes.map((f) => f.fonte), ['ANALISTA']);
  // Igual ao sistema: concordante (as duas proveniências ficam).
  const igual = pronto(planejarPreenchimento(d, [...base, localDoSistema()], [], CTX, [], [informado('TERMINAL A')]));
  assert.deepEqual(igual.proveniencia.find((p) => p.campo === 'local')?.fontes.map((f) => f.fonte), ['S3_VIAGEM', 'ANALISTA']);
  // Diferente do sistema: nada é escolhido; a divergência diz quem diverge de quem.
  const diverge = planejarPreenchimento(d, [...base, localDoSistema()], [], CTX, [], [informado('TERMINAL B')]);
  assert.equal(diverge.tipo, 'INCOMPLETO');
  const divergentes = diverge.tipo === 'INCOMPLETO' ? diverge.divergentes : [];
  assert.deepEqual(divergentes.map((x) => [x.campo, x.natureza, x.valores.map((v) => `${v.fonte}:${v.valor}`)]),
    [['local', 'INFORMADO_DIVERGE_DO_SISTEMA', ['S3_VIAGEM:TERMINAL A', 'ANALISTA:TERMINAL B']]]);
  const duasFontes = planejarPreenchimento(d, [...base, localDoSistema(), valor('LOCAL', 'TERMINAL C', 'S3_VIAGEM', { tipo: 'DOCUMENTO' }, 'outra')], [], CTX);
  assert.equal((duasFontes as { divergentes: Array<{ natureza: string }> }).divergentes[0].natureza, 'ENTRE_FONTES_DO_SISTEMA');
});

test('[UNI-20] DOC-20: registrado ≠ conferido; a conferência vale só para aquele registro e aquele arquivo; não conforme pede outro arquivo; arquivo novo exige nova conferência', () => {
  const versaoValidada: VersaoDoModelo = {
    modeloId: 'mod-1', tipo: 'TERMO_EVERGREEN', versao: 'sintetica-1', arquivoSha256: 'f'.repeat(64), origem: { tipo: 'CADASTRO', por: 'g' },
    definicao: definicaoEvergreen(), estado: 'VALIDADO', cadastradoEm: '2026-10-01T00:00:00.000Z', validacao: { por: 'g', em: '2026-10-01T00:00:00.000Z' }, rejeicao: null,
  };
  const sitEntrada = (assinaturas: ReturnType<typeof assinatura>[], conferencias: ConferenciaDaAssinatura[]) => ({
    masterId: MASTER, selecao: selecionarModelo(MASTER, { masterId: MASTER, codigo: 'EVERGREEN' }), versoes: [versaoValidada],
    sinaisPendentes: [], preenchimento: { tipo: 'PRONTO' as const, plano: {} as PlanoDePreenchimento, recusados: [], atencoes: [] }, conteudoAtualSha256: 'c'.repeat(64),
    documentos: [doc()], assinaturas, conferencias, signatarioLegal: null, poderesDoSignatario: null, email: null,
  });
  const sit = (assinaturas: ReturnType<typeof assinatura>[], conferencias: ConferenciaDaAssinatura[]) => situacaoDocumental(sitEntrada(assinaturas, conferencias));
  const conf = (p: Partial<ConferenciaDaAssinatura> = {}): ConferenciaDaAssinatura => ({
    conferenciaId: 'conf-1', documentoId: 'doc-1', assinaturaId: 'ass-1', arquivoSha256: 'b'.repeat(64), signatarioEsperado: null, resultado: 'CONFORME', constatacao: null,
    conferidoPor: 'm-gestor', conferidoEm: '2026-10-14T14:30:00.000Z', observacao: null, ...p,
  });
  assert.equal(sit([assinatura()], []).assinatura.tipo, 'AGUARDANDO_CONFERENCIA');
  assert.equal(sit([assinatura()], []).proximoPasso?.passo, 'CONFERIR_ASSINATURA');
  assert.equal(sit([assinatura()], [conf({ arquivoSha256: 'e'.repeat(64) })]).assinatura.tipo, 'AGUARDANDO_CONFERENCIA', 'hash de outro arquivo não vale');
  assert.equal(sit([assinatura()], [conf()]).proximoPasso?.passo, 'DOCUMENTO_PRONTO_PARA_ENCAMINHAMENTO');
  const nao = sit([assinatura()], [conf({ resultado: 'NAO_CONFORME', constatacao: 'ASSINATURA_INVALIDA', observacao: 'sem rubrica' })]);
  assert.deepEqual([nao.assinatura.tipo, nao.proximoPasso], ['NAO_CONFORME', {
    passo: 'SUBSTITUIR_ARQUIVO_ASSINADO', responsavel: 'ANALISTA', documentoId: 'doc-1', assinaturaId: 'ass-1', constatacao: 'ASSINATURA_INVALIDA', observacao: 'sem rubrica',
  }]);
  // A recusa nunca é sobreposta: a solicitação de agendamento continua restrita (DOC-25).
  assert.deepEqual((condicaoDaSolicitacaoDeAgendamento(nao) as { motivos: string[] }).motivos, ['ASSINATURA_NAO_CONFORME']);
  // Novo arquivo assinado depois da conferência: a conferência anterior não o cobre.
  const novo = assinatura({ assinaturaId: 'ass-2', arquivoSha256: 'd'.repeat(64), registradoEm: '2026-10-14T15:00:00.000Z', substituicao: { de: 'ass-1', motivo: 'OUTRO', justificativa: 'x' } });
  assert.equal(sit([assinatura(), novo], [conf()]).assinatura.tipo, 'AGUARDANDO_CONFERENCIA');
  assert.equal(conferenciaDaAssinatura(novo, [conf()]), null);
  // DOC-23: comprovação de poderes só vale se for do signatário REPRESENTADO no documento vigente (nunca de outro cadastro nem de Analista).
  const comPoderes = (signatarioId: string, doDocumento: string | null = 'sig-legal-1') => situacaoDocumental({
    ...sitEntrada([assinatura()], [conf()]),
    documentos: [doc({ signatario: doDocumento ? { signatarioId: doDocumento, nome: 'SIGNATARIO LEGAL SINTETICO' } : null })],
    versoes: [{ ...versaoValidada, definicao: definicaoEvergreen({ poderesDeRepresentacao: { fundamento: 'representante legal' } }) }],
    poderesDoSignatario: PODERES_SINTETICOS(signatarioId),
  }).representacao.tipo;
  assert.deepEqual([comPoderes('sig-legal-1'), comPoderes('sig-outro'), comPoderes('m-analista'), comPoderes('sig-legal-1', null)],
    ['COMPROVADA', 'NAO_COMPROVADA', 'NAO_COMPROVADA', 'NAO_COMPROVADA']);
  // Mesmo instante: vale a registrada por último (ordem de registro), não a ordem do id.
  assert.equal(conferenciaDaAssinatura(assinatura(), [conf({ conferenciaId: 'z' }), conf({ conferenciaId: 'a', resultado: 'NAO_CONFORME', observacao: 'x' })])?.resultado, 'NAO_CONFORME');
});

test('[UNI-25] DOC-31 no domínio puro: memorando nunca lê arquivo assinado, conferência ou e-mail — mesmo que a entrada traga (dado legado ou chamada indevida)', () => {
  const tipo = 'MEMORANDO_ZIM_ROCHAMAR';
  const versao: VersaoDoModelo = {
    modeloId: 'mod-1', tipo, versao: 'sintetica-1', arquivoSha256: 'f'.repeat(64), origem: { tipo: 'CADASTRO', por: 'g' },
    definicao: definicaoMemorando(tipo, { poderesDeRepresentacao: { fundamento: 'SINTÉTICO' } }), estado: 'VALIDADO', cadastradoEm: '2026-10-01T00:00:00.000Z',
    validacao: { por: 'g', em: '2026-10-01T00:00:00.000Z' }, rejeicao: null,
  };
  const { masterId: _m, preparo: _p, assinatura: _a, pendenciaDoTermo: _t, estadoDoModeloDoDocumento: _e, ...contextoDoEmail } = emailOk({ tentativas: [tentativa('ENVIO_CONFIRMADO')] });
  const s = situacaoDocumental({
    masterId: MASTER, selecao: selecionarModelo(MASTER, { masterId: MASTER, codigo: 'ZIM' }), versoes: [versao], sinaisPendentes: [],
    preenchimento: { tipo: 'PRONTO', plano: {} as PlanoDePreenchimento, recusados: [], atencoes: [] }, conteudoAtualSha256: 'c'.repeat(64),
    documentos: [doc({ tipo })], assinaturas: [assinatura({ substituicao: { de: 'ass-0', motivo: 'ALTERACAO_APOS_ASSINATURA', justificativa: 'x' } })], conferencias: [],
    signatarioLegal: null, poderesDoSignatario: null, email: contextoDoEmail,
  });
  assert.deepEqual([s.assinatura, s.representacao, s.atencoes, s.envio, s.pendencias, s.proximoPasso], [
    { tipo: 'FORA_DA_PRIORA' }, { tipo: 'FORA_DA_PRIORA' }, [], { tipo: 'NAO_APLICAVEL' }, [], { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId: 'doc-1' },
  ]);
});
