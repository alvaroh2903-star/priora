import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Response } from 'express';
import { AddressInfo } from 'net';
import { PDFDocument } from 'pdf-lib';
import { situacaoDaAgencia } from '../../dominio';
import { armador, clienteOk, decidir, evento, procedimento } from '../../dominio/__tests__/l1b/fixtures';
import { criarDocumentosRouter } from '../../../routes/documentosRoutes';
import { AuthedRequest } from '../../../middleware/requireAuth';
import {
  ARQUIVOS_OFICIAIS_RECEBIDOS, DEFINICOES_PROPOSTAS, DefinicaoDoModelo, ProximoPassoDocumental, TIPOS_DE_DOCUMENTO, TipoDocumento, acrescentarAoProcedimento,
  avaliarDocumentacao, conciliarManualmente, condicaoDaSolicitacaoDeAgendamento, conferirAssinatura, entradaDoCatalogo, enviarPelaPriora, fatosDocumentaisParaL1b,
  gerarDocumento, papeisDoDocumento, prepararDocumento, prepararRascunho, procedimentoDoModelo, registrarAssinatura, sha256,
} from '..';
import {
  ANALISTA, ATOR, MASTER, MBL_BYTES, ORG, OUTRO_ANALISTA, PERMITIDA, SIGNATARIO_COM_PODERES, SIGNATARIO_SINTETICO, TERCEIRO_ANALISTA, assinadoSintetico, assinarSobre, cenarioDocumental,
  definicaoEvergreen, definicaoMemorando, valor,
} from './fixtures';
import {
  MODELOS_OFICIAIS, SEM_MODELOS, SEM_POPPLER, VALORES_SINTETICOS, conteudoSintetico, renderizar, semEspacos, textoDoPdf,
} from './modelosReais';

/**
 * DOC-31 (§8, 1–20): correção de escopo documental.
 *  - Fluxo A — MSC, Hapag-Lloyd, ZIM: a Priora gera o PDF com os dados confiáveis, deixa ver e baixar, e para.
 *  - Fluxo B — Evergreen/Grieg: ciclo completo (assinado devolvido, conferência, guarda, rascunho com termo + MBL, envio).
 * Dependências SIMULADAS (repositório em memória, Outlook e caixa falsos); a geração real usa os arquivos oficiais
 * só quando `PRIORA_MODELOS_OFICIAIS_DIR` está definido. Nenhum e-mail real, nenhum certificado real.
 */

type Memorando = Exclude<TipoDocumento, 'TERMO_EVERGREEN'>;
const MEMORANDOS: Array<[Memorando, string]> = [['MEMORANDO_MSC', 'MSC'], ['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM']];
const ESCOLHA = [{ grupo: 'servico', alternativas: ['SERVICO_C'], por: ANALISTA, em: '2026-10-14T12:00:00.000Z' }];
const QUEM_ASSINA = [
  { id: 'nome', rotulo: 'Quem assina', dado: 'SIGNATARIO_NOME', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
  { id: 'cpf', rotulo: 'CPF', dado: 'SIGNATARIO_CPF', obrigatorio: true, fontesAceitas: ['CADASTRO_DO_SIGNATARIO_LEGAL'], escopo: 'SIGNATARIO' },
] as DefinicaoDoModelo['campos'];
/** Memorando SINTÉTICO com os campos de quem assina e, como Hapag e ZIM, a exigência de poderes declarada no modelo (o MSC não declara). */
const memorando = (tipo: Memorando) => definicaoMemorando(tipo, {
  campos: [...definicaoMemorando(tipo).campos, ...QUEM_ASSINA],
  poderesDeRepresentacao: tipo === 'MEMORANDO_MSC' ? null : { fundamento: 'texto SINTÉTICO: "quadro do representante"' },
});
/** Termo SINTÉTICO com quem assina e exigência de poderes (como o termo Evergreen real). */
const termo = () => definicaoEvergreen({ campos: [...definicaoEvergreen().campos, ...QUEM_ASSINA], poderesDeRepresentacao: { fundamento: 'texto SINTÉTICO' } });

type Cenario = Awaited<ReturnType<typeof cenarioDocumental>>;
const situacao = async (c: Cenario, op: Parameters<typeof avaliarDocumentacao>[3] = {}) => (await avaliarDocumentacao(c.deps, ORG, MASTER, op)).situacao;
const cenarioMemorando = (tipo: Memorando, codigo: string, p: Parameters<typeof cenarioDocumental>[0] = {}) =>
  cenarioDocumental({ armador: { masterId: MASTER, codigo }, defs: { [tipo]: memorando(tipo) }, ...p });
async function memorandoPreparado(tipo: Memorando, codigo: string, p: Parameters<typeof cenarioDocumental>[0] = {}) {
  const c = await cenarioMemorando(tipo, codigo, p);
  const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: ESCOLHA });
  assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r)}`);
  return { c, documentoId: (r as { documentoId: string }).documentoId };
}
const ASSINADO = assinadoSintetico('TERMO COM ASSINATURA DIGITAL SINTETICA DO SIGNATARIO LEGAL');
async function termoPreparado(c?: Cenario) {
  const cen = c ?? await cenarioDocumental({ defs: { TERMO_EVERGREEN: termo() }, signatarios: [SIGNATARIO_COM_PODERES] });
  const r = await prepararDocumento(cen.deps, ATOR, MASTER);
  assert.equal(r.tipo, 'PREPARADO', JSON.stringify(r));
  return { c: cen, documentoId: (r as { documentoId: string }).documentoId };
}
async function termoConferido(arquivo = ASSINADO) {
  const { c, documentoId } = await termoPreparado();
  const a = await registrarAssinatura(c.deps, ATOR, documentoId, arquivo);
  assert.equal(a.tipo, 'REGISTRADA', JSON.stringify(a));
  const assinaturaId = (a as { assinaturaId: string }).assinaturaId;
  const k = await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
  assert.equal(k.tipo, 'CONFERENCIA_REGISTRADA', JSON.stringify(k));
  return { c, documentoId, assinaturaId, conferenciaId: (k as { conferenciaId: string }).conferenciaId };
}
const acesso = (c: Cenario) => ({ outlook: c.outlook, caixaMonitorada: c.caixa });
const marcos = (d: ReturnType<typeof decidir>) => d.progresso.map((m) => m.marco);
const acoes = (d: ReturnType<typeof decidir>) => d.itens.map((i) => i.acao);
const decisaoCom = (codigo: string, c: Cenario) => {
  const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador(codigo)), c.repo.m.documentos, c.repo.m.assinaturas, c.repo.m.tentativas, c.repo.m.conferencias);
  return decidir({ ...clienteOk(), armador: armador(codigo), procedimento: acrescentarAoProcedimento(procedimento([]), fatos) });
};
/** Tudo o que a Priora guarda além do documento preparado. */
const registros = (c: Cenario) => JSON.stringify([c.repo.m.documentos.length, c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas, c.repo.m.eventosDoEnvio]);

const PASSOS_DE_ASSINATURA: ReadonlyArray<ProximoPassoDocumental['passo']> = ['ASSINAR_DOCUMENTO', 'CONFERIR_ASSINATURA', 'SUBSTITUIR_ARQUIVO_ASSINADO', 'COMPROVAR_PODERES_DE_REPRESENTACAO'];
const PASSOS_DE_ENVIO: ReadonlyArray<ProximoPassoDocumental['passo']> = [
  'OBTER_COPIA_DO_MBL_EM_PDF', 'ESCOLHER_COPIA_DO_MBL', 'ANALISAR_MBL_DO_MASTER', 'VALIDAR_DESTINATARIOS_DA_AGENCIA', 'AGUARDAR_PERMISSAO_DA_ACAO', 'PREPARAR_RASCUNHO_NO_OUTLOOK',
  'PREPARAR_REENVIO', 'AGUARDAR_CRIACAO_DO_RASCUNHO', 'CONFERIR_E_ENVIAR_RASCUNHO', 'CONFIRMAR_ENVIO_NO_OUTLOOK', 'CONCILIAR_ENVIO_INCERTO', 'DOCUMENTO_PRONTO_PARA_ENCAMINHAMENTO',
  'ACOMPANHAR_APRESENTACAO_NA_L1B',
];
const passosDe = (s: Awaited<ReturnType<typeof situacao>>) => [...s.pendencias.map((p) => p.passo), s.proximoPasso?.passo].filter(Boolean);

/** Nenhuma chamada de rede durante o bloco (prova de que nenhum e-mail real sai). */
async function semRede<T>(f: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('rede proibida nos testes'); }) as typeof fetch;
  try {
    return await f();
  } finally {
    globalThis.fetch = original;
  }
}

test('[DOC31-00] catálogo: o procedimento é do MODELO — MSC, Hapag e ZIM geram e disponibilizam; só o termo Evergreen tem o ciclo completo', () => {
  assert.deepEqual(TIPOS_DE_DOCUMENTO.map((t) => [t, procedimentoDoModelo(t), entradaDoCatalogo(t).procedimento]), [
    ['TERMO_EVERGREEN', 'CICLO_COMPLETO', 'CICLO_COMPLETO'], ['MEMORANDO_MSC', 'GERAR_E_DISPONIBILIZAR', 'GERAR_E_DISPONIBILIZAR'],
    ['MEMORANDO_HAPAG_ROCHAMAR', 'GERAR_E_DISPONIBILIZAR', 'GERAR_E_DISPONIBILIZAR'], ['MEMORANDO_ZIM_ROCHAMAR', 'GERAR_E_DISPONIBILIZAR', 'GERAR_E_DISPONIBILIZAR'],
  ]);
});

test('[DOC31-01] MSC: gera o PDF e o deixa para baixar sem nenhum upload do assinado; a preparação está completa', async () => {
  const { c, documentoId } = await memorandoPreparado('MEMORANDO_MSC', 'MSC');
  const doc = c.repo.m.documentos[0];
  const arquivo = await c.repo.arquivoDoDocumento(ORG, documentoId);
  assert.ok(arquivo && sha256(arquivo) === doc.arquivoSha256 && Buffer.from(arquivo).subarray(0, 5).toString() === '%PDF-');
  const s = await situacao(c);
  assert.deepEqual([s.preparo.tipo, s.proximoPasso, s.pendencias], ['PREPARADO', { passo: 'DOCUMENTO_DISPONIVEL', responsavel: 'ANALISTA', documentoId }, []]);
  assert.equal(c.repo.m.assinaturas.length, 0, 'nenhum arquivo assinado foi pedido nem guardado');
});

test('[DOC31-02] Hapag: sem conferência — a Priora não confere nada e o documento já está disponível', async () => {
  const { c, documentoId } = await memorandoPreparado('MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD');
  assert.deepEqual(await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: 'ass-1', arquivoSha256: 'a'.repeat(64), resultado: 'CONFORME' }),
    { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' });
  const s = await situacao(c);
  assert.ok(!passosDe(s).includes('CONFERIR_ASSINATURA'));
  assert.deepEqual([s.assinatura, s.proximoPasso?.passo], [{ tipo: 'FORA_DA_PRIORA' }, 'DOCUMENTO_DISPONIVEL']);
  assert.equal(c.repo.m.conferencias.length, 0);
});

test('[DOC31-03] ZIM: sem Outlook — nenhum rascunho, nenhum envio, nenhuma chamada ao Outlook', async () => {
  const { c } = await memorandoPreparado('MEMORANDO_ZIM_ROCHAMAR', 'ZIM');
  assert.deepEqual(await prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA }), { tipo: 'NAO_PREPARADO', motivo: 'FLUXO_NAO_APLICAVEL', avaliacao: null });
  const s = await situacao(c, { autorizacao: PERMITIDA });
  assert.deepEqual([s.envio, s.proximoPasso?.passo], [{ tipo: 'NAO_APLICAVEL' }, 'DOCUMENTO_DISPONIVEL']);
  assert.ok(!passosDe(s).some((p) => PASSOS_DE_ENVIO.includes(p!)));
  assert.deepEqual([c.outlook.chamadas, c.repo.m.tentativas], [[], []]);
});

test('[DOC31-04] MSC, Hapag e ZIM continuam exigindo dados confiáveis, o cadastro do signatário e opções válidas — nada é gerado sem eles', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    // Sem o BL do Master (S6): falta, com a fonte de onde viria; o mesmo dado de outra fonte nem é pedido e não preenche.
    const semBl = await cenarioMemorando(tipo, codigo, { valores: [valor('MBL', 'BL-DE-OUTRA-FONTE', 'HEADCARGO', { tipo: 'MASTER', masterId: MASTER })] });
    const r = await prepararDocumento(semBl.deps, ATOR, MASTER, { escolhas: ESCOLHA });
    assert.deepEqual([r.tipo, (r as { motivo: string }).motivo], ['NAO_PREPARADO', 'CONDICOES_NAO_ATENDIDAS'], tipo);
    const p = r.situacao?.preenchimento;
    assert.deepEqual(p?.tipo === 'INCOMPLETO' && p.faltantes.map((f) => [f.campo, f.fontesAceitas]), [['bl', ['S6_MASTER']]], tipo);
    // Sem cadastro válido do signatário legal: os campos de quem assina faltam (nada vem do Analista).
    const semCadastro = await cenarioMemorando(tipo, codigo, { signatarios: [] });
    const r2 = await prepararDocumento(semCadastro.deps, ATOR, MASTER, { escolhas: ESCOLHA });
    assert.equal(r2.tipo, 'NAO_PREPARADO', tipo);
    assert.ok(r2.situacao?.pendencias.some((x) => x.passo === 'DEFINIR_SIGNATARIO_LEGAL'), tipo);
    // Opções: sem escolha nada é presumido; alternativa inexistente ou incompatível é recusada.
    const c = await cenarioMemorando(tipo, codigo);
    assert.equal((await situacao(c)).proximoPasso?.passo, 'ESCOLHER_OPCOES_DO_MODELO', tipo);
    for (const alternativas of [['SERVICO_X'], ['SERVICO_A', 'SERVICO_B'], []]) {
      assert.equal((await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: [{ ...ESCOLHA[0], alternativas }] })).tipo, 'NAO_PREPARADO', `${tipo}: ${alternativas}`);
    }
    assert.deepEqual([semBl.repo.m.documentos.length, semCadastro.repo.m.documentos.length, c.repo.m.documentos.length], [0, 0, 0], tipo);
  }
});

test('[DOC31-05] gerar não cria tentativa de envio (nem no fluxo A, nem no termo Evergreen)', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const { c } = await memorandoPreparado(tipo, codigo);
    assert.deepEqual([c.repo.m.tentativas, c.repo.m.eventosDoEnvio, c.outlook.chamadas], [[], [], []], tipo);
  }
  const { c } = await termoPreparado();
  assert.deepEqual([c.repo.m.tentativas, c.repo.m.eventosDoEnvio, c.outlook.chamadas], [[], [], []]);
});

test('[DOC31-06] gerar não comprova apresentação: só "memorando gerado" vai à L1b, que continua pedindo "Enviar para apresentação"', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const { c } = await memorandoPreparado(tipo, codigo);
    const s = await situacao(c);
    assert.equal(s.apresentacao.tipo, 'NAO_E_FATO_DOCUMENTAL', tipo);
    const fatos = fatosDocumentaisParaL1b(MASTER, situacaoDaAgencia(MASTER, armador(codigo)), c.repo.m.documentos, c.repo.m.assinaturas, []);
    assert.deepEqual(fatos.eventos.map((e) => e.tipo), ['PREPARACAO_REGISTRADA'], tipo);
    const d = decisaoCom(codigo, c);
    assert.ok(acoes(d).includes('ENVIAR_PARA_APRESENTACAO') && !marcos(d).includes('MASTER_APRESENTADO'), tipo);
  }
});

test('[DOC31-07] baixar ou visualizar o PDF não registra nada e não comprova envio nem apresentação', async () => {
  const MASTER_UUID = '11111111-1111-4111-8111-111111111111';
  const c = await cenarioDocumental({
    armador: { masterId: MASTER_UUID, codigo: 'MSC' }, idsUuid: true, defs: { MEMORANDO_MSC: memorando('MEMORANDO_MSC') },
    valores: [valor('MBL', 'MBLSINTETICO0001', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER_UUID })],
  });
  const app = express();
  app.use(express.json());
  app.use('/api/liberacao/documentos', criarDocumentosRouter({
    habilitado: () => true, documentos: () => c.deps, caixaMonitorada: () => c.caixa,
    auth: (req: AuthedRequest, _res: Response, next: NextFunction) => {
      req.pessoa = { usuarioId: 'u-1', homeAccountId: 'conta-analista', nome: 'Analista', membershipId: ANALISTA, papel: 'ANALYST', organizationId: ORG, caixaId: 'caixa-1' };
      next();
    },
    outlookDaPessoa: async () => ({ tipo: 'DISPONIVEL', outlook: c.outlook }),
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/liberacao/documentos`;
  try {
    const corpo = JSON.stringify({ escolhas: [{ grupo: 'servico', alternativas: ['SERVICO_C'] }] });
    const r = await (await fetch(`${base}/masters/${MASTER_UUID}/preparar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo })).json() as { documentoId: string };
    const estado = async () => {
      const av = await avaliarDocumentacao(c.deps, ORG, MASTER_UUID);
      const fatos = fatosDocumentaisParaL1b(MASTER_UUID, situacaoDaAgencia(MASTER_UUID, armador('MSC', MASTER_UUID)), c.repo.m.documentos, c.repo.m.assinaturas, c.repo.m.tentativas);
      return JSON.stringify([registros(c), av.situacao, fatos, c.outlook.chamadas]);
    };
    const antes = await estado();
    for (const sufixo of ['', '?modo=visualizar', '', '?modo=visualizar']) {
      const arq = await fetch(`${base}/arquivos/${r.documentoId}${sufixo}`);
      assert.equal(arq.status, 200);
      await arq.arrayBuffer();
    }
    assert.equal(await estado(), antes, 'situação, fatos da L1b, registros e Outlook idênticos depois de baixar');
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test('[DOC31-08] MSC, Hapag e ZIM nunca têm pendência de assinatura, conferência ou poderes — nem com poderes declarados e não comprovados', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const c = await cenarioMemorando(tipo, codigo);
    const vistas = [await situacao(c, { escolhas: ESCOLHA })];
    await prepararDocumento(c.deps, ATOR, MASTER, { escolhas: ESCOLHA });
    vistas.push(await situacao(c));
    c.mundo.valores = [valor('MBL', 'OUTRO-BL-0002', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })];
    vistas.push(await situacao(c));
    await prepararDocumento(c.deps, ATOR, MASTER);
    vistas.push(await situacao(c));
    assert.deepEqual(vistas.map((s) => s.proximoPasso?.passo), ['GERAR_DOCUMENTO', 'DOCUMENTO_DISPONIVEL', 'GERAR_NOVA_VERSAO', 'DOCUMENTO_DISPONIVEL'], tipo);
    for (const s of vistas) {
      assert.ok(!passosDe(s).some((p) => PASSOS_DE_ASSINATURA.includes(p!)), `${tipo}: ${passosDe(s)}`);
      assert.deepEqual([s.assinatura, s.representacao], [{ tipo: 'FORA_DA_PRIORA' }, { tipo: 'FORA_DA_PRIORA' }], tipo);
    }
  }
});

test('[DOC31-09] MSC, Hapag e ZIM nunca têm pendência de upload: o arquivo assinado é recusado (serviço) e não pode ser guardado (banco/repositório)', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const { c, documentoId } = await memorandoPreparado(tipo, codigo);
    const assinado = assinarSobre(c.repo.m.documentos[0].arquivo);
    assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, assinado), { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
    assert.deepEqual(await registrarAssinatura(c.deps, ATOR, documentoId, assinado, { substituicao: { motivo: 'OUTRO', justificativa: 'reexportado' } }),
      { tipo: 'RECUSADA', motivo: 'FLUXO_NAO_APLICAVEL' }, tipo);
    await assert.rejects(c.repo.gravarAssinatura(ORG, {
      documentoId, arquivo: assinado, arquivoSha256: sha256(assinado), registradoPor: ANALISTA, registradoEm: new Date(), verificacao: 'INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO',
      signatarioEsperado: c.repo.m.documentos[0].signatario, substituicao: null,
    }), /só do termo Evergreen/, tipo);
    const s = await situacao(c, { autorizacao: PERMITIDA });
    assert.ok(!passosDe(s).some((p) => p === 'ASSINAR_DOCUMENTO' || PASSOS_DE_ENVIO.includes(p!)), tipo);
    assert.equal(c.repo.m.assinaturas.length, 0, tipo);
  }
});

test('[DOC31-10] Evergreen: a solicitação de agendamento continua exigindo o termo ASSINADO e CONFERIDO', async () => {
  const { c, documentoId } = await termoPreparado();
  const condicao = async () => condicaoDaSolicitacaoDeAgendamento(await situacao(c, { autorizacao: PERMITIDA }), PERMITIDA);
  const rascunho = () => prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA });
  assert.equal((await situacao(c)).proximoPasso?.passo, 'ASSINAR_DOCUMENTO', 'no ciclo completo a assinatura continua pendência');
  assert.deepEqual((await condicao() as { motivos: string[] }).motivos, ['ASSINATURA_PENDENTE']);
  assert.equal((await rascunho()).tipo, 'NAO_PREPARADO');
  const a = await registrarAssinatura(c.deps, ATOR, documentoId, ASSINADO) as { assinaturaId: string };
  assert.deepEqual((await condicao() as { motivos: string[] }).motivos, ['CONFERENCIA_DA_ASSINATURA_PENDENTE']);
  assert.equal((await rascunho()).tipo, 'NAO_PREPARADO');
  await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: a.assinaturaId, arquivoSha256: sha256(ASSINADO), resultado: 'CONFORME' });
  assert.equal((await condicao()).tipo, 'TERMO_PRONTO_PARA_A_SOLICITACAO');
  assert.equal((await rascunho()).tipo, 'RASCUNHO_DISPONIVEL');
  assert.equal((await situacao(c)).apresentacao.tipo, 'NAO_E_FATO_DOCUMENTAL', 'a solicitação não comprova a apresentação');
});

test('[DOC31-11] Evergreen: o rascunho leva os anexos corretos — o termo ASSINADO conferido e a cópia do MBL em PDF; nunca o preparado', async () => {
  const { c } = await termoConferido();
  const r = await prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA });
  assert.equal(r.tipo, 'RASCUNHO_DISPONIVEL', JSON.stringify(r));
  const msg = [...c.outlook.caixa.values()][0];
  assert.deepEqual(msg.anexos.map((x) => sha256(x.bytes)), [sha256(ASSINADO), sha256(MBL_BYTES)]);
  assert.ok(!msg.anexos.some((x) => sha256(x.bytes) === c.repo.m.documentos[0].arquivoSha256));
});

test('[DOC31-12] Evergreen: o hash do arquivo conferido é o do arquivo encaminhado; outro arquivo assinado exige nova conferência antes do e-mail', async () => {
  const { c, assinaturaId } = await termoConferido();
  const r = await prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA }) as { envioId: string };
  assert.equal((await enviarPelaPriora(c.deps, ATOR, r.envioId, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
  const t = (await c.repo.tentativa(ORG, r.envioId))!;
  const conferido = c.repo.m.conferencias.find((k) => k.assinaturaId === assinaturaId)!;
  assert.deepEqual([t.assinaturaId, t.anexos[0].sha256, t.estado], [assinaturaId, conferido.arquivoSha256, 'ENVIO_CONFIRMADO']);
  assert.equal(sha256([...c.outlook.caixa.values()][0].anexos[0].bytes), conferido.arquivoSha256);
  // Substituição depois da conferência: o novo arquivo não herda a conferência.
  const outro = await termoConferido();
  const novo = assinadoSintetico('TERMO REASSINADO');
  assert.equal((await registrarAssinatura(outro.c.deps, ATOR, outro.documentoId, novo, { substituicao: { motivo: 'OUTRO', justificativa: 'reassinado' } })).tipo, 'REGISTRADA');
  const bloqueado = await prepararRascunho(outro.c.deps, ATOR, MASTER, acesso(outro.c), { autorizacao: PERMITIDA }) as { avaliacao: { motivos: string[] } };
  assert.ok(bloqueado.avaliacao.motivos.includes('CONFERENCIA_DA_ASSINATURA_PENDENTE'), JSON.stringify(bloqueado));
  assert.equal(outro.c.repo.m.tentativas.length, 0);
});

test('[DOC31-13] Evergreen: envio incerto continua protegido — nada é reenviado até conciliar, e a pessoa não conclui antes do Graph', async () => {
  const { c } = await termoConferido();
  const r = await prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA }) as { envioId: string };
  c.outlook.falhar.enviar = new Error('timeout');
  assert.equal((await enviarPelaPriora(c.deps, ATOR, r.envioId, c.outlook)).tipo, 'RESULTADO_INCERTO');
  c.outlook.falhar = {};
  assert.equal((await prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA }) as { motivo: string }).motivo, 'CONCILIACAO_NECESSARIA');
  assert.equal((await situacao(c)).proximoPasso?.passo, 'CONCILIAR_ENVIO_INCERTO');
  assert.equal((await conciliarManualmente(c.deps, ATOR, r.envioId, { justificativa: 'acho que não saiu', verificacao: 'ANALISTA_CONFERIU_ITENS_ENVIADOS' }) as { motivo: string }).motivo,
    'CONCILIACAO_PELO_GRAPH_NECESSARIA');
  assert.equal(c.outlook.chamadas.filter((z) => z === 'enviarRascunho').length, 1, 'nenhum reenvio automático');
});

test('[DOC31-14] o histórico guarda as versões: memorandos (versões preparadas) e termo (versões, arquivos assinados e conferências)', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const { c, documentoId } = await memorandoPreparado(tipo, codigo);
    c.mundo.valores = [valor('MBL', 'OUTRO-BL-0002', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })];
    const v2 = (await prepararDocumento(c.deps, ATOR, MASTER)) as { documentoId: string };
    assert.deepEqual(c.repo.m.documentos.map((d) => d.documentoId), [documentoId, v2.documentoId], tipo);
    for (const d of c.repo.m.documentos) assert.equal(sha256((await c.repo.arquivoDoDocumento(ORG, d.documentoId))!), d.arquivoSha256, `${tipo}: versão anterior continua baixável`);
  }
  const { c, documentoId, assinaturaId, conferenciaId } = await termoConferido();
  c.mundo.valores = c.mundo.valores.map((v) => (v.dado === 'MBL' ? { ...v, valor: 'EGLVTESTE0002' } : v));
  const v2 = (await termoPreparado(c)).documentoId;
  const antiga = papeisDoDocumento(c.repo.m.documentos[0], c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas);
  assert.deepEqual([antiga.documentoId, antiga.arquivosAssinados.map((x) => x.assinaturaId), antiga.conferencias.map((x) => x.conferenciaId)], [documentoId, [assinaturaId], [conferenciaId]]);
  assert.notEqual(v2, documentoId);
  assert.equal((await situacao(c)).assinatura.tipo, 'PENDENTE_HUMANA', 'a nova versão não herda assinatura nem conferência');
});

test('[DOC31-15] papéis continuam separados: preparador, operador que anexa, conferente e signatário legal (termo); no memorando, preparador e signatário', async () => {
  const A = ATOR;
  const B = { organizationId: ORG, membershipId: OUTRO_ANALISTA };
  const C = { organizationId: ORG, membershipId: TERCEIRO_ANALISTA };
  const { c, documentoId } = await termoPreparado();
  const arquivo = assinarSobre(c.repo.m.documentos[0].arquivo);
  const a = await registrarAssinatura(c.deps, B, documentoId, arquivo) as { assinaturaId: string };
  await conferirAssinatura(c.deps, C, documentoId, { assinaturaId: a.assinaturaId, arquivoSha256: sha256(arquivo), resultado: 'CONFORME' });
  const p = papeisDoDocumento(c.repo.m.documentos[0], c.repo.m.assinaturas, c.repo.m.conferencias, c.repo.m.tentativas);
  const legal = { signatarioId: SIGNATARIO_SINTETICO.signatarioId, nome: SIGNATARIO_SINTETICO.nome };
  assert.deepEqual([p.preparacao.por, p.arquivosAssinados[0].operador, p.conferencias[0].conferente, p.signatario], [A.membershipId, OUTRO_ANALISTA, TERCEIRO_ANALISTA, legal]);
  const m = await memorandoPreparado('MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD');
  assert.deepEqual([m.c.repo.m.documentos[0].preparadoPor, m.c.repo.m.documentos[0].signatario], [ANALISTA, legal]);
});

test('[DOC31-16] a L1b produz exatamente a mesma decisão: com o memorando preparado, depois de tentativas recusadas, de baixar e de nova versão', async () => {
  for (const [tipo, codigo] of MEMORANDOS) {
    const { c, documentoId } = await memorandoPreparado(tipo, codigo);
    const preparadoEm = c.repo.m.documentos[0].preparadoEm;
    const referencia = decisaoCom(codigo, c);
    const congelado = JSON.stringify(referencia);
    // A semântica congelada: o mesmo que um PREPARACAO_REGISTRADA no instante da preparação.
    const manual = decidir({ ...clienteOk(), armador: armador(codigo), procedimento: procedimento([evento('PREPARACAO_REGISTRADA', preparadoEm)]) });
    assert.deepEqual([acoes(referencia), referencia.principal?.acao, referencia.subEtapa], [acoes(manual), manual.principal?.acao, manual.subEtapa], tipo);
    await registrarAssinatura(c.deps, ATOR, documentoId, assinarSobre(c.repo.m.documentos[0].arquivo));
    await conferirAssinatura(c.deps, ATOR, documentoId, { assinaturaId: 'x', arquivoSha256: 'a'.repeat(64), resultado: 'CONFORME' });
    await c.repo.arquivoDoDocumento(ORG, documentoId);
    assert.equal(JSON.stringify(decisaoCom(codigo, c)), congelado, tipo);
    c.mundo.valores = [valor('MBL', 'OUTRO-BL-0002', 'S6_MASTER', { tipo: 'MASTER', masterId: MASTER })];
    await prepararDocumento(c.deps, ATOR, MASTER);
    assert.equal(JSON.stringify(decisaoCom(codigo, c)), congelado, `${tipo}: vale a primeira preparação`);
  }
});

test('[DOC31-17] Demurrage intacta: a migration documental só cria e protege tabelas `documentos_apresentacao*`; o domínio documental não importa a Demurrage', () => {
  const raiz = path.resolve(__dirname, '../../../..');
  const sql = fs.readFileSync(path.join(raiz, 'src/demurrage-engine/db/migrations/0104_liberacao_documentos_apresentacao.sql'), 'utf8')
    .replace(/--.*$/gm, '');
  const alvos = [
    ...sql.matchAll(/\bCREATE\s+TABLE\s+(\w+)/gi), ...sql.matchAll(/\bALTER\s+TABLE\s+(\w+)/gi), ...sql.matchAll(/\bINSERT\s+INTO\s+(\w+)/gi),
    ...sql.matchAll(/\bUPDATE\s+(\w+)\s+SET/gi), ...sql.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi), ...sql.matchAll(/\bDROP\s+\w+\s+(\w+)/gi),
    ...sql.matchAll(/\bINDEX\s+\w+\s+ON\s+(\w+)/gi), ...sql.matchAll(/\b(?:BEFORE|AFTER)\s+[\w\s]+?\s+ON\s+(\w+)/gi),
  ].map((m) => m[1]);
  assert.ok(alvos.length > 10);
  assert.deepEqual(alvos.filter((t) => !t.startsWith('documentos_apresentacao')), []);
  assert.deepEqual([...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi)].map((m) => m[1]).filter((f) => !f.startsWith('check_')), [], 'nenhuma função existente é redefinida');
  for (const pasta of ['dominio', 'aplicacao', 'pdf']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', pasta)).filter((x) => x.endsWith('.ts'))) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', pasta, f), 'utf8');
      assert.ok(!/from '[^']*demurrage-engine\/(?!db\/)/.test(fonte), `${pasta}/${f} importa a Demurrage`);
    }
  }
});

test('[DOC31-18] os quatro geradores produzem PDFs legíveis (pdf-lib e poppler): páginas do oficial, texto extraível com os dados sintéticos, página renderizada', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS_DE_DOCUMENTO) {
    const pdf = await gerarDocumento({ definicao: DEFINICOES_PROPOSTAS[tipo], conteudo: conteudoSintetico(tipo), modeloOficial: MODELOS_OFICIAIS[tipo]! });
    assert.equal((await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount(), ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].paginas, tipo);
    const texto = semEspacos(textoDoPdf(pdf));
    for (const v of [VALORES_SINTETICOS.MBL, VALORES_SINTETICOS.SIGNATARIO_NOME]) assert.ok(texto.includes(semEspacos(v)), `${tipo}: ${v}`);
    const img = renderizar(pdf, 1);
    assert.ok(img.px.some((p) => p < 128) && img.px.some((p) => p > 200), `${tipo}: página renderizada com conteúdo`);
  }
});

test('[DOC31-19] Evergreen com 7, 15 e 30 contêineres: um único PDF com todos os contêineres, na ordem', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  const tipo = 'TERMO_EVERGREEN';
  const porPagina = DEFINICOES_PROPOSTAS[tipo].layout!.relacaoAnexa!.itensPorPagina;
  for (const n of [7, 15, 30]) {
    const lista = Array.from({ length: n }, (_, i) => `TSTU${String(i + 1).padStart(7, '0')}`);
    const pdf = await gerarDocumento({
      definicao: DEFINICOES_PROPOSTAS[tipo], modeloOficial: MODELOS_OFICIAIS[tipo]!,
      conteudo: conteudoSintetico(tipo, { ...VALORES_SINTETICOS, CONTEINERES_DO_MASTER: lista.join('\n') }),
    });
    assert.equal((await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount(), 3 + Math.ceil(n / porPagina), `${n}`);
    const texto = textoDoPdf(pdf);
    const posicoes = lista.map((x) => texto.indexOf(x));
    assert.ok(posicoes.every((p, i) => p >= 0 && (i === 0 || p > posicoes[i - 1])), `${n}: todos, na ordem`);
  }
});

test('[DOC31-20] nenhum e-mail real: o ciclo completo do termo e o fluxo A rodam sem rede; o fluxo A nem toca o Outlook', async () => {
  await semRede(async () => {
    const { c } = await termoConferido();
    const r = await prepararRascunho(c.deps, ATOR, MASTER, acesso(c), { autorizacao: PERMITIDA }) as { envioId: string };
    assert.equal((await enviarPelaPriora(c.deps, ATOR, r.envioId, c.outlook)).tipo, 'ENVIO_CONFIRMADO');
    assert.equal(c.outlook.caixa.size, 1, 'a mensagem existe só no Outlook FALSO');
    for (const [tipo, codigo] of MEMORANDOS) {
      const m = await memorandoPreparado(tipo, codigo);
      assert.deepEqual(m.c.outlook.chamadas, [], tipo);
    }
  });
});
