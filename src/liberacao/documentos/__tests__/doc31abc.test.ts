import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { NextFunction, Response } from 'express';
import { AddressInfo } from 'net';
import { situacaoDaAgencia } from '../../dominio';
import { armador, clienteOk, decidir, procedimento } from '../../dominio/__tests__/l1b/fixtures';
import { criarDocumentosRouter } from '../../../routes/documentosRoutes';
import { AuthedRequest } from '../../../middleware/requireAuth';
import {
  DefinicaoDoModelo, MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO, MENSAGEM_VIGENCIA_NAO_VERIFICAVEL, TEXTO_DOCUMENTO_DISPONIVEL, TipoDocumento, acrescentarAoProcedimento,
  avaliarDocumentacao, compararConteudo, condicaoDaSolicitacaoDeAgendamento, conferirAssinatura, fatosDocumentaisParaL1b, prepararDocumento, prepararRascunho, registrarAssinatura,
  sha256,
} from '..';
import {
  ANALISTA, ATOR, MASTER, ORG, PERMITIDA, SIGNATARIO_COM_PODERES, SIGNATARIO_SINTETICO, assinadoSintetico, cenarioDocumental, definicaoEvergreen, definicaoMemorando,
  valor,
} from './fixtures';

/**
 * DOC-31.A (representação sem bloqueio em Hapag/ZIM), DOC-31.B (atualização só por dado efetivamente usado no PDF) e
 * DOC-31.C (situação documental separada da próxima ação operacional). Dependências simuladas; dados sintéticos.
 */

type Memorando = Exclude<TipoDocumento, 'TERMO_EVERGREEN'>;
type Cenario = Awaited<ReturnType<typeof cenarioDocumental>>;
const ESCOLHA = [{ grupo: 'servico', alternativas: ['SERVICO_C'], por: ANALISTA, em: '2026-10-14T12:00:00.000Z' }];
const mestre = { tipo: 'MASTER' as const, masterId: MASTER };

/** Memorando SINTÉTICO como Hapag/ZIM: BL, consignatário, nome e CPF de quem assina (cadastro) e poderes DECLARADOS no modelo. */
function memorando(tipo: Memorando): DefinicaoDoModelo {
  const base = definicaoMemorando(tipo, {
    campos: [
      { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
      { id: 'consignatario', rotulo: 'Exportador/Importador', dado: 'CONSIGNATARIO_RAZAO_SOCIAL', obrigatorio: true, fontesAceitas: ['S2_AUDITORIA'], escopo: 'MASTER' },
      { id: 'nome', rotulo: 'Representante', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
      { id: 'cpf', rotulo: 'CPF do representante', dado: 'SIGNATARIO_CPF', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
    ],
    poderesDeRepresentacao: tipo === 'MEMORANDO_MSC' ? null : { fundamento: 'texto SINTÉTICO: "quadro do representante legal"' },
  });
  return { ...base, layout: { ...base.layout!, campos: { ...base.layout!.campos, cpf: { ...base.layout!.campos.cpf, formato: 'CPF' } } } };
}
const valores = (p: { bl?: string; consignatario?: string; ref?: string; em?: string } = {}) => [
  { ...valor('MBL', p.bl ?? 'MBLSINTETICO0001', 'S6_MASTER', mestre, p.ref), observadoEm: p.em ?? '2026-10-01T12:00:00.000Z' },
  { ...valor('CONSIGNATARIO_RAZAO_SOCIAL', p.consignatario ?? 'EMPRESA SINTETICA DE TESTE LTDA', 'S2_AUDITORIA', mestre, p.ref), observadoEm: p.em ?? '2026-10-01T12:00:00.000Z' },
];
async function preparado(tipo: Memorando, codigo: string, p: Parameters<typeof cenarioDocumental>[0] = {}) {
  const c = await cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: memorando(tipo) }, valores: valores(), ...p });
  const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: ESCOLHA });
  assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
  return { c, documentoId: (r as { documentoId: string }).documentoId };
}
const situacao = async (c: Cenario) => (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
const camposDe = (c: Cenario, i = 0) => (c.repo.m.documentos[i].plano as { conteudo: { campos: Array<{ campo: string; valor: string }> } }).conteudo.campos;
const PASSOS_DE_PODERES_OU_ASSINATURA = ['COMPROVAR_PODERES_DE_REPRESENTACAO', 'ASSINAR_DOCUMENTO', 'CONFERIR_ASSINATURA', 'SUBSTITUIR_ARQUIVO_ASSINADO'];

/* ------------------------------------------------ DOC-31.A ------------------------------------------------ */

test('[DOC31A-01] Hapag e ZIM geram e disponibilizam o PDF sem comprovação de poderes (cadastro sem poderes registrados); nenhuma pendência de poderes, upload ou conferência', async () => {
  for (const [tipo, codigo] of [['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM']] as Array<[Memorando, string]>) {
    assert.equal(SIGNATARIO_SINTETICO.poderes, null, 'o cadastro não traz comprovação de poderes');
    const { c, documentoId } = await preparado(tipo, codigo, { signatarios: [SIGNATARIO_SINTETICO] });
    const s = await situacao(c);
    assert.deepEqual([s.representacao, s.assinatura, s.proximoPasso, s.pendencias, s.texto],
      [{ tipo: 'FORA_DA_PRIORA' }, { tipo: 'FORA_DA_PRIORA' }, { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId }, [], TEXTO_DOCUMENTO_DISPONIVEL], tipo);
    assert.ok(!s.pendencias.some((p) => PASSOS_DE_PODERES_OU_ASSINATURA.includes(p.passo)), tipo);
    assert.ok(await c.repo.arquivoDoDocumento(ORG, documentoId), `${tipo}: PDF disponível para baixar`);
    // Nenhum documento de representação é pedido nem aceito: não há upload nem conferência no fluxo A.
    assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, assinadoSintetico('PROCURACAO SINTETICA')), { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
    assert.deepEqual(await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: 'x', arquivoSha256: 'a'.repeat(64), resultado: 'CONFORME' }),
      { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
  }
});

test('[DOC31A-02] os dados de quem assina vêm do cadastro confiável do signatário legal (proveniência registrada); sem cadastro, faltam — nunca presumidos nem tirados do Analista', async () => {
  for (const [tipo, codigo] of [['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM']] as Array<[Memorando, string]>) {
    const { c } = await preparado(tipo, codigo, { signatarios: [SIGNATARIO_SINTETICO] });
    const doc = c.repo.m.documentos[0];
    assert.deepEqual(camposDe(c).filter((x) => x.campo === 'nome' || x.campo === 'cpf').map((x) => [x.campo, x.valor]),
      [['nome', SIGNATARIO_SINTETICO.nome], ['cpf', SIGNATARIO_SINTETICO.cpf]], tipo);
    const prov = (doc.plano as { proveniencia: Array<{ campo: string; fontes: Array<{ fonte: string }> }> }).proveniencia;
    assert.deepEqual(prov.filter((p) => p.campo === 'nome' || p.campo === 'cpf').map((p) => p.fontes.map((f) => f.fonte)), [['CADASTRO_DO_SIGNATARIO_LEGAL'], ['CADASTRO_DO_SIGNATARIO_LEGAL']], tipo);
    assert.deepEqual(doc.signatario, { signatarioId: SIGNATARIO_SINTETICO.signatarioId, nome: SIGNATARIO_SINTETICO.nome }, tipo);
    // O Analista não "informa" quem assina; sem cadastro válido, os campos faltam e a pendência é de configuração.
    const semCadastro = await cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: memorando(tipo) }, valores: valores(), signatarios: [] });
    const r = await prepararDocumento(semCadastro.deps, ATOR, MASTER, { escolhas: ESCOLHA, informados: [{ dado: 'SIGNATARIO_NOME', valor: 'NOME DIGITADO' }] });
    assert.equal(r.tipo, 'NAO_PREPARADO', tipo);
    assert.ok(r.situacao?.pendencias.some((p) => p.passo === 'DEFINIR_SIGNATARIO_LEGAL'), tipo);
  }
});

/* ------------------------------------------------ DOC-31.B ------------------------------------------------ */

test('[DOC31B-01] alteração de dado IMPRESSO (BL, consignatário) gera pendência de atualização com os campos alterados e a mensagem — sem afirmar substituição do PDF baixado', async () => {
  for (const [mudar, campo, rotulo] of [[{ bl: 'MBLSINTETICO0002' }, 'bl', 'BL'], [{ consignatario: 'OUTRA EMPRESA SINTETICA LTDA' }, 'consignatario', 'Exportador/Importador']] as const) {
    const { c, documentoId } = await preparado('MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD');
    c.mundo.valores = valores(mudar);
    const s = await situacao(c);
    assert.deepEqual(s.proximoPasso, {
      passo: 'GERAR_NOVA_VERSAO', responsavel: 'ANALISTA', anterior: documentoId, alterados: [{ item: { tipo: 'CAMPO', campo }, rotulo }],
      mensagem: MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO,
    }, campo);
    assert.deepEqual([s.preparo.tipo, (s.preparo as { motivo: string }).motivo, s.texto], ['DESATUALIZADO', 'CONTEUDO_MUDOU', MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO], campo);
    assert.ok(!/substitu|recolhid/i.test(s.texto!), 'não afirma que o PDF baixado foi substituído ou recolhido');
    assert.equal(c.repo.m.documentos.length, 1, 'nenhuma versão nova criada automaticamente');
  }
  // Opção marcada também é dado impresso.
  const { c } = await preparado('MEMORANDO_ZIM_ROCHAMAR', 'ZIM');
  const s = (await avaliarDocumentacao(c.deps, ORG, MASTER, { escolhas: [{ ...ESCOLHA[0], alternativas: ['SERVICO_B'] }] })).situacao;
  assert.deepEqual((s.proximoPasso as { alterados: unknown[] }).alterados, [{ item: { tipo: 'OPCAO', grupo: 'servico' }, rotulo: 'Serviço' }]);
});

test('[DOC31B-02] dado que o PDF não usa, reprocessamento com o mesmo valor (ou mesma escrita) e metadado irrelevante NÃO geram pendência nem versão nova', async () => {
  const { c, documentoId } = await preparado('MEMORANDO_ZIM_ROCHAMAR', 'ZIM');
  const disponivel = { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId };
  const verifica = async (rotulo: string) => {
    const s = await situacao(c);
    assert.deepEqual([s.proximoPasso, s.pendencias, s.texto, s.preparo.tipo], [disponivel, [], TEXTO_DOCUMENTO_DISPONIVEL, 'PREPARADO'], rotulo);
    const r = await prepararDocumento(c.deps, ATOR, MASTER);
    assert.deepEqual([r.tipo, (r as { novo: boolean }).novo, c.repo.m.documentos.length], ['PREPARADO', false, 1], `${rotulo}: nenhuma versão nova`);
  };
  // Dado do processo que o memorando não imprime (navio, código do processo).
  c.mundo.valores = [...valores(), valor('NOME_DO_NAVIO', 'NAVIO SINTETICO NOVO', 'S3_VIAGEM', mestre), valor('CODIGO_DO_PROCESSO', 'IM999', 'S6_PROCESSO', { tipo: 'PROCESSO', processoId: 'IM100' })];
  await verifica('dado não usado no PDF');
  // OCR reprocessado: mesmo valor, outra evidência e outro instante de observação.
  c.mundo.valores = valores({ ref: 'reprocessamento-ocr-2', em: '2026-10-09T08:00:00.000Z' });
  await verifica('reprocessamento com o mesmo valor');
  // Mesma escrita no PDF: espaços repetidos.
  c.mundo.valores = valores({ consignatario: 'EMPRESA  SINTETICA   DE TESTE LTDA' });
  await verifica('mesmo valor escrito');
  // Metadado irrelevante: novo processo vinculado (snapshot) sem efeito no que o PDF mostra.
  c.mundo.processos = ['IM100', 'IM200'];
  c.mundo.valores = valores();
  await verifica('processo novo sem campo no PDF');
});

test('[DOC31B-03] comparação pelo que o PDF ESCREVE: CPF com ou sem pontuação, espaços repetidos e linhas em branco na lista são o mesmo texto; valor diferente é alteração só daquele campo', async () => {
  const d = memorando('MEMORANDO_HAPAG_ROCHAMAR');
  const modelo = { modeloId: 'mod-1', versao: 's1', arquivoSha256: 'f'.repeat(64) };
  const anterior = { modelo, campos: [{ campo: 'cpf', valor: '52998224725' }, { campo: 'consignatario', valor: 'EMPRESA SINTETICA LTDA' }], opcoes: [{ grupo: 'servico', alternativas: ['SERVICO_B', 'SERVICO_C'] }] };
  const atual = (campos: Array<{ campo: string; valor: string }>, alternativas = ['SERVICO_C', 'SERVICO_B']) =>
    compararConteudo(d, anterior, { modelo, campos, opcoes: [{ grupo: 'servico', alternativas }], naoResolvidos: { campos: [], grupos: [] } });
  assert.deepEqual(atual([{ campo: 'cpf', valor: '529.982.247-25' }, { campo: 'consignatario', valor: 'EMPRESA   SINTETICA  LTDA' }]), { alteracoes: [], naoVerificados: [] });
  assert.deepEqual(atual([{ campo: 'cpf', valor: '11144477735' }, { campo: 'consignatario', valor: 'EMPRESA SINTETICA LTDA' }]).alteracoes, [{ tipo: 'CAMPO', campo: 'cpf' }]);
  assert.deepEqual(atual([{ campo: 'cpf', valor: '52998224725' }]).alteracoes, [{ tipo: 'CAMPO', campo: 'consignatario' }], 'valor que deixou de existir também muda o PDF');
  assert.deepEqual(atual(anterior.campos, ['SERVICO_C']).alteracoes, [{ tipo: 'OPCAO', grupo: 'servico' }]);
  assert.deepEqual(compararConteudo(d, anterior, { modelo: { ...modelo, arquivoSha256: 'e'.repeat(64) }, campos: anterior.campos, opcoes: anterior.opcoes, naoResolvidos: { campos: [], grupos: [] } }).alteracoes,
    [{ tipo: 'VERSAO_DO_MODELO' }]);
  const lista = definicaoEvergreen({ campos: [{ id: 'cnt', rotulo: 'Contêineres', dado: 'CONTEINERES_DO_MASTER', obrigatorio: true, fontesAceitas: ['S2_AUDITORIA'], escopo: 'MASTER' }] });
  const comLista = { ...lista, layout: { ...lista.layout!, campos: { cnt: { ...lista.layout!.campos.cnt, formato: 'LISTA' as const } } } };
  assert.deepEqual(compararConteudo(comLista, { modelo, campos: [{ campo: 'cnt', valor: 'TSTU0000001\nTSTU0000002' }], opcoes: [] },
    { modelo, campos: [{ campo: 'cnt', valor: 'TSTU0000001\n\n  TSTU0000002 ' }], opcoes: [], naoResolvidos: { campos: [], grupos: [] } }).alteracoes, []);
  // No serviço: o cadastro do signatário mudou de CPF → pendência só do CPF.
  const { c } = await preparado('MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD', { signatarios: [SIGNATARIO_SINTETICO] });
  c.mundo.signatarios = [{ ...SIGNATARIO_SINTETICO, cpf: '11144477735' }];
  assert.deepEqual(((await situacao(c)).proximoPasso as { alterados: unknown[] }).alterados, [{ item: { tipo: 'CAMPO', campo: 'cpf' }, rotulo: 'CPF do representante' }]);
});

test('[DOC31B-04] sem dados para verificar um campo impresso, nada é presumido: estado explícito, sem "documento disponível"; com outro campo comprovadamente alterado, os dois aparecem', async () => {
  const { c, documentoId } = await preparado('MEMORANDO_MSC', 'MSC');
  c.mundo.valores = valores().filter((v) => v.dado !== 'CONSIGNATARIO_RAZAO_SOCIAL');
  const s = await situacao(c);
  assert.deepEqual([s.preparo.tipo, (s.preparo as { motivo: string }).motivo, (s.preparo as { naoVerificados: unknown[] }).naoVerificados, s.texto],
    ['DESATUALIZADO', 'VIGENCIA_NAO_VERIFICAVEL', [{ tipo: 'CAMPO', campo: 'consignatario' }], MENSAGEM_VIGENCIA_NAO_VERIFICAVEL]);
  assert.equal(s.proximoPasso?.passo, 'OBTER_DADOS_FALTANTES');
  assert.ok(!s.pendencias.some((p) => p.passo === 'GERAR_NOVA_VERSAO' || p.passo === 'DOCUMENTO_DISPONIVEL'));
  c.mundo.valores = valores({ bl: 'MBLSINTETICO0003' }).filter((v) => v.dado !== 'CONSIGNATARIO_RAZAO_SOCIAL');
  const s2 = await situacao(c);
  assert.deepEqual([(s2.preparo as { motivo: string }).motivo, (s2.preparo as { alteracoes: unknown[] }).alteracoes, (s2.preparo as { naoVerificados: unknown[] }).naoVerificados],
    ['CONTEUDO_MUDOU', [{ tipo: 'CAMPO', campo: 'bl' }], [{ tipo: 'CAMPO', campo: 'consignatario' }]]);
  assert.equal(c.repo.m.documentos[0].documentoId, documentoId);
});

test('[DOC31B-05] versão anterior preservada e comparação isolada por organização, Master e modelo', async () => {
  const { c, documentoId } = await preparado('MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD');
  const antes = c.repo.m.documentos[0].arquivoSha256;
  c.mundo.valores = valores({ bl: 'MBLSINTETICO0002' });
  const nova = (await prepararDocumento(c.deps, ATOR, MASTER)) as { documentoId: string; novo: boolean };
  assert.deepEqual([nova.novo, c.repo.m.documentos.map((d) => d.documentoId)], [true, [documentoId, nova.documentoId]]);
  assert.equal(sha256((await c.repo.arquivoDoDocumento(ORG, documentoId))!), antes, 'a versão anterior continua guardada, igual');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'DOCUMENTO_DISPONIVEL');
  // Outra organização não vê a versão nem herda a comparação; outro Master não é comparado.
  assert.equal((await avaliarDocumentacao(c.deps, 'org-2', MASTER)).situacao.preparo.tipo, 'NAO_PREPARADO');
  assert.equal((await avaliarDocumentacao(c.deps, ORG, 'M2')).situacao.preparo.tipo, 'NAO_PREPARADO');
});

test('[DOC31B-06] Evergreen assinado e conferido: dado impresso alterado → versão nova sem herdar assinatura nem conferência; o agendamento volta a exigir os dois; nada vira apresentação', async () => {
  const termo = definicaoEvergreen({
    campos: [...definicaoEvergreen().campos, { id: 'nome', rotulo: 'Quem assina', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' }],
    poderesDeRepresentacao: { fundamento: 'texto SINTÉTICO' },
  });
  const c = await cenarioDocumental({ defs: { TERMO_EVERGREEN: termo }, signatarios: [SIGNATARIO_COM_PODERES] });
  const r = (await prepararDocumento(c.deps, ATOR, MASTER)) as { documentoId: string };
  const arquivo = assinadoSintetico('TERMO ASSINADO SINTETICO');
  const a = (await registrarAssinatura(c.deps, ATOR, r.documentoId, arquivo)) as { assinaturaId: string };
  await conferirAssinatura(c.deps, ATOR, r.documentoId, { assinaturaId: a.assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
  const sit = async () => (await avaliarDocumentacao(c.deps, ORG, MASTER, { autorizacao: PERMITIDA })).situacao;
  assert.equal(condicaoDaSolicitacaoDeAgendamento(await sit(), PERMITIDA).tipo, 'TERMO_PRONTO_PARA_A_SOLICITACAO');
  // Navio impresso mudou.
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'NOME_DO_NAVIO' ? { ...v, valor: 'NAVIO SINTETICO NOVO' } : v));
  const s = await sit();
  assert.deepEqual([s.preparo.tipo, (s.proximoPasso as { alterados?: unknown[] }).alterados], ['DESATUALIZADO', [{ item: { tipo: 'CAMPO', campo: 'navio' }, rotulo: 'Navio' }]]);
  assert.deepEqual((condicaoDaSolicitacaoDeAgendamento(s, PERMITIDA) as { motivos: string[] }).motivos, ['DOCUMENTO_DESATUALIZADO']);
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA })).tipo, 'NAO_PREPARADO');
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, r.documentoId, assinadoSintetico('OUTRA')), { tipo: 'RECUSADA', motivo: 'DOCUMENTO_NAO_VIGENTE' }, 'arquivo para a versão antiga');
  const v2 = (await prepararDocumento(c.deps, ATOR, MASTER)) as { documentoId: string };
  const s2 = await sit();
  assert.deepEqual([s2.preparo.tipo, s2.assinatura.tipo, s2.proximoPasso?.passo], ['PREPARADO', 'PENDENTE_HUMANA', 'ASSINAR_DOCUMENTO'], 'a assinatura antiga não vale para os bytes novos');
  assert.deepEqual((condicaoDaSolicitacaoDeAgendamento(s2, PERMITIDA) as { motivos: string[] }).motivos, ['ASSINATURA_PENDENTE']);
  assert.notEqual(v2.documentoId, r.documentoId);
  assert.deepEqual([c.repo.m.assinaturas.length, c.repo.m.conferencias.length, c.repo.m.tentativas.length], [1, 1, 0], 'histórico preservado; nada enviado');
});

/* ------------------------------------------------ DOC-31.C ------------------------------------------------ */

test('[DOC31C-01] a API mostra exatamente "Documento disponível para download" como situação documental; nenhuma ação operacional nem "apresentado/enviado/liberado"; baixar não muda nada', async () => {
  const MASTER_UUID = '11111111-1111-4111-8111-111111111111';
  const c = await cenarioDocumental({
    armador: { masterId: MASTER_UUID, codigo: 'MSC' }, idsUuid: true, defs: { MEMORANDO_MSC: memorando('MEMORANDO_MSC') },
    valores: valores().map((v) => ({ ...v, escopo: { tipo: 'MASTER' as const, masterId: MASTER_UUID } })),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/liberacao/documentos', criarDocumentosRouter({
    habilitado: () => true, documentos: () => c.deps, caixaMonitorada: () => c.caixa, outlookDaPessoa: async () => ({ tipo: 'DISPONIVEL', outlook: c.outlook }),
    auth: (req: AuthedRequest, _res: Response, next: NextFunction) => {
      req.pessoa = { usuarioId: 'u-1', homeAccountId: 'conta-analista', nome: 'Analista', membershipId: ANALISTA, papel: 'ANALYST', organizationId: ORG, caixaId: 'caixa-1' };
      next();
    },
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/liberacao/documentos`;
  try {
    const corpo = JSON.stringify({ escolhas: [{ grupo: 'servico', alternativas: ['SERVICO_C'] }] });
    const r = await (await fetch(`${base}/masters/${MASTER_UUID}/preparar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo })).json() as { documentoId: string };
    const ler = async () => (await fetch(`${base}/masters/${MASTER_UUID}`)).text();
    const antes = await ler();
    const resposta = JSON.parse(antes) as { situacao: { texto: string; proximoPasso: { passo: string } } } & Record<string, unknown>;
    assert.equal(resposta.situacao.texto, 'Documento disponível para download');
    assert.equal(resposta.situacao.proximoPasso.passo, 'DOCUMENTO_DISPONIVEL');
    assert.ok(!/master apresentado|apresenta[cç][aã]o conclu[ií]da|\benviad[oa]\b|\bliberad[oa]\b/i.test(antes), 'nenhum resultado operacional na resposta documental');
    assert.ok(!['proximaAcao', 'acao', 'acaoDaL1b', 'etapa'].some((k) => k in resposta), 'a ação operacional não sai daqui');
    for (const sufixo of ['', '?modo=visualizar']) await (await fetch(`${base}/arquivos/${r.documentoId}${sufixo}`)).arrayBuffer();
    assert.equal(await ler(), antes, 'baixar/visualizar não muda a situação');
    assert.deepEqual([c.repo.m.tentativas, c.repo.m.assinaturas, c.outlook.chamadas], [[], [], []], 'nenhuma evidência de envio, assinatura ou Outlook');
    // Ao L1b vai só "memorando gerado" (a ação operacional é dela, mostrada à parte — DOC31C-02).
    const fatos = fatosDocumentaisParaL1b(MASTER_UUID, situacaoDaAgencia(MASTER_UUID, armador('MSC', MASTER_UUID)), c.repo.m.documentos, c.repo.m.assinaturas, []);
    assert.deepEqual(fatos.eventos.map((e) => e.tipo), ['PREPARACAO_REGISTRADA']);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test('[DOC31C-02] a próxima ação da L1b é independente da situação documental: igual com o PDF disponível, desatualizado ou com nova versão', async () => {
  const { c } = await preparado('MEMORANDO_ZIM_ROCHAMAR', 'ZIM');
  const decisao = () => {
    const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador('ZIM')), c.repo.m.documentos, c.repo.m.assinaturas, []);
    return JSON.stringify(decidir({ ...clienteOk(), armador: armador('ZIM'), procedimento: acrescentarAoProcedimento(procedimento([]), fatos) }));
  };
  const disponivel = decisao();
  assert.ok(JSON.parse(disponivel).itens.some((i: { acao: string }) => i.acao === 'ENVIAR_PARA_APRESENTACAO'), 'a ação não some porque o documento ficou pronto');
  c.mundo.valores = valores({ bl: 'MBLSINTETICO0002' });
  assert.equal((await situacao(c)).texto, MENSAGEM_PDF_PODE_ESTAR_DESATUALIZADO);
  assert.equal(decisao(), disponivel, 'documento desatualizado não muda a decisão da L1b');
  await prepararDocumento(c.deps, ATOR, MASTER);
  assert.equal(decisao(), disponivel, 'nova versão não muda a decisão da L1b');
});
