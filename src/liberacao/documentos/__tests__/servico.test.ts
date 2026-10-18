import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FONTE_DO_ARMADOR_PENDENTE, GraphDoAnalista, LIMITE_ANEXOS_NO_PEDIDO_BYTES, VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO, avaliarDocumentacao, caixaMonitoradaGraph,
  conciliarEnvio, descartarRascunho, escritaNoOutlookHabilitada, outlookDoAnalistaGraph, prepararDocumento, prepararRascunho, recusaDefinitiva,
  conferirAssinatura, registrarAssinatura, sha256,
} from '..';
import {
  ATOR, CLIENTE, FalhaAntesDoEnvio, GERADOR_DE_TESTE, MASTER, ORG, PERMITIDA, assinadoSintetico, cenarioDocumental, copiaMbl, pdf, valor,
} from './fixtures';

/** Aplicação documental e adaptadores Graph com dependências SIMULADAS (nenhum banco, Graph real ou e-mail real). */

const UM_DIA = 24 * 3600 * 1000;
const ASSINADO = assinadoSintetico('TERMO COM ASSINATURA DIGITAL SINTETICA DO SIGNATARIO LEGAL');

async function assinado(c?: Awaited<ReturnType<typeof cenarioDocumental>>) {
  const cen = c ?? await cenarioDocumental();
  const r = await prepararDocumento(cen.deps, ATOR, MASTER);
  const documentoId = (r as { documentoId: string }).documentoId;
  const a = await registrarAssinatura(cen.deps, ATOR, documentoId, ASSINADO);
  assert.equal(a.tipo, 'REGISTRADA');
  // DOC-20: conferência humana do arquivo assinado antes de qualquer encaminhamento.
  const k = await conferirAssinatura(cen.deps, ATOR, documentoId, { assinaturaId: (a as { assinaturaId: string }).assinaturaId, arquivoSha256: sha256(ASSINADO), resultado: 'CONFORME' });
  assert.equal(k.tipo, 'CONFERENCIA_REGISTRADA');
  return { c: cen, documentoId };
}

/* -------------------------------------------- preparar -------------------------------------------- */

test('[SVC-01] preparar de novo é idempotente (gerador não chamado); um dia depois a data da geração não "envelhece" o documento', async () => {
  const c = await cenarioDocumental();
  const a = await prepararDocumento(c.deps, ATOR, MASTER);
  const chamadas = GERADOR_DE_TESTE.chamadas;
  c.relogio.avancar(UM_DIA);
  const b = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.deepEqual([b.tipo, (b as { documentoId: string }).documentoId, (b as { novo: boolean }).novo], ['PREPARADO', (a as { documentoId: string }).documentoId, false]);
  assert.equal(GERADOR_DE_TESTE.chamadas, chamadas);
  assert.equal(c.repo.m.documentos.length, 1);
});

test('[SVC-02] dado faltante: nada é gerado; o próximo passo diz o que falta e de onde viria', async () => {
  const c = await cenarioDocumental({ valores: [valor('MBL', 'EGLVTESTE0001', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })] });
  const chamadas = GERADOR_DE_TESTE.chamadas;
  const r = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.equal((r as { motivo: string }).motivo, 'CONDICOES_NAO_ATENDIDAS');
  const passo = r.situacao?.proximoPasso as { passo: string; faltantes: Array<{ campo: string; fontesAceitas: ReadonlyArray<string> }> };
  assert.deepEqual([passo.passo, passo.faltantes.map((f) => [f.campo, f.fontesAceitas])], ['OBTER_DADOS_FALTANTES', [['navio', ['S3_VIAGEM']]]]);
  assert.equal(GERADOR_DE_TESTE.chamadas, chamadas);
});

test('[SVC-03] produção hoje: sem armador confiável, sem versão de modelo e sem gerador — nada é gerado e o motivo é explícito', async () => {
  const semArmador = await cenarioDocumental();
  semArmador.deps.armador = FONTE_DO_ARMADOR_PENDENTE;
  assert.equal((await prepararDocumento(semArmador.deps, ATOR, MASTER)).situacao?.proximoPasso?.passo, 'IDENTIFICAR_ARMADOR_DO_MASTER');
  const semModelo = await cenarioDocumental({ defs: {} });
  const r = await prepararDocumento(semModelo.deps, ATOR, MASTER);
  assert.deepEqual(r.situacao?.proximoPasso, { passo: 'FORNECER_MODELO_OFICIAL', responsavel: 'CONFIGURACAO', tipo: 'TERMO_EVERGREEN', exemploDeReferencia: 'EVERGREEN TERMO EGLV102600060211.pdf' });
  const naoValidado = await cenarioDocumental({ validar: false });
  assert.equal((await prepararDocumento(naoValidado.deps, ATOR, MASTER)).situacao?.proximoPasso?.passo, 'VALIDAR_VERSAO_DO_MODELO');
  assert.equal((await prepararDocumento((await cenarioDocumental({ gerador: null })).deps, ATOR, MASTER) as { motivo: string }).motivo, 'GERADOR_PENDENTE');
  const adulterado = await cenarioDocumental();
  adulterado.repo.m.versoes[0].arquivo = pdf('ARQUIVO TROCADO');
  assert.equal((await prepararDocumento(adulterado.deps, ATOR, MASTER) as { motivo: string }).motivo, 'ARQUIVO_DO_MODELO_DIVERGENTE');
  assert.equal((await prepararDocumento((await cenarioDocumental()).deps, { organizationId: ORG, membershipId: CLIENTE }, MASTER) as { motivo: string }).motivo, 'PESSOA_SEM_PERMISSAO');
});

test('[SVC-04] arquivo assinado é ato humano: nunca o próprio PDF, nunca arquivo reaproveitado, nunca por cliente; operador e arquivo preservados', async () => {
  const c = await cenarioDocumental();
  const documentoId = ((await prepararDocumento(c.deps, ATOR, MASTER)) as { documentoId: string }).documentoId;
  const preparado = c.repo.m.documentos[0].arquivo;
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, preparado), { tipo: 'RECUSADA', motivo: 'IGUAL_AO_PREPARADO' });
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, new TextEncoder().encode('não é pdf')), { tipo: 'RECUSADA', motivo: 'ARQUIVO_NAO_E_PDF' });
  assert.deepEqual(await registrarAssinatura(c.deps, { organizationId: ORG, membershipId: CLIENTE }, documentoId, ASSINADO), { tipo: 'RECUSADA', motivo: 'PESSOA_SEM_PERMISSAO' });
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, 'doc-x', ASSINADO), { tipo: 'RECUSADA', motivo: 'DOCUMENTO_INEXISTENTE' });
  assert.equal((await registrarAssinatura(c.deps, ATOR, documentoId, ASSINADO)).tipo, 'REGISTRADA');
  assert.deepEqual([c.repo.m.assinaturas[0].registradoPor, c.repo.m.assinaturas[0].arquivoSha256], [ATOR.membershipId, sha256(ASSINADO)]);
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, ASSINADO), { tipo: 'RECUSADA', motivo: 'SUBSTITUICAO_SEM_JUSTIFICATIVA' });
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, ASSINADO, { substituicao: { motivo: 'OUTRO', justificativa: 'de novo' } }),
    { tipo: 'RECUSADA', motivo: 'ARQUIVO_JA_REGISTRADO' });
});

/* ------------------------------------------- rascunho ------------------------------------------- */

test('[SVC-05] sem permissão determinada (padrão de hoje), escrita desligada, anexo de outra caixa ou autorizador sem papel: nenhum rascunho', async () => {
  const { c } = await assinado();
  const acesso = { outlook: c.outlook, caixaMonitorada: c.caixa };
  const padrao = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
  assert.deepEqual(padrao.envio.tipo === 'BLOQUEADO' && padrao.envio.motivos, ['PERMISSAO_DA_ACAO_NAO_DETERMINADA']);
  assert.equal(padrao.proximoPasso?.passo, 'AGUARDAR_PERMISSAO_DA_ACAO');
  c.outlook.ligado = false;
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }) as { motivo: string }).motivo, 'ESCRITA_NO_OUTLOOK_DESLIGADA');
  c.outlook.ligado = true;
  c.mundo.copias = [copiaMbl({ caixaId: 'caixa-2' })];
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }) as { motivo: string }).motivo, 'ANEXO_DE_OUTRA_CAIXA');
  const reenvioDeCliente = { de: 'x', motivo: 'm', autorizadoPor: CLIENTE };
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA, reenvio: reenvioDeCliente }) as { motivo: string }).motivo, 'AUTORIZADOR_SEM_PERMISSAO');
  assert.deepEqual(c.outlook.chamadas, []);
  assert.equal(c.repo.m.tentativas.length, 0);
});

test('[SVC-06] falha ao montar o rascunho (MBL não é PDF, Graph fora): tentativa encerrada como NÃO REALIZADA e nova tentativa permitida', async () => {
  const { c } = await assinado();
  const acesso = { outlook: c.outlook, caixaMonitorada: c.caixa };
  c.caixa.anexos['msg-1|anexo-1'] = { nome: 'MBL.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('não é pdf') };
  assert.deepEqual(await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA }), { tipo: 'ENVIO_NAO_REALIZADO', envioId: c.repo.m.tentativas[0].envioId, falha: 'COPIA_DO_MBL_NAO_E_PDF' });
  c.caixa.anexos['msg-1|anexo-1'] = { nome: 'MBL.pdf', contentType: 'application/pdf', bytes: pdf('MBL') };
  c.outlook.falhar.criar = new Error('Graph 503');
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA })).tipo, 'ENVIO_NAO_REALIZADO');
  c.outlook.falhar = {};
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA })).tipo, 'RASCUNHO_DISPONIVEL');
  assert.deepEqual(c.repo.m.tentativas.map((t) => t.estado), ['ENVIO_NAO_REALIZADO', 'ENVIO_NAO_REALIZADO', 'RASCUNHO_DISPONIVEL']);
});

test('[SVC-07] descartar rascunho: exige justificativa; só descarta o que continua rascunho; enviado vira confirmado (nada é apagado)', async () => {
  const { c } = await assinado();
  const acesso = { outlook: c.outlook, caixaMonitorada: c.caixa };
  const r1 = await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA });
  const e1 = (r1 as { envioId: string }).envioId;
  assert.equal((await descartarRascunho(c.deps, ATOR, e1, c.outlook, ' ') as { motivo: string }).motivo, 'SEM_JUSTIFICATIVA');
  assert.equal((await descartarRascunho(c.deps, ATOR, e1, c.outlook, 'Destinatário errado no rascunho')).tipo, 'ENVIO_NAO_REALIZADO');
  assert.equal(c.outlook.caixa.size, 0);
  const r2 = await prepararRascunho(c.deps, ATOR, MASTER, acesso, { autorizacao: PERMITIDA });
  const e2 = (r2 as { envioId: string }).envioId;
  c.outlook.enviarPeloOutlook((await c.repo.tentativa(ORG, e2))!.rascunho!.id);
  assert.equal((await descartarRascunho(c.deps, ATOR, e2, c.outlook, 'tarde demais')).tipo, 'ENVIO_CONFIRMADO');
  assert.equal(c.outlook.chamadas.filter((x) => x === 'descartarRascunho').length, 1);
});

test('[SVC-08] conciliação indisponível (Graph fora) não muda o estado', async () => {
  const { c } = await assinado();
  const r = await prepararRascunho(c.deps, ATOR, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  c.outlook.falhar.ler = new Error('Graph 503');
  assert.deepEqual(await conciliarEnvio(c.deps, ATOR, (r as { envioId: string }).envioId, c.outlook), { tipo: 'SEM_ACAO', motivo: 'CONCILIACAO_INDISPONIVEL' });
  assert.equal(c.repo.m.tentativas[0].estado, 'RASCUNHO_DISPONIVEL');
});

/* -------------------------------------- adaptadores Graph -------------------------------------- */

function graphFalso(estado: Partial<{ isDraft: boolean; sentDateTime: string | null; existe: boolean }> = {}) {
  const chamadas: Array<[string, unknown]> = [];
  const e = { isDraft: true, sentDateTime: null as string | null, existe: true, ...estado };
  const g: GraphDoAnalista = {
    createDraftMessage: async (_t, input) => { chamadas.push(['createDraftMessage', input]); return { id: 'imm-1', internetMessageId: '<imm-1@x>', conversationId: 'conv', changeKey: 'ck', webLink: null }; },
    getMessageSendState: async (_t, id) => {
      chamadas.push(['getMessageSendState', id]);
      return e.existe ? { id, isDraft: e.isDraft, sentDateTime: e.sentDateTime, internetMessageId: '<imm-1@x>', conversationId: 'conv', changeKey: 'ck2', subject: 's', toRecipients: ['a@b'], ccRecipients: [] } : null;
    },
    findMessagesByInternetMessageId: async (_t, imid) => {
      chamadas.push(['findMessagesByInternetMessageId', imid]);
      return e.existe ? [{ id: 'imm-1', isDraft: e.isDraft, sentDateTime: e.sentDateTime, internetMessageId: imid, conversationId: 'conv', changeKey: 'ck2', subject: 's', toRecipients: ['a@b'], ccRecipients: [] }] : [];
    },
    getMessageFileAttachments: async (_t, id) => { chamadas.push(['getMessageFileAttachments', id]); return [{ name: 'T.pdf', contentType: 'application/pdf', contentBytes: Buffer.from('%PDF-x').toString('base64') }]; },
    sendDraftMessage: async (_t, id) => { chamadas.push(['sendDraftMessage', id]); },
    deleteDraftMessage: async (_t, id) => { chamadas.push(['deleteDraftMessage', id]); },
  };
  return { g, chamadas };
}

test('[SVC-09] Outlook do Analista: escrita DESLIGADA por padrão; desligada, nada é criado, enviado ou apagado no Graph; leitura continua possível', async () => {
  assert.equal(process.env[VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO], undefined, 'o ambiente de teste nunca liga a escrita real');
  assert.equal(escritaNoOutlookHabilitada({}), false);
  assert.equal(escritaNoOutlookHabilitada({ [VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO]: 'true' }), false);
  assert.equal(escritaNoOutlookHabilitada({ [VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO]: 'on' }), true);
  const { g, chamadas } = graphFalso();
  const o = outlookDoAnalistaGraph({ membershipId: 'm', contaMicrosoft: 'conta', accessToken: 't', env: {}, graph: g });
  await assert.rejects(o.criarRascunho({ assunto: 'a', corpo: 'b', para: ['x@y'], cc: [], anexos: [] }), FalhaAntesDoEnvio);
  await assert.rejects(o.enviarRascunho('imm-1'), FalhaAntesDoEnvio);
  await assert.rejects(o.descartarRascunho('imm-1'), FalhaAntesDoEnvio);
  assert.deepEqual(chamadas, []);
  assert.deepEqual(await o.lerMensagem('imm-1'), { tipo: 'RASCUNHO', changeKey: 'ck2' });
});

test('[SVC-10] Outlook do Analista ligado (Graph SIMULADO): rascunho em base64; leitura só confirma com data de envio; erros classificados', async () => {
  const env = { [VARIAVEL_ESCRITA_OUTLOOK_LIBERACAO]: 'on' };
  const { g, chamadas } = graphFalso({ isDraft: false, sentDateTime: '2026-10-14T16:00:00Z' });
  const o = outlookDoAnalistaGraph({ membershipId: 'm', contaMicrosoft: 'conta', accessToken: 't', env, graph: g });
  const r = await o.criarRascunho({ assunto: 'a', corpo: 'b', para: ['x@y'], cc: [], anexos: [{ nome: 'T.pdf', contentType: 'application/pdf', bytes: pdf('T') }] });
  assert.deepEqual(r, { id: 'imm-1', internetMessageId: '<imm-1@x>', conversationId: 'conv', changeKey: 'ck' });
  assert.equal(Buffer.from((chamadas[0][1] as { attachments: Array<{ contentBytes: string }> }).attachments[0].contentBytes, 'base64').toString(), Buffer.from(pdf('T')).toString());
  const lida = await o.lerMensagem('imm-1');
  assert.deepEqual(lida.tipo === 'ENVIADA' && [lida.enviadaEm, lida.anexos], ['2026-10-14T16:00:00.000Z', [{ nome: 'T.pdf', sha256: sha256('%PDF-x'), tamanho: 6 }]]);
  // Não é rascunho mas sem data de envio: não é evidência suficiente.
  await assert.rejects(outlookDoAnalistaGraph({ membershipId: 'm', contaMicrosoft: 'c', accessToken: 't', env, graph: graphFalso({ isDraft: false, sentDateTime: null }).g }).lerMensagem('x'));
  assert.deepEqual(await outlookDoAnalistaGraph({ membershipId: 'm', contaMicrosoft: 'c', accessToken: 't', env, graph: graphFalso({ existe: false }).g }).lerMensagem('x'), { tipo: 'NAO_ENCONTRADA' });
  // Recusa definitiva (nada saiu) × falha incerta.
  const erro = (statusCode: number) => Object.assign(new Error(`Graph ${statusCode}`), { statusCode });
  assert.ok(recusaDefinitiva(erro(429)) && recusaDefinitiva(erro(400)) && !recusaDefinitiva(erro(503)) && !recusaDefinitiva(new Error('timeout')));
  const falha = (statusCode: number) => outlookDoAnalistaGraph({ membershipId: 'm', contaMicrosoft: 'c', accessToken: 't', env, graph: { ...g, sendDraftMessage: async () => { throw erro(statusCode); } } });
  await assert.rejects(falha(429).enviarRascunho('x'), (e: unknown) => e instanceof FalhaAntesDoEnvio && e.motivo === 'RECUSADO_PELO_GRAPH_429');
  await assert.rejects(falha(503).enviarRascunho('x'), (e: unknown) => !(e instanceof FalhaAntesDoEnvio));
  const grande = new Uint8Array(LIMITE_ANEXOS_NO_PEDIDO_BYTES + 1);
  await assert.rejects(o.criarRascunho({ assunto: 'a', corpo: 'b', para: ['x@y'], cc: [], anexos: [{ nome: 'g.pdf', contentType: 'application/pdf', bytes: grande }] }),
    (e: unknown) => e instanceof FalhaAntesDoEnvio && e.motivo === 'ANEXOS_ACIMA_DO_LIMITE_DO_PEDIDO');
});

test('[SVC-11] caixa monitorada: só leitura do anexo vinculado (nenhuma outra operação existe)', async () => {
  const chamadas: string[] = [];
  const caixa = caixaMonitoradaGraph({
    caixaId: 'caixa-1', accessToken: 't',
    graph: { getAttachmentContent: async (_t, m, a) => { chamadas.push(`${m}/${a}`); return { name: 'MBL.pdf', contentType: 'application/pdf', contentBytes: Buffer.from('%PDF-mbl').toString('base64') }; } },
  });
  const a = await caixa.lerAnexo({ messageId: 'msg-1', attachmentId: 'anexo-1' });
  assert.deepEqual([a?.nome, Buffer.from(a!.bytes).toString(), chamadas], ['MBL.pdf', '%PDF-mbl', ['msg-1/anexo-1']]);
  assert.deepEqual(Object.keys(caixa).sort(), ['caixaId', 'lerAnexo']);
});
