import { test } from 'node:test';
import assert from 'node:assert/strict';
import { situacaoDaAgencia } from '../../dominio';
import { armador, clienteOk, decidir, procedimento } from '../../dominio/__tests__/l1b/fixtures';
import {
  ARQUIVOS_OFICIAIS_RECEBIDOS, DEFINICOES_EM_VIGOR, DEFINICOES_PROPOSTAS, DefinicaoDoModelo, FonteDeDado, TipoDocumento, ValorObservado, acrescentarAoProcedimento,
  avaliarDocumentacao, cadastrarModeloOficial, conciliarEnvio, condicaoDaSolicitacaoDeAgendamento, conferirAssinatura, fatosDocumentaisParaL1b, geradorPdfPriora,
  prepararDocumento, prepararRascunho, registrarAssinatura, sha256, validarModelo, SignatarioLegal,
} from '..';
import { ANALISTA, ATOR, GESTOR, MASTER, ORG, PERMITIDA, PODERES_SINTETICOS, SIGNATARIO_SINTETICO, assinarSobre, cenarioDocumental, valor } from './fixtures';
import { ESCOLHAS_SINTETICAS, MODELOS_OFICIAIS, SEM_MODELOS, SEM_POPPLER, VALORES_SINTETICOS, semEspacos, textoDoPdf } from './modelosReais';

/**
 * Fluxo do serviço com o GERADOR REAL sobre os arquivos oficiais e dados
 * SINTÉTICOS. Repositório, fontes e Outlook continuam em memória (simulados):
 * provam as regras com documentos reais, não a integração com banco, S2/S3,
 * HeadCargo ou Graph.
 */

const CODIGO: Record<TipoDocumento, string> = {
  TERMO_EVERGREEN: 'EVERGREEN', MEMORANDO_MSC: 'MSC', MEMORANDO_HAPAG_ROCHAMAR: 'HAPAG_LLOYD', MEMORANDO_ZIM_ROCHAMAR: 'ZIM',
};

/**
 * Valores sintéticos para um tipo, cada dado vindo da PRIMEIRA fonte aceita pela definição (menos ANALISTA, GERACAO e o
 * cadastro do signatário legal — esse vem do cadastro SINTÉTICO `SIGNATARIO_LEGAL_SINTETICO`). Campo que exige
 * confirmação documental (14.20) recebe a confirmação sintética, como o adaptador a entrega com a identidade VERIFICADA.
 */
function valoresDasFontes(tipo: TipoDocumento, exceto: string[] = [], defs: Readonly<Record<TipoDocumento, DefinicaoDoModelo>> = DEFINICOES_PROPOSTAS): ValorObservado[] {
  const out: ValorObservado[] = [];
  for (const c of defs[tipo].campos) {
    const fonte = c.fontesAceitas.find((f) => f !== 'ANALISTA' && f !== 'GERACAO' && f !== 'CADASTRO_DO_SIGNATARIO_LEGAL') as FonteDeDado | undefined;
    if (!fonte || exceto.includes(c.dado) || out.some((v) => v.dado === c.dado)) continue;
    const v = valor(c.dado, VALORES_SINTETICOS[c.dado], fonte, c.escopo === 'MASTER' ? { tipo: 'MASTER', masterId: MASTER } : { tipo: 'DOCUMENTO' });
    out.push(c.confirmacao ? { ...v, confirmacao: { tipo: c.confirmacao.tipo, evidencias: [{ fonte: 'auditoria', ref: 'auditoria_extracao:sintetica' }] } } : v);
  }
  return out;
}

const informadosSinteticos = (tipo: TipoDocumento) => DEFINICOES_PROPOSTAS[tipo].campos
  .filter((c) => c.fontesAceitas.includes('ANALISTA')).map((c) => ({ dado: c.dado, valor: VALORES_SINTETICOS[c.dado] }));

const escolhas = (tipo: TipoDocumento) => ESCOLHAS_SINTETICAS[tipo].map((e) => ({ ...e, por: ANALISTA, em: '2026-10-15T10:00:00.000Z' }));

/** Cadastro SINTÉTICO do signatário legal da organização (DOC-23) com os nomes/CPF sintéticos dos modelos reais. */
const SIGNATARIO_LEGAL_SINTETICO: SignatarioLegal = { ...SIGNATARIO_SINTETICO, nome: VALORES_SINTETICOS.SIGNATARIO_NOME, cpf: VALORES_SINTETICOS.SIGNATARIO_CPF };

async function cenarioReal(tipo: TipoDocumento, p: { valores?: ValorObservado[]; validar?: boolean; semSignatario?: boolean; poderes?: boolean } = {}) {
  return cenarioDocumental({
    armador: { masterId: MASTER, codigo: CODIGO[tipo] }, defs: { [tipo]: DEFINICOES_PROPOSTAS[tipo] }, arquivos: { [tipo]: MODELOS_OFICIAIS[tipo] },
    gerador: geradorPdfPriora, valores: p.valores ?? valoresDasFontes(tipo), validar: p.validar,
    signatarios: p.semSignatario ? [] : [{ ...SIGNATARIO_LEGAL_SINTETICO, poderes: p.poderes ? PODERES_SINTETICOS() : null }],
  });
}

/** Arquivo com a assinatura (sintética) do signatário legal anexado pelo Analista + conferência humana CONFORME (DOC-24). */
async function assinarEConferir(c: Awaited<ReturnType<typeof cenarioReal>>, documentoId: string, arquivo: Uint8Array) {
  const a = await registrarAssinatura(c.deps, ATOR, documentoId, arquivo);
  assert.equal(a.tipo, 'REGISTRADA', JSON.stringify(a));
  const k = await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: (a as { assinaturaId: string }).assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
  assert.equal(k.tipo, 'CONFERENCIA_REGISTRADA', JSON.stringify(k));
  return (a as { assinaturaId: string }).assinaturaId;
}

test('[GR-01] modelo oficial: só os bytes recebidos são cadastrados; a versão fica PENDENTE e nada é gerado até uma pessoa validar', { skip: SEM_MODELOS }, async () => {
  // 14.20: o cadastro do arquivo oficial recebe a revisão EM VIGOR das definições (consignatário pelo cadastro, confirmado pela Auditoria).
  const c = await cenarioDocumental({ armador: { masterId: MASTER, codigo: 'MSC' }, defs: {}, gerador: geradorPdfPriora, valores: valoresDasFontes('MEMORANDO_MSC', [], DEFINICOES_EM_VIGOR) });
  assert.deepEqual(await cadastrarModeloOficial(c.deps, ATOR, 'MEMORANDO_MSC', MODELOS_OFICIAIS.MEMORANDO_ZIM_ROCHAMAR!), { tipo: 'RECUSADO', motivo: 'ARQUIVO_DIFERENTE_DO_OFICIAL_RECEBIDO' });
  const r = await cadastrarModeloOficial(c.deps, ATOR, 'MEMORANDO_MSC', MODELOS_OFICIAIS.MEMORANDO_MSC!);
  assert.equal(r.tipo, 'OK');
  const modeloId = (r as { modeloId: string }).modeloId;
  assert.equal(c.repo.m.versoes[0].arquivoSha256, ARQUIVOS_OFICIAIS_RECEBIDOS.MEMORANDO_MSC.sha256);
  assert.equal(c.repo.m.versoes[0].estado, 'PENDENTE_DE_VALIDACAO');
  assert.deepEqual((await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas('MEMORANDO_MSC') })).tipo, 'NAO_PREPARADO');
  assert.equal((await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao.proximoPasso?.passo, 'VALIDAR_VERSAO_DO_MODELO');
  // O mesmo arquivo de novo não vira outra versão.
  assert.deepEqual(await cadastrarModeloOficial(c.deps, ATOR, 'MEMORANDO_MSC', MODELOS_OFICIAIS.MEMORANDO_MSC!), { tipo: 'OK', modeloId, novo: false });
  assert.equal((await validarModelo(c.deps, { organizationId: ORG, membershipId: GESTOR }, modeloId)).tipo, 'OK');
  const g = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas('MEMORANDO_MSC') });
  assert.equal(g.tipo, 'PREPARADO', JSON.stringify(g));
});

test('[GR-02] dados obrigatórios sem fonte confiável integrada: nada é gerado e a situação diz o que falta e de onde viria', { skip: SEM_MODELOS }, async () => {
  for (const tipo of ['TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as TipoDocumento[]) {
    // Como na produção de hoje: só o MBL (S6) tem fonte integrada; não há cadastro do signatário legal nem da organização.
    const c = await cenarioReal(tipo, { valores: [valor('MBL', VALORES_SINTETICOS.MBL, 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })], semSignatario: true });
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo) });
    assert.deepEqual([r.tipo, (r as { motivo: string }).motivo], ['NAO_PREPARADO', 'CONDICOES_NAO_ATENDIDAS'], tipo);
    assert.equal(c.repo.m.documentos.length, 0, tipo);
    const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
    const faltantes = s.pendencias.find((p) => p.passo === 'OBTER_DADOS_FALTANTES') as { faltantes: Array<{ dado: string; fontesAceitas: string[] }> } | undefined;
    assert.ok(faltantes, tipo);
    const dados = faltantes!.faltantes.map((f) => f.dado);
    assert.ok(dados.includes('ORGANIZACAO_RAZAO_SOCIAL') || tipo === 'MEMORANDO_MSC', `${tipo}: cadastro da organização`);
    // DOC-23: o nome de quem assina vem do cadastro do SIGNATÁRIO LEGAL (sem ele, falta — nunca os dados do Analista).
    assert.deepEqual(faltantes!.faltantes.find((f) => f.dado === 'SIGNATARIO_NOME')?.fontesAceitas, ['CADASTRO_DO_SIGNATARIO_LEGAL'], tipo);
    assert.deepEqual(s.pendencias.find((p) => p.passo === 'DEFINIR_SIGNATARIO_LEGAL'), { passo: 'DEFINIR_SIGNATARIO_LEGAL', responsavel: 'CONFIGURACAO', motivo: 'SEM_CADASTRO_VALIDADO' }, tipo);
    assert.ok(!dados.includes('MBL') && !dados.includes('DATA_DA_GERACAO'), tipo);
    for (const f of faltantes!.faltantes) assert.ok(f.fontesAceitas.length > 0, `${tipo}/${f.dado}: de onde viria`);
  }
});

test('[GR-03] memorando real preparado (PDF preenchido = preparado): L1b recebe "memorando gerado" e oferece "Enviar para apresentação"; o documento fica disponível, sem assinatura na Priora (DOC-31)', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of ['MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as TipoDocumento[]) {
    const c = await cenarioReal(tipo);
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo), informados: informadosSinteticos(tipo) });
    assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
    const doc = c.repo.m.documentos[0];
    const texto = semEspacos(textoDoPdf(doc.arquivo));
    assert.ok(texto.includes(semEspacos(VALORES_SINTETICOS.MBL)), tipo);
    // Valores do Analista: no documento, com autor e instante; o autor é sempre quem preparou.
    for (const i of doc.informados) assert.equal(i.por, ANALISTA, tipo);
    assert.equal(doc.informados.length, informadosSinteticos(tipo).length, tipo);
    const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
    assert.deepEqual([s.proximoPasso?.passo, s.pendencias, s.assinatura.tipo], ['DOCUMENTO_DISPONIVEL', [], 'FORA_DA_PRIORA'], tipo);
    const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador(CODIGO[tipo], MASTER)), c.repo.m.documentos, c.repo.m.assinaturas, []);
    assert.deepEqual(fatos.eventos.map((e) => [e.tipo, e.em]), [['PREPARACAO_REGISTRADA', doc.preparadoEm]], tipo);
    const acoes = decidir({ ...clienteOk(), armador: armador(CODIGO[tipo], MASTER), procedimento: acrescentarAoProcedimento(procedimento([]), fatos) }).itens.map((i) => i.acao);
    assert.ok(acoes.includes('ENVIAR_PARA_APRESENTACAO'), tipo);
  }
});

test('[GR-04] valor informado pelo Analista só vale onde a definição aceita ANALISTA e no formato do lugar; nunca substitui dado de sistema', { skip: SEM_MODELOS }, async () => {
  const c = await cenarioReal('MEMORANDO_HAPAG_ROCHAMAR');
  const ruim = await prepararDocumento(c.deps, ATOR, MASTER, {
    escolhas: escolhas('MEMORANDO_HAPAG_ROCHAMAR'), informados: [{ dado: 'AGENDAMENTO_DATA', valor: '2026-02-30' }, { dado: 'AGENDAMENTO_HORA', valor: '25:00' }],
  });
  assert.equal(ruim.tipo, 'NAO_PREPARADO');
  const s = (await avaliarDocumentacao(c.deps, ORG, MASTER, { informados: [{ dado: 'AGENDAMENTO_DATA', valor: '2026-02-30', por: ANALISTA, em: '2026-10-15T10:00:00.000Z' }] })).situacao;
  const faltam = (s.preenchimento as { faltantes: Array<{ dado: string }>; recusados: Array<{ motivo: string }> });
  assert.ok(faltam.faltantes.some((f) => f.dado === 'AGENDAMENTO_DATA'));
  assert.ok(faltam.recusados.some((r) => r.motivo === 'FORA_DO_FORMATO'));
  // Tentar "informar" o BL (do S6) ou o nome de quem assina (do cadastro do signatário legal): recusado; o documento usa o valor do dono.
  const ok = await prepararDocumento(c.deps, ATOR, MASTER, {
    escolhas: escolhas('MEMORANDO_HAPAG_ROCHAMAR'),
    informados: [...informadosSinteticos('MEMORANDO_HAPAG_ROCHAMAR'), { dado: 'MBL', valor: 'BL-DIGITADO-0001' }, { dado: 'SIGNATARIO_NOME', valor: 'NOME DIGITADO' }],
  });
  assert.equal(ok.tipo, 'PREPARADO', JSON.stringify(ok));
  const doc = c.repo.m.documentos.at(-1)!;
  assert.ok(!doc.informados.some((i) => i.dado === 'MBL' || i.dado === 'SIGNATARIO_NOME'));
  const campos = (doc.plano as { conteudo: { campos: Array<{ campo: string; valor: string }> } }).conteudo.campos;
  assert.equal(campos.find((x) => x.campo === 'BL')?.valor, VALORES_SINTETICOS.MBL);
  assert.equal(campos.find((x) => x.campo === 'REPRESENTANTE')?.valor, VALORES_SINTETICOS.SIGNATARIO_NOME);
});

test('[GR-05] assinatura humana sobre o termo Evergreen REAL (ciclo completo): digital sobre o preparado é verificada; outro arquivo fica sem vínculo verificável; nunca o próprio preparado; memorando real não recebe assinado (DOC-31)', { skip: SEM_MODELOS }, async () => {
  const c = await cenarioReal('TERMO_EVERGREEN', { poderes: true });
  const r = await prepararDocumento(c.deps, ATOR, MASTER);
  const documentoId = (r as { documentoId: string }).documentoId;
  const preparado = c.repo.m.documentos[0].arquivo;
  assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, preparado), { tipo: 'RECUSADA', motivo: 'IGUAL_AO_PREPARADO' });
  // Assinatura por atualização incremental (o que um assinador PDF faz): o arquivo começa com os bytes do preparado.
  const incremento = new TextEncoder().encode('\n99 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 1 2 3] /Contents <00> >>\nendobj\n%%EOF\n');
  const assinado = new Uint8Array([...preparado, ...incremento]);
  const a = await registrarAssinatura(c.deps, ATOR, documentoId, assinado);
  assert.deepEqual(a, {
    tipo: 'REGISTRADA', assinaturaId: (a as { assinaturaId: string }).assinaturaId, verificacao: 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO',
    certificado: 'CERTIFICADO_NAO_VERIFICADO', signatarioEsperado: { signatarioId: SIGNATARIO_LEGAL_SINTETICO.signatarioId, nome: SIGNATARIO_LEGAL_SINTETICO.nome },
    substituicao: null, proximoPasso: 'CONFERIR_ASSINATURA',
  });
  // DOC-20: o indício estrutural não é validade — o próximo passo é a conferência humana do arquivo.
  assert.equal((await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao.proximoPasso?.passo, 'CONFERIR_ASSINATURA');
  await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: (a as { assinaturaId: string }).assinaturaId, arquivoSha256: sha256(assinado), resultado: 'CONFORME' });
  assert.equal((await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao.assinatura.tipo, 'CONFERIDA');
  // Outro Master: arquivo assinado que não deriva deste documento.
  const c2 = await cenarioReal('TERMO_EVERGREEN', { poderes: true });
  const r2 = await prepararDocumento(c2.deps, ATOR, MASTER);
  const outro = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n% documento de outro Master\n'), ...incremento]);
  const a2 = await registrarAssinatura(c2.deps, ATOR, (r2 as { documentoId: string }).documentoId, outro);
  assert.equal((a2 as { verificacao: string }).verificacao, 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO');
  // DOC-31: o memorando MSC real é assinado e encaminhado fora da Priora — nada assinado entra.
  const msc = await cenarioReal('MEMORANDO_MSC');
  const rm = (await prepararDocumento(msc.deps, ATOR, MASTER, { escolhas: escolhas('MEMORANDO_MSC') })) as { documentoId: string };
  assert.deepEqual(await registrarAssinatura(msc.deps, ATOR, rm.documentoId, new Uint8Array([...msc.repo.m.documentos[0].arquivo, ...incremento])),
    { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' });
  assert.equal(msc.repo.m.assinaturas.length, 0);
});

test('[GR-06] valor que não cabe no lugar do modelo: geração recusada com o campo; nada é gravado', { skip: SEM_MODELOS }, async () => {
  const valores = valoresDasFontes('MEMORANDO_MSC', ['CONSIGNATARIO_RAZAO_SOCIAL']);
  valores.push(valor('CONSIGNATARIO_RAZAO_SOCIAL', 'EMPRESA SINTETICA '.repeat(8).trim(), 'S2_AUDITORIA', { tipo: 'MASTER', masterId: MASTER }));
  const c = await cenarioReal('MEMORANDO_MSC', { valores });
  const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas('MEMORANDO_MSC') });
  assert.deepEqual([r.tipo, (r as { motivo: string }).motivo, (r as { detalhe?: unknown }).detalhe], ['NAO_PREPARADO', 'GERACAO_RECUSADA', { motivo: 'VALOR_NAO_CABE_NO_LUGAR', item: 'CONSIGNATARIO' }]);
  assert.equal(c.repo.m.documentos.length, 0);
});

test('[GR-07] dado alterado depois da preparação: o documento fica desatualizado e a nova versão é outro documento, disponível; a anterior é preservada (DOC-31: sem assinatura na Priora)', { skip: SEM_MODELOS }, async () => {
  const c = await cenarioReal('MEMORANDO_ZIM_ROCHAMAR');
  const op = { escolhas: escolhas('MEMORANDO_ZIM_ROCHAMAR'), informados: informadosSinteticos('MEMORANDO_ZIM_ROCHAMAR') };
  const r = await prepararDocumento(c.deps, ATOR, MASTER, op);
  assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
  // O memorando ZIM não tem navio: muda o exportador/importador (consignatário do MBL).
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'CONSIGNATARIO_RAZAO_SOCIAL' ? { ...v, valor: 'OUTRA EMPRESA SINTETICA LTDA' } : v));
  assert.equal((await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao.preparo.tipo, 'DESATUALIZADO');
  const novo = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.equal(novo.tipo, 'PREPARADO');
  assert.equal(c.repo.m.documentos.length, 2, 'versão anterior preservada');
  assert.notEqual(c.repo.m.documentos[0].arquivoSha256, c.repo.m.documentos[1].arquivoSha256);
  // Os valores informados e as escolhas continuam valendo (até nova informação/decisão).
  assert.deepEqual(c.repo.m.documentos[1].informados.map((i) => [i.dado, i.valor]), c.repo.m.documentos[0].informados.map((i) => [i.dado, i.valor]));
  assert.deepEqual((await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao.proximoPasso,
    { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId: (novo as { documentoId: string }).documentoId });
});

test('[GR-08] Grieg com o termo REAL: preparado → assinado → conferido → rascunho no Outlook do Analista com o termo assinado e a cópia do MBL → envio confirmado pelo Graph', { skip: SEM_MODELOS }, async () => {
  const c = await cenarioReal('TERMO_EVERGREEN', { poderes: true });
  const r = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
  const termo = c.repo.m.documentos[0].arquivo;
  const assinado = new Uint8Array([...termo, ...new TextEncoder().encode('\n9 0 obj << /Type /Sig /ByteRange [0 1 2 3] >> endobj\n%%EOF')]);
  await assinarEConferir(c, (r as { documentoId: string }).documentoId, assinado);
  const rascunho = await prepararRascunho(c.deps, ATOR, MASTER, { outlook: c.outlook, caixaMonitorada: c.caixa }, { autorizacao: PERMITIDA });
  assert.equal(rascunho.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(rascunho));
  const msg = [...c.outlook.caixa.values()][0];
  assert.deepEqual(msg.anexos.map((a) => sha256(a.bytes)), [sha256(assinado), sha256(c.caixa.anexos['msg-1|anexo-1'].bytes)], 'termo ASSINADO + MBL; nunca o preparado');
  const envioId = (rascunho as { envioId: string }).envioId;
  c.outlook.enviarPeloOutlook((await c.repo.tentativa(ORG, envioId))!.rascunho!.id);
  assert.equal((await conciliarEnvio(c.deps, ATOR, envioId, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
  // Solicitação de agendamento enviada não vira fato da L1b (decisão 14.3).
  const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador('EVERGREEN', MASTER)), c.repo.m.documentos, c.repo.m.assinaturas, c.repo.m.tentativas,
    c.repo.m.conferencias);
  assert.deepEqual(fatos.eventos, []);
  assert.deepEqual(fatos.mantidosNoDominioDocumental.map((f) => f.fato),
    ['TERMO_EVERGREEN_PREPARADO', 'TERMO_EVERGREEN_ASSINADO', 'TERMO_EVERGREEN_CONFERIDO', 'SOLICITACAO_DE_AGENDAMENTO_ENVIADA']);
});

test('[GR-09] DOC-17: Exportador/Importador (Hapag e ZIM) = consignatário do MBL, por regra específica desses modelos; sem consignatário confiável o campo fica faltando com a fonte', { skip: SEM_MODELOS }, async () => {
  for (const tipo of ['MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as TipoDocumento[]) {
    const campo = DEFINICOES_PROPOSTAS[tipo].campos.find((x) => x.id === 'EXPORTADOR_IMPORTADOR')!;
    assert.deepEqual([campo.dado, campo.fontesAceitas, campo.escopo], ['CONSIGNATARIO_RAZAO_SOCIAL', ['S2_AUDITORIA'], 'MASTER'], tipo);
    assert.match(String(campo.fundamento), /DOC-17/);
    const c = await cenarioReal(tipo, { valores: valoresDasFontes(tipo, ['CONSIGNATARIO_RAZAO_SOCIAL']) });
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo), informados: informadosSinteticos(tipo) });
    assert.deepEqual([r.tipo, (r as { motivo: string }).motivo], ['NAO_PREPARADO', 'CONDICOES_NAO_ATENDIDAS'], tipo);
    const passo = r.situacao?.pendencias.find((p) => p.passo === 'OBTER_DADOS_FALTANTES');
    const faltantes = passo?.passo === 'OBTER_DADOS_FALTANTES' ? passo.faltantes : [];
    assert.deepEqual(faltantes.map((f) => [f.campo, f.fontesAceitas]), [['EXPORTADOR_IMPORTADOR', ['S2_AUDITORIA']]], tipo);
    // Um consignatário vindo de outra fonte (não confiável para esse dado) também não preenche.
    c.mundo.valores.push(valor('CONSIGNATARIO_RAZAO_SOCIAL', 'EMPRESA DE OUTRA FONTE', 'HEADCARGO', { tipo: 'MASTER', masterId: MASTER }));
    assert.equal((await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo), informados: informadosSinteticos(tipo) })).tipo, 'NAO_PREPARADO', tipo);
  }
  // Nenhuma regra global: só os memorandos Rochamar chamam o consignatário de "Exportador/Importador".
  for (const tipo of ['TERMO_EVERGREEN', 'MEMORANDO_MSC'] as TipoDocumento[]) {
    assert.ok(!DEFINICOES_PROPOSTAS[tipo].campos.some((x) => /export|import/i.test(x.rotulo) || x.fundamento), tipo);
  }
});

test('[GR-10] DOC-23 nos modelos reais: quem assina é o signatário legal (cadastro dele, nunca o Analista); Evergreen exige poderes comprovados antes da solicitação; Hapag e ZIM declaram o representante, mas assinatura e poderes ficam fora da Priora (DOC-31); MSC não declara', { skip: SEM_MODELOS }, async () => {
  const exigem: Record<TipoDocumento, boolean> = { TERMO_EVERGREEN: true, MEMORANDO_MSC: false, MEMORANDO_HAPAG_ROCHAMAR: true, MEMORANDO_ZIM_ROCHAMAR: true };
  for (const tipo of ['TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as TipoDocumento[]) {
    const d = DEFINICOES_PROPOSTAS[tipo];
    assert.equal(!!d.poderesDeRepresentacao, exigem[tipo], tipo);
    for (const c of d.campos.filter((x) => x.dado.startsWith('SIGNATARIO_'))) assert.deepEqual([c.fontesAceitas, c.escopo], [['CADASTRO_DO_SIGNATARIO_LEGAL'], 'SIGNATARIO'], `${tipo}/${c.id}`);
    const c = await cenarioReal(tipo);
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo), informados: informadosSinteticos(tipo) });
    assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
    const nome = semEspacos(VALORES_SINTETICOS.SIGNATARIO_NOME);
    assert.ok(semEspacos(textoDoPdf(c.repo.m.documentos[0].arquivo)).includes(nome), `${tipo}: nome do signatário legal`);
    assert.deepEqual(c.repo.m.documentos[0].signatario, { signatarioId: SIGNATARIO_LEGAL_SINTETICO.signatarioId, nome: SIGNATARIO_LEGAL_SINTETICO.nome }, tipo);
    if (tipo !== 'TERMO_EVERGREEN') {
      const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
      assert.deepEqual([s.representacao.tipo, s.proximoPasso?.passo, s.pendencias], ['FORA_DA_PRIORA', 'DOCUMENTO_DISPONIVEL', []], tipo);
      continue;
    }
    await assinarEConferir(c, (r as { documentoId: string }).documentoId, assinarSobre(c.repo.m.documentos[0].arquivo));
    const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
    assert.equal(s.representacao.tipo, 'NAO_COMPROVADA', tipo);
    assert.equal(condicaoDaSolicitacaoDeAgendamento(s).tipo, 'SOLICITACAO_RESTRITA', tipo);
  }
});

test('[GR-11] DOC-18 no serviço: Hapag e ZIM aceitam um ou mais serviços escolhidos pelo Analista; MSC só um; sem escolha, nada é presumido', { skip: SEM_MODELOS }, async () => {
  const por = { por: ANALISTA, em: '2026-10-15T10:00:00.000Z' };
  const hapag = await cenarioReal('MEMORANDO_HAPAG_ROCHAMAR');
  const dois = await prepararDocumento(hapag.deps, ATOR, MASTER, {
    escolhas: [{ grupo: 'SERVICOS', alternativas: ['RETIRADA_E_DESBLOQUEIO', 'SOMENTE_DEVOLUCAO'], ...por }], informados: informadosSinteticos('MEMORANDO_HAPAG_ROCHAMAR'),
  });
  assert.equal(dois.tipo, 'PREPARADO', JSON.stringify(dois));
  assert.deepEqual(hapag.repo.m.documentos[0].selecoes.map((x) => [x.alternativas, x.origem.tipo]), [[['RETIRADA_E_DESBLOQUEIO', 'SOMENTE_DEVOLUCAO'], 'ANALISTA']]);
  const msc = await cenarioReal('MEMORANDO_MSC');
  const r = await prepararDocumento(msc.deps, ATOR, MASTER, { escolhas: [{ grupo: 'SERVICO_REQUERIDO', alternativas: ['APRESENTACAO_COM_DESBLOQUEIO', 'RETIRADA_SEM_DESBLOQUEIO'], ...por }] });
  assert.deepEqual((r.situacao?.pendencias.find((p) => p.passo === 'ESCOLHER_OPCOES_DO_MODELO') as { problemas: Array<{ tipo: string }> }).problemas.map((x) => x.tipo), ['QUANTIDADE_INVALIDA']);
  const zim = await cenarioReal('MEMORANDO_ZIM_ROCHAMAR');
  const sem = await prepararDocumento(zim.deps, ATOR, MASTER, { informados: informadosSinteticos('MEMORANDO_ZIM_ROCHAMAR') });
  assert.deepEqual((sem.situacao?.pendencias.find((p) => p.passo === 'ESCOLHER_OPCOES_DO_MODELO') as { problemas: unknown[] }).problemas,
    [{ tipo: 'ESCOLHA_PENDENTE', grupo: 'SERVICOS', motivo: 'SEM_REGRA_OU_EVIDENCIA' }]);
});

test('[GR-12] DOC-27 no serviço: termo Evergreen real com 15 contêineres é preparado (relação anexa, aceite da agência pendente); contêiner repetido no MBL nunca é descartado em silêncio', { skip: SEM_MODELOS }, async () => {
  const lista = (n: number, extra: string[] = []) => [...Array.from({ length: n }, (_, i) => `TSTU${String(i + 1).padStart(7, '0')}`), ...extra].join('\n');
  const comConteineres = (v: string) => [...valoresDasFontes('TERMO_EVERGREEN', ['CONTEINERES_DO_MASTER']),
    valor('CONTEINERES_DO_MASTER', v, 'S2_AUDITORIA', { tipo: 'MASTER', masterId: MASTER })];
  const c = await cenarioReal('TERMO_EVERGREEN', { valores: comConteineres(lista(15)), poderes: true });
  const r = await prepararDocumento(c.deps, ATOR, MASTER);
  assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
  const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
  assert.deepEqual(s.atencoes.map((x) => [x.tipo, (x as { itens?: number }).itens, (x as { paginas?: number }).paginas]), [['RELACAO_ANEXA_PENDENTE_DE_ACEITE_DA_AGENCIA', 15, 1]]);
  assert.equal(DEFINICOES_PROPOSTAS.TERMO_EVERGREEN.layout!.relacaoAnexa!.aceiteDaAgencia.estado, 'PENDENTE_DE_ACEITE_DA_AGENCIA', 'nunca considerado aceito sem confirmação');
  // Repetido na fonte: dado inconsistente → o campo fica faltando (nada é deduplicado nem truncado em silêncio).
  const dup = await cenarioReal('TERMO_EVERGREEN', { valores: comConteineres(lista(7, ['TSTU0000003'])) });
  const r2 = await prepararDocumento(dup.deps, ATOR, MASTER);
  assert.equal(r2.tipo, 'NAO_PREPARADO');
  const p = (await avaliarDocumentacao(dup.deps, ORG, MASTER)).situacao.preenchimento;
  assert.deepEqual(p?.tipo === 'INCOMPLETO' && [p.faltantes.map((f) => f.campo), p.recusados.filter((x) => x.valor.dado === 'CONTEINERES_DO_MASTER').map((x) => x.motivo)],
    [['CONTEINERES'], ['FORA_DO_FORMATO']]);
});

test('[GR-13] DOC-31.A nos modelos reais: Hapag e ZIM geram e disponibilizam o PDF com o representante do CADASTRO, sem comprovação de poderes; nada de upload ou conferência', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of ['MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR'] as TipoDocumento[]) {
    assert.ok(DEFINICOES_PROPOSTAS[tipo].poderesDeRepresentacao, `${tipo}: o modelo declara o quadro do representante`);
    const c = await cenarioReal(tipo, { poderes: false });
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo), informados: informadosSinteticos(tipo) });
    assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
    const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
    assert.deepEqual([s.representacao.tipo, s.proximoPasso?.passo, s.pendencias, s.texto], ['FORA_DA_PRIORA', 'DOCUMENTO_DISPONIVEL', [], 'Documento disponível para download'], tipo);
    const texto = semEspacos(textoDoPdf(c.repo.m.documentos[0].arquivo));
    for (const v of [VALORES_SINTETICOS.SIGNATARIO_NOME, '529.982.247-25']) assert.ok(texto.includes(semEspacos(v)), `${tipo}: ${v} do cadastro no PDF`);
    assert.equal(c.repo.m.assinaturas.length, 0, tipo);
  }
});

test('[GR-14] DOC-31.B nos modelos reais: consignatário (Hapag) e contêiner (Evergreen) impressos alterados → pendência com o campo; mesmo valor reprocessado → nenhuma', { skip: SEM_MODELOS }, async () => {
  const casos: Array<[TipoDocumento, string, string, string]> = [
    ['MEMORANDO_HAPAG_ROCHAMAR', 'CONSIGNATARIO_RAZAO_SOCIAL', 'OUTRA EMPRESA SINTETICA LTDA', 'EXPORTADOR_IMPORTADOR'],
    ['TERMO_EVERGREEN', 'CONTEINERES_DO_MASTER', 'TSTU0000001\nTSTU0000009', 'CONTEINERES'],
  ];
  for (const [tipo, dado, novo, campo] of casos) {
    const c = await cenarioReal(tipo, { poderes: true });
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: escolhas(tipo), informados: informadosSinteticos(tipo) });
    assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
    // Reprocessamento (outra evidência, outro instante, mesmo valor): nada muda.
    c.mundo.valores = c.mundo.valores.map((v) => ({ ...v, evidencia: { ...v.evidencia, ref: `${v.evidencia.ref}#reprocessado` }, observadoEm: '2026-10-12T09:00:00.000Z' }));
    const igual = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
    assert.equal(igual.preparo.tipo, 'PREPARADO', `${tipo}: reprocessado com o mesmo valor`);
    c.mundo.valores = c.mundo.valores.map((v) => (v.dado === dado ? { ...v, valor: novo } : v));
    const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
    const passo = s.pendencias.find((p) => p.passo === 'GERAR_NOVA_VERSAO') as { alterados: Array<{ item: { campo?: string } }> } | undefined;
    assert.deepEqual(passo?.alterados.map((a) => a.item.campo), [campo], tipo);
  }
});
