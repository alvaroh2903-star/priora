import { test } from 'node:test';
import assert from 'node:assert/strict';
import { situacaoDaAgencia } from '../../dominio';
import {
  T, apresentacao, armador, clienteOk, decidir, encaminhado, evento, instante, pagamento, procedimento, viagem,
} from '../../dominio/__tests__/l1b/fixtures';
import {
  CORPO_AGENDAMENTO_GRIEG, DefinicaoDoModelo, FalhaAntesDoEnvio, TipoDocumento, acrescentarAoProcedimento, avaliarDocumentacao, cadastrarModelo,
  conciliarEnvio, conciliarManualmente, condicaoDaSolicitacaoDeAgendamento, conferirAssinatura, decidirSinalDeRejeicao, definirLeituraDoModelo, enviarPelaPriora,
  fatosDocumentaisParaL1b, papeisDoDocumento, prepararDocumento, prepararRascunho, registrarAssinatura, registrarModeloSubstituto, registrarSinalDeRejeicao, sha256,
  validarModelo,
} from '..';
import {
  ANALISTA, ATOR, CLAUSULA, CLIENTE, DADOS_DOS_ANALISTAS_SINTETICOS, DONO_DA_CAIXA, GESTOR, MASTER, MBL_BYTES, ORG, OUTRO_ANALISTA, PERMITIDA, PODERES_SINTETICOS,
  SIGNATARIO_COM_PODERES, SIGNATARIO_SINTETICO, TABELA, TERCEIRO_ANALISTA, arquivoSintetico, assinadoSintetico, assinarSobre, cenarioDocumental, definicaoEvergreen,
  definicaoMemorando, outlookFalso, pdf, texto, valor,
} from './fixtures';

/**
 * Aceitação da camada documental (DOC-A … DOC-N) com dependências SIMULADAS:
 * modelos sintéticos, gerador MOCK, Outlook e caixa monitorada falsos.
 * Provam regras, guardas e rastreabilidade — não a geração dos documentos
 * reais nem a integração real com o Graph.
 */

const ASSINADO = assinadoSintetico('TERMO COM ASSINATURA DIGITAL SINTETICA DO SIGNATARIO LEGAL');

async function preparado(c?: Awaited<ReturnType<typeof cenarioDocumental>>) {
  const cen = c ?? await cenarioDocumental();
  const r = await prepararDocumento(cen.deps, ATOR, MASTER);
  assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
  return { c: cen, documentoId: (r as { documentoId: string }).documentoId };
}

/** Arquivo com a assinatura (sintética) do signatário legal anexado pelo Analista e, por padrão, a conferência humana CONFORME (DOC-24). */
async function assinado(c?: Awaited<ReturnType<typeof cenarioDocumental>>, arquivo = ASSINADO, conferir = true) {
  const { c: cen, documentoId } = await preparado(c);
  const a = await registrarAssinatura(cen.deps, ATOR, documentoId, arquivo);
  assert.equal(a.tipo, 'REGISTRADA', JSON.stringify(a));
  const assinaturaId = (a as { assinaturaId: string }).assinaturaId;
  if (conferir) {
    const k = await conferirAssinatura(cen.deps, ATOR, documentoId, { assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
    assert.equal(k.tipo, 'CONFERENCIA_REGISTRADA', JSON.stringify(k));
  }
  return { c: cen, documentoId, assinaturaId };
}

async function comRascunho(c?: Awaited<ReturnType<typeof cenarioDocumental>>) {
  const s = await assinado(c);
  const r = await prepararRascunho(s.c.deps, ATOR, MASTER, { outlook: s.c.outlook, caixaMonitorada: s.c.caixa }, { autorizacao: PERMITIDA });
  assert.equal(r.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(r));
  const envioId = (r as { envioId: string }).envioId;
  const rascunhoId = (await s.c.repo.tentativa(ORG, envioId))!.rascunho!.id;
  return { ...s, envioId, rascunhoId };
}

async function enviado(c?: Awaited<ReturnType<typeof cenarioDocumental>>) {
  const s = await comRascunho(c);
  s.c.outlook.enviarPeloOutlook(s.rascunhoId);
  const r = await conciliarEnvio(s.c.deps, ATOR, s.envioId, s.c.outlook);
  assert.equal(r.tipo, 'ENVIO_CONFIRMADO', JSON.stringify(r));
  return s;
}

const situacao = async (c: Awaited<ReturnType<typeof cenarioDocumental>>, op = {}) => (await avaliarDocumentacao(c.deps, ORG, MASTER, op)).situacao;

/* -------------------------------------------- DOC-A -------------------------------------------- */

test('[DOC-A] Evergreen: termo gerado com dados confiáveis → preparação concluída, assinatura pendente', async () => {
  const { c, documentoId } = await preparado();
  const d = c.repo.m.documentos[0];
  const t = texto(d.arquivo);
  assert.ok(t.includes(CLAUSULA) && t.includes(TABELA), 'texto fixo e tabela saem como estão');
  assert.ok(t.includes('EGLVTESTE0001') && t.includes('NAVIO TESTE') && t.includes('2026-10-14'));
  assert.ok(t.includes('[assinatura: EM BRANCO — ASSINATURA HUMANA]'));
  assert.deepEqual(d.modelo, { modeloId: c.modelos.TERMO_EVERGREEN, versao: 'sintetica-1' });
  const s = await situacao(c);
  assert.equal(s.preparo.tipo, 'PREPARADO');
  // O termo sintético não tem campos de quem assina: não há identidade de signatário representada.
  assert.deepEqual(s.assinatura, { tipo: 'PENDENTE_HUMANA', documentoId, signatarioEsperado: null });
  assert.equal(s.proximoPasso?.passo, 'ASSINAR_DOCUMENTO');
  assert.equal(c.repo.m.assinaturas.length, 0);
  assert.equal(c.repo.m.tentativas.length, 0);
});

/* -------------------------------------------- DOC-B -------------------------------------------- */

test('[DOC-B] arquivo assinado anexado na versão correta → documento assinado, ainda não enviado', async () => {
  const { c, documentoId, assinaturaId } = await assinado();
  const s = await situacao(c, { autorizacao: PERMITIDA });
  assert.deepEqual(s.assinatura.tipo === 'CONFERIDA' && [s.assinatura.assinatura.assinaturaId, s.assinatura.assinatura.registradoPor], [assinaturaId, ANALISTA]);
  assert.equal(s.envio.tipo, 'PODE_PREPARAR_RASCUNHO');
  assert.equal(s.proximoPasso?.passo, 'PREPARAR_RASCUNHO_NO_OUTLOOK');
  assert.equal(c.repo.m.tentativas.length, 0, 'assinado ≠ enviado');
  assert.deepEqual(c.outlook.chamadas, []);
  // Assinatura de outra versão não vale: dados mudam → nova versão → assinatura pendente outra vez.
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'NOME_DO_NAVIO' ? { ...v, valor: 'NAVIO CORRIGIDO' } : v));
  const r = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.notEqual((r as { documentoId: string }).documentoId, documentoId);
  assert.equal((await situacao(c)).assinatura.tipo, 'PENDENTE_HUMANA');
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, pdf('outra')), { tipo: 'RECUSADA', motivo: 'DOCUMENTO_NAO_VIGENTE' });
});

/* -------------------------------------------- DOC-C -------------------------------------------- */

test('[DOC-C] rascunho no Outlook do PRÓPRIO Analista com o termo assinado e o MBL em PDF → disponível para conferência, nada enviado', async () => {
  const { c, envioId, rascunhoId, documentoId, assinaturaId } = await comRascunho();
  const msg = c.outlook.caixa.get(rascunhoId)!;
  assert.equal(msg.isDraft, true);
  assert.equal(msg.assunto, 'Solicitação de agendamento de apresentação de BL – EGLVTESTE0001');
  assert.deepEqual(msg.para, ['agendamento@agencia.teste']);
  assert.deepEqual(msg.anexos.map((a) => [a.nome, sha256(a.bytes)]), [['EVERGREEN TERMO EGLVTESTE0001.pdf', sha256(ASSINADO)], ['MBL.pdf', sha256(MBL_BYTES)]]);
  const t = (await c.repo.tentativa(ORG, envioId))!;
  assert.equal(t.estado, 'RASCUNHO_DISPONIVEL');
  assert.deepEqual([t.documentoId, t.assinaturaId, t.analista], [documentoId, assinaturaId, { membershipId: ANALISTA, contaMicrosoft: 'conta-analista' }]);
  assert.equal(t.composicao.corpo, CORPO_AGENDAMENTO_GRIEG);
  assert.deepEqual(t.anexos.map((a) => a.origem.tipo), ['ASSINATURA', 'ANEXO_DO_EMAIL']);
  assert.deepEqual(c.repo.m.eventosDoEnvio.map((e) => e.tipo), ['TENTATIVA_ABERTA', 'RASCUNHO_CRIADO']);
  assert.ok(!c.outlook.chamadas.includes('enviarRascunho'), 'a Priora não envia sozinha');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'CONFERIR_E_ENVIAR_RASCUNHO');
});

test('[DOC-C] só a conta do próprio Analista: nunca a caixa monitorada, nunca o Outlook de outra pessoa', async () => {
  const { c } = await assinado();
  const tentar = (outlook: ReturnType<typeof outlookFalso>) => prepararRascunho(c.deps, ATOR, MASTER, { outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  assert.equal((await tentar(outlookFalso(ANALISTA, 'conta-clara')) as { motivo: string }).motivo, 'CONTA_DO_ANALISTA_INVALIDA');
  assert.equal((await tentar(outlookFalso(OUTRO_ANALISTA, 'conta-outro')) as { motivo: string }).motivo, 'CONTA_DO_ANALISTA_INVALIDA');
  assert.equal((await tentar(outlookFalso(ANALISTA, 'conta-de-outra-pessoa')) as { motivo: string }).motivo, 'CONTA_DO_ANALISTA_INVALIDA');
  // Mesmo a pessoa cuja conta vinculada É a caixa monitorada não usa essa caixa como se fosse a conta humana.
  const dono = { organizationId: ORG, membershipId: DONO_DA_CAIXA };
  const r = await prepararRascunho(c.deps, dono, MASTER, { outlook: outlookFalso(DONO_DA_CAIXA, 'conta-clara'), caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  assert.equal((r as { motivo: string }).motivo, 'CONTA_DO_ANALISTA_INVALIDA');
  assert.equal(c.repo.m.tentativas.length, 0);
});

/* -------------------------------------------- DOC-D -------------------------------------------- */

test('[DOC-D] envio pelo próprio Outlook: só a leitura do Graph confirma (mensagem enviada, com data de envio)', async () => {
  const { c, envioId, rascunhoId } = await comRascunho();
  c.outlook.enviarPeloOutlook(rascunhoId);
  // Antes da conciliação, a Priora não presume nada.
  assert.equal((await c.repo.tentativa(ORG, envioId))!.estado, 'RASCUNHO_DISPONIVEL');
  const r = await conciliarEnvio(c.deps, ATOR, envioId, c.outlook);
  assert.deepEqual([r.tipo, (r as { detalhe: unknown }).detalhe], ['ENVIO_CONFIRMADO', { tipo: 'CONFORME' }]);
  const t = (await c.repo.tentativa(ORG, envioId))!;
  assert.deepEqual([t.confirmacao?.internetMessageId, t.confirmacao?.conversationId], [`<${rascunhoId}@teste>`, `conv-${rascunhoId}`]);
  assert.equal(c.repo.m.eventosDoEnvio.at(-1)?.origem, 'INTEGRACAO');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'ACOMPANHAR_APRESENTACAO_NA_L1B');
});

test('[DOC-D] envio pedido pela Priora (ação explícita): pedido aceito sem efeito visível fica SOLICITADO; confirma só depois', async () => {
  const { c, envioId, rascunhoId } = await comRascunho();
  c.outlook.envioSemEfeitoImediato = true;
  const r = await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook);
  assert.equal(r.tipo, 'ENVIO_SOLICITADO');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'CONFIRMAR_ENVIO_NO_OUTLOOK');
  c.outlook.enviarPeloOutlook(rascunhoId);
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
  assert.deepEqual(c.repo.m.eventosDoEnvio.map((e) => e.tipo), ['TENTATIVA_ABERTA', 'RASCUNHO_CRIADO', 'ENVIO_SOLICITADO', 'ENVIO_CONFIRMADO']);
  // Outra pessoa não envia nem concilia o rascunho que está na caixa do Analista.
  const s = await comRascunho();
  assert.equal((await enviarPelaPriora(s.c.deps, { organizationId: ORG, membershipId: OUTRO_ANALISTA }, s.envioId, outlookFalso(OUTRO_ANALISTA, 'conta-outro')) as { motivo: string }).motivo,
    'NAO_E_O_ANALISTA_DA_TENTATIVA');
});

test('[DOC-D] rascunho alterado no Outlook é registrado; envio com composição diferente é confirmado COM a divergência visível', async () => {
  const { c, envioId, rascunhoId } = await comRascunho();
  c.outlook.editarNoOutlook(rascunhoId);
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'RASCUNHO_DISPONIVEL');
  assert.equal(c.repo.m.eventosDoEnvio.at(-1)?.tipo, 'RASCUNHO_ALTERADO');
  // Reconciliar de novo sem mudança não grava nada.
  const antes = c.repo.m.eventosDoEnvio.length;
  await conciliarEnvio(c.deps, ATOR, envioId, c.outlook);
  assert.equal(c.repo.m.eventosDoEnvio.length, antes);
  c.outlook.editarNoOutlook(rascunhoId, (m) => { m.anexos = m.anexos.filter((a) => a.nome !== 'MBL.pdf'); });
  c.outlook.enviarPeloOutlook(rascunhoId);
  const r = await conciliarEnvio(c.deps, ATOR, envioId, c.outlook);
  assert.deepEqual([r.tipo, (r as { detalhe: unknown }).detalhe], ['ENVIO_CONFIRMADO', { tipo: 'DIVERGENTE', divergencias: ['ANEXO_AUSENTE:COPIA_DO_MBL'] }]);
});

/* -------------------------------------------- DOC-E -------------------------------------------- */

test('[DOC-E] Grieg: solicitação de agendamento enviada não comprova apresentação nem cria BL_ENCAMINHADO_PARA_APRESENTACAO', async () => {
  const { c } = await enviado();
  const docs = c.repo.m.documentos;
  const assinaturas = c.repo.m.assinaturas;
  const tentativas = c.repo.m.tentativas;
  const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador('EVERGREEN')), docs, assinaturas, tentativas, c.repo.m.conferencias);
  assert.deepEqual(fatos.eventos, []);
  // DOC-28: preparado, assinado, conferido e solicitação enviada são fatos distintos, todos no domínio documental.
  assert.deepEqual(fatos.mantidosNoDominioDocumental.map((x) => x.fato),
    ['TERMO_EVERGREEN_PREPARADO', 'TERMO_EVERGREEN_ASSINADO', 'TERMO_EVERGREEN_CONFERIDO', 'SOLICITACAO_DE_AGENDAMENTO_ENVIADA']);
  const base = { ...clienteOk(), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(2)) }) };
  const sem = decidir({ ...base, armador: armador('EVERGREEN') });
  const com = decidir({ ...base, armador: armador('EVERGREEN'), procedimento: acrescentarAoProcedimento(procedimento([]), fatos) });
  assert.deepEqual(com, sem, 'a L1b não muda');
  assert.ok(!com.progresso.some((m) => m.marco === 'MASTER_APRESENTADO' || m.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO'));
  assert.equal(com.apresentacao, null);
});

/* -------------------------------------------- DOC-F -------------------------------------------- */

test('[DOC-F] protocolo carimbado + confirmação do Analista → a L1b reconhece a apresentação pelas regras congeladas', async () => {
  const { c } = await enviado();
  const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador('EVERGREEN')), c.repo.m.documentos, c.repo.m.assinaturas, c.repo.m.tentativas);
  const g = { ...clienteOk(), armador: armador('EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(2)) }) };
  const proc = (confirmadaPor: string | null) => procedimento([evento('PREPARACAO_REGISTRADA', T(3))], [apresentacao('PROTOCOLO_CARIMBADO', T(9), confirmadaPor)], [encaminhado(T(5), 'ana', 'GRIEG')]);
  const comDocs = decidir({ ...g, procedimento: acrescentarAoProcedimento(proc('ana'), fatos) });
  const semDocs = decidir({ ...g, procedimento: proc('ana') });
  assert.ok(comDocs.progresso.some((m) => m.marco === 'MASTER_APRESENTADO'));
  assert.deepEqual(comDocs, semDocs);
  assert.ok(!decidir({ ...g, procedimento: acrescentarAoProcedimento(proc(null), fatos) }).progresso.some((m) => m.marco === 'MASTER_APRESENTADO'),
    'sem confirmação do Analista não há apresentação');
});

/* -------------------------------------------- DOC-G -------------------------------------------- */

test('[DOC-G] agência pede correção: nova versão e reenvio justificado (motivo + autorizador), sem apagar histórico', async () => {
  const primeiro = await enviado();
  const c = primeiro.c;
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'NOME_DO_NAVIO' ? { ...v, valor: 'NAVIO CORRIGIDO' } : v));
  assert.equal((await situacao(c)).proximoPasso?.passo, 'GERAR_NOVA_VERSAO');
  const { documentoId: novoDoc } = await assinado(c, assinadoSintetico('TERMO CORRIGIDO E ASSINADO'));
  assert.notEqual(novoDoc, primeiro.documentoId);
  assert.equal((await situacao(c, { autorizacao: PERMITIDA })).proximoPasso?.passo, 'PREPARAR_REENVIO');
  const acesso = { outlook: c.outlook, caixaMonitorada: c.caixa };
  // Sem pedido de reenvio, é duplicidade acidental.
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }) as { motivo: string }).motivo, 'JA_ENVIADO');
  const semMotivo = await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA, reenvio: { de: primeiro.envioId, motivo: ' ', autorizadoPor: GESTOR } });
  assert.deepEqual((semMotivo as { avaliacao: { motivos: string[] } }).avaliacao.motivos, ['REENVIO_SEM_MOTIVO']);
  const reenvio = { de: primeiro.envioId, motivo: 'Agência pediu correção do navio', autorizadoPor: GESTOR };
  const r = await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA, reenvio });
  assert.equal(r.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(r));
  const segundo = (r as { envioId: string }).envioId;
  c.outlook.enviarPeloOutlook((await c.repo.tentativa(ORG, segundo))!.rascunho!.id);
  assert.equal((await conciliarEnvio(c.deps, ATOR, segundo, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
  const [t1, t2] = c.repo.m.tentativas;
  assert.deepEqual([t1.estado, t1.documentoId], ['ENVIO_CONFIRMADO', primeiro.documentoId], 'envio original preservado');
  assert.deepEqual([t2.estado, t2.documentoId, t2.reenvio], ['ENVIO_CONFIRMADO', novoDoc, reenvio]);
  assert.equal(c.repo.m.documentos.length, 2, 'versão anterior preservada');
  // Um reenvio que ainda se refere ao primeiro envio está desatualizado (evita reenvio duplicado).
  const velho = await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA, reenvio });
  assert.deepEqual((velho as { avaliacao: { motivos: string[] } }).avaliacao.motivos, ['REENVIO_DESATUALIZADO']);
});

/* -------------------------------------------- DOC-H -------------------------------------------- */

test('[DOC-H] duas solicitações concorrentes da mesma intenção → no máximo uma execução efetiva', async () => {
  const { c } = await assinado();
  const acesso = { outlook: c.outlook, caixaMonitorada: c.caixa };
  const [a, b] = await Promise.all([
    prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }),
    prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }),
  ]);
  assert.deepEqual([a.tipo, b.tipo].sort(), ['NAO_PREPARADO', 'RASCUNHO_DISPONIVEL']);
  assert.equal(c.outlook.chamadas.filter((x) => x === 'criarRascunho').length, 1);
  const envioId = ((a.tipo === 'RASCUNHO_DISPONIVEL' ? a : b) as { envioId: string }).envioId;
  const [x, y] = await Promise.all([enviarPelaPriora(c.deps, ATOR, envioId, c.outlook), enviarPelaPriora(c.deps, ATOR, envioId, c.outlook)]);
  assert.deepEqual([x.tipo, y.tipo].sort(), ['ENVIO_CONFIRMADO', 'SEM_ACAO']);
  assert.equal(c.outlook.chamadas.filter((z) => z === 'enviarRascunho').length, 1);
  assert.equal(c.repo.m.tentativas.length, 1);
});

/* -------------------------------------------- DOC-I -------------------------------------------- */

test('[DOC-I] falha durante o envio → resultado incerto; nada é reenviado até conciliar (pelo Graph e, se preciso, por pessoa)', async () => {
  const { c, envioId, rascunhoId } = await comRascunho();
  c.outlook.falhar.enviar = new Error('timeout');
  assert.equal((await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook)).tipo, 'RESULTADO_INCERTO');
  c.outlook.falhar = {};
  const acesso = { outlook: c.outlook, caixaMonitorada: c.caixa };
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }) as { motivo: string }).motivo, 'CONCILIACAO_NECESSARIA');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'CONCILIAR_ENVIO_INCERTO');
  // Pessoa não concilia antes do Graph ser consultado.
  assert.equal((await conciliarManualmente(c.deps, ATOR, envioId, { justificativa: 'acho que não saiu', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' }) as { motivo: string }).motivo, 'CONCILIACAO_PELO_GRAPH_NECESSARIA');
  // O Graph mostra que continua rascunho: nada saiu; o MESMO rascunho volta a estar disponível (enviar de novo não duplica).
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'RASCUNHO_DISPONIVEL');
  // Agora a mensagem some: incerto de novo, e só então a pessoa pode concluir "não enviado".
  c.outlook.falhar.enviar = new Error('timeout');
  await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook);
  c.outlook.falhar = {};
  c.outlook.apagarNoOutlook(rascunhoId);
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'RESULTADO_INCERTO');
  // As duas buscas (pelo id e pelo Internet Message ID) ficaram registradas; sozinhas não concluem nada.
  const ultimo = c.repo.m.eventosDoEnvio.filter((e) => e.envioId === envioId).at(-1)!;
  assert.deepEqual([ultimo.tipo, ultimo.detalhe.motivo, ultimo.detalhe.buscas], ['RESULTADO_INCERTO', 'MENSAGEM_NAO_ENCONTRADA', ['ID_IMUTAVEL', 'INTERNET_MESSAGE_ID']]);
  assert.equal(c.repo.m.tentativas[0].estado, 'RESULTADO_INCERTO', 'busca negativa não conclui "não enviado"');
  assert.equal((await conciliarManualmente(c.deps, ATOR, envioId, { justificativa: ' ', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' }) as { motivo: string }).motivo, 'SEM_JUSTIFICATIVA');
  assert.equal((await conciliarManualmente(c.deps, ATOR, envioId, { justificativa: 'ok', verificacao: 'QUALQUER' as never }) as { motivo: string }).motivo, 'VERIFICACAO_HUMANA_INVALIDA');
  // Itens Enviados são da caixa do PRÓPRIO Analista da tentativa: outra pessoa não declara que os conferiu.
  assert.equal((await conciliarManualmente(c.deps, { organizationId: ORG, membershipId: GESTOR }, envioId,
    { justificativa: 'conferi', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' }) as { motivo: string }).motivo, 'NAO_E_O_ANALISTA_DA_TENTATIVA');
  assert.equal((await conciliarManualmente(c.deps, ATOR, envioId, { justificativa: 'Itens Enviados e Excluídos conferidos; nada saiu', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' })).tipo, 'ENVIO_NAO_REALIZADO');
  assert.equal(c.outlook.chamadas.filter((z) => z === 'enviarRascunho').length, 2, 'só os pedidos explícitos; nenhum reenvio automático');
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA })).tipo, 'RASCUNHO_DISPONIVEL');
  assert.deepEqual(c.repo.m.tentativas.map((t) => t.estado), ['ENVIO_NAO_REALIZADO', 'RASCUNHO_DISPONIVEL']);
});

test('[DOC-I] o id não encontra a mensagem, mas ela saiu (id mudou): a busca independente acha a enviada e confirma — nunca "não enviado"', async () => {
  const { c, envioId, rascunhoId } = await comRascunho();
  c.outlook.falhar.enviar = new Error('timeout');
  assert.equal((await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook)).tipo, 'RESULTADO_INCERTO');
  c.outlook.falhar = {};
  c.outlook.enviarPeloOutlook(rascunhoId);
  c.outlook.trocarIdNoOutlook(rascunhoId, 'id-depois-de-movida');
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
  assert.deepEqual(c.outlook.chamadas.slice(-2), ['lerMensagem', 'buscarPorInternetMessageId']);
  assert.equal(c.repo.m.tentativas[0].confirmacao?.internetMessageId, `<${rascunhoId}@teste>`);
});

test('[DOC-I] sem Internet Message ID do rascunho: só a busca pelo id não basta; a pessoa só concilia com a confirmação da agência', async () => {
  const { c, envioId, rascunhoId } = await comRascunho();
  c.outlook.falhar.enviar = new Error('timeout');
  await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook);
  c.outlook.falhar = {};
  const t = c.repo.m.tentativas[0];
  t.rascunho = { ...t.rascunho!, internetMessageId: null };
  c.outlook.apagarNoOutlook(rascunhoId);
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'RESULTADO_INCERTO');
  assert.deepEqual(c.repo.m.eventosDoEnvio.filter((e) => e.envioId === envioId).at(-1)!.detalhe.buscas, ['ID_IMUTAVEL']);
  assert.equal((await conciliarManualmente(c.deps, ATOR, envioId, { justificativa: 'conferi', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' }) as { motivo: string }).motivo, 'BUSCA_INDEPENDENTE_NECESSARIA');
  assert.equal((await conciliarManualmente(c.deps, ATOR, envioId, { justificativa: 'agência confirmou por telefone que não recebeu', verificacao: 'AGENCIA_CONFIRMOU_NAO_RECEBIMENTO' })).tipo, 'ENVIO_NAO_REALIZADO');
});

/* -------------------------------------------- DOC-J -------------------------------------------- */

const respostaDaAgencia = (envio: { internetMessageId: string | null }, p: Partial<{ remetente: string; leitura: 'INEQUIVOCA' | 'AMBIGUA'; messageId: string; emRespostaA: string | null }> = {}) => ({
  messageId: p.messageId ?? 'resposta-1', internetMessageId: '<resposta-1@agencia>', conversationId: null, emRespostaA: p.emRespostaA === undefined ? envio.internetMessageId : p.emRespostaA,
  remetente: p.remetente ?? 'Agendamento@Agencia.teste', recebidaEm: '2026-10-15T10:00:00.000Z',
});

test('[DOC-J] agência informa inequivocamente que o modelo não é mais aceito → versão rejeitada, evidência preservada, novos envios bloqueados', async () => {
  const s = await enviado();
  const c = s.c;
  const t = (await c.repo.tentativa(ORG, s.envioId))!;
  const sinal = { modeloId: c.modelos.TERMO_EVERGREEN!, envioId: s.envioId, email: respostaDaAgencia(t.confirmacao!), leitura: 'INEQUIVOCA' as const, trecho: 'Esse termo não é mais aceito. Segue o novo modelo.' };
  const r = await registrarSinalDeRejeicao(c.deps, ORG, sinal);
  assert.deepEqual(r.tipo === 'REGISTRADO' && [r.novo, r.veredicto], [true, { tipo: 'REJEICAO_CONFIRMADA' }]);
  const versao = (await c.repo.versao(ORG, c.modelos.TERMO_EVERGREEN!))!;
  assert.equal(versao.estado, 'REJEITADO_PELA_AGENCIA');
  assert.deepEqual(versao.rejeicao?.confirmadaPor, { tipo: 'ORIGEM_CONFIAVEL_E_MENSAGEM_INEQUIVOCA' });
  // A mesma mensagem não vira outro sinal.
  assert.deepEqual((await registrarSinalDeRejeicao(c.deps, ORG, sinal) as { novo: boolean }).novo, false);
  // Histórico preservado.
  assert.equal(c.repo.m.documentos.length, 1);
  assert.equal(c.repo.m.tentativas[0].estado, 'ENVIO_CONFIRMADO');
  // Bloqueio: sem versão validada, nenhum documento nem envio com a versão rejeitada.
  assert.equal((await situacao(c)).proximoPasso?.passo, 'OBTER_NOVO_MODELO_DA_AGENCIA');
  const reenvio = { de: s.envioId, motivo: 'reenviar', autorizadoPor: GESTOR };
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA, reenvio }) as { motivo: string }).motivo,
    'SEM_VERSAO_VALIDADA_DO_MODELO');
  assert.equal((await prepararDocumento(c.deps, ATOR, MASTER) as { motivo: string }).motivo, 'CONDICOES_NAO_ATENDIDAS');
});

test('[DOC-J] rascunho aberto feito com a versão depois rejeitada não pode ser enviado pela Priora', async () => {
  const s = await comRascunho();
  const c = s.c;
  // Outra resposta confiável (a um envio anterior confirmado desta versão) rejeita o modelo.
  await c.repo.mudarEstadoDoModelo(ORG, c.modelos.TERMO_EVERGREEN!, 'VALIDADO', 'REJEITADO_PELA_AGENCIA',
    { tipo: 'REJEICAO_CONFIRMADA', origem: 'PESSOA', por: GESTOR, detalhe: { sinalId: 'x' } }, c.relogio.agora());
  assert.equal((await enviarPelaPriora(c.deps, ATOR, s.envioId, c.outlook) as { motivo: string }).motivo, 'DOCUMENTO_DO_RASCUNHO_NAO_E_MAIS_VALIDO');
  assert.ok(!c.outlook.chamadas.includes('enviarRascunho'));
});

/* -------------------------------------------- DOC-K -------------------------------------------- */

test('[DOC-K] mensagem ambígua ou de origem não comprovada → validação humana; o modelo NÃO é invalidado sozinho', async () => {
  const s = await enviado();
  const c = s.c;
  const conf = (await c.repo.tentativa(ORG, s.envioId))!.confirmacao!;
  const modeloId = c.modelos.TERMO_EVERGREEN!;
  const ambigua = await registrarSinalDeRejeicao(c.deps, ORG, { modeloId, envioId: s.envioId, email: respostaDaAgencia(conf), leitura: 'AMBIGUA', trecho: 'Favor verificar o documento.' });
  assert.deepEqual((ambigua as { veredicto: unknown }).veredicto, { tipo: 'VALIDACAO_HUMANA', motivos: ['LEITURA_AMBIGUA'] });
  const outraOrigem = await registrarSinalDeRejeicao(c.deps, ORG, {
    modeloId, envioId: s.envioId, email: respostaDaAgencia(conf, { remetente: 'alguem@outro.teste', messageId: 'resposta-2', emRespostaA: null }), leitura: 'INEQUIVOCA', trecho: 'não aceito',
  });
  assert.deepEqual((outraOrigem as { veredicto: unknown }).veredicto, { tipo: 'VALIDACAO_HUMANA', motivos: ['REMETENTE_NAO_CONFIAVEL', 'NAO_RESPONDE_AO_ENVIO'] });
  assert.equal((await c.repo.versao(ORG, modeloId))!.estado, 'VALIDADO');
  const sit = await situacao(c);
  assert.equal(sit.proximoPasso?.passo, 'ANALISAR_SINAL_DE_REJEICAO');
  // Pessoa descarta um e confirma o outro, com justificativa.
  const s1 = (ambigua as { sinalId: string }).sinalId;
  const s2 = (outraOrigem as { sinalId: string }).sinalId;
  assert.deepEqual(await decidirSinalDeRejeicao(c.deps, ATOR, s1, 'DESCARTAR', ''), { tipo: 'RECUSADO', motivo: 'SEM_JUSTIFICATIVA' });
  assert.deepEqual(await decidirSinalDeRejeicao(c.deps, ATOR, s1, 'DESCARTAR', 'Pedido de conferência, não de troca de modelo'), { tipo: 'OK' });
  assert.equal((await c.repo.versao(ORG, modeloId))!.estado, 'VALIDADO');
  assert.deepEqual(await decidirSinalDeRejeicao(c.deps, ATOR, s1, 'CONFIRMAR_REJEICAO', 'mudei de ideia'), { tipo: 'RECUSADO', motivo: 'SINAL_NAO_AGUARDA_DECISAO' });
  assert.deepEqual(await decidirSinalDeRejeicao(c.deps, { organizationId: ORG, membershipId: GESTOR }, s2, 'CONFIRMAR_REJEICAO', 'Confirmado por telefone com a agência'), { tipo: 'OK' });
  const v = (await c.repo.versao(ORG, modeloId))!;
  assert.deepEqual([v.estado, v.rejeicao?.confirmadaPor], ['REJEITADO_PELA_AGENCIA', { tipo: 'PESSOA', por: GESTOR }]);
});

/* -------------------------------------------- DOC-L -------------------------------------------- */

test('[DOC-L] substituto enviado pela agência só entra em uso depois da leitura e da validação humana', async () => {
  const s = await enviado();
  const c = s.c;
  const antigo = c.modelos.TERMO_EVERGREEN!;
  const conf = (await c.repo.tentativa(ORG, s.envioId))!.confirmacao!;
  const sinal = await registrarSinalDeRejeicao(c.deps, ORG, { modeloId: antigo, envioId: s.envioId, email: respostaDaAgencia(conf), leitura: 'INEQUIVOCA', trecho: 'Segue o novo modelo.' });
  const novoArquivo = arquivoSintetico('TERMO_EVERGREEN', 'v2-da-agencia');
  const sub = await registrarModeloSubstituto(c.deps, ORG, {
    substitui: antigo, email: respostaDaAgencia(conf), anexo: { attachmentId: 'anexo-novo', nome: 'TERMO NOVO.pdf' }, arquivo: novoArquivo,
    sinalId: (sinal as { sinalId: string }).sinalId,
  });
  assert.equal(sub.tipo, 'OK');
  const novo = (sub as { modeloId: string }).modeloId;
  const v = (await c.repo.versao(ORG, novo))!;
  assert.deepEqual([v.estado, v.definicao, v.origem.tipo], ['PENDENTE_DE_VALIDACAO', null, 'SUBSTITUTO_DA_AGENCIA']);
  assert.equal((await situacao(c)).proximoPasso?.passo, 'VALIDAR_VERSAO_DO_MODELO', 'pendente não entra em uso');
  // O mesmo arquivo não é reprocessado.
  assert.equal((await registrarModeloSubstituto(c.deps, ORG, { substitui: antigo, email: respostaDaAgencia(conf), anexo: { attachmentId: 'anexo-novo', nome: 'x.pdf' }, arquivo: novoArquivo, sinalId: null }) as { novo: boolean }).novo, false);
  // Validação exige leitura completa e coerente (nada do exemplo no texto fixo, lugar da assinatura).
  assert.deepEqual(await validarModelo(c.deps, ATOR, novo), { tipo: 'RECUSADO', motivo: 'SEM_DEFINICAO', detalhe: undefined });
  const vazada: DefinicaoDoModelo = definicaoEvergreen({ blocosFixos: [{ id: 'clausula', natureza: 'TEXTO_JURIDICO', texto: `Navio: NAVIO DO EXEMPLO. ${CLAUSULA}` }] });
  assert.equal((await definirLeituraDoModelo(c.deps, ATOR, novo, vazada)).tipo, 'OK');
  assert.equal((await validarModelo(c.deps, ATOR, novo) as { motivo: string }).motivo, 'DEFINICAO_INVALIDA');
  assert.equal((await definirLeituraDoModelo(c.deps, ATOR, novo, definicaoEvergreen())).tipo, 'OK');
  assert.equal((await validarModelo(c.deps, ATOR, novo)).tipo, 'OK');
  // Agora a nova versão é a vigente: o termo é gerado de novo com ela.
  const r = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.equal(r.tipo, 'PREPARADO');
  assert.equal(c.repo.m.documentos.at(-1)!.modelo.modeloId, novo);
  assert.equal((await definirLeituraDoModelo(c.deps, ATOR, novo, definicaoEvergreen()) as { motivo: string }).motivo, 'VERSAO_NAO_ESTA_PENDENTE');
});

test('[DOC-L] cadastro inicial também fica pendente até validação; cliente não cadastra nem valida', async () => {
  const c = await cenarioDocumental({ defs: {} });
  const arquivo = arquivoSintetico('TERMO_EVERGREEN', 'cadastro');
  const r = await cadastrarModelo(c.deps, ATOR, { tipo: 'TERMO_EVERGREEN', versao: 'oficial-1', arquivo, definicao: definicaoEvergreen() });
  assert.equal(r.tipo, 'OK');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'VALIDAR_VERSAO_DO_MODELO');
  assert.deepEqual(await cadastrarModelo(c.deps, ATOR, { tipo: 'TERMO_EVERGREEN', versao: 'x', arquivo: new TextEncoder().encode('não é pdf') }), { tipo: 'RECUSADO', motivo: 'ARQUIVO_NAO_E_PDF' });
  assert.deepEqual(await validarModelo(c.deps, { organizationId: ORG, membershipId: 'm-cliente' }, (r as { modeloId: string }).modeloId), { tipo: 'RECUSADO', motivo: 'PESSOA_SEM_PERMISSAO' });
  assert.equal((await validarModelo(c.deps, ATOR, (r as { modeloId: string }).modeloId)).tipo, 'OK');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'GERAR_DOCUMENTO');
});

/* -------------------------------------------- DOC-M -------------------------------------------- */

const MEMORANDOS: Array<[Exclude<TipoDocumento, 'TERMO_EVERGREEN'>, string]> = [
  ['MEMORANDO_MSC', 'MSC'], ['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM'],
];
const evidenciaFisica = { fonte: 'courier', ref: 'mbl-recebido' };

test('[DOC-M] MSC/Hapag/ZIM: serviço selecionado automaticamente só com regra explícita e modalidade provada; ambiguidade → Analista', async () => {
  const regra = { id: 'R-SINTETICA-1', grupo: 'servico', alternativa: 'SERVICO_A', quandoModalidade: 'FISICO' as const, fundamento: 'REGRA SINTÉTICA DE TESTE (nenhuma regra real aprovada)' };
  for (const [tipo, codigo] of MEMORANDOS) {
    const def = definicaoMemorando(tipo, { regras: [regra] });
    // Regra inequívoca + modalidade única provada → seleção automática, com origem.
    const auto = await cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: def }, modalidade: { tipo: 'UNICA', modalidade: 'FISICO', evidencia: evidenciaFisica } });
    const r = await prepararDocumento(auto.deps, ATOR, MASTER);
    assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
    assert.deepEqual(auto.repo.m.documentos[0].selecoes, [{ grupo: 'servico', alternativas: ['SERVICO_A'], origem: { tipo: 'REGRA', regras: [{ id: regra.id, fundamento: regra.fundamento }], evidencia: evidenciaFisica } }]);
    // Modalidade ambígua ou desconhecida → nada é selecionado; o Analista escolhe.
    for (const modalidade of [{ tipo: 'AMBIGUA' as const, modalidades: ['FISICO' as const, 'WAVE' as const] }, { tipo: 'DESCONHECIDA' as const }]) {
      const c = await cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: def }, modalidade });
      const s = await situacao(c);
      assert.equal(s.proximoPasso?.passo, 'ESCOLHER_OPCOES_DO_MODELO', tipo);
      const esc = { grupo: 'servico', alternativas: ['SERVICO_C'], por: ANALISTA, em: '2026-10-14T12:00:00.000Z' };
      const p = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: [esc] });
      assert.equal(p.tipo, 'PREPARADO');
      assert.deepEqual(c.repo.m.documentos[0].selecoes[0].origem, { tipo: 'ANALISTA', por: ANALISTA, em: esc.em });
      // Alternativa restrita a FISICO não pode ser marcada sem a modalidade provada: nada é preparado com ela.
      const restrita = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: [{ ...esc, alternativas: ['SERVICO_A'] }] });
      assert.equal(restrita.tipo, 'NAO_PREPARADO', tipo);
      const p2 = restrita.situacao?.preenchimento;
      assert.deepEqual(p2?.tipo === 'INCOMPLETO' && p2.problemasDeOpcao, [{ tipo: 'MODALIDADE_NECESSARIA_PARA_A_ALTERNATIVA', grupo: 'servico', alternativa: 'SERVICO_A' }]);
      assert.equal(c.repo.m.documentos.length, 1);
    }
    // Escolha incompatível com a modalidade, ou contrária à regra, é recusada.
    const wave = await cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: def }, modalidade: { tipo: 'UNICA', modalidade: 'WAVE', evidencia: { fonte: 'email', ref: 'wave' } } });
    const incomp = await prepararDocumento(wave.deps, ATOR, MASTER, { escolhas: [{ grupo: 'servico', alternativas: ['SERVICO_A'], por: ANALISTA, em: '2026-10-14T12:00:00.000Z' }] });
    assert.equal(incomp.tipo, 'NAO_PREPARADO');
    const contraRegra = await prepararDocumento(auto.deps, ATOR, MASTER, { escolhas: [{ grupo: 'servico', alternativas: ['SERVICO_C'], por: ANALISTA, em: '2026-10-14T12:00:00.000Z' }] });
    assert.equal(contraRegra.tipo, 'NAO_PREPARADO', `${tipo}: escolha contrária à regra`);
  }
});

test('[DOC-M] regras em conflito para a mesma modalidade → nenhuma seleção automática', async () => {
  const def = definicaoMemorando('MEMORANDO_MSC', {
    opcoes: [{ ...definicaoMemorando('MEMORANDO_MSC').opcoes[0], selecao: 'EXATAMENTE_UMA', incompativeis: [] }],
    regras: [
      { id: 'R1', grupo: 'servico', alternativa: 'SERVICO_B', quandoModalidade: 'WAVE', fundamento: 'SINTÉTICA' },
      { id: 'R2', grupo: 'servico', alternativa: 'SERVICO_C', quandoModalidade: 'WAVE', fundamento: 'SINTÉTICA' },
    ],
  });
  const c = await cenarioDocumental({ armador: { masterId: MASTER, codigo: 'MSC' }, defs: { MEMORANDO_MSC: def }, modalidade: { tipo: 'UNICA', modalidade: 'WAVE', evidencia: { fonte: 'email', ref: 'wave' } } });
  const s = await situacao(c);
  assert.deepEqual(s.preenchimento?.tipo === 'INCOMPLETO' && s.preenchimento.problemasDeOpcao, [{ tipo: 'ESCOLHA_PENDENTE', grupo: 'servico', motivo: 'REGRAS_AMBIGUAS' }]);
});

/* -------------------------------------------- DOC-N -------------------------------------------- */

test('[DOC-N] DOC-31: o memorando gerado é a PREPARACAO_REGISTRADA da L1b e encerra o trabalho documental da Priora; "Enviar para apresentação" continua a ação da L1b, sem portão de assinatura', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const c = await cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: definicaoMemorando(tipo) } });
    const esc = [{ grupo: 'servico', alternativas: ['SERVICO_C'], por: ANALISTA, em: '2026-10-14T12:00:00.000Z' }];
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: esc });
    const documentoId = (r as { documentoId: string }).documentoId;
    const preparadoEm = c.repo.m.documentos[0].preparadoEm;
    // PDF gerado e disponível: nada falta à Priora (sem assinatura, conferência, poderes ou envio a cobrar).
    const s = await situacao(c);
    assert.deepEqual([s.proximoPasso, s.pendencias, s.assinatura, s.representacao, s.envio],
      [{ passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId }, [], { tipo: 'FORA_DA_PRIORA' }, { tipo: 'FORA_DA_PRIORA' }, { tipo: 'NAO_APLICAVEL' }], tipo);
    const agencia = situacaoDaAgencia(MASTER, armador(codigo));
    // Decisão 4.1: PDF preenchido = preparado. A L1b recebe "memorando gerado" no instante da preparação.
    const fatos = fatosDocumentaisParaL1b(MASTER, agencia, c.repo.m.documentos, c.repo.m.assinaturas, []);
    assert.deepEqual(fatos.eventos.map((e) => [e.tipo, e.em, e.evidencia.ref]), [['PREPARACAO_REGISTRADA', preparadoEm, `documento:${documentoId}`]], tipo);
    const acoes = decidir({ ...clienteOk(), armador: armador(codigo), procedimento: acrescentarAoProcedimento(procedimento([]), fatos) }).itens.map((i) => i.acao);
    assert.ok(acoes.includes('ENVIAR_PARA_APRESENTACAO'), `${tipo}: a L1b oferece o encaminhamento (comportamento congelado)`);
    // O Analista assina e encaminha fora da Priora: nada assinado entra, nada é conferido, nada é guardado.
    assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, assinadoSintetico(`${tipo} ASSINADO`)), { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
    assert.deepEqual(await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: 'ass-x', arquivoSha256: 'a'.repeat(64), resultado: 'CONFORME' }),
      { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
    assert.deepEqual([c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas], [[], [], []], tipo);
    // Dado novo: o PDF anterior fica desatualizado e a nova versão é outro documento; a primeira preparação continua sendo o fato da L1b.
    c.mundo.valores = [valor('MBL', 'OUTRO-BL-0002', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })];
    assert.deepEqual((await situacao(c)).proximoPasso, {
      passo: 'GERAR_NOVA_VERSAO', responsavel: 'ANALISTA', anterior: documentoId, alterados: [{ item: { tipo: 'CAMPO', campo: 'bl' }, rotulo: 'BL' }],
      mensagem: 'O PDF disponibilizado pode estar desatualizado e precisa ser regenerado.',
    }, tipo);
    const nova = (await prepararDocumento(c.deps, ATOR, MASTER)) as { documentoId: string };
    assert.notEqual(nova.documentoId, documentoId);
    assert.deepEqual((await situacao(c)).proximoPasso, { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId: nova.documentoId }, tipo);
    assert.equal(fatosDocumentaisParaL1b(MASTER, agencia, c.repo.m.documentos, c.repo.m.assinaturas, []).eventos.length, 1, 'a primeira preparação continua sendo o fato');
  }
});

test('[DOC-N] falha antes do envio (nada saiu) no pedido explícito devolve o rascunho; nada é marcado como enviado', async () => {
  const { c, envioId } = await comRascunho();
  c.outlook.falhar.enviar = new FalhaAntesDoEnvio('RECUSADO_PELO_GRAPH_429');
  assert.equal((await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook)).tipo, 'RASCUNHO_DISPONIVEL');
  assert.equal(c.repo.m.eventosDoEnvio.at(-1)?.tipo, 'ENVIO_RECUSADO_PELA_INTEGRACAO');
  assert.equal((await c.repo.tentativa(ORG, envioId))!.confirmacao, null);
});

/* ------------------------------ DOC-22 a DOC-25, DOC-28, DOC-30 (aplicação) ------------------------------ */

/** Termo SINTÉTICO com o nome e o CPF do SIGNATÁRIO LEGAL (escopo SIGNATARIO) e exigência de poderes de representação. */
const comQuemAssina = (poderes = true) => definicaoEvergreen({
  campos: [
    { id: 'bl', rotulo: 'BL', dado: 'MBL', obrigatorio: true, fontesAceitas: ['S6_MASTER'], escopo: 'MASTER' },
    { id: 'nome', rotulo: 'Quem assina', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
    { id: 'cpf', rotulo: 'CPF', dado: 'SIGNATARIO_CPF', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
  ],
  poderesDeRepresentacao: poderes ? { fundamento: 'texto SINTÉTICO: "assina como representante legal"' } : null,
});
const A = ATOR;
const B = { organizationId: ORG, membershipId: OUTRO_ANALISTA };
const C = { organizationId: ORG, membershipId: TERCEIRO_ANALISTA };
const IDENTIDADE = { signatarioId: SIGNATARIO_SINTETICO.signatarioId, nome: SIGNATARIO_SINTETICO.nome };
const camposDo = (c: Awaited<ReturnType<typeof cenarioDocumental>>, i = 0) =>
  (c.repo.m.documentos[i].plano as { conteudo: { campos: Array<{ campo: string; valor: string }> } }).conteudo.campos;

/** Nenhuma chamada de rede durante o bloco (prova de que nenhum e-mail real sai — o Outlook é o falso). */
async function semRede<T>(f: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('rede proibida nos testes'); }) as typeof fetch;
  try {
    return await f();
  } finally {
    globalThis.fetch = original;
  }
}

test('[DOC-R1] DOC-22/23 (§5 1–4, 18): A prepara, B anexa o arquivo assinado, C confere e encaminha pelo PRÓPRIO Outlook; o signatário continua sendo o legal', async () => {
  await semRede(async () => {
    const c = await cenarioDocumental({ defs: { TERMO_EVERGREEN: comQuemAssina() }, signatarios: [SIGNATARIO_COM_PODERES] });
    // 1) A prepara: os campos de quem assina trazem o signatário LEGAL do cadastro confiável — nunca os dados de A.
    const r = await prepararDocumento(c.deps, A, MASTER);
    assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
    const documentoId = (r as { documentoId: string }).documentoId;
    const doc = c.repo.m.documentos[0];
    assert.deepEqual([doc.preparadoPor, doc.signatario], [ANALISTA, IDENTIDADE]);
    assert.deepEqual(camposDo(c).filter((x) => x.campo !== 'bl').map((x) => [x.campo, x.valor]), [['nome', SIGNATARIO_SINTETICO.nome], ['cpf', SIGNATARIO_SINTETICO.cpf]]);
    // 4) Nenhum dado civil de Analista como dado de quem assina (nem no conteúdo, nem no PDF gerado, nem na proveniência).
    const tudo = JSON.stringify(doc.plano) + texto(doc.arquivo);
    for (const x of [...DADOS_DOS_ANALISTAS_SINTETICOS.nomes, ...DADOS_DOS_ANALISTAS_SINTETICOS.cpfs, 'conta-analista', 'conta-outro', 'conta-terceiro']) {
      assert.ok(!tudo.includes(x), `dado de Analista no documento: ${x}`);
    }
    const s0 = await situacao(c);
    assert.deepEqual(s0.proximoPasso, { passo: 'ASSINAR_DOCUMENTO', responsavel: 'ANALISTA', documentoId, signatarioEsperado: IDENTIDADE });
    // 2) B (outro Analista autorizado) anexa o PDF com a assinatura do signatário legal — não precisa ter preparado.
    const arquivo = assinarSobre(doc.arquivo, 'assinatura sintetica do signatario legal');
    const a = await registrarAssinatura(c.deps, B, documentoId, arquivo);
    assert.deepEqual(a.tipo === 'REGISTRADA' && [a.verificacao, a.certificado, a.signatarioEsperado, a.substituicao],
      ['INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO', 'CERTIFICADO_NAO_VERIFICADO', IDENTIDADE, null]);
    const assinaturaId = (a as { assinaturaId: string }).assinaturaId;
    // 3) C confere no leitor de PDF (o que viu, não validação de certificado) e encaminha pelo PRÓPRIO Outlook.
    const k = await conferirAssinatura(c.deps, C, documentoId, { assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
    assert.deepEqual(k.tipo === 'CONFERENCIA_REGISTRADA' && [k.resultado, k.certificado], ['CONFORME', 'CERTIFICADO_NAO_VERIFICADO']);
    const outlookDeC = outlookFalso(TERCEIRO_ANALISTA, 'conta-terceiro', () => c.relogio.agora());
    const rascunho = await prepararRascunho(c.deps, C, MASTER, { outlook: outlookDeC, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
    assert.equal(rascunho.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(rascunho));
    const envioId = (rascunho as { envioId: string }).envioId;
    assert.equal((await enviarPelaPriora(c.deps, C, envioId, outlookDeC)).tipo, 'ENVIO_CONFIRMADO');
    assert.ok(c.outlook.chamadas.length === 0, 'o Outlook de A não foi usado');
    // DOC-30: cada papel com o seu autor, sem misturar; o signatário não é nenhum dos Analistas.
    const p = papeisDoDocumento(c.repo.m.documentos[0], c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas);
    assert.deepEqual([p.preparacao.por, p.signatario, p.arquivosAssinados.map((x) => [x.operador, x.signatarioEsperado, x.vigente]),
      p.conferencias.map((x) => [x.conferente, x.resultado, x.arquivoSha256, x.signatarioEsperado]), p.encaminhamentos.map((x) => [x.encaminhador, x.contaMicrosoft, x.estado])],
    [ANALISTA, IDENTIDADE, [[OUTRO_ANALISTA, IDENTIDADE, true]], [[TERCEIRO_ANALISTA, 'CONFORME', sha256(arquivo), IDENTIDADE]],
      [[TERCEIRO_ANALISTA, 'conta-terceiro', 'ENVIO_CONFIRMADO']]]);
    assert.ok(![ANALISTA, OUTRO_ANALISTA, TERCEIRO_ANALISTA].includes(p.signatario!.signatarioId));
    // 18) Só o Outlook falso foi usado: nenhum fetch saiu (o bloco proíbe rede) e a caixa falsa tem a única mensagem.
    assert.equal([...outlookDeC.caixa.values()].filter((m) => !m.isDraft).length, 1);
  });
});

test('[DOC-R2] DOC-23 (§5 6): sem cadastro confiável do signatário legal nada é preenchido; cadastro inválido ou ambíguo também não; poderes só do cadastro, válidos', async () => {
  const pedir = async (signatarios: typeof SIGNATARIO_SINTETICO[]) => {
    const c = await cenarioDocumental({ defs: { TERMO_EVERGREEN: comQuemAssina() }, signatarios });
    const r = await prepararDocumento(c.deps, A, MASTER);
    return { c, r, s: await situacao(c) };
  };
  for (const [caso, signatarios, motivo] of [
    ['sem cadastro', [], 'SEM_CADASTRO_VALIDADO'],
    ['CPF inválido', [{ ...SIGNATARIO_SINTETICO, cpf: '12345678900' }], 'SEM_CADASTRO_VALIDADO'],
    ['sem validação humana', [{ ...SIGNATARIO_SINTETICO, cadastro: { ...SIGNATARIO_SINTETICO.cadastro, validadoPor: '' } }], 'SEM_CADASTRO_VALIDADO'],
    ['dois vigentes', [SIGNATARIO_SINTETICO, { ...SIGNATARIO_SINTETICO, signatarioId: 'sig-legal-2', nome: 'OUTRO SIGNATARIO SINTETICO', cpf: '11144477735' }],
      'MAIS_DE_UM_CADASTRO_VIGENTE'],
  ] as const) {
    const { c, r, s } = await pedir([...signatarios]);
    assert.deepEqual([r.tipo, c.repo.m.documentos.length], ['NAO_PREPARADO', 0], caso);
    assert.deepEqual(s.pendencias[0], { passo: 'DEFINIR_SIGNATARIO_LEGAL', responsavel: 'CONFIGURACAO', motivo }, caso);
    const faltantes = s.preenchimento?.tipo === 'INCOMPLETO' ? s.preenchimento.faltantes.map((f) => [f.campo, f.fontesAceitas]) : null;
    assert.deepEqual(faltantes, [['nome', ['CADASTRO_DO_SIGNATARIO_LEGAL']], ['cpf', ['CADASTRO_DO_SIGNATARIO_LEGAL']]], `${caso}: falta, com a origem esperada`);
  }
  // Poderes: sem comprovação → pendência; de outro cadastro → não vale; vencidos → não valem; válidos → comprovados.
  const poderes = async (p: typeof SIGNATARIO_SINTETICO['poderes']) => {
    const c = await cenarioDocumental({ defs: { TERMO_EVERGREEN: comQuemAssina() }, signatarios: [{ ...SIGNATARIO_SINTETICO, poderes: p }] });
    await assinado(c);
    return (await situacao(c)).representacao;
  };
  assert.deepEqual(await poderes(null), { tipo: 'NAO_COMPROVADA', signatario: SIGNATARIO_SINTETICO.signatarioId, fundamento: 'texto SINTÉTICO: "assina como representante legal"' });
  assert.equal((await poderes(PODERES_SINTETICOS('sig-de-outro'))).tipo, 'NAO_COMPROVADA');
  assert.equal((await poderes(PODERES_SINTETICOS(undefined, '2026-01-31'))).tipo, 'NAO_COMPROVADA', 'vencida antes de hoje');
  assert.equal((await poderes(PODERES_SINTETICOS())).tipo, 'COMPROVADA');
  const c = await cenarioDocumental({ defs: { TERMO_EVERGREEN: comQuemAssina() } });
  await assinado(c);
  const s = await situacao(c, { autorizacao: PERMITIDA });
  assert.deepEqual([s.proximoPasso?.passo, (s.envio as { motivos?: string[] }).motivos], ['COMPROVAR_PODERES_DE_REPRESENTACAO', ['PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS']]);
  assert.deepEqual(condicaoDaSolicitacaoDeAgendamento(s).tipo === 'SOLICITACAO_RESTRITA' && condicaoDaSolicitacaoDeAgendamento(s), {
    tipo: 'SOLICITACAO_RESTRITA', motivos: ['PODERES_DE_REPRESENTACAO_NAO_COMPROVADOS'], permissaoDaAcao: null,
    passosDocumentais: [{ passo: 'COMPROVAR_PODERES_DE_REPRESENTACAO', responsavel: 'CONFIGURACAO', signatario: SIGNATARIO_SINTETICO.signatarioId, fundamento: 'texto SINTÉTICO: "assina como representante legal"' }],
  });
});

test('[DOC-R3] DOC-22 (§5 5): pessoa de outra organização não lê, não anexa, não confere e não encaminha documentos', async () => {
  const { c, documentoId, assinaturaId } = await assinado(await cenarioDocumental({ defs: { TERMO_EVERGREEN: comQuemAssina() }, signatarios: [SIGNATARIO_COM_PODERES] }), ASSINADO, false);
  const deOutraOrg = { organizationId: 'org-2', membershipId: ANALISTA };
  const intruso = { organizationId: 'org-2', membershipId: 'm-de-outra-org' };
  assert.deepEqual(await c.repo.documento('org-2', documentoId), null);
  assert.deepEqual(await c.repo.arquivoDaAssinatura('org-2', assinaturaId), null);
  assert.deepEqual((await avaliarDocumentacao(c.deps, 'org-2', MASTER)).documentos, []);
  assert.deepEqual(await registrarAssinatura(c.deps, deOutraOrg, documentoId, assinadoSintetico('X')), { tipo: 'RECUSADA', motivo: 'DOCUMENTO_INEXISTENTE' });
  assert.deepEqual(await registrarAssinatura(c.deps, intruso, documentoId, assinadoSintetico('Y')), { tipo: 'RECUSADA', motivo: 'PESSOA_SEM_PERMISSAO' });
  assert.deepEqual(await conferirAssinatura(c.deps, deOutraOrg, documentoId, { assinaturaId, arquivoSha256: sha256(ASSINADO), resultado: 'CONFORME' }),
    { tipo: 'RECUSADA', motivo: 'DOCUMENTO_INEXISTENTE' });
  assert.deepEqual(await conferirAssinatura(c.deps, { organizationId: ORG, membershipId: CLIENTE }, documentoId, { assinaturaId, arquivoSha256: sha256(ASSINADO), resultado: 'CONFORME' }),
    { tipo: 'RECUSADA', motivo: 'PESSOA_SEM_PERMISSAO' });
  assert.equal((await prepararDocumento(c.deps, intruso, MASTER)).tipo, 'NAO_PREPARADO');
  assert.deepEqual([c.repo.m.assinaturas.length, c.repo.m.conferencias.length, c.repo.m.tentativas.length, c.repo.m.documentos.length], [1, 0, 0, 1]);
});

test('[DOC-R4] DOC-24/25 (§5 7–9, 19): conferência presa ao hash; alteração depois da assinatura exige justificativa E nova conferência, e a justificativa nunca valida', async () => {
  const c = await cenarioDocumental({ defs: { TERMO_EVERGREEN: comQuemAssina() }, signatarios: [SIGNATARIO_COM_PODERES] });
  const { documentoId } = await preparado(c);
  const preparadoBytes = c.repo.m.documentos[0].arquivo;
  const arquivo1 = assinarSobre(preparadoBytes, 'assinatura 1');
  const a1 = (await registrarAssinatura(c.deps, B, documentoId, arquivo1)) as { assinaturaId: string };
  // 7) A conferência cita o hash exato; outro hash é recusado; a registrada guarda o hash, a identidade esperada e a versão.
  assert.equal((await conferirAssinatura(c.deps, C, documentoId, { assinaturaId: a1.assinaturaId, arquivoSha256: sha256(assinadoSintetico('outro')), resultado: 'CONFORME' }) as { motivo: string }).motivo,
    'ARQUIVO_DIFERENTE_DO_REGISTRADO');
  await conferirAssinatura(c.deps, C, documentoId, { assinaturaId: a1.assinaturaId, arquivoSha256: sha256(arquivo1), resultado: 'CONFORME' });
  assert.deepEqual(c.repo.m.conferencias.map((x) => [x.documentoId, x.assinaturaId, x.arquivoSha256, x.signatarioEsperado, x.resultado, x.constatacao, x.conferidoPor]),
    [[documentoId, a1.assinaturaId, sha256(arquivo1), IDENTIDADE, 'CONFORME', null, TERCEIRO_ANALISTA]]);
  assert.equal((await situacao(c)).assinatura.tipo, 'CONFERIDA');
  // 9) O documento é alterado DEPOIS de assinado (atualização incremental sobre o arquivo assinado).
  const alterado = new Uint8Array([...arquivo1, ...new TextEncoder().encode('\n% ALTERACAO SINTETICA DEPOIS DA ASSINATURA\n')]);
  assert.deepEqual(await registrarAssinatura(c.deps, B, documentoId, alterado), { tipo: 'RECUSADA', motivo: 'SUBSTITUICAO_SEM_JUSTIFICATIVA' });
  assert.deepEqual(await registrarAssinatura(c.deps, B, documentoId, alterado, { substituicao: { motivo: 'ALTERACAO_APOS_ASSINATURA', justificativa: '   ' } }),
    { tipo: 'RECUSADA', motivo: 'SUBSTITUICAO_SEM_JUSTIFICATIVA' }, 'justificativa em branco não é justificativa');
  assert.deepEqual(await registrarAssinatura(c.deps, B, documentoId, alterado, { substituicao: { motivo: 'OUTRO', justificativa: 'corrigi um campo' } }),
    { tipo: 'RECUSADA', motivo: 'ALTERACAO_APOS_ASSINATURA_NAO_DECLARADA' }, 'os bytes mostram a alteração: tem de ser declarada');
  assert.deepEqual(await registrarAssinatura(c.deps, B, documentoId, alterado, { substituicao: { motivo: 'QUALQUER', justificativa: 'x' } }),
    { tipo: 'RECUSADA', motivo: 'MOTIVO_DE_SUBSTITUICAO_INVALIDO' });
  const justificativa = 'Agência pediu correção do e-mail de recibo depois da assinatura';
  const a2 = (await registrarAssinatura(c.deps, B, documentoId, alterado, { substituicao: { motivo: 'ALTERACAO_APOS_ASSINATURA', justificativa } })) as { assinaturaId: string; tipo: string };
  assert.equal(a2.tipo, 'REGISTRADA');
  let s = await situacao(c, { autorizacao: PERMITIDA });
  // A conferência do arquivo anterior NÃO é reaproveitada; a justificativa não valida nada.
  assert.deepEqual([s.assinatura.tipo, s.proximoPasso?.passo, (s.envio as { motivos?: string[] }).motivos], ['AGUARDANDO_CONFERENCIA', 'CONFERIR_ASSINATURA', ['CONFERENCIA_DA_ASSINATURA_PENDENTE']]);
  assert.deepEqual(s.atencoes.map((x) => [x.tipo, (x as { justificativa?: string }).justificativa]), [['ARQUIVO_ALTERADO_APOS_ASSINATURA', justificativa]]);
  assert.equal(condicaoDaSolicitacaoDeAgendamento(s).tipo, 'SOLICITACAO_RESTRITA');
  // O leitor de PDF mostra a assinatura comprometida: nunca CONFORME; NAO_CONFORME com a constatação.
  const conf2 = (p: { resultado: string; constatacao?: string; observacao?: string }) =>
    conferirAssinatura(c.deps, C, documentoId, { assinaturaId: a2.assinaturaId, arquivoSha256: sha256(alterado), ...p });
  assert.equal((await conf2({ resultado: 'CONFORME', constatacao: 'DOCUMENTO_ALTERADO_APOS_ASSINATURA' }) as { motivo: string }).motivo, 'CONFORME_COM_CONSTATACAO_DE_PROBLEMA');
  assert.equal((await conf2({ resultado: 'NAO_CONFORME', observacao: 'Adobe: assinatura inválida' }) as { motivo: string }).motivo, 'NAO_CONFORME_SEM_MOTIVO');
  assert.equal((await conf2({ resultado: 'NAO_CONFORME', constatacao: 'INVENTADA', observacao: 'x' }) as { motivo: string }).motivo, 'CONSTATACAO_INVALIDA');
  assert.equal((await conf2({ resultado: 'NAO_CONFORME', constatacao: 'DOCUMENTO_ALTERADO_APOS_ASSINATURA', observacao: 'Adobe: "documento alterado após a assinatura"' })).tipo,
    'CONFERENCIA_REGISTRADA');
  s = await situacao(c, { autorizacao: PERMITIDA });
  assert.deepEqual([s.assinatura.tipo, s.proximoPasso], ['NAO_CONFORME', {
    passo: 'SUBSTITUIR_ARQUIVO_ASSINADO', responsavel: 'ANALISTA', documentoId, assinaturaId: a2.assinaturaId, constatacao: 'DOCUMENTO_ALTERADO_APOS_ASSINATURA',
    observacao: 'Adobe: "documento alterado após a assinatura"',
  }]);
  // Nenhum caminho sobrepõe a recusa: nada de rascunho, nada de encaminhamento.
  assert.equal((await prepararRascunho(c.deps, C, MASTER, { outlook: outlookFalso(TERCEIRO_ANALISTA, 'conta-terceiro'), caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA })).tipo, 'NAO_PREPARADO');
  assert.deepEqual((condicaoDaSolicitacaoDeAgendamento(s) as { motivos: string[] }).motivos, ['ASSINATURA_NAO_CONFORME']);
  // Novo arquivo assinado de novo (sem a alteração comprometedora) → nova conferência → liberado.
  const arquivo3 = assinarSobre(preparadoBytes, 'assinatura 3 depois da correcao');
  const a3 = (await registrarAssinatura(c.deps, A, documentoId, arquivo3, { substituicao: { motivo: 'ARQUIVO_ANTERIOR_NAO_CONFORME', justificativa: 'reassinado pelo procedimento corporativo' } })) as { assinaturaId: string };
  await conferirAssinatura(c.deps, B, documentoId, { assinaturaId: a3.assinaturaId, arquivoSha256: sha256(arquivo3), resultado: 'CONFORME' });
  s = await situacao(c, { autorizacao: PERMITIDA });
  assert.deepEqual([s.assinatura.tipo, condicaoDaSolicitacaoDeAgendamento(s).tipo, s.envio.tipo], ['CONFERIDA', 'TERMO_PRONTO_PARA_A_SOLICITACAO', 'PODE_PREPARAR_RASCUNHO']);
  // 19) Os arquivos anteriores continuam guardados, iguais, em cadeia (nada sobrescrito).
  assert.deepEqual(c.repo.m.assinaturas.map((x) => [x.arquivoSha256, sha256(x.arquivo), x.substituicao?.de ?? null, x.substituicao?.motivo ?? null]), [
    [sha256(arquivo1), sha256(arquivo1), null, null],
    [sha256(alterado), sha256(alterado), a1.assinaturaId, 'ALTERACAO_APOS_ASSINATURA'],
    [sha256(arquivo3), sha256(arquivo3), a2.assinaturaId, 'ARQUIVO_ANTERIOR_NAO_CONFORME'],
  ]);
  for (const x of [a1, a2]) assert.ok(await c.repo.arquivoDaAssinatura(ORG, x.assinaturaId));
  // Substituição concorrente que não parte do último arquivo é recusada (cadeia linear, sem arquivos paralelos).
  const desatualizada = await c.repo.gravarAssinatura(ORG, {
    documentoId, arquivo: assinadoSintetico('paralelo'), arquivoSha256: sha256(assinadoSintetico('paralelo')), registradoPor: ANALISTA, registradoEm: new Date(),
    verificacao: 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO', signatarioEsperado: IDENTIDADE, substituicao: { de: a1.assinaturaId, motivo: 'OUTRO', justificativa: 'x' },
  });
  assert.deepEqual(desatualizada, { tipo: 'SUBSTITUICAO_DESATUALIZADA' });
  // 8) Nova versão do documento (dados mudaram): nenhuma assinatura nem conferência anterior vale.
  c.mundo.valores = [valor('MBL', 'OUTRO-BL-0003', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })];
  const v2 = await prepararDocumento(c.deps, B, MASTER);
  assert.notEqual((v2 as { documentoId: string }).documentoId, documentoId);
  s = await situacao(c);
  assert.deepEqual([s.assinatura.tipo, condicaoDaSolicitacaoDeAgendamento(s).tipo], ['PENDENTE_HUMANA', 'SOLICITACAO_RESTRITA']);
  assert.equal((await conferirAssinatura(c.deps, C, documentoId, { assinaturaId: a3.assinaturaId, arquivoSha256: sha256(arquivo3), resultado: 'CONFORME' }) as { motivo: string }).motivo,
    'DOCUMENTO_NAO_VIGENTE');
});

test('[DOC-R5] DOC-23/25: arquivo sem nenhuma estrutura de assinatura digital nunca é conferido como CONFORME (pode ser recusado com a constatação)', async () => {
  const { c, documentoId, assinaturaId } = await assinado(undefined, pdf('IMPRESSO, ASSINADO A MAO E DIGITALIZADO'), false);
  const base = { assinaturaId, arquivoSha256: sha256(pdf('IMPRESSO, ASSINADO A MAO E DIGITALIZADO')) };
  assert.deepEqual(await conferirAssinatura(c.deps, C, documentoId, { ...base, resultado: 'CONFORME' }), { tipo: 'RECUSADA', motivo: 'SEM_INDICIO_DE_ASSINATURA_DIGITAL' });
  assert.equal((await conferirAssinatura(c.deps, C, documentoId, { ...base, resultado: 'NAO_CONFORME', constatacao: 'SEM_ASSINATURA_DIGITAL', observacao: 'sem assinatura digital no Adobe' })).tipo,
    'CONFERENCIA_REGISTRADA');
  assert.equal((await situacao(c)).assinatura.tipo, 'NAO_CONFORME');
});

test('[DOC-R6] DOC-30 (§5 20): histórico de envios e reenvios preservado, com a evidência e o encaminhador de cada um', async () => {
  const primeiro = await enviado();
  const c = primeiro.c;
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'NOME_DO_NAVIO' ? { ...v, valor: 'NAVIO CORRIGIDO' } : v));
  await assinado(c, assinadoSintetico('TERMO V2 ASSINADO'));
  const outlookDeB = outlookFalso(OUTRO_ANALISTA, 'conta-outro', () => c.relogio.agora());
  const reenvio = { de: primeiro.envioId, motivo: 'Agência pediu correção', autorizadoPor: GESTOR };
  const r = await prepararRascunho(c.deps, B, MASTER, { outlook: outlookDeB, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA, reenvio });
  assert.equal(r.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(r));
  assert.equal((await enviarPelaPriora(c.deps, B, (r as { envioId: string }).envioId, outlookDeB)).tipo, 'ENVIO_CONFIRMADO');
  const [d1, d2] = c.repo.m.documentos;
  const p1 = papeisDoDocumento(d1, c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas);
  const p2 = papeisDoDocumento(d2, c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas);
  assert.deepEqual(p1.encaminhamentos.map((x) => [x.encaminhador, x.estado, x.reenvio]), [[ANALISTA, 'ENVIO_CONFIRMADO', null]]);
  assert.deepEqual(p2.encaminhamentos.map((x) => [x.encaminhador, x.estado, x.reenvio]), [[OUTRO_ANALISTA, 'ENVIO_CONFIRMADO', reenvio]]);
  // Evidências de cada envio continuam: anexos com hash, rascunho e confirmação lida do Graph.
  for (const t of c.repo.m.tentativas) {
    assert.ok(t.confirmacao?.internetMessageId && t.rascunho?.id && t.anexos.length === 2, t.envioId);
  }
  assert.deepEqual(c.repo.m.eventosDoEnvio.filter((e) => e.envioId === primeiro.envioId).map((e) => e.tipo), ['TENTATIVA_ABERTA', 'RASCUNHO_CRIADO', 'ENVIO_CONFIRMADO']);
});

test('[DOC-S] DOC-28 (§5 15–16): solicitação de agendamento restrita sem termo assinado e conferido; enviada, não cria fato de apresentação', async () => {
  const c = await cenarioDocumental();
  const restrita = async () => condicaoDaSolicitacaoDeAgendamento(await situacao(c), PERMITIDA);
  assert.deepEqual(await restrita(), {
    tipo: 'SOLICITACAO_RESTRITA', motivos: ['SEM_DOCUMENTO_PREPARADO'], permissaoDaAcao: 'PERMITIDA', passosDocumentais: [{ passo: 'GERAR_DOCUMENTO', responsavel: 'ANALISTA' }],
  });
  const { documentoId, assinaturaId } = await assinado(c, ASSINADO, false);
  assert.deepEqual((await restrita() as { motivos: string[] }).motivos, ['CONFERENCIA_DA_ASSINATURA_PENDENTE']);
  assert.equal((await prepararRascunho(c.deps, A, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA })).tipo, 'NAO_PREPARADO');
  const k = await conferirAssinatura(c.deps, B, documentoId, { assinaturaId, arquivoSha256: sha256(ASSINADO), resultado: 'CONFORME' });
  assert.deepEqual(await restrita(), {
    tipo: 'TERMO_PRONTO_PARA_A_SOLICITACAO', documentoId, assinaturaId, conferenciaId: (k as { conferenciaId: string }).conferenciaId, permissaoDaAcao: 'PERMITIDA',
  });
  // Não se aplica a quem não usa o termo Evergreen.
  const msc = await cenarioDocumental({ armador: { masterId: MASTER, codigo: 'MSC' }, defs: { MEMORANDO_MSC: definicaoMemorando('MEMORANDO_MSC') } });
  assert.deepEqual(condicaoDaSolicitacaoDeAgendamento(await situacao(msc)), { tipo: 'NAO_APLICAVEL' });
  // A solicitação enviada não é apresentação: nenhum evento L1b, nenhum MASTER_APRESENTADO.
  const r = await prepararRascunho(c.deps, A, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  assert.equal((await enviarPelaPriora(c.deps, A, (r as { envioId: string }).envioId, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
  const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador('EVERGREEN')), c.repo.m.documentos, c.repo.m.assinaturas, c.repo.m.tentativas, c.repo.m.conferencias);
  assert.deepEqual(fatos.eventos, []);
  const g = { ...clienteOk(), armador: armador('EVERGREEN'), pagamentoArmador: pagamento('FINALIZADO', T(2)), viagem: viagem({ atracacao: instante(T(2)) }) };
  const d = decidir({ ...g, procedimento: acrescentarAoProcedimento(procedimento([]), fatos) });
  assert.deepEqual(d, decidir({ ...g, procedimento: procedimento([]) }));
  assert.ok(!d.progresso.some((m) => m.marco === 'MASTER_APRESENTADO' || m.marco === 'BL_ENCAMINHADO_PARA_APRESENTACAO'));
  assert.equal(d.apresentacao, null);
});

test('[DOC-Q] DOC-20/24: assinatura não conferida não sai; conferência de arquivo diferente é recusada; arquivo trocado depois da conferência exige nova conferência e bloqueia o envio já preparado', async () => {
  const { c, documentoId, assinaturaId } = await assinado(undefined, ASSINADO, false);
  let s = await situacao(c, { autorizacao: PERMITIDA });
  assert.deepEqual([s.assinatura.tipo, s.proximoPasso?.passo, (s.envio as { motivos?: string[] }).motivos], ['AGUARDANDO_CONFERENCIA', 'CONFERIR_ASSINATURA', ['CONFERENCIA_DA_ASSINATURA_PENDENTE']]);
  const rascunho = await prepararRascunho(c.deps, ATOR, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  assert.equal(rascunho.tipo, 'NAO_PREPARADO');
  assert.equal(c.outlook.chamadas.length, 0, 'nada chega ao Outlook sem a conferência');
  // Recusas: arquivo que não é o registrado; registro que não é o vigente; documento que não é o vigente; resultado inválido; não conforme sem motivo.
  const conf = (p: Partial<{ assinaturaId: string; arquivoSha256: string; resultado: string; observacao: string }>, doc = documentoId, ator = ATOR) =>
    conferirAssinatura(c.deps, ator, doc, { assinaturaId, arquivoSha256: sha256(ASSINADO), resultado: 'CONFORME', ...p });
  assert.equal((await conf({ arquivoSha256: sha256(pdf('OUTRO ARQUIVO')) }) as { motivo: string }).motivo, 'ARQUIVO_DIFERENTE_DO_REGISTRADO');
  assert.equal((await conf({ assinaturaId: 'ass-inexistente' }) as { motivo: string }).motivo, 'ASSINATURA_NAO_E_A_VIGENTE');
  assert.equal((await conf({ resultado: 'TALVEZ' }) as { motivo: string }).motivo, 'RESULTADO_INVALIDO');
  assert.equal((await conf({ resultado: 'NAO_CONFORME' }) as { motivo: string }).motivo, 'NAO_CONFORME_SEM_MOTIVO');
  assert.equal((await conf({}, documentoId, { organizationId: ORG, membershipId: CLIENTE }) as { motivo: string }).motivo, 'PESSOA_SEM_PERMISSAO');
  assert.equal(c.repo.m.conferencias.length, 0);
  // Conferência de outra pessoa interna vale (registra quem e quando); repetir a mesma conclusão não duplica.
  const k = await conf({}, documentoId, { organizationId: ORG, membershipId: GESTOR });
  assert.deepEqual([k.tipo, (k as { nova: boolean }).nova], ['CONFERENCIA_REGISTRADA', true]);
  assert.equal(((await conf({}, documentoId, { organizationId: ORG, membershipId: GESTOR })) as { nova: boolean }).nova, false);
  assert.deepEqual(c.repo.m.conferencias.map((x) => [x.conferidoPor, x.arquivoSha256, x.resultado]), [[GESTOR, sha256(ASSINADO), 'CONFORME']]);
  // Rascunho preparado com o arquivo conferido…
  const r = await prepararRascunho(c.deps, ATOR, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  assert.equal(r.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(r));
  // …e o Analista entrega OUTRO arquivo assinado (substituição justificada): a conferência anterior não o cobre e o envio pela Priora é recusado.
  const outro = assinadoSintetico('TERMO ASSINADO DE NOVO');
  assert.equal((await registrarAssinatura(c.deps, ATOR, documentoId, outro, { substituicao: { motivo: 'OUTRO', justificativa: 'arquivo reexportado' } })).tipo, 'REGISTRADA');
  s = await situacao(c);
  assert.equal(s.assinatura.tipo, 'AGUARDANDO_CONFERENCIA');
  const envioId = (r as { envioId: string }).envioId;
  assert.deepEqual(await enviarPelaPriora(c.deps, ATOR, envioId, c.outlook), { tipo: 'SEM_ACAO', motivo: 'DOCUMENTO_DO_RASCUNHO_NAO_E_MAIS_VALIDO' });
  assert.ok(!c.outlook.chamadas.includes('enviarRascunho'), 'nenhum envio sem autorização documental');
  // Conferir o arquivo ANTIGO não serve mais (não é o vigente).
  assert.equal((await conf({}) as { motivo: string }).motivo, 'ASSINATURA_NAO_E_A_VIGENTE');
  // Documento que deixou de ser vigente: conferência recusada.
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'NOME_DO_NAVIO' ? { ...v, valor: 'NAVIO CORRIGIDO' } : v));
  assert.equal((await conf({}) as { motivo: string }).motivo, 'DOCUMENTO_NAO_VIGENTE');
});
