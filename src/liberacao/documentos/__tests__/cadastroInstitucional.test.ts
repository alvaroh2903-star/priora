import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import express, { NextFunction, Response } from 'express';
import { AddressInfo } from 'net';
import { Pool } from 'pg';
import * as gemini from '../../../ai/geminiClient';
import * as graph from '../../../graph/graphService';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario, contar } from '../../../operacional/__tests__/cenario';
import { preparar } from '../../aplicacao/__tests__/apoio';
import { validaISO6346 } from '../../../auditoria/preAlerta/normalizacao';
import { CamposDocumentaisExtraidos, persistirExtracoesAuditoria } from '../../../auditoria/fatos/extracoes';
import { criarDocumentosRouter } from '../../../routes/documentosRoutes';
import { AuthedRequest } from '../../../middleware/requireAuth';
import { AcessoDaPessoa } from '../../../auth/pessoa';
import { situacaoDaAgencia } from '../../dominio';
import { armador } from '../../dominio/__tests__/l1b/fixtures';
import {
  ARQUIVOS_OFICIAIS_RECEBIDOS, CadastroInstitucional, DEFINICOES_EM_VIGOR, DEFINICOES_PROPOSTAS, DEFINICOES_REVISAO_2, DefinicaoDoModelo, DepsDocumentos,
  EventoDoSignatario, FonteDeDado, IdentidadeDoConsignatario, MOTIVO_IDENTIDADE_NAO_CONFIRMADA, ResultadoDoPreenchimento, SituacaoDoConsignatario, TipoDocumento,
  PlanoDePreenchimento, ValorInformado, ValorObservado, VersaoDoConsignatario, avaliarDocumentacao, cadastrarModelo, cadastrarModeloOficial, cadastroVigente, canonico, cnpjAlfanumericoValido, cnpjsNoTexto,
  conferirConsignatario, consignatarioNaoConfirmado, consignatarioPeloCadastro, consultarCadastroInstitucional, depsDocumentosPadrao, fatosDocumentaisParaL1b,
  geradorPdfPriora, modeloVigente, pendenciasInstitucionais, planejarPreenchimento, prepararDocumento, registrarCadastroInstitucional, registrarPoderesDoSignatario,
  registrarSignatarioLegal, revisarDefinicaoDoModelo, revogarSignatarioLegal, sha256, signatarioDaOrganizacao, signatariosVigentes, validarDadosInstitucionais,
  validarModelo, validarPoderes, validarSignatario, verificarDefinicao,
} from '..';
import { ATOR, MASTER, ORG, PODERES_SINTETICOS, SIGNATARIO_SINTETICO, arquivoSintetico, cenarioDocumental, relogio, valor } from './fixtures';
import { ESCOLHAS_SINTETICAS, MODELOS_OFICIAIS, SEM_MODELOS, SEM_POPPLER, VALORES_SINTETICOS, semEspacos, textoDoPdf } from './modelosReais';

/**
 * O1.8 + O1.9 — cadastro institucional da organização (fonte `CADASTRO_DA_ORGANIZACAO`), signatário legal (DOC-23),
 * conferência da identidade do consignatário do MBL pelo CNPJ e (14.20) o consignatário escrito pelo cadastro só com a
 * identidade confirmada. Tudo SINTÉTICO: os CNPJs e os CPFs são os de teste do repositório ou calculados aqui; nenhum
 * dado real de empresa ou pessoa. Nenhum OCR, nenhuma IA, nenhum Graph/Outlook.
 */

const url = testDatabaseUrl();

/** CNPJ sintético: 12 dígitos de base com os dois verificadores calculados. */
function cnpjSintetico(base: string): string {
  const dv = (d: string, pesos: number[]) => {
    const r = [...d].reduce((s, x, i) => s + Number(x) * pesos[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${dv(`${base}${d1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])}`;
}
/** CPF sintético: 9 dígitos de base com os dois verificadores calculados. */
function cpfSintetico(base: string): string {
  const dv = (d: string) => {
    const r = ([...d].reduce((s, x, i) => s + Number(x) * (d.length + 1 - i), 0) * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  return `${base}${d1}${dv(`${base}${d1}`)}`;
}
const mascara = (c: string) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
const CNPJ_ORG = VALORES_SINTETICOS.ORGANIZACAO_CNPJ;
const CNPJ_OUTRA = cnpjSintetico('987654320001');
const CNPJ_RUIM = `${CNPJ_ORG.slice(0, 13)}${(Number(CNPJ_ORG[13]) + 1) % 10}`;
/** CNPJ alfanumérico do exemplo público da Receita Federal (IN RFB 2.229/2024): não pertence a ninguém. */
const CNPJ_ALFA = '12ABC34501DE35';
const CPF = VALORES_SINTETICOS.SIGNATARIO_CPF;
const OUTRO_CPF = cpfSintetico('123456789');

/** Cadastro completo SINTÉTICO, com os valores de teste dos modelos reais. */
const CADASTRO_COMPLETO = {
  cnpj: mascara(CNPJ_ORG), razaoSocial: VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL, endereco: VALORES_SINTETICOS.ORGANIZACAO_ENDERECO,
  telefone: VALORES_SINTETICOS.ORGANIZACAO_TELEFONE, contatoSobreestadiaNome: VALORES_SINTETICOS.CONTATO_SOBREESTADIA_NOME,
  contatoSobreestadiaEmail: VALORES_SINTETICOS.CONTATO_SOBREESTADIA_EMAIL, emailsParaRecibo: VALORES_SINTETICOS.EMAILS_PARA_RECIBO,
};
const SIGNATARIO = { nome: VALORES_SINTETICOS.SIGNATARIO_NOME, cpf: '529.982.247-25', qualificacao: 'representante legal (sintético)', evidencia: 'documento societário sintético de teste' };

/** Consignatário como o OCR o leria, com o CNPJ da organização (o endereço do MBL não é o do cadastro). */
const CONSIGNATARIO_ORG = `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${mascara(CNPJ_ORG)}\nAVENIDA DO MBL SINTETICA, 999`;
const QUALIFICACAO_DO_CADASTRO = `${CADASTRO_COMPLETO.razaoSocial}\nCNPJ ${mascara(CNPJ_ORG)}\n${CADASTRO_COMPLETO.endereco}`;
const CONSIGNATARIO_DADOS = ['CONSIGNATARIO_RAZAO_SOCIAL', 'CONSIGNATARIO_QUALIFICACAO'];
const TIPOS: TipoDocumento[] = ['MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR', 'TERMO_EVERGREEN'];
const CODIGO: Record<TipoDocumento, string> = { TERMO_EVERGREEN: 'EVERGREEN', MEMORANDO_MSC: 'MSC', MEMORANDO_HAPAG_ROCHAMAR: 'HAPAG_LLOYD', MEMORANDO_ZIM_ROCHAMAR: 'ZIM' };

/** Registro do cadastro como o banco o devolve (sequência = ordem de gravação). */
const registro = (d: Record<string, unknown>, p: Partial<CadastroInstitucional> = {}): CadastroInstitucional => ({
  ...(validarDadosInstitucionais(d) as unknown as { dados: CadastroInstitucional }).dados, cadastroId: 'cad-1', sequencia: 1, motivo: null, registradoPor: 'm-admin',
  registradoEm: '2026-10-20T12:00:00.000Z', ...p,
});

/* -------------------------------------------- cadastro (puro) -------------------------------------------- */

test('[CI-01] cadastro institucional válido: CNPJ com ou sem máscara vira só dígitos (verificadores conferidos); textos de uma linha; e-mails conferidos', () => {
  const v = validarDadosInstitucionais({ ...CADASTRO_COMPLETO, razaoSocial: `  ${CADASTRO_COMPLETO.razaoSocial}  ` });
  assert.deepEqual(v, {
    tipo: 'VALIDO',
    dados: {
      cnpj: CNPJ_ORG, razaoSocial: CADASTRO_COMPLETO.razaoSocial, endereco: CADASTRO_COMPLETO.endereco, telefone: CADASTRO_COMPLETO.telefone,
      contatoSobreestadiaNome: CADASTRO_COMPLETO.contatoSobreestadiaNome, contatoSobreestadiaEmail: CADASTRO_COMPLETO.contatoSobreestadiaEmail,
      emailsParaRecibo: CADASTRO_COMPLETO.emailsParaRecibo,
    },
  });
  assert.equal((validarDadosInstitucionais({ cnpj: CNPJ_ORG }) as { dados: { cnpj: string } }).dados.cnpj, CNPJ_ORG, 'só dígitos também vale');
  // O CNPJ de referência informado pelo usuário é válido pelos dígitos verificadores — e é DADO do cadastro, nunca constante.
  assert.equal(validarDadosInstitucionais({ cnpj: '27.909.874/0001-12' }).tipo, 'VALIDO');
});

test('[CI-02] cadastro incompleto ou inválido: só o CNPJ é obrigatório; o resto fica faltando, nunca inventado; erro de formato é recusado com o motivo', () => {
  const so = validarDadosInstitucionais({ cnpj: CNPJ_ORG });
  assert.deepEqual(so, { tipo: 'VALIDO', dados: { cnpj: CNPJ_ORG, razaoSocial: null, endereco: null, telefone: null, contatoSobreestadiaNome: null, contatoSobreestadiaEmail: null, emailsParaRecibo: null } });
  const problemas = (e: Record<string, unknown>) => { const r = validarDadosInstitucionais(e); return r.tipo === 'INVALIDO' ? r.problemas : []; };
  assert.deepEqual(problemas({}), [{ campo: 'cnpj', motivo: 'OBRIGATORIO' }]);
  assert.deepEqual(problemas({ cnpj: mascara(CNPJ_RUIM) }), [{ campo: 'cnpj', motivo: 'CNPJ_INVALIDO' }], 'dígito verificador errado');
  assert.deepEqual(problemas({ cnpj: '11111111111111' }), [{ campo: 'cnpj', motivo: 'CNPJ_INVALIDO' }], 'dígitos repetidos');
  assert.deepEqual(problemas({ cnpj: `CNPJ ${CNPJ_ORG}` }), [{ campo: 'cnpj', motivo: 'CNPJ_INVALIDO' }], 'nada além da máscara usual');
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, endereco: 'RUA FICTICIA, 100\nSALA 1' }), [{ campo: 'endereco', motivo: 'CARACTERE_DE_CONTROLE_OU_QUEBRA' }], 'os lugares são de uma linha');
  for (const separador of [' ', ' ', '\u0085']) {
    assert.deepEqual(problemas({ cnpj: CNPJ_ORG, razaoSocial: `EMPRESA${separador}SINTETICA` }), [{ campo: 'razaoSocial', motivo: 'CARACTERE_DE_CONTROLE_OU_QUEBRA' }],
      `separador de linha U+${separador.charCodeAt(0).toString(16).padStart(4, '0')} também é quebra`);
  }
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, telefone: '   ' }), [{ campo: 'telefone', motivo: 'VAZIO' }]);
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, razaoSocial: 123 }), [{ campo: 'razaoSocial', motivo: 'NAO_E_TEXTO' }]);
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, contatoSobreestadiaEmail: 'sem-arroba' }), [{ campo: 'contatoSobreestadiaEmail', motivo: 'EMAIL_INVALIDO' }]);
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, emailsParaRecibo: 'a@exemplo.invalid; nao-e-email' }), [{ campo: 'emailsParaRecibo', motivo: 'EMAIL_INVALIDO' }]);
});

test('[CI-02b] o que falta cadastrar, por modelo (revisão em vigor): os campos que cada modelo pede do cadastro, inclusive o consignatário; signatário e poderes só onde o modelo os usa', () => {
  const defs = TIPOS.map((t) => DEFINICOES_EM_VIGOR[t]);
  const resumo = (cad: CadastroInstitucional | null, sig: ReturnType<typeof signatariosVigentes>) =>
    pendenciasInstitucionais(defs, cad, sig, '2026-10-20').map((p) => [p.tipo, p.faltam.map((f) => f.campo), p.signatario, p.poderes]);
  assert.deepEqual(resumo(registro({ cnpj: CNPJ_ORG }), []), [
    ['MEMORANDO_MSC', ['CONSIGNATARIO'], 'SEM_CADASTRO_VALIDADO', null],
    ['MEMORANDO_HAPAG_ROCHAMAR', ['EXPORTADOR_IMPORTADOR', 'EMPRESA', 'TELEFONE'], 'SEM_CADASTRO_VALIDADO', 'NAO_COMPROVADOS'],
    ['MEMORANDO_ZIM_ROCHAMAR', ['EXPORTADOR_IMPORTADOR', 'EMPRESA', 'TELEFONE'], 'SEM_CADASTRO_VALIDADO', 'NAO_COMPROVADOS'],
    ['TERMO_EVERGREEN', ['CONSIGNATARIO', 'EMPRESA_DAS_FATURAS', 'ENDERECO_DAS_FATURAS', 'CONTATO_SOBREESTADIA', 'EMAIL_DO_RESPONSAVEL', 'EMAILS_PARA_RECIBO', 'EMPRESA_SIGNATARIA'], 'SEM_CADASTRO_VALIDADO', 'NAO_COMPROVADOS'],
  ]);
  // A qualificação do termo precisa de razão social E endereço: só a razão social não basta.
  const semEndereco = resumo(registro({ cnpj: CNPJ_ORG, razaoSocial: CADASTRO_COMPLETO.razaoSocial }), []);
  assert.deepEqual([semEndereco[0][1], (semEndereco[3][1] as string[]).includes('CONSIGNATARIO')], [[], true]);
  const eventos = [evento('e1', 's1', 'CADASTRADO', '2026-10-20T10:00:00.000Z'), evento('e2', 's1', 'PODERES_COMPROVADOS', '2026-10-20T10:05:00.000Z', { refereCadastroId: 'e1' })];
  assert.deepEqual(resumo(registro(CADASTRO_COMPLETO), signatariosVigentes(eventos, '2026-10-20T12:00:00.000Z')), [
    ['MEMORANDO_MSC', [], 'DEFINIDO', null], ['MEMORANDO_HAPAG_ROCHAMAR', [], 'DEFINIDO', 'COMPROVADOS'],
    ['MEMORANDO_ZIM_ROCHAMAR', [], 'DEFINIDO', 'COMPROVADOS'], ['TERMO_EVERGREEN', [], 'DEFINIDO', 'COMPROVADOS'],
  ], 'um cadastro só serve aos quatro modelos');
  // Vale o registro GRAVADO POR ÚLTIMO (sequência do banco, que serializa e não deixa o instante voltar); o histórico fica.
  const antigo = registro({ cnpj: CNPJ_ORG }, { cadastroId: 'c1', sequencia: 1, registradoEm: '2026-10-20T10:00:00.000Z' });
  const novo = registro(CADASTRO_COMPLETO, { cadastroId: 'c2', sequencia: 2, registradoEm: '2026-10-20T11:00:00.000Z' });
  assert.equal(cadastroVigente([antigo, novo])?.cadastroId, 'c2');
  assert.equal(cadastroVigente([novo, antigo])?.cadastroId, 'c2', 'a ordem de leitura não importa');
  assert.equal(cadastroVigente([{ ...antigo, registradoEm: novo.registradoEm }, novo])?.cadastroId, 'c2', 'no mesmo instante, a sequência decide');
  assert.equal(cadastroVigente([{ ...antigo, cadastroId: 'zz' }, novo])?.cadastroId, 'c2', 'nunca o identificador aleatório');
  assert.equal(cadastroVigente([{ ...antigo, cadastroId: 'zz', registradoEm: novo.registradoEm }, novo])?.cadastroId, 'c2',
    'no mesmo instante, o gravado depois vale, mesmo com identificador menor');
  assert.equal(cadastroVigente([]), null);
  // Revisão 1 (preservada): o consignatário não vem do cadastro e não aparece como falta dele.
  assert.deepEqual(pendenciasInstitucionais([DEFINICOES_PROPOSTAS.MEMORANDO_MSC], registro({ cnpj: CNPJ_ORG }), [], '2026-10-20')[0].faltam, []);
});

/** Evento sintético do registro do signatário (a sequência segue a ordem de criação). */
let sequencia = 0;
function evento(eventoId: string, signatarioId: string, tipo: EventoDoSignatario['evento'], em: string, p: Partial<EventoDoSignatario> = {}): EventoDoSignatario {
  const dados = tipo === 'CADASTRADO' ? { nome: SIGNATARIO.nome, cpf: CPF, qualificacao: SIGNATARIO.qualificacao, evidencia: SIGNATARIO.evidencia } : { nome: null, cpf: null, qualificacao: null, evidencia: tipo === 'PODERES_COMPROVADOS' ? 'procuração sintética' : null };
  return {
    eventoId, sequencia: ++sequencia, signatarioId, evento: tipo, ...dados, poderesValidoAte: null, refereCadastroId: null, motivo: tipo === 'REVOGADO' ? 'saiu (sintético)' : null,
    registradoPor: 'm-admin', registradoEm: em, ...p,
  };
}

test('[CI-03] signatário legal (DOC-23): dados validados, correção por novo registro, poderes só com evidência, revogação definitiva, nunca dois presumidos', () => {
  assert.deepEqual(validarSignatario(SIGNATARIO), { tipo: 'VALIDO', dados: { ...SIGNATARIO, cpf: CPF } });
  const problemas = (e: Record<string, unknown>) => { const r = validarSignatario(e); return r.tipo === 'INVALIDO' ? r.problemas.map((p) => `${p.campo}:${p.motivo}`) : []; };
  assert.deepEqual(problemas({ ...SIGNATARIO, cpf: '529.982.247-24' }), ['cpf:CPF_INVALIDO']);
  assert.deepEqual(problemas({ ...SIGNATARIO, cpf: '111.111.111-11' }), ['cpf:CPF_INVALIDO'], 'dígitos repetidos');
  assert.deepEqual(problemas({ ...SIGNATARIO, evidencia: undefined }), ['evidencia:OBRIGATORIO'], 'sem evidência não há cadastro');
  assert.deepEqual(validarPoderes({ evidencia: 'procuração sintética', validoAte: '2028-02-29' }), { tipo: 'VALIDO', dados: { evidencia: 'procuração sintética', validoAte: '2028-02-29' } });
  assert.equal(validarPoderes({ evidencia: 'x', validoAte: '2027-02-29' }).tipo, 'INVALIDO', 'data inexistente');
  assert.equal(validarPoderes({ validoAte: '2028-01-01' }).tipo, 'INVALIDO', 'poderes nunca sem evidência');

  const eventos = [
    evento('e1', 'a', 'CADASTRADO', '2026-10-01T10:00:00.000Z'),
    evento('e2', 'b', 'CADASTRADO', '2026-10-01T11:00:00.000Z', { nome: 'OUTRO SIGNATARIO SINTETICO' }),
    evento('e3', 'a', 'CADASTRADO', '2026-10-02T10:00:00.000Z', { qualificacao: 'administrador (sintético)' }),
    evento('e4', 'a', 'PODERES_COMPROVADOS', '2026-10-03T10:00:00.000Z', { poderesValidoAte: '2026-12-31', refereCadastroId: 'e3' }),
    evento('e5', 'b', 'REVOGADO', '2026-10-04T10:00:00.000Z'),
  ];
  const em = (t: string) => signatariosVigentes(eventos, t);
  assert.deepEqual(signatarioDaOrganizacao(em('2026-10-01T12:00:00.000Z')), { tipo: 'MAIS_DE_UM_CADASTRO_VIGENTE', signatarioIds: ['a', 'b'] }, 'dois vigentes: nada é presumido');
  assert.equal(em('2026-10-02T12:00:00.000Z').find((s) => s.signatarioId === 'a')!.qualificacao, 'administrador (sintético)', 'a correção vale a partir dela');
  assert.equal(em('2026-10-01T12:00:00.000Z').find((s) => s.signatarioId === 'a')!.qualificacao, SIGNATARIO.qualificacao, 'o histórico continua respondendo');
  const depois = em('2026-10-05T00:00:00.000Z');
  assert.deepEqual(depois.map((s) => s.signatarioId), ['a'], 'o revogado sai');
  assert.deepEqual(depois[0].poderes && [depois[0].poderes.validoAte, depois[0].poderes.evidencia.ref], ['2026-12-31', 'signatario_legal_poderes:e4']);
  assert.deepEqual(depois[0].cadastro, { evidencia: { fonte: 'cadastro_institucional', ref: 'signatario_legal:e3' }, validadoPor: 'm-admin', validadoEm: '2026-10-02T10:00:00.000Z' });
  assert.equal(em('2026-09-30T00:00:00.000Z').length, 0, 'antes do cadastro: nada');
});

test('[CI-03b] proveniência dos poderes (O1.9): a correção do cadastro que troca a pessoa NÃO herda os poderes comprovados da anterior; sem poderes = não comprovados', () => {
  const eventos = [
    evento('p1', 'a', 'CADASTRADO', '2026-10-01T10:00:00.000Z'),
    evento('p2', 'a', 'PODERES_COMPROVADOS', '2026-10-01T11:00:00.000Z', { refereCadastroId: 'p1' }),
    evento('p3', 'a', 'CADASTRADO', '2026-10-02T10:00:00.000Z', { nome: 'OUTRA PESSOA SINTETICA', cpf: OUTRO_CPF }),
    evento('p4', 'a', 'PODERES_COMPROVADOS', '2026-10-03T10:00:00.000Z', { refereCadastroId: 'p3', poderesValidoAte: '2027-01-31' }),
  ];
  const em = (t: string) => signatariosVigentes(eventos, t)[0];
  assert.equal(em('2026-10-01T12:00:00.000Z').poderes?.evidencia.ref, 'signatario_legal_poderes:p2', 'poderes da pessoa cadastrada');
  const trocada = em('2026-10-02T12:00:00.000Z');
  assert.deepEqual([trocada.nome, trocada.cpf, trocada.poderes], ['OUTRA PESSOA SINTETICA', OUTRO_CPF, null], 'outra pessoa: poderes não comprovados');
  assert.deepEqual(pendenciasInstitucionais([DEFINICOES_EM_VIGOR.MEMORANDO_HAPAG_ROCHAMAR], registro(CADASTRO_COMPLETO), [trocada], '2026-10-02')[0].poderes, 'NAO_COMPROVADOS');
  assert.equal(em('2026-10-04T00:00:00.000Z').poderes?.evidencia.ref, 'signatario_legal_poderes:p4', 'comprovados de novo, para os dados novos');
  // Uma comprovação que aponta outro cadastro (de outro signatário, ou antigo) nunca vale.
  const cruzado = [evento('x1', 'a', 'CADASTRADO', '2026-10-01T10:00:00.000Z'), evento('x2', 'b', 'CADASTRADO', '2026-10-01T10:00:00.000Z'),
    evento('x3', 'a', 'PODERES_COMPROVADOS', '2026-10-01T11:00:00.000Z', { refereCadastroId: 'x2' })];
  assert.equal(signatariosVigentes(cruzado, '2026-10-02T00:00:00.000Z').find((s) => s.signatarioId === 'a')!.poderes, null);
});

/* ---------------------------------- identidade do consignatário (puro) ---------------------------------- */

const versao = (extracaoId: string, texto: string | null, arquivoSha256: string | null = `sha-${extracaoId}`): VersaoDoConsignatario => ({
  extracaoId, arquivoSha256, textoOriginal: texto,
  estado: texto === null ? { tipo: 'AUSENTE', motivo: 'NAO_LIDO' } : { tipo: 'PRESENTE', valor: texto.trim() },
});
const igual = (...textos: string[]): SituacaoDoConsignatario => ({ tipo: 'IGUAL', valores: [...new Set(textos)] });
const CAD = { cadastroId: 'cad-1', cnpj: CNPJ_ORG };
const conferir = (situacao: SituacaoDoConsignatario, textos: Array<string | null>, cadastro: typeof CAD | null = CAD): IdentidadeDoConsignatario =>
  conferirConsignatario({ situacao, versoes: textos.map((t, i) => versao(`v${i + 1}`, t)) }, cadastro);
const conferirVersoes = (situacao: SituacaoDoConsignatario, versoes: VersaoDoConsignatario[], cadastro: typeof CAD | null = CAD) => conferirConsignatario({ situacao, versoes }, cadastro);
const motivo = (r: IdentidadeDoConsignatario) => (r.tipo === 'EXCECAO' ? r.motivo : r.tipo);

test('[CI-04] CNPJs no texto: com ou sem máscara, inteiros; o número cortado, quebrado, colado a outro dígito ou dentro de número maior não é lido como CNPJ', () => {
  assert.deepEqual(cnpjsNoTexto(`EMPRESA SINTETICA\nCNPJ: ${mascara(CNPJ_ORG)}`), { validos: [CNPJ_ORG], invalidos: [], citaCnpj: true });
  assert.deepEqual(cnpjsNoTexto(`EMPRESA SINTETICA ${CNPJ_ORG}`), { validos: [CNPJ_ORG], invalidos: [], citaCnpj: false });
  assert.deepEqual(cnpjsNoTexto(`C.N.P.J. ${mascara(CNPJ_RUIM)}`), { validos: [], invalidos: [CNPJ_RUIM], citaCnpj: true });
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${mascara(CNPJ_ORG).slice(0, 15)}\n${mascara(CNPJ_ORG).slice(15)}`).validos, [], 'quebrado entre linhas');
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${mascara(CNPJ_ORG).slice(0, -1)}`).validos, [], 'cortado');
  assert.deepEqual(cnpjsNoTexto(`REF 9${CNPJ_ORG}`).validos, [], 'colado a outro dígito: não é um CNPJ');
  const m = mascara(CNPJ_ORG);
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${m.slice(0, 7)}\n${m.slice(7)}`).validos, [], 'quebra de linha entre grupos de dígitos');
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${m.slice(0, 11)} ${m.slice(11)}`).validos, [], 'espaço dentro do número');
  // O1.9 (R4): dentro de um número maior, ligado por separador, não é um CNPJ.
  assert.deepEqual(cnpjsNoTexto(`REF 1.${m}`), { validos: [], invalidos: [], citaCnpj: false }, 'precedido de dígito e separador');
  assert.deepEqual(cnpjsNoTexto(`REF ${m}-3`).validos, [], 'seguido de separador e dígito');
  assert.deepEqual(cnpjsNoTexto(`REF ${m}/0`).validos, [], 'seguido de barra e dígito');
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${m}.`).validos, [CNPJ_ORG], 'ponto final da frase não muda nada');
  assert.deepEqual(cnpjsNoTexto(`CNPJ${CNPJ_ORG} LTDA`).validos, [CNPJ_ORG], 'letra colada não é dígito');
});

test('[CI-04b] CNPJ alfanumérico (IN RFB 2.229/2024): reconhecido com os verificadores; um segundo CNPJ alfanumérico nunca é ignorado (antes, a identidade verificava)', () => {
  assert.equal(cnpjAlfanumericoValido(CNPJ_ALFA), true, 'exemplo público: 12.ABC.345/01DE-35');
  assert.equal(cnpjAlfanumericoValido('12ABC34501DE36'), false, 'verificador errado');
  assert.equal(cnpjAlfanumericoValido('12abc34501de35'), false, 'só letra maiúscula');
  assert.equal(cnpjAlfanumericoValido(CNPJ_ORG), false, 'sem letra é o numérico (outra regra)');
  assert.deepEqual(cnpjsNoTexto('CNPJ 12.ABC.345/01DE-35').validos, [CNPJ_ALFA]);
  assert.deepEqual(cnpjsNoTexto('CNPJ 12ABC34501DE35').validos, [CNPJ_ALFA], 'sem a máscara');
  assert.deepEqual(cnpjsNoTexto('CNPJ 12.ABC.345/01DE-36'), { validos: [], invalidos: ['12ABC34501DE36'], citaCnpj: true }, 'com a máscara completa, inválido conta');
  const codigo = 'ZIMUSNH1234567';
  assert.equal(cnpjAlfanumericoValido(codigo), false);
  assert.deepEqual(cnpjsNoTexto(`BL ${codigo}`), { validos: [], invalidos: [], citaCnpj: false }, 'um código qualquer de 14 posições sem a máscara não vira CNPJ');
  const comAlfa = `${CONSIGNATARIO_ORG}\nA/C CNPJ 12.ABC.345/01DE-35`;
  assert.equal(motivo(conferir(igual(comAlfa), [comAlfa])), 'MULTIPLOS_CNPJS', 'o 2º CNPJ (alfanumérico) não passa despercebido');
  const soAlfa = `EMPRESA SINTETICA\nCNPJ 12.ABC.345/01DE-35`;
  assert.deepEqual([motivo(conferir(igual(soAlfa), [soAlfa])), (conferir(igual(soAlfa), [soAlfa]) as { cnpjsEncontrados: string[] }).cnpjsEncontrados], ['CNPJ_DIVERGENTE', [CNPJ_ALFA]]);
});

test('[CI-05] CNPJ correspondente: só o CNPJ válido, igual ao do cadastro e o mesmo em todas as versões verifica; texto original e proveniência preservados', () => {
  const r = conferir(igual(CONSIGNATARIO_ORG), [CONSIGNATARIO_ORG, CONSIGNATARIO_ORG]);
  assert.equal(r.tipo, 'VERIFICADA');
  assert.deepEqual([r.tipo === 'VERIFICADA' && r.cnpj, r.situacaoDoTexto], [CNPJ_ORG, 'IGUAL']);
  assert.deepEqual(r.evidencias,
    [{ fonte: 'auditoria', ref: 'auditoria_extracao:v1' }, { fonte: 'auditoria', ref: 'auditoria_extracao:v2' }, { fonte: 'cadastro_institucional', ref: 'cadastro_institucional:cad-1#cnpj' }]);
  assert.deepEqual(r.versoes.map((v) => [v.extracaoId, v.arquivoSha256, v.conclusao, v.textoOriginal]),
    [['v1', 'sha-v1', { tipo: 'CNPJ', cnpj: CNPJ_ORG }, CONSIGNATARIO_ORG], ['v2', 'sha-v2', { tipo: 'CNPJ', cnpj: CNPJ_ORG }, CONSIGNATARIO_ORG]], 'o texto como a Auditoria o persistiu');
  assert.equal(motivo(conferir(igual(`${CONSIGNATARIO_ORG}\nCNPJ ${CNPJ_ORG}`), [`${CONSIGNATARIO_ORG}\nCNPJ ${CNPJ_ORG}`])), 'VERIFICADA', 'o mesmo CNPJ escrito duas vezes é um só');
  assert.ok(!JSON.stringify(r).includes(VALORES_SINTETICOS.ORGANIZACAO_ENDERECO), 'a conferência não traz dado do cadastro: só o CNPJ comparado');
});

test('[CI-06] CNPJ divergente, ausente, inválido, ilegível ou múltiplo: exceção documental com o motivo; nome igual nunca prova nada', () => {
  const texto = (cnpj: string) => `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${cnpj}`;
  const divergente = conferir(igual(texto(mascara(CNPJ_OUTRA))), [texto(mascara(CNPJ_OUTRA))]);
  assert.deepEqual([motivo(divergente), (divergente as { cnpjsEncontrados: string[] }).cnpjsEncontrados], ['CNPJ_DIVERGENTE', [CNPJ_OUTRA]], 'outra empresa, mesmo com o nome da organização');
  assert.ok(divergente.evidencias.some((e) => e.ref === 'cadastro_institucional:cad-1#cnpj'), 'a exceção traz o registro comparado');
  const semCnpj = VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL;
  assert.equal(motivo(conferir(igual(semCnpj), [semCnpj])), 'CNPJ_AUSENTE', 'o nome exato da organização sem CNPJ não verifica');
  assert.equal(motivo(conferir(igual(texto(mascara(CNPJ_RUIM))), [texto(mascara(CNPJ_RUIM))])), 'CNPJ_INVALIDO');
  for (const corte of [7, 10, 11]) {
    const quebrado = `${semCnpj}\nCNPJ ${mascara(CNPJ_ORG).slice(0, corte)}\n${mascara(CNPJ_ORG).slice(corte)}`;
    assert.equal(motivo(conferir(igual(quebrado), [quebrado])), 'CNPJ_ILEGIVEL', `cita CNPJ, mas o número não está inteiro (quebra na posição ${corte})`);
  }
  const dois = `${texto(mascara(CNPJ_ORG))}\nCNPJ ${mascara(CNPJ_OUTRA)}`;
  assert.equal(motivo(conferir(igual(dois), [dois])), 'MULTIPLOS_CNPJS', 'dois CNPJs válidos: nenhum é escolhido');
  const validoEInvalido = `${texto(mascara(CNPJ_ORG))} / ${mascara(CNPJ_RUIM)}`;
  assert.equal(motivo(conferir(igual(validoEInvalido), [validoEInvalido])), 'MULTIPLOS_CNPJS');
  assert.equal(motivo(conferir(igual(CONSIGNATARIO_ORG), [CONSIGNATARIO_ORG], null)), 'CADASTRO_INSTITUCIONAL_AUSENTE', 'sem cadastro, nada se presume');
  assert.equal(motivo(conferir({ tipo: 'SEM_VINCULO_DOCUMENTAL' }, [])), 'SEM_VINCULO_DOCUMENTAL');
  assert.equal(motivo(conferir({ tipo: 'AUSENTE' }, [null])), 'CONSIGNATARIO_AUSENTE');
  assert.equal(motivo(conferir({ tipo: 'NAO_UTILIZAVEL', motivos: ['DOCUMENTO_ILEGIVEL'] }, [])), 'CONSIGNATARIO_ILEGIVEL');
});

test('[CI-07] versões do MBL (O1.9): cópia do mesmo arquivo, diferença só de formatação e texto diferente com o mesmo CNPJ verificam; conclusões diferentes nunca se resolvem pela chegada', () => {
  // Diferença só de formatação (E1: SO_FORMATACAO).
  const crlf = CONSIGNATARIO_ORG.replace(/\n/g, '\r\n');
  const so = conferir({ tipo: 'SO_FORMATACAO', valores: [CONSIGNATARIO_ORG, crlf] }, [CONSIGNATARIO_ORG, crlf]);
  assert.deepEqual([motivo(so), so.situacaoDoTexto], ['VERIFICADA', 'SO_FORMATACAO']);
  // R7: o TEXTO diverge (outro endereço, outra quebra de linha), mas o CNPJ é o mesmo: não é conflito de identidade (antes, VERSOES_DIVERGENTES).
  const outroEndereco = CONSIGNATARIO_ORG.replace('999', '888');
  const outraQuebra = CONSIGNATARIO_ORG.replace(' LTDA', '\nLTDA');
  const texto = conferir({ tipo: 'DIVERGENTE', valores: [CONSIGNATARIO_ORG, outroEndereco, outraQuebra] }, [CONSIGNATARIO_ORG, outroEndereco, outraQuebra]);
  assert.deepEqual([motivo(texto), texto.situacaoDoTexto], ['VERIFICADA', 'DIVERGENTE'], 'a divergência do texto fica registrada; a identidade é a mesma');
  assert.deepEqual(texto.versoes.map((v) => v.textoOriginal), [CONSIGNATARIO_ORG, outroEndereco, outraQuebra], 'nenhum texto é escolhido nem descartado');
  // Duplicatas: o mesmo arquivo (mesmo SHA-256) recebido em duas mensagens.
  const dup = conferirVersoes(igual(CONSIGNATARIO_ORG), [versao('m1', CONSIGNATARIO_ORG, 'sha-x'), versao('m2', CONSIGNATARIO_ORG, 'sha-x')]);
  assert.deepEqual([motivo(dup), dup.evidencias.filter((e) => e.fonte === 'auditoria').length], ['VERIFICADA', 2], 'as duas origens ficam');
  // Arquivos diferentes com CNPJs diferentes: exceção, nas duas ordens de chegada (o último não vale mais).
  const outra = `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${mascara(CNPJ_OUTRA)}`;
  for (const ordem of [[CONSIGNATARIO_ORG, outra], [outra, CONSIGNATARIO_ORG]]) {
    const r = conferir({ tipo: 'DIVERGENTE', valores: ordem }, ordem);
    assert.deepEqual([motivo(r), (r as { cnpjsEncontrados: string[] }).cnpjsEncontrados.sort()], ['VERSOES_DIVERGENTES', [CNPJ_ORG, CNPJ_OUTRA].sort()]);
  }
  // Uma versão com o CNPJ e outra (outro arquivo) sem nenhum: evidência insuficiente, exceção.
  const semCnpj = VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL;
  assert.equal(motivo(conferir({ tipo: 'DIVERGENTE', valores: [CONSIGNATARIO_ORG, semCnpj] }, [CONSIGNATARIO_ORG, semCnpj])), 'VERSOES_DIVERGENTES');
  // O MESMO arquivo lido duas vezes (outra versão do extrator) com conclusões diferentes.
  const cortado = `${semCnpj}\nCNPJ ${mascara(CNPJ_ORG).slice(0, 10)}`;
  const releitura = conferirVersoes({ tipo: 'DIVERGENTE', valores: [CONSIGNATARIO_ORG, cortado] }, [versao('r1', CONSIGNATARIO_ORG, 'sha-y'), versao('r2', cortado, 'sha-y')]);
  assert.equal(motivo(releitura), 'LEITURAS_DIVERGENTES_DO_MESMO_ARQUIVO');
  // Sem o hash do arquivo, não se prova que é o mesmo documento.
  assert.equal(motivo(conferirVersoes({ tipo: 'DIVERGENTE', valores: [CONSIGNATARIO_ORG, cortado] }, [versao('n1', CONSIGNATARIO_ORG, null), versao('n2', cortado, null)])), 'VERSOES_DIVERGENTES');
  // Versão sem o consignatário lido, anterior à 0106 ou ilegível não contribui (E1/14.18) — e fica no resultado.
  const naoContribuem: VersaoDoConsignatario[] = [
    versao('a1', CONSIGNATARIO_ORG), versao('a2', null),
    { extracaoId: 'a3', arquivoSha256: null, textoOriginal: null, estado: { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' } },
    { extracaoId: 'a4', arquivoSha256: 'sha-a4', textoOriginal: null, estado: { tipo: 'NAO_UTILIZAVEL', motivo: 'DOCUMENTO_ILEGIVEL' } },
  ];
  const r = conferirVersoes(igual(CONSIGNATARIO_ORG), naoContribuem);
  assert.equal(motivo(r), 'VERIFICADA');
  assert.deepEqual(r.versoes.map((v) => v.conclusao.tipo === 'NAO_CONTRIBUI' ? v.conclusao.motivo : v.conclusao.tipo), ['CNPJ', 'CONSIGNATARIO_NAO_LIDO', 'NAO_PRESERVADO', 'DOCUMENTO_ILEGIVEL']);
  assert.deepEqual(r.evidencias.map((e) => e.ref), ['auditoria_extracao:a1', 'cadastro_institucional:cad-1#cnpj'], 'confirmam só as versões que trazem o consignatário');
});

/* ----------------------------- consignatário escrito pelo cadastro (14.20, puro) ----------------------------- */

const CADASTRO = registro(CADASTRO_COMPLETO);
const VERIFICADA = conferir(igual(CONSIGNATARIO_ORG), [CONSIGNATARIO_ORG]);
const DIVERGENTE = conferir(igual(`X\nCNPJ ${mascara(CNPJ_OUTRA)}`), [`X\nCNPJ ${mascara(CNPJ_OUTRA)}`]);

test('[CI-21] o cadastro preenche, a Auditoria confirma: valores do cadastro com a confirmação; nenhum valor atribuído à Auditoria; nada sem a identidade', () => {
  const v = consignatarioPeloCadastro(CADASTRO, VERIFICADA, CONSIGNATARIO_DADOS, MASTER);
  assert.deepEqual(v.map((x) => [x.dado, x.valor]), [['CONSIGNATARIO_RAZAO_SOCIAL', CADASTRO_COMPLETO.razaoSocial], ['CONSIGNATARIO_QUALIFICACAO', QUALIFICACAO_DO_CADASTRO]],
    'razão social numa linha; a qualificação do termo: razão social, CNPJ e endereço, uma informação por linha (o bloco do exemplo oficial)');
  for (const x of v) {
    assert.deepEqual([x.fonte, x.evidencia.fonte, x.escopo], ['CADASTRO_DA_ORGANIZACAO', 'cadastro_institucional', { tipo: 'MASTER', masterId: MASTER }]);
    assert.match(x.evidencia.ref, /^cadastro_institucional:cad-1#/);
    assert.deepEqual(x.confirmacao, { tipo: 'IDENTIDADE_DO_CONSIGNATARIO_NO_MBL', evidencias: VERIFICADA.evidencias });
    assert.notEqual(x.fonte as FonteDeDado, 'S2_AUDITORIA', 'o valor nunca é atribuído à Auditoria');
  }
  assert.ok(!v.some((x) => x.valor.includes('AVENIDA DO MBL SINTETICA')), 'o texto do MBL nunca é copiado');
  assert.deepEqual(consignatarioNaoConfirmado(VERIFICADA, CONSIGNATARIO_DADOS, MASTER, '2026-10-20T12:00:00.000Z'), []);
  // Sem a identidade: nada escrito; o motivo, a causa e as evidências da exceção.
  assert.deepEqual(consignatarioPeloCadastro(CADASTRO, DIVERGENTE, CONSIGNATARIO_DADOS, MASTER), [], 'o consignatário nunca é trocado em silêncio');
  const np = consignatarioNaoConfirmado(DIVERGENTE, CONSIGNATARIO_DADOS, MASTER, '2026-10-20T12:00:00.000Z');
  assert.deepEqual(np.map((n) => [n.dado, n.fonte, n.motivo, n.causa]), CONSIGNATARIO_DADOS.map((d) => [d, 'CADASTRO_DA_ORGANIZACAO', MOTIVO_IDENTIDADE_NAO_CONFIRMADA, 'CNPJ_DIVERGENTE']));
  assert.deepEqual(np[0].evidencias, DIVERGENTE.evidencias);
  // Cadastro incompleto: o que não está cadastrado falta (nada é inventado).
  const semEndereco = registro({ cnpj: CNPJ_ORG, razaoSocial: CADASTRO_COMPLETO.razaoSocial });
  assert.deepEqual(consignatarioPeloCadastro(semEndereco, VERIFICADA, CONSIGNATARIO_DADOS, MASTER).map((x) => x.dado), ['CONSIGNATARIO_RAZAO_SOCIAL']);
  assert.deepEqual(consignatarioPeloCadastro(registro({ cnpj: CNPJ_ORG }), VERIFICADA, CONSIGNATARIO_DADOS, MASTER), []);
  // A confirmação é do CNPJ comparado: um cadastro trocado depois (outro CNPJ) não herda a confirmação.
  assert.deepEqual(consignatarioPeloCadastro(registro({ ...CADASTRO_COMPLETO, cnpj: mascara(CNPJ_OUTRA) }), VERIFICADA, CONSIGNATARIO_DADOS, MASTER), []);
  assert.deepEqual(consignatarioPeloCadastro(null, VERIFICADA, CONSIGNATARIO_DADOS, MASTER), []);
  // Só os dados do consignatário: os demais institucionais seguem pelo caminho de sempre.
  assert.deepEqual(consignatarioPeloCadastro(CADASTRO, VERIFICADA, ['ORGANIZACAO_RAZAO_SOCIAL'], MASTER), []);
});

const emUso = (definicao: DefinicaoDoModelo) => ({ modeloId: 'mod-1', versao: 'v', arquivoSha256: 'f'.repeat(64), definicao });
const CTX = { masterId: MASTER, processoIds: ['IM100'], modalidade: { tipo: 'DESCONHECIDA' as const }, signatario: null };

test('[CI-22] o preenchimento exige a confirmação (14.20): sem ela, ou só com evidência do próprio cadastro, recusa; S2, HEADCARGO ou o Analista nunca preenchem o consignatário', () => {
  const def = DEFINICOES_EM_VIGOR.MEMORANDO_MSC;
  const [razao] = consignatarioPeloCadastro(CADASTRO, VERIFICADA, CONSIGNATARIO_DADOS, MASTER);
  const recusa = (v: ValorObservado) => {
    const r = planejarPreenchimento(emUso(def), [v], [], CTX);
    return r.recusados.find((x) => x.valor === v)?.motivo ?? null;
  };
  assert.equal(recusa(razao), null);
  const { confirmacao: _c, ...semConfirmacao } = razao;
  assert.equal(recusa(semConfirmacao), 'SEM_CONFIRMACAO_DOCUMENTAL');
  assert.equal(recusa({ ...razao, confirmacao: { tipo: 'IDENTIDADE_DO_CONSIGNATARIO_NO_MBL', evidencias: [{ fonte: 'cadastro_institucional', ref: 'cadastro_institucional:cad-1#cnpj' }] } }),
    'SEM_CONFIRMACAO_DOCUMENTAL', 'a confirmação precisa de evidência documental da Auditoria');
  assert.equal(recusa({ ...razao, escopo: { tipo: 'MASTER', masterId: 'OUTRO' } }), 'OUTRO_MASTER', 'a confirmação é deste Master');
  assert.equal(recusa(valor('CONSIGNATARIO_RAZAO_SOCIAL', 'TEXTO DO MBL', 'S2_AUDITORIA', { tipo: 'MASTER', masterId: MASTER })), 'FONTE_NAO_ACEITA', 'o texto do MBL não é mais fonte');
  assert.equal(recusa(valor('CONSIGNATARIO_RAZAO_SOCIAL', 'EMPRESA DE OUTRA FONTE', 'HEADCARGO', { tipo: 'MASTER', masterId: MASTER })), 'FONTE_NAO_ACEITA');
  const digitado: ValorInformado = { dado: 'CONSIGNATARIO_RAZAO_SOCIAL', valor: 'DIGITADO PELO ANALISTA', por: 'm-analista', em: '2026-10-20T12:00:00.000Z' };
  const r = planejarPreenchimento(emUso(def), [razao], [], CTX, [], [digitado]);
  assert.ok(r.tipo === 'INCOMPLETO' && r.resolvidos.campos.find((c) => c.campo === 'CONSIGNATARIO')?.valor === CADASTRO_COMPLETO.razaoSocial, 'o informado não entra');
  // Proveniência dupla no plano: origem = cadastro; confirmação = versões do MBL e CNPJ comparado.
  const evergreen = planejarPreenchimento(emUso(DEFINICOES_EM_VIGOR.TERMO_EVERGREEN), consignatarioPeloCadastro(CADASTRO, VERIFICADA, CONSIGNATARIO_DADOS, MASTER), [], CTX);
  assert.ok(evergreen.tipo === 'INCOMPLETO');
  assert.equal(evergreen.resolvidos.campos.find((c) => c.campo === 'CONSIGNATARIO')?.valor, QUALIFICACAO_DO_CADASTRO);
});

/** Hash canônico da revisão 2 das definições (decisão 14.20): qualquer mudança nela é uma revisão nova. */
const REVISAO_2_SHA256 = '792a60102efb0027c6766e58516de0038d021b911ad9dcef055a171eea35d83e';

test('[CI-08] definições versionadas: a revisão 1 fica exatamente como era; a revisão 2 muda SÓ a fonte dos quatro campos do consignatário, com a confirmação', () => {
  const h = (v: unknown) => createHash('sha256').update(canonico(v)).digest('hex');
  assert.equal(h(DEFINICOES_PROPOSTAS), 'c2d1678a90b8e1d7fe6db72bb1a36f5d62aae6c2f84155cf8298240842a677e5', 'revisão 1: nenhum campo, fonte, layout, opção ou texto fixo mudou');
  assert.equal(h(ARQUIVOS_OFICIAIS_RECEBIDOS), 'c2c0cc52afa3b5209b5f283eb97428fd1ed51ba18371fb60dae321f08f024514');
  assert.equal(h(DEFINICOES_REVISAO_2), REVISAO_2_SHA256, 'revisão 2 fixada');
  assert.equal(DEFINICOES_EM_VIGOR, DEFINICOES_REVISAO_2);
  for (const t of TIPOS) {
    const r1 = DEFINICOES_PROPOSTAS[t];
    const r2 = DEFINICOES_REVISAO_2[t];
    assert.ok(r1.campos.filter((c) => CONSIGNATARIO_DADOS.includes(c.dado)).every((c) => c.fontesAceitas.join() === 'S2_AUDITORIA'), `${t}: r1 só S2 (DOC-17)`);
    const mudaram = r2.campos.filter((c, i) => canonico(c) !== canonico(r1.campos[i])).map((c) => c.id);
    assert.deepEqual(mudaram, r1.campos.filter((c) => CONSIGNATARIO_DADOS.includes(c.dado)).map((c) => c.id), `${t}: só o consignatário muda`);
    for (const c of r2.campos.filter((x) => CONSIGNATARIO_DADOS.includes(x.dado))) {
      assert.deepEqual([c.fontesAceitas, c.confirmacao?.tipo, c.escopo, c.obrigatorio], [['CADASTRO_DA_ORGANIZACAO'], 'IDENTIDADE_DO_CONSIGNATARIO_NO_MBL', 'MASTER', true], `${t}/${c.id}`);
      const original = r1.campos.find((x) => x.id === c.id)!;
      assert.deepEqual([c.rotulo, c.dado], [original.rotulo, original.dado], 'rótulo e dado do modelo oficial ficam');
    }
    const { campos: _a, revisao, ...resto2 } = r2;
    const { campos: _b, ...resto1 } = r1;
    assert.equal(canonico(resto2), canonico(resto1), `${t}: layout, texto jurídico, opções, assinatura e marcadores idênticos`);
    assert.deepEqual(revisao, { numero: 2, decisao: '14.20' });
    assert.deepEqual(verificarDefinicao(r2, t), [], `${t}: revisão 2 válida`);
    assert.deepEqual(verificarDefinicao(r1, t), [], `${t}: revisão 1 continua válida`);
  }
  assert.match(String(DEFINICOES_REVISAO_2.MEMORANDO_HAPAG_ROCHAMAR.campos.find((c) => c.id === 'EXPORTADOR_IMPORTADOR')!.fundamento), /DOC-17 \(revista pela 14\.20\)/);
  // Consignatário pelo cadastro SEM a confirmação: definição inválida (não entra em uso).
  const sem = { ...DEFINICOES_REVISAO_2.MEMORANDO_MSC, campos: DEFINICOES_REVISAO_2.MEMORANDO_MSC.campos.map((c) => ({ ...c, confirmacao: undefined })) };
  assert.deepEqual(verificarDefinicao(sem, 'MEMORANDO_MSC'), [{ tipo: 'CONFIRMACAO_INVALIDA', campo: 'CONSIGNATARIO' }]);
  // Confirmação fora do consignatário, ou com outra fonte junto: inválida.
  const fora = { ...DEFINICOES_REVISAO_2.MEMORANDO_MSC, campos: DEFINICOES_REVISAO_2.MEMORANDO_MSC.campos.map((c) => (c.id === 'NAVIO' ? { ...c, confirmacao: DEFINICOES_REVISAO_2.MEMORANDO_MSC.campos[1].confirmacao } : c)) };
  assert.deepEqual(verificarDefinicao(fora, 'MEMORANDO_MSC'), [{ tipo: 'CONFIRMACAO_INVALIDA', campo: 'NAVIO' }]);
  const duas = { ...DEFINICOES_REVISAO_2.MEMORANDO_MSC, campos: DEFINICOES_REVISAO_2.MEMORANDO_MSC.campos.map((c) => (c.id === 'CONSIGNATARIO' ? { ...c, fontesAceitas: ['CADASTRO_DA_ORGANIZACAO', 'S2_AUDITORIA'] as FonteDeDado[] } : c)) };
  assert.deepEqual(verificarDefinicao(duas, 'MEMORANDO_MSC'), [{ tipo: 'CONFIRMACAO_INVALIDA', campo: 'CONSIGNATARIO' }]);
});

/* ------------------------------------------- estáticos ------------------------------------------- */

const raiz = path.resolve(__dirname, '..', '..', '..');
const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(d, e.name)) : [path.join(d, e.name)]));
const NOVOS = ['liberacao/documentos/dominio/institucional.ts', 'liberacao/documentos/dominio/identidadeDoConsignatario.ts', 'liberacao/documentos/aplicacao/cadastroInstitucional.ts'];

test('[CI-09] zero OCR, IA ou Graph e nenhum dado jurídico fixo no código: os módulos novos só leem o que já está persistido', () => {
  for (const f of [...NOVOS, 'liberacao/documentos/aplicacao/postgres.ts', 'liberacao/documentos/dominio/preenchimento.ts', 'liberacao/documentos/dominio/modelosOficiais.ts']) {
    const fonte = fs.readFileSync(path.join(raiz, f), 'utf8');
    for (const [, imp] of fonte.matchAll(/from\s+'([^']+)'/g)) assert.doesNotMatch(imp, /docExtractor|extracaoPreAlerta|geminiClient|\/ai\/|graphService|auditClara|mistral/i, `${f} importa ${imp}`);
    assert.doesNotMatch(fonte, /generateStructured|getAttachmentContent|fetch\(/, f);
  }
  // O CNPJ de referência da organização é dado do cadastro (gravado pela administração), nunca constante do software. Ele só
  // aparece nos `marcadoresDoExemplo` das definições oficiais (já existentes e protegidos pelo hash do [CI-08]): o dado do
  // exemplo preenchido que vem no PDF oficial e que o domínio garante NUNCA ser copiado para campo ou texto fixo.
  const semMarcadoresDoExemplo = (fonte: string) => fonte.replace(/marcadoresDoExemplo:\s*\[[\s\S]*?\]/g, '');
  for (const f of todos(raiz).filter((x) => x.endsWith('.ts') && !x.includes('__tests__'))) {
    assert.doesNotMatch(semMarcadoresDoExemplo(fs.readFileSync(f, 'utf8')), /27\.?909\.?874\/?0001-?12|27909874000112/, path.relative(raiz, f));
  }
});

test('[CI-10] nenhuma decisão nova na L1b: nenhum arquivo da L1a/L1b, da projeção (L2) ou da reconstrução (G-3c) usa o cadastro, a conferência ou a confirmação', () => {
  const arquivos = [...todos(path.join(raiz, 'liberacao', 'dominio')), ...todos(path.join(raiz, 'liberacao', 'aplicacao'))].filter((f) => f.endsWith('.ts') && !f.includes('__tests__'));
  assert.ok(arquivos.length > 10);
  for (const f of arquivos) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /cadastroInstitucional|institucional|identidadeDoConsignatario|conferirConsignatario|consignatarioPeloCadastro|IDENTIDADE_DO_CONSIGNATARIO/,
      path.relative(raiz, f));
  }
});

/* --------------------------------- os quatro modelos oficiais reais (em memória) --------------------------------- */

/** Os valores das fontes para a revisão em vigor: o consignatário vem do cadastro, pela identidade conferida. */
function valoresDoEmbarque(tipo: TipoDocumento, identidade: IdentidadeDoConsignatario): ValorObservado[] {
  const out: ValorObservado[] = [];
  for (const c of DEFINICOES_EM_VIGOR[tipo].campos) {
    const fonte = c.fontesAceitas.find((f) => f !== 'ANALISTA' && f !== 'GERACAO' && f !== 'CADASTRO_DO_SIGNATARIO_LEGAL');
    if (!fonte || CONSIGNATARIO_DADOS.includes(c.dado) || out.some((v) => v.dado === c.dado)) continue;
    const v = fonte === 'CADASTRO_DA_ORGANIZACAO' ? (CADASTRO as unknown as Record<string, string>)[Object.entries({
      ORGANIZACAO_RAZAO_SOCIAL: 'razaoSocial', ORGANIZACAO_CNPJ: 'cnpj', ORGANIZACAO_ENDERECO: 'endereco', ORGANIZACAO_TELEFONE: 'telefone',
      CONTATO_SOBREESTADIA_NOME: 'contatoSobreestadiaNome', CONTATO_SOBREESTADIA_EMAIL: 'contatoSobreestadiaEmail', EMAILS_PARA_RECIBO: 'emailsParaRecibo',
    }).find(([d]) => d === c.dado)![1]] : VALORES_SINTETICOS[c.dado];
    out.push(valor(c.dado, v, fonte, c.escopo === 'MASTER' ? { tipo: 'MASTER', masterId: MASTER } : { tipo: 'DOCUMENTO' }));
  }
  return [...out, ...consignatarioPeloCadastro(CADASTRO, identidade, CONSIGNATARIO_DADOS, MASTER)];
}

test('[CI-19] os quatro modelos oficiais preenchidos pela revisão em vigor: fixos do cadastro (inclusive o consignatário confirmado), variáveis do embarque; proveniência dupla no documento', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  for (const tipo of TIPOS) {
    const c = await cenarioDocumental({
      armador: { masterId: MASTER, codigo: CODIGO[tipo] }, defs: { [tipo]: DEFINICOES_EM_VIGOR[tipo] }, arquivos: { [tipo]: MODELOS_OFICIAIS[tipo] }, gerador: geradorPdfPriora,
      valores: valoresDoEmbarque(tipo, VERIFICADA),
      signatarios: [{ ...SIGNATARIO_SINTETICO, nome: VALORES_SINTETICOS.SIGNATARIO_NOME, cpf: VALORES_SINTETICOS.SIGNATARIO_CPF, poderes: PODERES_SINTETICOS() }],
    });
    const informados = DEFINICOES_EM_VIGOR[tipo].campos.filter((x) => x.fontesAceitas.includes('ANALISTA')).map((x) => ({ dado: x.dado, valor: VALORES_SINTETICOS[x.dado] }));
    const escolhas = ESCOLHAS_SINTETICAS[tipo].map((e) => ({ ...e, por: ATOR.membershipId, em: '2026-10-15T10:00:00.000Z' }));
    const r = await prepararDocumento(c.deps, ATOR, MASTER, { escolhas, informados });
    assert.equal(r.tipo, 'PREPARADO', `${tipo}: ${JSON.stringify(r).slice(0, 600)}`);
    const doc = c.repo.m.documentos[0] as typeof c.repo.m.documentos[0] & { plano: PlanoDePreenchimento };
    const texto = semEspacos(textoDoPdf(doc.arquivo));
    assert.ok(texto.includes(semEspacos(CADASTRO_COMPLETO.razaoSocial)), `${tipo}: razão social do cadastro`);
    assert.ok(!texto.includes(semEspacos('AVENIDA DO MBL SINTETICA')), `${tipo}: nada do texto do MBL`);
    if (tipo === 'TERMO_EVERGREEN') {
      assert.ok(texto.includes(semEspacos(`CNPJ ${mascara(CNPJ_ORG)}`)) && texto.includes(semEspacos(CADASTRO_COMPLETO.endereco)), 'qualificação do consignatário');
    }
    const consignatario = DEFINICOES_EM_VIGOR[tipo].campos.find((x) => CONSIGNATARIO_DADOS.includes(x.dado))!.id;
    const prov = doc.plano.proveniencia.find((p) => p.campo === consignatario)!;
    assert.deepEqual(prov.fontes.map((f) => [f.fonte, f.evidencia.fonte, f.confirmacao?.evidencias.map((e) => e.fonte)]),
      [['CADASTRO_DA_ORGANIZACAO', 'cadastro_institucional', ['auditoria', 'cadastro_institucional']]], `${tipo}: origem = cadastro; confirmação = Auditoria + CNPJ comparado`);
    assert.ok(!doc.plano.proveniencia.some((p) => CONSIGNATARIO_DADOS.includes(DEFINICOES_EM_VIGOR[tipo].campos.find((x) => x.id === p.campo)!.dado)
      && p.fontes.some((f) => f.fonte === 'S2_AUDITORIA')), 'nenhum valor do cadastro atribuído à Auditoria');
    assert.equal(doc.conteudo.campos.find((x) => x.campo === 'BL')?.valor, VALORES_SINTETICOS.MBL, `${tipo}: BL do embarque`);
    // Sem a identidade: só este documento não é gerado; o motivo diz por quê.
    const e = await cenarioDocumental({
      armador: { masterId: MASTER, codigo: CODIGO[tipo] }, defs: { [tipo]: DEFINICOES_EM_VIGOR[tipo] }, arquivos: { [tipo]: MODELOS_OFICIAIS[tipo] }, gerador: geradorPdfPriora,
      valores: valoresDoEmbarque(tipo, DIVERGENTE),
      signatarios: [{ ...SIGNATARIO_SINTETICO, poderes: PODERES_SINTETICOS() }],
    });
    const n = await prepararDocumento(e.deps, ATOR, MASTER, { escolhas, informados });
    assert.equal(n.tipo, 'NAO_PREPARADO', tipo);
    const faltas = n.situacao?.pendencias.find((p) => p.passo === 'OBTER_DADOS_FALTANTES');
    assert.deepEqual(faltas?.passo === 'OBTER_DADOS_FALTANTES' && faltas.faltantes.map((f) => f.campo), [consignatario], `${tipo}: só o consignatário falta`);
    assert.equal(e.repo.m.documentos.length, 0);
  }
});

test('[CI-23] DOC-31.B: documento gerado com o consignatário confirmado; se a identidade deixa de ser confirmável, a vigência fica NÃO VERIFICÁVEL (nenhuma regra nova)', { skip: SEM_MODELOS || SEM_POPPLER }, async () => {
  const tipo: TipoDocumento = 'MEMORANDO_MSC';
  const c = await cenarioDocumental({
    armador: { masterId: MASTER, codigo: 'MSC' }, defs: { [tipo]: DEFINICOES_EM_VIGOR[tipo] }, arquivos: { [tipo]: MODELOS_OFICIAIS[tipo] }, gerador: geradorPdfPriora,
    valores: valoresDoEmbarque(tipo, VERIFICADA),
  });
  const escolhas = ESCOLHAS_SINTETICAS[tipo].map((e) => ({ ...e, por: ATOR.membershipId, em: '2026-10-15T10:00:00.000Z' }));
  assert.equal((await prepararDocumento(c.deps, ATOR, MASTER, { escolhas })).tipo, 'PREPARADO');
  assert.equal((await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao.proximoPasso?.passo, 'DOCUMENTO_DISPONIVEL');
  // Chega uma versão do MBL com outra empresa: a identidade vira exceção e o consignatário some das fontes.
  c.mundo.valores = valoresDoEmbarque(tipo, DIVERGENTE);
  const s = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
  assert.deepEqual([s.preparo.tipo, (s.preparo as { motivo: string }).motivo, (s.preparo as { naoVerificados: unknown[] }).naoVerificados],
    ['DESATUALIZADO', 'VIGENCIA_NAO_VERIFICAVEL', [{ tipo: 'CAMPO', campo: 'CONSIGNATARIO' }]]);
  // A razão social corrigida no cadastro (identidade confirmada) muda o que o PDF mostra: nova versão.
  c.mundo.valores = valoresDoEmbarque(tipo, VERIFICADA).map((v) => (v.dado === 'CONSIGNATARIO_RAZAO_SOCIAL' ? { ...v, valor: 'ORGANIZACAO SINTETICA CORRIGIDA LTDA' } : v));
  const s2 = (await avaliarDocumentacao(c.deps, ORG, MASTER)).situacao;
  assert.deepEqual([(s2.preparo as { motivo: string }).motivo, (s2.preparo as { alteracoes: unknown[] }).alteracoes, s2.pendencias.map((p) => p.passo)],
    ['CONTEUDO_MUDOU', [{ tipo: 'CAMPO', campo: 'CONSIGNATARIO' }], ['GERAR_NOVA_VERSAO']]);
});

/* ------------------------------------------------ PostgreSQL ------------------------------------------------ */

function conteiner(base: string): string {
  for (let d = 0; d <= 9; d++) if (validaISO6346(`${base}${d}`)) return `${base}${d}`;
  throw new Error(base);
}
const C1 = conteiner('TSTU000001');
const C2 = conteiner('TSTU000002');
const SHA = (n: number) => n.toString(16).padStart(64, '0');

/** Uma versão do MBL (ou outro documento) pelo caminho do DONO (S2), com o consignatário como o OCR o teria devolvido. */
async function mbl(pool: Pool, c: Cenario, v: { id: string; processo: string; conhecimento: string; sha: number; consignee: string | null; recebida?: string; tipo?: 'MBL' | 'HBL' }) {
  const recebida = new Date(v.recebida ?? '2026-10-01T08:00:00Z');
  const campos: CamposDocumentaisExtraidos = { navio: 'NAVIO SINTETICO DE TESTE V001T', consignee: v.consignee, conteineres: [C1, C2] };
  const [r] = await persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: `msg-${v.id}`, internetMessageId: `<${v.id}@agente.teste>`, attachmentId: `anexo-${v.id}`, attachmentNome: `${v.tipo ?? 'MBL'}.pdf`, contentType: 'application/pdf',
      remetente: 'agente@agente.teste', recebidaEm: recebida, referenciasBrutas: [v.processo], associacao: 'CITADA',
    },
    resultado: { tipoPorNome: v.tipo ?? 'MBL', tipoDetectado: v.tipo ?? 'MBL', legivel: true, conhecimento: v.conhecimento, camposDocumentais: campos, arquivoSha256: SHA(v.sha) },
    modelo: 'modelo-teste', extraidaEm: recebida,
  }]);
  return r.extracaoId;
}
const masterDe = async (pool: Pool, org: string, processo: string): Promise<string> => (await pool.query(
  `SELECT DISTINCT v.master_id FROM processo_master_vinculos v JOIN processos p ON p.id = v.processo_id WHERE v.organization_id = $1 AND p.numero_processo = $2`,
  [org, processo])).rows[0].master_id;

const acesso = (c: Cenario, membershipId: string, papel: string): AcessoDaPessoa =>
  ({ usuarioId: 'u', homeAccountId: 'h', nome: 'Pessoa sintética', membershipId, papel, organizationId: c.orgId, caixaId: c.caixaId } as AcessoDaPessoa);

/** A API documental de verdade (rotas, serviço, PostgreSQL), com a sessão simulada. */
async function api(deps: () => DepsDocumentos) {
  let quem: AcessoDaPessoa | null = null;
  const app = express();
  app.use(express.json());
  app.use('/api/liberacao/documentos', criarDocumentosRouter({
    habilitado: () => true, documentos: deps,
    auth: (req: AuthedRequest, _res: Response, next: NextFunction) => { if (quem) req.pessoa = quem; next(); },
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/liberacao/documentos`;
  const pedir = async (caminho: string, corpo?: unknown) => {
    const r = await fetch(`${base}/cadastro-institucional${caminho}`, corpo === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    return { status: r.status, corpo: await r.json() as any };
  };
  const master = async (masterId: string) => {
    const r = await fetch(`${base}/masters/${masterId}`);
    return { status: r.status, corpo: await r.json() as any };
  };
  return { pedir, master, como: (a: AcessoDaPessoa | null) => { quem = a; }, fechar: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Conta (e bloqueia) qualquer chamada a OCR/IA ou ao Graph/Outlook (todas as funções exportadas) durante `fn`. */
async function semOcr<T>(fn: () => Promise<T>): Promise<{ r: T; chamadas: string[] }> {
  const chamadas: string[] = [];
  const modulos: Array<[string, Record<string, unknown>]> = [['gemini', gemini as unknown as Record<string, unknown>], ['graph', graph as unknown as Record<string, unknown>]];
  const originais: Array<[Record<string, unknown>, string, unknown]> = [];
  for (const [nome, m] of modulos) {
    for (const k of Object.keys(m).filter((x) => typeof m[x] === 'function')) {
      originais.push([m, k, m[k]]);
      m[k] = async () => { chamadas.push(`${nome}.${k}`); throw new Error('chamada externa proibida'); };
    }
  }
  assert.ok(originais.some(([, k]) => k === 'generateStructuredFromDocument') && originais.some(([, k]) => k === 'getAttachmentContent'), 'o espião cobre OCR e anexos');
  try {
    return { r: await fn(), chamadas };
  } finally {
    for (const [m, k, f] of originais) m[k] = f;
  }
}

test('O1.8/O1.9 — cadastro institucional, signatário, conferência e consignatário pelo cadastro sobre o PostgreSQL', { skip: !url && 'DEMURRAGE_TEST_DATABASE_URL não definida' }, async (t) => {
  const pool = testPool();
  await preparar(pool);
  const rel = relogio('2026-10-20T12:00:00.000Z');
  const codigos = new Map<string, string>();
  const deps = (): DepsDocumentos => ({
    ...depsDocumentosPadrao(pool, rel), armador: { armadorDoMaster: async (_o, m) => (codigos.has(m) ? { masterId: m, codigo: codigos.get(m)! } : null) },
  });
  const s = await api(deps);
  try {
    await t.test('[CI-11] alteração pela administração (API): registra, corrige com novo registro e consulta; organização e autor vêm da sessão, nunca do corpo', async () => {
      const c = await cenario(pool, 'ci-admin');
      const outra = await cenario(pool, 'ci-admin-outra');
      s.como(acesso(c, c.membershipCaixa, 'ADMIN'));
      const r1 = await s.pedir('', { ...CADASTRO_COMPLETO, razaoSocial: 'NOME PROVISORIO SINTETICO', organizationId: outra.orgId, registradoPor: 'forjado', registradoEm: '2020-01-01T00:00:00Z' });
      assert.equal(r1.status, 201, JSON.stringify(r1.corpo));
      rel.avancar(60_000);
      const r2 = await s.pedir('', { ...CADASTRO_COMPLETO, motivo: 'razão social corrigida' });
      assert.equal(r2.status, 201);
      const g = await s.pedir('');
      assert.equal(g.status, 200);
      assert.deepEqual([g.corpo.vigente.cadastroId, g.corpo.vigente.cnpj, g.corpo.vigente.razaoSocial, g.corpo.vigente.registradoPor, g.corpo.vigente.motivo],
        [r2.corpo.id, CNPJ_ORG, CADASTRO_COMPLETO.razaoSocial, c.membershipCaixa, 'razão social corrigida']);
      assert.deepEqual(g.corpo.historico.map((h: { razaoSocial: string }) => h.razaoSocial), ['NOME PROVISORIO SINTETICO', CADASTRO_COMPLETO.razaoSocial], 'o histórico fica');
      assert.equal(g.corpo.historico[0].registradoEm, '2026-10-20T12:00:00.000Z', 'o instante é o do servidor, nunca o do corpo');
      assert.equal(await contar(pool, `SELECT count(*) n FROM organizacao_cadastro_institucional WHERE organization_id = $1`, [outra.orgId]), 0, 'o corpo não escolhe a organização');
      const invalido = await s.pedir('', { cnpj: mascara(CNPJ_RUIM) });
      assert.deepEqual([invalido.status, invalido.corpo.motivo, invalido.corpo.problemas], [422, 'DADOS_INVALIDOS', [{ campo: 'cnpj', motivo: 'CNPJ_INVALIDO' }]]);
    });

    await t.test('[CI-12] tentativa sem autorização: ANALYST, MANAGER e CLIENT são recusados pela API; o banco recusa também quem não é ADMIN', async () => {
      const c = await cenario(pool, 'ci-negado');
      const u = await pool.query(`INSERT INTO usuarios (nome, email, home_account_id) VALUES ('gestor sintetico', 'gestor-ci@x.com', 'home-gestor-ci') RETURNING id`);
      const gestor: string = (await pool.query(`INSERT INTO organization_memberships (organization_id, usuario_id, papel) VALUES ($1, $2, 'MANAGER') RETURNING id`,
        [c.orgId, u.rows[0].id])).rows[0].id;
      for (const [m, papel, esperado] of [[c.membershipPessoa, 'ANALYST', 403], [gestor, 'MANAGER', 403], [c.membershipCliente, 'CLIENT', 403]] as const) {
        s.como(acesso(c, m, papel));
        const r = await s.pedir('', CADASTRO_COMPLETO);
        assert.equal(r.status, esperado, `${papel} grava`);
        assert.equal((await s.pedir('')).status, esperado, `${papel} consulta`);
        assert.equal((await s.pedir('/signatarios', SIGNATARIO)).status, esperado, `${papel} cadastra signatário`);
      }
      s.como(acesso(c, c.membershipPessoa, 'ANALYST'));
      assert.equal((await s.pedir('', CADASTRO_COMPLETO)).corpo.motivo, 'EXIGE_ADMIN');
      assert.equal(await contar(pool, `SELECT count(*) n FROM organizacao_cadastro_institucional WHERE organization_id = $1`, [c.orgId]), 0);
      // Proteção em profundidade: mesmo sem a aplicação, o banco só aceita ADMIN da própria organização.
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, registrado_por_membership_id) VALUES ($1, $2, $3)`,
        [c.orgId, CNPJ_ORG, c.membershipPessoa]), /CADASTRO_INSTITUCIONAL_EXIGE_ADMIN/);
      const r = await registrarCadastroInstitucional(deps(), { organizationId: c.orgId, membershipId: c.membershipPessoa }, CADASTRO_COMPLETO);
      assert.deepEqual(r, { tipo: 'RECUSADO', motivo: 'EXIGE_ADMIN' });
      // Um ADMIN rebaixado deixa de gravar na hora (o papel é conferido no instante da gravação).
      await pool.query(`UPDATE organization_memberships SET papel = 'ANALYST' WHERE id = $1`, [gestor]);
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, registrado_por_membership_id) VALUES ($1, $2, $3)`,
        [c.orgId, CNPJ_ORG, gestor]), /CADASTRO_INSTITUCIONAL_EXIGE_ADMIN/);
    });

    await t.test('[CI-13] histórico: append-only; instante nunca volta; ordem pela sequência; CNPJ inválido, texto com quebra ou separador Unicode recusados também pelo banco', async () => {
      const c = await cenario(pool, 'ci-hist');
      const ator = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const r = await registrarCadastroInstitucional(deps(), ator, CADASTRO_COMPLETO);
      assert.equal(r.tipo, 'REGISTRADO');
      const id = (r as { id: string }).id;
      await assert.rejects(pool.query(`UPDATE organizacao_cadastro_institucional SET razao_social = 'OUTRA' WHERE id = $1`, [id]));
      await assert.rejects(pool.query(`DELETE FROM organizacao_cadastro_institucional WHERE id = $1`, [id]));
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, registrado_por_membership_id) VALUES ($1, $2, $3)`,
        [c.orgId, CNPJ_RUIM, c.membershipCaixa]), /check constraint/);
      for (const t2 of ['RUA\nSALA', 'RUA SALA', 'RUA SALA']) {
        await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, endereco, registrado_por_membership_id) VALUES ($1, $2, $3, $4)`,
          [c.orgId, CNPJ_ORG, t2, c.membershipCaixa]), /check constraint/, JSON.stringify(t2));
      }
      // Nada é gravado "no passado" para reordenar o histórico.
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, registrado_por_membership_id, registrado_em) VALUES ($1, $2, $3, $4)`,
        [c.orgId, CNPJ_ORG, c.membershipCaixa, '2026-10-19T00:00:00Z']), /CADASTRO_INSTITUCIONAL_FORA_DE_ORDEM/);
      const atrasado = await registrarCadastroInstitucional({ ...deps(), relogio: relogio('2026-10-19T00:00:00.000Z') }, ator, CADASTRO_COMPLETO);
      assert.deepEqual(atrasado, { tipo: 'RECUSADO', motivo: 'CADASTRO_INSTITUCIONAL_FORA_DE_ORDEM' }, 'relógio atrasado: recusa, nunca reordena');
      // No mesmo instante, a ordem de gravação decide (sequência), nunca o identificador.
      const mesmo = await registrarCadastroInstitucional(deps(), ator, { ...CADASTRO_COMPLETO, razaoSocial: 'SEGUNDO NO MESMO INSTANTE LTDA' });
      const consulta = await consultarCadastroInstitucional(deps(), ator);
      assert.ok(consulta.tipo === 'OK');
      assert.deepEqual(consulta.historico.map((h) => h.cadastroId), [id, (mesmo as { id: string }).id], 'as tentativas recusadas não entram no histórico');
      assert.equal(consulta.vigente?.razaoSocial, 'SEGUNDO NO MESMO INSTANTE LTDA');
      // Gravações concorrentes da mesma organização são serializadas: todas entram, em ordem, nenhuma se perde.
      const concorrentes = await Promise.all([1, 2, 3, 4].map((n) => registrarCadastroInstitucional(deps(), ator, { ...CADASTRO_COMPLETO, razaoSocial: `CONCORRENTE ${n} LTDA` })));
      assert.ok(concorrentes.every((x) => x.tipo === 'REGISTRADO'));
      const seqs = (await pool.query(`SELECT sequencia FROM organizacao_cadastro_institucional WHERE organization_id = $1 ORDER BY sequencia`, [c.orgId])).rows.map((x) => Number(x.sequencia));
      assert.equal(new Set(seqs).size, 6);
      // A FK do autor é composta (membership DA organização) — estrutural, além do gatilho.
      const fk = (await pool.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'organizacao_cadastro_institucional_autor_fk'`)).rows[0].d;
      assert.match(fk, /FOREIGN KEY \(registrado_por_membership_id, organization_id\) REFERENCES organization_memberships\(id, organization_id\)/);
    });

    await t.test('[CI-14] isolamento entre organizações: cada uma só vê e só usa o próprio cadastro; o banco recusa autor de outra organização', async () => {
      const a = await cenario(pool, 'ci-iso-a');
      const b = await cenario(pool, 'ci-iso-b');
      await registrarCadastroInstitucional(deps(), { organizationId: a.orgId, membershipId: a.membershipCaixa }, CADASTRO_COMPLETO);
      await registrarSignatarioLegal(deps(), { organizationId: a.orgId, membershipId: a.membershipCaixa }, SIGNATARIO);
      const consultaB = await consultarCadastroInstitucional(deps(), { organizationId: b.orgId, membershipId: b.membershipCaixa });
      assert.deepEqual(consultaB.tipo === 'OK' && [consultaB.vigente, consultaB.historico, consultaB.signatarios.vigentes], [null, [], []]);
      const pedidos = [{ dado: 'ORGANIZACAO_CNPJ', fonte: 'CADASTRO_DA_ORGANIZACAO' as const }];
      assert.deepEqual(await deps().fontes.valores(b.orgId, '00000000-0000-0000-0000-000000000000', [], pedidos), []);
      assert.deepEqual(await deps().fontes.signatariosLegais(b.orgId, rel.agora()), []);
      assert.equal((await deps().fontes.valores(a.orgId, '00000000-0000-0000-0000-000000000000', [], pedidos))[0]?.valor, CNPJ_ORG);
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, registrado_por_membership_id) VALUES ($1, $2, $3)`,
        [a.orgId, CNPJ_ORG, b.membershipCaixa]), /CADASTRO_INSTITUCIONAL_EXIGE_ADMIN/, 'ADMIN de outra organização');
      // O signatário de A não existe para B (corrigir, comprovar poderes ou revogar pelo identificador de A é recusado).
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE organization_id = $1`, [a.orgId])).rows[0].signatario_id;
      const atorB = { organizationId: b.orgId, membershipId: b.membershipCaixa };
      assert.deepEqual(await registrarPoderesDoSignatario(deps(), atorB, sid, { evidencia: 'x' }), { tipo: 'RECUSADO', motivo: 'SIGNATARIO_INEXISTENTE' });
      assert.deepEqual(await registrarSignatarioLegal(deps(), atorB, SIGNATARIO, sid), { tipo: 'RECUSADO', motivo: 'SIGNATARIO_INEXISTENTE' });
      assert.deepEqual(await revogarSignatarioLegal(deps(), atorB, sid, { motivo: 'x' }), { tipo: 'RECUSADO', motivo: 'SIGNATARIO_INEXISTENTE' });
    });

    await t.test('[CI-15] signatário legal pela API: cadastro, poderes do cadastro ATUAL, correção sem herdar poderes, revogação; o banco amarra os poderes ao cadastro', async () => {
      const c = await cenario(pool, 'ci-sig');
      s.como(acesso(c, c.membershipCaixa, 'ADMIN'));
      const cad = await s.pedir('/signatarios', SIGNATARIO);
      assert.equal(cad.status, 201, JSON.stringify(cad.corpo));
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE id = $1`, [cad.corpo.id])).rows[0].signatario_id;
      // Representante sem poderes comprovados: os modelos que os exigem dizem NAO_COMPROVADOS.
      const antes = await s.pedir('');
      assert.deepEqual(antes.corpo.pendencias.map((p: { tipo: string; poderes: string | null }) => [p.tipo, p.poderes]),
        [['MEMORANDO_MSC', null], ['MEMORANDO_HAPAG_ROCHAMAR', 'NAO_COMPROVADOS'], ['MEMORANDO_ZIM_ROCHAMAR', 'NAO_COMPROVADOS'], ['TERMO_EVERGREEN', 'NAO_COMPROVADOS']]);
      const pod = await s.pedir(`/signatarios/${sid}/poderes`, { evidencia: 'procuração sintética', validoAte: '2027-12-31' });
      assert.equal(pod.status, 201);
      assert.equal((await pool.query(`SELECT refere_cadastro_id FROM organizacao_signatarios_legais WHERE id = $1`, [pod.corpo.id])).rows[0].refere_cadastro_id, cad.corpo.id,
        'os poderes apontam o cadastro exato que comprovam');
      const vigentes = await deps().fontes.signatariosLegais(c.orgId, rel.agora());
      assert.deepEqual(vigentes.map((v) => [v.nome, v.cpf, v.qualificacao, v.poderes?.validoAte]), [[SIGNATARIO.nome, CPF, SIGNATARIO.qualificacao, '2027-12-31']]);
      assert.equal(signatarioDaOrganizacao(vigentes).tipo, 'DEFINIDO');
      // Correção que troca a pessoa: os poderes da anterior não passam.
      rel.avancar(60_000);
      const correcao = await s.pedir(`/signatarios/${sid}`, { ...SIGNATARIO, nome: 'OUTRA PESSOA SINTETICA', cpf: OUTRO_CPF });
      assert.equal(correcao.status, 201);
      assert.deepEqual((await deps().fontes.signatariosLegais(c.orgId, rel.agora())).map((v) => [v.nome, v.poderes]), [['OUTRA PESSOA SINTETICA', null]]);
      // O banco recusa poderes que apontam o cadastro antigo.
      await assert.rejects(pool.query(
        `INSERT INTO organizacao_signatarios_legais (organization_id, signatario_id, evento, evidencia, refere_cadastro_id, registrado_por_membership_id, registrado_em) VALUES ($1, $2, 'PODERES_COMPROVADOS', 'x', $3, $4, $5)`,
        [c.orgId, sid, cad.corpo.id, c.membershipCaixa, rel.agora()]), /PODERES_DE_OUTRO_CADASTRO/);
      await assert.rejects(pool.query(`INSERT INTO organizacao_signatarios_legais (organization_id, signatario_id, evento, evidencia, registrado_por_membership_id, registrado_em) VALUES ($1, $2, 'PODERES_COMPROVADOS', 'x', $3, $4)`,
        [c.orgId, sid, c.membershipCaixa, rel.agora()]), /PODERES_DE_OUTRO_CADASTRO|check constraint/, 'poderes sem o cadastro que comprovam');
      assert.equal((await s.pedir(`/signatarios/${sid}/poderes`, { evidencia: 'procuração sintética da nova pessoa' })).status, 201);
      assert.equal((await deps().fontes.signatariosLegais(c.orgId, rel.agora()))[0].poderes?.evidencia.ref.startsWith('signatario_legal_poderes:'), true);
      assert.equal((await s.pedir('/signatarios/00000000-0000-4000-8000-000000000000/poderes', { evidencia: 'x' })).status, 404);
      assert.equal((await s.pedir(`/signatarios/${sid}/revogar`, {})).status, 422, 'revogar exige motivo');
      assert.equal((await s.pedir(`/signatarios/${sid}/revogar`, { motivo: 'saída sintética' })).status, 201);
      assert.equal((await s.pedir(`/signatarios/${sid}/poderes`, { evidencia: 'x' })).status, 409, 'revogado não recebe mais nada');
      assert.deepEqual(await deps().fontes.signatariosLegais(c.orgId, rel.agora()), [], 'revogado: os campos de quem assina voltam a faltar');
      await assert.rejects(pool.query(
        `INSERT INTO organizacao_signatarios_legais (organization_id, signatario_id, evento, evidencia, refere_cadastro_id, registrado_por_membership_id, registrado_em) VALUES ($1, $2, 'PODERES_COMPROVADOS', 'x', $3, $4, $5)`,
        [c.orgId, sid, correcao.corpo.id, c.membershipCaixa, rel.agora()]), /SIGNATARIO_REVOGADO/, 'o banco também recusa');
    });

    await t.test('[CI-16] identidade no MBL persistido: correspondente, divergente, ausente, inválido e múltiplos; versões; duplicatas; Master de vários Houses; HBL não entra; zero OCR', async () => {
      const c = await cenario(pool, 'ci-mbl');
      const ator = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const conferencia = async (processo: string) => deps().fontes.identidadeDoConsignatario!(c.orgId, await masterDe(pool, c.orgId, processo));
      const e1 = await mbl(pool, c, { id: 'p1', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 1, consignee: CONSIGNATARIO_ORG });
      assert.equal(motivo(await conferencia('IM901')), 'CADASTRO_INSTITUCIONAL_AUSENTE', 'antes do cadastro, nada se presume');
      await registrarCadastroInstitucional(deps(), ator, CADASTRO_COMPLETO);
      const { r, chamadas } = await semOcr(() => conferencia('IM901'));
      assert.deepEqual(chamadas, [], 'nenhuma chamada a OCR, IA ou Graph/Outlook');
      assert.equal(motivo(r), 'VERIFICADA');
      assert.deepEqual(r.versoes.map((v) => [v.extracaoId, v.arquivoSha256, v.textoOriginal]), [[e1, SHA(1), CONSIGNATARIO_ORG]], 'texto e proveniência preservados');
      const casos: Array<[string, string, string | null, string]> = [
        ['IM902', 'MEDU9020001', `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${mascara(CNPJ_OUTRA)}`, 'CNPJ_DIVERGENTE'],
        ['IM903', 'MEDU9030001', VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL, 'CNPJ_AUSENTE'],
        ['IM904', 'MEDU9040001', `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${mascara(CNPJ_RUIM)}`, 'CNPJ_INVALIDO'],
        ['IM905', 'MEDU9050001', `${CONSIGNATARIO_ORG}\nCNPJ ${mascara(CNPJ_OUTRA)}`, 'MULTIPLOS_CNPJS'],
        ['IM906', 'MEDU9060001', null, 'CONSIGNATARIO_AUSENTE'],
      ];
      for (const [processo, conhecimento, consignee, esperado] of casos) {
        await mbl(pool, c, { id: processo, processo, conhecimento, sha: Number(processo.slice(2)), consignee });
        assert.equal(motivo(await conferencia(processo)), esperado, processo);
      }
      // Versões: só formatação verifica; outro texto com o MESMO CNPJ também (R7); outro CNPJ em outro arquivo é exceção.
      await mbl(pool, c, { id: 'p1-v2', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 2, consignee: CONSIGNATARIO_ORG.replace(/\n/g, '\r\n'), recebida: '2026-10-02T08:00:00Z' });
      assert.equal(motivo(await conferencia('IM901')), 'VERIFICADA', 'SO_FORMATACAO');
      await mbl(pool, c, { id: 'p1-v3', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 3, consignee: CONSIGNATARIO_ORG.replace('999', '777'), recebida: '2026-10-03T08:00:00Z' });
      const v3 = await conferencia('IM901');
      assert.deepEqual([motivo(v3), v3.situacaoDoTexto, v3.versoes.length], ['VERIFICADA', 'DIVERGENTE', 3], 'o texto diverge, a identidade não');
      await mbl(pool, c, { id: 'p1-v4', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 4, consignee: `IMPORTADORA SINTETICA\nCNPJ ${mascara(CNPJ_OUTRA)}`, recebida: '2026-10-04T08:00:00Z' });
      assert.equal(motivo(await conferencia('IM901')), 'VERSOES_DIVERGENTES', 'a versão mais nova não vence: sem critério aprovado, exceção');
      // Master compartilhado por vários Houses, com o MESMO arquivo do MBL em duas mensagens (duplicata).
      await mbl(pool, c, { id: 'h1', processo: 'IM910', conhecimento: 'MEDU9100001', sha: 10, consignee: CONSIGNATARIO_ORG });
      await mbl(pool, c, { id: 'h2', processo: 'IM911', conhecimento: 'MEDU9100001', sha: 10, consignee: CONSIGNATARIO_ORG, recebida: '2026-10-02T08:00:00Z' });
      assert.equal(await masterDe(pool, c.orgId, 'IM910'), await masterDe(pool, c.orgId, 'IM911'));
      const compartilhado = await conferencia('IM910');
      assert.deepEqual([compartilhado.tipo, compartilhado.evidencias.filter((e) => e.fonte === 'auditoria').length], ['VERIFICADA', 2], 'as duas origens ficam');
      // O importador do HBL nunca entra (consignatário do MBL ≠ importador do HBL).
      const m910 = await masterDe(pool, c.orgId, 'IM910');
      const hbl = await mbl(pool, c, { id: 'hbl1', processo: 'IM910', conhecimento: 'HBLSINT0001', sha: 11, consignee: `IMPORTADORA SINTETICA\nCNPJ ${mascara(CNPJ_OUTRA)}`, tipo: 'HBL' });
      const comHbl = await deps().fontes.identidadeDoConsignatario!(c.orgId, m910);
      assert.deepEqual([comHbl.tipo, comHbl.evidencias.some((e) => e.ref.endsWith(hbl))], ['VERIFICADA', false]);
      // Outra organização com o mesmo MBL e outro consignatário não interfere.
      const outra = await cenario(pool, 'ci-mbl-outra');
      await mbl(pool, outra, { id: 'o1', processo: 'IM910', conhecimento: 'MEDU9100001', sha: 10, consignee: `X\nCNPJ ${mascara(CNPJ_OUTRA)}` });
      assert.equal(motivo(await deps().fontes.identidadeDoConsignatario!(c.orgId, m910)), 'VERIFICADA');
    });

    await t.test('[CI-25] concorrência: gravações da mesma organização são serializadas no banco; poderes concorrentes com a revogação nunca entram depois dela', async () => {
      const c = await cenario(pool, 'ci-concorrencia');
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const sig = await registrarSignatarioLegal(deps(), admin, SIGNATARIO);
      const cadastroId = (sig as { id: string }).id;
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE id = $1`, [cadastroId])).rows[0].signatario_id;
      const em = rel.agora();
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        await a.query(`INSERT INTO organizacao_signatarios_legais (organization_id, signatario_id, evento, motivo, registrado_por_membership_id, registrado_em) VALUES ($1, $2, 'REVOGADO', 'saída sintética', $3, $4)`,
          [c.orgId, sid, c.membershipCaixa, em]);
        await b.query('BEGIN');
        const poderes = b.query(
          `INSERT INTO organizacao_signatarios_legais (organization_id, signatario_id, evento, evidencia, refere_cadastro_id, registrado_por_membership_id, registrado_em) VALUES ($1, $2, 'PODERES_COMPROVADOS', 'procuração sintética', $3, $4, $5)`,
          [c.orgId, sid, cadastroId, c.membershipCaixa, em]).then(() => 'GRAVOU', (e: Error) => e.message);
        const enquanto = await Promise.race([poderes, new Promise<string>((ok) => setTimeout(() => ok('ESPERANDO'), 400))]);
        await a.query('COMMIT');
        const depois = await poderes;
        await b.query(depois === 'GRAVOU' ? 'COMMIT' : 'ROLLBACK');
        assert.equal(enquanto, 'ESPERANDO', 'a segunda gravação espera a primeira terminar');
        assert.match(depois, /SIGNATARIO_REVOGADO/, 'vista a revogação, os poderes são recusados');
      } finally {
        a.release();
        b.release();
      }
      const eventos = (await pool.query(`SELECT evento FROM organizacao_signatarios_legais WHERE organization_id = $1 ORDER BY sequencia`, [c.orgId])).rows.map((r) => r.evento);
      assert.deepEqual(eventos, ['CADASTRADO', 'REVOGADO'], 'nada depois da revogação');
    });

    /** Modelos validados da revisão em vigor (arquivos sintéticos): o MESMO caminho de cadastro e validação. */
    async function modelosEmVigor(c: Cenario, rotulo: string) {
      const analista = { organizationId: c.orgId, membershipId: c.membershipPessoa };
      for (const tipo of TIPOS) {
        const r = await cadastrarModelo(deps(), analista, { tipo, versao: `vigor-${tipo}`, arquivo: arquivoSintetico(tipo, rotulo), definicao: DEFINICOES_EM_VIGOR[tipo] });
        assert.equal((await validarModelo(deps(), { organizationId: c.orgId, membershipId: c.membershipCaixa }, (r as { modeloId: string }).modeloId)).tipo, 'OK', tipo);
      }
    }
    const informadosDe = (c: Cenario, tipo: TipoDocumento) => DEFINICOES_EM_VIGOR[tipo].campos.filter((x) => x.fontesAceitas.includes('ANALISTA'))
      .map((x) => ({ dado: x.dado, valor: VALORES_SINTETICOS[x.dado], por: c.membershipPessoa, em: rel.agora().toISOString() }));
    const escolhasDe = (c: Cenario, tipo: TipoDocumento) => ESCOLHAS_SINTETICAS[tipo].map((e) => ({ ...e, por: c.membershipPessoa, em: rel.agora().toISOString() }));
    const L1B = ['liberacao_avaliacoes', 'liberacao_avaliacao_eventos', 'liberacao_reconstrucoes', 'liberacao_revisoes'];
    const contagemL1b = async (org: string) => Promise.all(L1B.map((tabela) => contar(pool, `SELECT count(*) n FROM ${tabela} WHERE organization_id = $1`, [org])));

    await t.test('[CI-17] os quatro modelos (revisão em vigor) reutilizam o MESMO cadastro: fixos e consignatário do cadastro, confirmados; variáveis do embarque; proveniência dupla', async () => {
      const c = await cenario(pool, 'ci-modelos');
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      await registrarCadastroInstitucional(deps(), admin, CADASTRO_COMPLETO);
      const sig = await registrarSignatarioLegal(deps(), admin, SIGNATARIO);
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE id = $1`, [(sig as { id: string }).id])).rows[0].signatario_id;
      await registrarPoderesDoSignatario(deps(), admin, sid, { evidencia: 'procuração sintética' });
      await modelosEmVigor(c, 'o19');
      const casos = TIPOS.map((tipo, i): [TipoDocumento, string] => [tipo, `IM92${i}`]);
      const FIXOS: Record<string, string> = {
        ORGANIZACAO_RAZAO_SOCIAL: CADASTRO_COMPLETO.razaoSocial, ORGANIZACAO_CNPJ: CNPJ_ORG, ORGANIZACAO_ENDERECO: CADASTRO_COMPLETO.endereco,
        ORGANIZACAO_TELEFONE: CADASTRO_COMPLETO.telefone, CONTATO_SOBREESTADIA_NOME: CADASTRO_COMPLETO.contatoSobreestadiaNome,
        CONTATO_SOBREESTADIA_EMAIL: CADASTRO_COMPLETO.contatoSobreestadiaEmail, EMAILS_PARA_RECIBO: CADASTRO_COMPLETO.emailsParaRecibo,
        SIGNATARIO_NOME: SIGNATARIO.nome, SIGNATARIO_CPF: CPF, CONSIGNATARIO_RAZAO_SOCIAL: CADASTRO_COMPLETO.razaoSocial, CONSIGNATARIO_QUALIFICACAO: QUALIFICACAO_DO_CADASTRO,
      };
      const l1bAntes = await contagemL1b(c.orgId);
      for (const [tipo, processo] of casos) {
        const e = await mbl(pool, c, { id: processo, processo, conhecimento: `MEDU${processo.slice(2)}0001`, sha: Number(processo.slice(2)), consignee: CONSIGNATARIO_ORG });
        const masterId = await masterDe(pool, c.orgId, processo);
        codigos.set(masterId, CODIGO[tipo]);
        const { r: av, chamadas } = await semOcr(() => avaliarDocumentacao(deps(), c.orgId, masterId, { informados: informadosDe(c, tipo), escolhas: escolhasDe(c, tipo) }));
        assert.deepEqual(chamadas, [], `${tipo}: zero OCR, IA ou Outlook`);
        const p = av.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'PRONTO' }>;
        assert.equal(p?.tipo, 'PRONTO', `${tipo}: ${JSON.stringify(av.situacao.pendencias).slice(0, 500)}`);
        const def = DEFINICOES_EM_VIGOR[tipo];
        const resolvido = new Map(p.plano.conteudo.campos.map((x) => [x.campo, x.valor]));
        for (const campo of def.campos) {
          const v = resolvido.get(campo.id);
          if (campo.fontesAceitas.includes('CADASTRO_DA_ORGANIZACAO') || campo.fontesAceitas.includes('CADASTRO_DO_SIGNATARIO_LEGAL')) {
            assert.equal(v, FIXOS[campo.dado], `${tipo}/${campo.id}: dado fixo do cadastro`);
          } else if (campo.dado === 'MBL') assert.equal(v, `MEDU${processo.slice(2)}0001`, `${tipo}/BL: do S6, do embarque`);
          else if (campo.dado === 'NAVIO_E_VIAGEM') assert.equal(v, 'NAVIO SINTETICO DE TESTE V001T', `${tipo}/navio: do MBL do embarque`);
          else if (campo.dado === 'CONTEINERES_DO_MASTER') assert.equal(v, `${C1}\n${C2}`, `${tipo}/contêineres: do MBL do embarque`);
          else if (campo.fontesAceitas.includes('ANALISTA')) assert.equal(v, VALORES_SINTETICOS[campo.dado], `${tipo}/${campo.id}: informado`);
          else assert.ok(v, `${tipo}/${campo.id}: ${JSON.stringify(v)}`);
        }
        const consignatario = def.campos.find((x) => CONSIGNATARIO_DADOS.includes(x.dado))!.id;
        const prov = p.plano.proveniencia.find((x) => x.campo === consignatario)!;
        assert.deepEqual(prov.fontes.map((f) => [f.fonte, f.evidencia.fonte, f.confirmacao?.evidencias.map((x) => x.ref)]),
          [['CADASTRO_DA_ORGANIZACAO', 'cadastro_institucional', [`auditoria_extracao:${e}`, conferido(prov.fontes[0].confirmacao!.evidencias[1].ref, /^cadastro_institucional:.*#cnpj$/)]]],
          `${tipo}: origem = cadastro; confirmação = a versão do MBL + o CNPJ comparado`);
        assert.equal(av.identidadeDoConsignatario?.tipo, 'VERIFICADA', `${tipo}: identidade conferida pelo CNPJ`);
        const fatos = fatosDocumentaisParaL1b(masterId, situacaoDaAgencia(masterId, armador(CODIGO[tipo], masterId)), av.documentos, av.assinaturas, av.tentativas, av.conferencias);
        assert.deepEqual(fatos.eventos, [], `${tipo}: nada novo para a L1b`);
        assert.ok(!JSON.stringify(fatos).includes(CNPJ_ORG), 'nenhum dado do cadastro chega à L1b');
      }
      assert.deepEqual(await contagemL1b(c.orgId), l1bAntes, 'nenhuma escrita na L1b, na projeção ou na reconstrução');
      // Um cadastro só: corrigir a razão social muda os quatro modelos de uma vez (inclusive o consignatário); o embarque não muda.
      rel.avancar(60_000);
      await registrarCadastroInstitucional(deps(), admin, { ...CADASTRO_COMPLETO, razaoSocial: 'ORGANIZACAO SINTETICA CORRIGIDA LTDA' });
      for (const [tipo, processo] of casos) {
        const masterId = await masterDe(pool, c.orgId, processo);
        const av = await avaliarDocumentacao(deps(), c.orgId, masterId, { informados: informadosDe(c, tipo), escolhas: escolhasDe(c, tipo) });
        const p = av.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'PRONTO' }>;
        const empresas = DEFINICOES_EM_VIGOR[tipo].campos.filter((x) => ['ORGANIZACAO_RAZAO_SOCIAL', 'CONSIGNATARIO_RAZAO_SOCIAL'].includes(x.dado)).map((x) => p.plano.conteudo.campos.find((y) => y.campo === x.id)?.valor);
        assert.ok(empresas.length && empresas.every((e) => e === 'ORGANIZACAO SINTETICA CORRIGIDA LTDA'), `${tipo}: ${JSON.stringify(empresas)}`);
        assert.equal(p.plano.conteudo.campos.find((y) => y.campo === 'BL')?.valor, `MEDU${processo.slice(2)}0001`);
      }
    });

    await t.test('[CI-18] exceção: só o consignatário falta (com o motivo, a causa e as evidências); o cadastro e o resto ficam; nada chega à L1b nem bloqueia a Liberação', async () => {
      const c = await cenario(pool, 'ci-excecao');
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      await registrarCadastroInstitucional(deps(), admin, CADASTRO_COMPLETO);
      await registrarSignatarioLegal(deps(), admin, SIGNATARIO);
      await modelosEmVigor(c, 'excecao');
      const l1bAntes = await contagemL1b(c.orgId);
      const situacoes = [];
      const extracoes: string[] = [];
      for (const [processo, consignee] of [['IM930', CONSIGNATARIO_ORG], ['IM931', `X\nCNPJ ${mascara(CNPJ_OUTRA)}`]] as const) {
        extracoes.push(await mbl(pool, c, { id: processo, processo, conhecimento: `MEDU${processo.slice(2)}0001`, sha: Number(processo.slice(2)), consignee }));
        const masterId = await masterDe(pool, c.orgId, processo);
        codigos.set(masterId, 'MSC');
        situacoes.push(await avaliarDocumentacao(deps(), c.orgId, masterId, { informados: informadosDe(c, 'MEMORANDO_MSC'), escolhas: escolhasDe(c, 'MEMORANDO_MSC') }));
      }
      const [verificada, divergente] = situacoes;
      assert.deepEqual([verificada.identidadeDoConsignatario?.tipo, divergente.identidadeDoConsignatario?.tipo === 'EXCECAO' && divergente.identidadeDoConsignatario.motivo],
        ['VERIFICADA', 'CNPJ_DIVERGENTE']);
      assert.equal(verificada.situacao.preenchimento?.tipo, 'PRONTO', 'com a identidade confirmada, nenhuma confirmação humana');
      const p = divergente.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'INCOMPLETO' }>;
      assert.equal(p.tipo, 'INCOMPLETO');
      assert.deepEqual(p.faltantes.map((f) => [f.campo, f.naoPublicados?.map((n) => [n.motivo, n.causa])]), [['CONSIGNATARIO', [[MOTIVO_IDENTIDADE_NAO_CONFIRMADA, 'CNPJ_DIVERGENTE']]]],
        'só o consignatário falta, com o motivo da exceção');
      assert.ok(p.faltantes[0].naoPublicados![0].evidencias!.some((e) => e.ref === `auditoria_extracao:${extracoes[1]}`), 'com as evidências da versão do MBL');
      assert.equal(p.resolvidos.campos.find((x) => x.campo === 'CONSIGNATARIO'), undefined, 'nunca substituído em silêncio');
      assert.equal(p.resolvidos.campos.find((x) => x.campo === 'SIGNATARIO')?.valor, SIGNATARIO.nome, 'o resto do documento fica');
      // A exceção não é pendência operacional: as pendências documentais são as do dado faltante; nada vai para a L1b.
      assert.deepEqual(divergente.situacao.pendencias.map((x) => x.passo), ['OBTER_DADOS_FALTANTES']);
      assert.ok(situacoes.every((a) => a.documentos.length === 0), 'nada é gerado só por avaliar');
      const prep = await prepararDocumento(deps(), { organizationId: c.orgId, membershipId: c.membershipPessoa }, await masterDe(pool, c.orgId, 'IM931'),
        { informados: informadosDe(c, 'MEMORANDO_MSC'), escolhas: escolhasDe(c, 'MEMORANDO_MSC') });
      assert.equal(prep.tipo, 'NAO_PREPARADO', 'só este documento não é gerado');
      assert.equal(await contar(pool, `SELECT count(*) n FROM documentos_apresentacao WHERE organization_id = $1`, [c.orgId]), 0);
      assert.deepEqual(await contagemL1b(c.orgId), l1bAntes, 'nenhum bloqueio, estágio, pendência ou próxima ação da L1b muda');
      // A leitura do Master (API) traz a exceção com as evidências de cada versão.
      s.como(acesso(c, c.membershipPessoa, 'ANALYST'));
      const lida = await s.master(await masterDe(pool, c.orgId, 'IM931'));
      assert.deepEqual([lida.status, lida.corpo.identidadeDoConsignatario.motivo, lida.corpo.identidadeDoConsignatario.versoes[0].textoOriginal],
        [200, 'CNPJ_DIVERGENTE', `X\nCNPJ ${mascara(CNPJ_OUTRA)}`]);
    });

    await t.test('[CI-24] representante revogado: os campos de quem assina faltam e o signatário vira pendência de configuração; o consignatário confirmado continua', async () => {
      const c = await cenario(pool, 'ci-revogado');
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      await registrarCadastroInstitucional(deps(), admin, CADASTRO_COMPLETO);
      const sig = await registrarSignatarioLegal(deps(), admin, SIGNATARIO);
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE id = $1`, [(sig as { id: string }).id])).rows[0].signatario_id;
      await modelosEmVigor(c, 'revogado');
      await mbl(pool, c, { id: 'IM940', processo: 'IM940', conhecimento: 'MEDU9400001', sha: 940, consignee: CONSIGNATARIO_ORG });
      const masterId = await masterDe(pool, c.orgId, 'IM940');
      codigos.set(masterId, 'HAPAG_LLOYD');
      assert.equal((await revogarSignatarioLegal(deps(), admin, sid, { motivo: 'saída sintética' })).tipo, 'REGISTRADO');
      const av = await avaliarDocumentacao(deps(), c.orgId, masterId, { informados: informadosDe(c, 'MEMORANDO_HAPAG_ROCHAMAR'), escolhas: escolhasDe(c, 'MEMORANDO_HAPAG_ROCHAMAR') });
      const p = av.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'INCOMPLETO' }>;
      assert.deepEqual(p.faltantes.map((f) => f.campo), ['REPRESENTANTE', 'CPF_DO_REPRESENTANTE']);
      assert.ok(av.situacao.pendencias.some((x) => x.passo === 'DEFINIR_SIGNATARIO_LEGAL'));
      assert.equal(p.resolvidos.campos.find((x) => x.campo === 'EXPORTADOR_IMPORTADOR')?.valor, CADASTRO_COMPLETO.razaoSocial);
    });

    await t.test('[CI-20] revisão da definição (0109): a versão validada da revisão 1 fica intacta; o MESMO arquivo ganha versão nova pendente até validar; o banco guarda a cadeia', { skip: SEM_MODELOS }, async () => {
      const c = await cenario(pool, 'ci-revisao');
      const analista = { organizationId: c.orgId, membershipId: c.membershipPessoa };
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const tipo: TipoDocumento = 'MEMORANDO_MSC';
      const oficial = MODELOS_OFICIAIS[tipo]!;
      // Uma organização que validou a revisão 1 antes da 14.20.
      const r1 = await cadastrarModelo(deps(), analista, { tipo, versao: `oficial-${ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256.slice(0, 12)}`, arquivo: oficial, definicao: DEFINICOES_PROPOSTAS[tipo] });
      const v1 = (r1 as { modeloId: string }).modeloId;
      assert.equal((await validarModelo(deps(), admin, v1)).tipo, 'OK');
      assert.deepEqual(await revisarDefinicaoDoModelo(deps(), { organizationId: c.orgId, membershipId: c.membershipCliente }, v1), { tipo: 'RECUSADO', motivo: 'PESSOA_SEM_PERMISSAO' });
      // Cadastrar o arquivo oficial de novo não muda nada validado.
      assert.deepEqual(await cadastrarModeloOficial(deps(), analista, tipo, oficial), { tipo: 'OK', modeloId: v1, novo: false });
      const rev = await revisarDefinicaoDoModelo(deps(), analista, v1);
      assert.equal(rev.tipo, 'OK');
      const v2 = (rev as { modeloId: string }).modeloId;
      const linhas = (await pool.query(`SELECT id, estado, origem, substitui_modelo_id, revisao_da_definicao, arquivo_sha256, definicao, evidencia FROM documentos_apresentacao_modelos WHERE organization_id = $1 ORDER BY revisao_da_definicao`, [c.orgId])).rows;
      assert.deepEqual(linhas.map((l) => [l.id, l.estado, l.origem, l.substitui_modelo_id, l.revisao_da_definicao, l.arquivo_sha256]), [
        [v1, 'VALIDADO', 'CADASTRO', null, 1, ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256],
        [v2, 'PENDENTE_DE_VALIDACAO', 'REVISAO_DA_DEFINICAO', v1, 2, ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256],
      ]);
      assert.equal(canonico(linhas[0].definicao), canonico(DEFINICOES_PROPOSTAS[tipo]), 'a leitura validada da revisão 1 não muda');
      assert.equal(canonico(linhas[1].definicao), canonico(DEFINICOES_EM_VIGOR[tipo]));
      assert.deepEqual(linhas[1].evidencia, { decisao: '14.20', revisa: v1 });
      assert.equal(modeloVigente(tipo, await deps().repo.versoes(c.orgId, tipo))?.modeloId, v1, 'até uma pessoa validar, a revisão 1 segue em uso');
      assert.deepEqual(await revisarDefinicaoDoModelo(deps(), analista, v1), { tipo: 'OK', modeloId: v2, novo: false }, 'idempotente');
      assert.deepEqual(await revisarDefinicaoDoModelo(deps(), analista, v2), { tipo: 'RECUSADO', motivo: 'VERSAO_NAO_ESTA_VALIDADA' });
      rel.avancar(60_000);
      assert.equal((await validarModelo(deps(), admin, v2)).tipo, 'OK');
      assert.equal(modeloVigente(tipo, await deps().repo.versoes(c.orgId, tipo))?.modeloId, v2, 'validada por pessoa, a revisão 2 entra em uso');
      assert.deepEqual(await revisarDefinicaoDoModelo(deps(), analista, v2), { tipo: 'RECUSADO', motivo: 'LEITURA_JA_E_A_EM_VIGOR' });
      // O banco: só do mesmo arquivo, de versão validada, com o número seguinte e leitura nova; o número não muda.
      const inserir = (p: { substitui: string; revisao: number; definicao: unknown; arquivo?: Uint8Array; sha?: string; versao: string }) => pool.query(
        `INSERT INTO documentos_apresentacao_modelos (organization_id, tipo, versao, arquivo, arquivo_sha256, origem, substitui_modelo_id, evidencia, definicao, cadastrado_por_membership_id, cadastrado_em, revisao_da_definicao)
         VALUES ($1, $2, $3, $4, $5, 'REVISAO_DA_DEFINICAO', $6, '{"decisao":"x"}', $7, $8, now(), $9)`,
        [c.orgId, tipo, p.versao, Buffer.from(p.arquivo ?? oficial), p.sha ?? ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256, p.substitui, JSON.stringify(p.definicao), c.membershipPessoa, p.revisao]);
      await assert.rejects(inserir({ substitui: v2, revisao: 3, definicao: DEFINICOES_EM_VIGOR[tipo], versao: 'x1' }), /REVISAO_SEM_LEITURA_NOVA/);
      await assert.rejects(inserir({ substitui: v2, revisao: 5, definicao: DEFINICOES_PROPOSTAS[tipo], versao: 'x2' }), /REVISAO_FORA_DE_ORDEM/);
      const outroArquivo = arquivoSintetico(tipo, 'outro');
      await assert.rejects(inserir({ substitui: v2, revisao: 3, definicao: DEFINICOES_PROPOSTAS[tipo], arquivo: outroArquivo, sha: sha256(outroArquivo), versao: 'x3' }), /REVISAO_DE_OUTRO_ARQUIVO/);
      const pend = await cadastrarModelo(deps(), analista, { tipo, versao: 'pendente-sintetica', arquivo: outroArquivo, definicao: DEFINICOES_PROPOSTAS[tipo] });
      await assert.rejects(inserir({ substitui: (pend as { modeloId: string }).modeloId, revisao: 2, definicao: DEFINICOES_EM_VIGOR[tipo], arquivo: outroArquivo, sha: sha256(outroArquivo), versao: 'x4' }),
        /REVISAO_SO_DE_VERSAO_VALIDADA/);
      const outraOrg = await cenario(pool, 'ci-revisao-outra');
      await assert.rejects(pool.query(
        `INSERT INTO documentos_apresentacao_modelos (organization_id, tipo, versao, arquivo, arquivo_sha256, origem, substitui_modelo_id, evidencia, definicao, cadastrado_por_membership_id, cadastrado_em, revisao_da_definicao)
         VALUES ($1, $2, 'x5', $3, $4, 'REVISAO_DA_DEFINICAO', $5, '{"decisao":"x"}', $6, $7, now(), 2)`,
        [outraOrg.orgId, tipo, Buffer.from(oficial), ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256, v1, JSON.stringify(DEFINICOES_EM_VIGOR[tipo]), outraOrg.membershipPessoa]),
      /REVISAO_DE_OUTRO_ARQUIVO|foreign key/, 'nunca de outra organização');
      await assert.rejects(pool.query(`UPDATE documentos_apresentacao_modelos SET revisao_da_definicao = 7 WHERE id = $1`, [v2]), /imutável/);
      await assert.rejects(pool.query(
        `INSERT INTO documentos_apresentacao_modelos (organization_id, tipo, versao, arquivo, arquivo_sha256, origem, definicao, cadastrado_por_membership_id, cadastrado_em, revisao_da_definicao)
         VALUES ($1, $2, 'x6', $3, $4, 'CADASTRO', $5, $6, now(), 2)`,
        [c.orgId, tipo, Buffer.from(oficial), ARQUIVOS_OFICIAIS_RECEBIDOS[tipo].sha256, JSON.stringify(DEFINICOES_EM_VIGOR[tipo]), c.membershipPessoa]), /check constraint/,
      'cadastro e substituto são sempre a leitura original (revisão 1)');
      // Organização nova: o cadastro oficial já recebe a revisão em vigor. Pendente com a revisão 1 (nunca editada): atualizada.
      const nova = await cenario(pool, 'ci-revisao-nova');
      const rn = await cadastrarModeloOficial(deps(), { organizationId: nova.orgId, membershipId: nova.membershipPessoa }, tipo, oficial);
      assert.equal(canonico((await deps().repo.versao(nova.orgId, (rn as { modeloId: string }).modeloId))!.definicao), canonico(DEFINICOES_EM_VIGOR[tipo]));
      const antiga = await cenario(pool, 'ci-revisao-pendente');
      const atorAntiga = { organizationId: antiga.orgId, membershipId: antiga.membershipPessoa };
      const ra = await cadastrarModelo(deps(), atorAntiga, { tipo, versao: 'oficial-antiga', arquivo: oficial, definicao: DEFINICOES_PROPOSTAS[tipo] });
      assert.deepEqual(await cadastrarModeloOficial(deps(), atorAntiga, tipo, oficial), { tipo: 'OK', modeloId: (ra as { modeloId: string }).modeloId, novo: false, leituraAtualizada: true });
      assert.equal(canonico((await deps().repo.versao(antiga.orgId, (ra as { modeloId: string }).modeloId))!.definicao), canonico(DEFINICOES_EM_VIGOR[tipo]));
      // Leitura pendente editada por pessoa: nunca sobrescrita.
      const editada = await cenario(pool, 'ci-revisao-editada');
      const atorEd = { organizationId: editada.orgId, membershipId: editada.membershipPessoa };
      const lida = { ...DEFINICOES_PROPOSTAS[tipo], campos: DEFINICOES_PROPOSTAS[tipo].campos.map((x) => (x.id === 'NAVIO' ? { ...x, rotulo: 'Navio (rótulo editado)' } : x)) };
      const re = await cadastrarModelo(deps(), atorEd, { tipo, versao: 'oficial-editada', arquivo: oficial, definicao: lida });
      assert.deepEqual(await cadastrarModeloOficial(deps(), atorEd, tipo, oficial), { tipo: 'OK', modeloId: (re as { modeloId: string }).modeloId, novo: false });
      assert.equal(canonico((await deps().repo.versao(editada.orgId, (re as { modeloId: string }).modeloId))!.definicao), canonico(lida));
    });
  } finally {
    await s.fechar();
    await pool.end();
  }
});

/** Confere o padrão e devolve o próprio valor (para comparar listas com um item variável). */
function conferido(valor: string, padrao: RegExp): string {
  assert.match(valor, padrao);
  return valor;
}
