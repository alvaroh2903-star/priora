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
  ARQUIVOS_OFICIAIS_RECEBIDOS, DEFINICOES_PROPOSTAS, DepsDocumentos, EventoDoSignatario, IdentidadeDoConsignatario, ResultadoDoPreenchimento, SituacaoDoConsignatario,
  TipoDocumento, avaliarDocumentacao, cadastrarModelo, cadastroVigente, canonico, cnpjsNoTexto, conferirConsignatario, consultarCadastroInstitucional, depsDocumentosPadrao,
  fatosDocumentaisParaL1b, pendenciasInstitucionais, registrarCadastroInstitucional, registrarPoderesDoSignatario, registrarSignatarioLegal, revogarSignatarioLegal,
  signatarioDaOrganizacao, signatariosVigentes, validarDadosInstitucionais, validarModelo, validarPoderes, validarSignatario,
} from '..';
import { arquivoSintetico, relogio } from './fixtures';
import { ESCOLHAS_SINTETICAS, VALORES_SINTETICOS } from './modelosReais';

/**
 * O1.8 — cadastro institucional da organização (fonte `CADASTRO_DA_ORGANIZACAO`), signatário legal (DOC-23) e
 * conferência da identidade do consignatário do MBL pelo CNPJ. Tudo SINTÉTICO: os CNPJs e o CPF são os de teste do
 * repositório ou calculados aqui; nenhum dado real de empresa ou pessoa. Nenhum OCR, nenhuma IA, nenhum Graph.
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
const mascara = (c: string) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
const CNPJ_ORG = VALORES_SINTETICOS.ORGANIZACAO_CNPJ;
const CNPJ_OUTRA = cnpjSintetico('987654320001');
const CNPJ_RUIM = `${CNPJ_ORG.slice(0, 13)}${(Number(CNPJ_ORG[13]) + 1) % 10}`;
const CPF = VALORES_SINTETICOS.SIGNATARIO_CPF;

/** Cadastro completo SINTÉTICO, com os valores de teste dos modelos reais. */
const CADASTRO_COMPLETO = {
  cnpj: mascara(CNPJ_ORG), razaoSocial: VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL, endereco: VALORES_SINTETICOS.ORGANIZACAO_ENDERECO,
  telefone: VALORES_SINTETICOS.ORGANIZACAO_TELEFONE, contatoSobreestadiaNome: VALORES_SINTETICOS.CONTATO_SOBREESTADIA_NOME,
  contatoSobreestadiaEmail: VALORES_SINTETICOS.CONTATO_SOBREESTADIA_EMAIL, emailsParaRecibo: VALORES_SINTETICOS.EMAILS_PARA_RECIBO,
};
const SIGNATARIO = { nome: VALORES_SINTETICOS.SIGNATARIO_NOME, cpf: '529.982.247-25', qualificacao: 'representante legal (sintético)', evidencia: 'documento societário sintético de teste' };

/** Consignatário como o OCR o leria, com o CNPJ da organização. */
const CONSIGNATARIO_ORG = `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${mascara(CNPJ_ORG)}\nRUA FICTICIA DE TESTE, 100`;

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
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, telefone: '   ' }), [{ campo: 'telefone', motivo: 'VAZIO' }]);
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, razaoSocial: 123 }), [{ campo: 'razaoSocial', motivo: 'NAO_E_TEXTO' }]);
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, contatoSobreestadiaEmail: 'sem-arroba' }), [{ campo: 'contatoSobreestadiaEmail', motivo: 'EMAIL_INVALIDO' }]);
  assert.deepEqual(problemas({ cnpj: CNPJ_ORG, emailsParaRecibo: 'a@exemplo.invalid; nao-e-email' }), [{ campo: 'emailsParaRecibo', motivo: 'EMAIL_INVALIDO' }]);
});

test('[CI-02b] o que falta cadastrar, por modelo: só os campos que cada modelo pede do cadastro; signatário e poderes só onde o modelo os usa', () => {
  const defs = (['MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR', 'TERMO_EVERGREEN'] as TipoDocumento[]).map((t) => DEFINICOES_PROPOSTAS[t]);
  const reg = (d: Record<string, unknown>) => ({ ...(validarDadosInstitucionais(d) as { dados: any }).dados, cadastroId: 'c1', motivo: null, registradoPor: 'm-admin', registradoEm: '2026-10-20T12:00:00.000Z' });
  const resumo = (cad: ReturnType<typeof reg> | null, sig: ReturnType<typeof signatariosVigentes>) =>
    pendenciasInstitucionais(defs, cad, sig, '2026-10-20').map((p) => [p.tipo, p.faltam.map((f) => f.campo), p.signatario, p.poderes]);
  assert.deepEqual(resumo(reg({ cnpj: CNPJ_ORG }), []), [
    ['MEMORANDO_MSC', [], 'SEM_CADASTRO_VALIDADO', null],
    ['MEMORANDO_HAPAG_ROCHAMAR', ['EMPRESA', 'TELEFONE'], 'SEM_CADASTRO_VALIDADO', 'NAO_COMPROVADOS'],
    ['MEMORANDO_ZIM_ROCHAMAR', ['EMPRESA', 'TELEFONE'], 'SEM_CADASTRO_VALIDADO', 'NAO_COMPROVADOS'],
    ['TERMO_EVERGREEN', ['EMPRESA_DAS_FATURAS', 'ENDERECO_DAS_FATURAS', 'CONTATO_SOBREESTADIA', 'EMAIL_DO_RESPONSAVEL', 'EMAILS_PARA_RECIBO', 'EMPRESA_SIGNATARIA'], 'SEM_CADASTRO_VALIDADO', 'NAO_COMPROVADOS'],
  ]);
  const eventos = [evento('e1', 's1', 'CADASTRADO', '2026-10-20T10:00:00.000Z'), evento('e2', 's1', 'PODERES_COMPROVADOS', '2026-10-20T10:05:00.000Z')];
  assert.deepEqual(resumo(reg(CADASTRO_COMPLETO), signatariosVigentes(eventos, '2026-10-20T12:00:00.000Z')), [
    ['MEMORANDO_MSC', [], 'DEFINIDO', null], ['MEMORANDO_HAPAG_ROCHAMAR', [], 'DEFINIDO', 'COMPROVADOS'],
    ['MEMORANDO_ZIM_ROCHAMAR', [], 'DEFINIDO', 'COMPROVADOS'], ['TERMO_EVERGREEN', [], 'DEFINIDO', 'COMPROVADOS'],
  ], 'um cadastro só serve aos quatro modelos');
  // Vale o registro MAIS RECENTE (o histórico fica); no mesmo instante, o de maior identificador, sempre o mesmo.
  const antigo = { ...reg({ cnpj: CNPJ_ORG }), cadastroId: 'c1', registradoEm: '2026-10-20T10:00:00.000Z' };
  const novo = { ...reg(CADASTRO_COMPLETO), cadastroId: 'c2', registradoEm: '2026-10-20T11:00:00.000Z' };
  assert.equal(cadastroVigente([antigo, novo])?.cadastroId, 'c2');
  assert.equal(cadastroVigente([novo, antigo])?.cadastroId, 'c2', 'a ordem de leitura não importa');
  assert.equal(cadastroVigente([{ ...antigo, registradoEm: novo.registradoEm }, novo])?.cadastroId, 'c2');
  assert.equal(cadastroVigente([]), null);
  assert.deepEqual(resumo(null, []).map((r) => r[1]), [[], ['EMPRESA', 'CNPJ', 'TELEFONE'], ['EMPRESA', 'CNPJ', 'TELEFONE'],
    ['EMPRESA_DAS_FATURAS', 'ENDERECO_DAS_FATURAS', 'CONTATO_SOBREESTADIA', 'EMAIL_DO_RESPONSAVEL', 'EMAILS_PARA_RECIBO', 'EMPRESA_SIGNATARIA']]);
});

/** Evento sintético do registro do signatário. */
function evento(eventoId: string, signatarioId: string, tipo: EventoDoSignatario['evento'], em: string, p: Partial<EventoDoSignatario> = {}): EventoDoSignatario {
  const dados = tipo === 'CADASTRADO' ? { nome: SIGNATARIO.nome, cpf: CPF, qualificacao: SIGNATARIO.qualificacao, evidencia: SIGNATARIO.evidencia } : { nome: null, cpf: null, qualificacao: null, evidencia: tipo === 'PODERES_COMPROVADOS' ? 'procuração sintética' : null };
  return { eventoId, signatarioId, evento: tipo, ...dados, poderesValidoAte: null, motivo: tipo === 'REVOGADO' ? 'saiu (sintético)' : null, registradoPor: 'm-admin', registradoEm: em, ...p };
}

test('[CI-03] signatário legal (DOC-23): dados validados, correção por novo registro, poderes só com evidência, revogação definitiva, nunca dois presumidos', () => {
  assert.deepEqual(validarSignatario(SIGNATARIO), { tipo: 'VALIDO', dados: { ...SIGNATARIO, cpf: CPF } });
  const problemas = (e: Record<string, unknown>) => { const r = validarSignatario(e); return r.tipo === 'INVALIDO' ? r.problemas.map((p) => `${p.campo}:${p.motivo}`) : []; };
  assert.deepEqual(problemas({ ...SIGNATARIO, cpf: '529.982.247-24' }), ['cpf:CPF_INVALIDO']);
  assert.deepEqual(problemas({ ...SIGNATARIO, evidencia: undefined }), ['evidencia:OBRIGATORIO'], 'sem evidência não há cadastro');
  assert.deepEqual(validarPoderes({ evidencia: 'procuração sintética', validoAte: '2028-02-29' }), { tipo: 'VALIDO', dados: { evidencia: 'procuração sintética', validoAte: '2028-02-29' } });
  assert.equal(validarPoderes({ evidencia: 'x', validoAte: '2027-02-29' }).tipo, 'INVALIDO', 'data inexistente');
  assert.equal(validarPoderes({ validoAte: '2028-01-01' }).tipo, 'INVALIDO', 'poderes nunca sem evidência');

  const eventos = [
    evento('e1', 'a', 'CADASTRADO', '2026-10-01T10:00:00.000Z'),
    evento('e2', 'b', 'CADASTRADO', '2026-10-01T11:00:00.000Z', { nome: 'OUTRO SIGNATARIO SINTETICO' }),
    evento('e3', 'a', 'CADASTRADO', '2026-10-02T10:00:00.000Z', { qualificacao: 'administrador (sintético)' }),
    evento('e4', 'a', 'PODERES_COMPROVADOS', '2026-10-03T10:00:00.000Z', { poderesValidoAte: '2026-12-31' }),
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

/* ---------------------------------- identidade do consignatário (puro) ---------------------------------- */

const versao = (extracaoId: string, valor: string | null) => ({ extracaoId, estado: valor === null ? { tipo: 'AUSENTE' as const, motivo: 'NAO_LIDO' as const } : { tipo: 'PRESENTE' as const, valor } });
const igual = (...textos: string[]): SituacaoDoConsignatario => ({ tipo: 'IGUAL', valores: [...new Set(textos)] });
const CAD = { cadastroId: 'cad-1', cnpj: CNPJ_ORG };
const conferir = (situacao: SituacaoDoConsignatario, textos: Array<string | null>, cadastro: typeof CAD | null = CAD): IdentidadeDoConsignatario =>
  conferirConsignatario({ situacao, versoes: textos.map((t, i) => versao(`v${i + 1}`, t)) }, cadastro);
const motivo = (r: IdentidadeDoConsignatario) => (r.tipo === 'EXCECAO' ? r.motivo : r.tipo);

test('[CI-04] CNPJs no texto: com ou sem máscara, inteiros; o número cortado, quebrado ou colado a outro dígito não é lido como CNPJ', () => {
  assert.deepEqual(cnpjsNoTexto(`EMPRESA SINTETICA\nCNPJ: ${mascara(CNPJ_ORG)}`), { validos: [CNPJ_ORG], invalidos: [], citaCnpj: true });
  assert.deepEqual(cnpjsNoTexto(`EMPRESA SINTETICA ${CNPJ_ORG}`), { validos: [CNPJ_ORG], invalidos: [], citaCnpj: false });
  assert.deepEqual(cnpjsNoTexto(`C.N.P.J. ${mascara(CNPJ_RUIM)}`), { validos: [], invalidos: [CNPJ_RUIM], citaCnpj: true });
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${mascara(CNPJ_ORG).slice(0, 15)}\n${mascara(CNPJ_ORG).slice(15)}`).validos, [], 'quebrado entre linhas');
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${mascara(CNPJ_ORG).slice(0, -1)}`).validos, [], 'cortado');
  assert.deepEqual(cnpjsNoTexto(`REF 9${CNPJ_ORG}`).validos, [], 'colado a outro dígito: não é um CNPJ');
  const m = mascara(CNPJ_ORG);
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${m.slice(0, 7)}\n${m.slice(7)}`).validos, [], 'quebra de linha entre grupos de dígitos');
  assert.deepEqual(cnpjsNoTexto(`CNPJ ${m.slice(0, 11)} ${m.slice(11)}`).validos, [], 'espaço dentro do número');
});

test('[CI-05] CNPJ correspondente: só o CNPJ válido, igual ao do cadastro e o mesmo em todas as versões verifica a identidade', () => {
  const r = conferir(igual(CONSIGNATARIO_ORG), [CONSIGNATARIO_ORG, CONSIGNATARIO_ORG]);
  assert.deepEqual(r, {
    tipo: 'VERIFICADA', cnpj: CNPJ_ORG,
    evidencias: [{ fonte: 'auditoria', ref: 'auditoria_extracao:v1' }, { fonte: 'auditoria', ref: 'auditoria_extracao:v2' }, { fonte: 'cadastro_institucional', ref: 'cadastro_institucional:cad-1#cnpj' }],
  });
  assert.equal(motivo(conferir(igual(`${CONSIGNATARIO_ORG}\nCNPJ ${CNPJ_ORG}`), [`${CONSIGNATARIO_ORG}\nCNPJ ${CNPJ_ORG}`])), 'VERIFICADA', 'o mesmo CNPJ escrito duas vezes é um só');
  assert.ok(!JSON.stringify(r).includes(VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL), 'só informa: nenhum dado do cadastro vira valor do consignatário');
});

test('[CI-06] CNPJ divergente, ausente, inválido, ilegível ou múltiplo: exceção documental com o motivo; nome igual nunca prova nada', () => {
  const texto = (cnpj: string) => `${VALORES_SINTETICOS.ORGANIZACAO_RAZAO_SOCIAL}\nCNPJ ${cnpj}`;
  const divergente = conferir(igual(texto(mascara(CNPJ_OUTRA))), [texto(mascara(CNPJ_OUTRA))]);
  assert.deepEqual([motivo(divergente), (divergente as { cnpjsEncontrados: string[] }).cnpjsEncontrados], ['CNPJ_DIVERGENTE', [CNPJ_OUTRA]], 'outra empresa, mesmo com o nome da organização');
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

test('[CI-07] múltiplas versões e diferença só de formatação: a situação é a da E1 (nenhum outro normalizador); divergência real não verifica', () => {
  const crlf = CONSIGNATARIO_ORG.replace(/\n/g, '\r\n');
  assert.equal(motivo(conferir({ tipo: 'SO_FORMATACAO', valores: [CONSIGNATARIO_ORG, crlf] }, [CONSIGNATARIO_ORG, crlf])), 'VERIFICADA', 'CRLF × LF (E1: SO_FORMATACAO)');
  const outroEndereco = CONSIGNATARIO_ORG.replace('100', '200');
  assert.equal(motivo(conferir({ tipo: 'DIVERGENTE', valores: [CONSIGNATARIO_ORG, outroEndereco] }, [CONSIGNATARIO_ORG, outroEndereco])), 'VERSOES_DIVERGENTES',
    'mesmo CNPJ, mas as versões divergem: a E1 manda, nada é escolhido');
  assert.equal(motivo(conferir(igual(CONSIGNATARIO_ORG), [CONSIGNATARIO_ORG, null])), 'VERIFICADA', 'versão sem consignatário não conta (a E1 já a considera)');
});

/* ------------------------------------------- estáticos ------------------------------------------- */

const raiz = path.resolve(__dirname, '..', '..', '..');
const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(d, e.name)) : [path.join(d, e.name)]));
const NOVOS = ['liberacao/documentos/dominio/institucional.ts', 'liberacao/documentos/dominio/identidadeDoConsignatario.ts', 'liberacao/documentos/aplicacao/cadastroInstitucional.ts'];

test('[CI-08] modelos oficiais preservados: as quatro definições e os arquivos oficiais esperados são exatamente os de antes', () => {
  const h = (v: unknown) => createHash('sha256').update(canonico(v)).digest('hex');
  assert.equal(h(DEFINICOES_PROPOSTAS), 'c2d1678a90b8e1d7fe6db72bb1a36f5d62aae6c2f84155cf8298240842a677e5', 'nenhum campo, fonte, layout, opção ou texto fixo mudou');
  assert.equal(h(ARQUIVOS_OFICIAIS_RECEBIDOS), 'c2c0cc52afa3b5209b5f283eb97428fd1ed51ba18371fb60dae321f08f024514');
  for (const t of ['MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR', 'TERMO_EVERGREEN'] as TipoDocumento[]) {
    assert.ok(DEFINICOES_PROPOSTAS[t].campos.filter((c) => /CONSIGNATARIO/.test(c.dado)).every((c) => c.fontesAceitas.join() === 'S2_AUDITORIA'), `${t}: consignatário só do S2 (DOC-17)`);
  }
});

test('[CI-09] zero OCR, IA ou Graph e nenhum dado jurídico fixo no código: os módulos novos só leem o que já está persistido', () => {
  for (const f of [...NOVOS, 'liberacao/documentos/aplicacao/postgres.ts']) {
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

test('[CI-10] nenhuma decisão nova na L1b: nenhum arquivo da L1a/L1b, da projeção (L2) ou da reconstrução (G-3c) usa o cadastro ou a conferência', () => {
  const arquivos = [...todos(path.join(raiz, 'liberacao', 'dominio')), ...todos(path.join(raiz, 'liberacao', 'aplicacao'))].filter((f) => f.endsWith('.ts') && !f.includes('__tests__'));
  assert.ok(arquivos.length > 10);
  for (const f of arquivos) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /cadastroInstitucional|institucional|identidadeDoConsignatario|conferirConsignatario/, path.relative(raiz, f));
});

/* ------------------------------------------------ PostgreSQL ------------------------------------------------ */

function conteiner(base: string): string {
  for (let d = 0; d <= 9; d++) if (validaISO6346(`${base}${d}`)) return `${base}${d}`;
  throw new Error(base);
}
const C1 = conteiner('TSTU000001');
const C2 = conteiner('TSTU000002');
const SHA = (n: number) => n.toString(16).padStart(64, '0');

/** Uma versão do MBL pelo caminho do DONO (S2), com o consignatário como o OCR o teria devolvido. */
async function mbl(pool: Pool, c: Cenario, v: { id: string; processo: string; conhecimento: string; sha: number; consignee: string | null; recebida?: string }) {
  const recebida = new Date(v.recebida ?? '2026-10-01T08:00:00Z');
  const campos: CamposDocumentaisExtraidos = { navio: 'NAVIO SINTETICO DE TESTE V001T', consignee: v.consignee, conteineres: [C1, C2] };
  const [r] = await persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: `msg-${v.id}`, internetMessageId: `<${v.id}@agente.teste>`, attachmentId: `anexo-${v.id}`, attachmentNome: 'MBL.pdf', contentType: 'application/pdf',
      remetente: 'agente@agente.teste', recebidaEm: recebida, referenciasBrutas: [v.processo], associacao: 'CITADA',
    },
    resultado: { tipoPorNome: 'MBL', tipoDetectado: 'MBL', legivel: true, conhecimento: v.conhecimento, camposDocumentais: campos, arquivoSha256: SHA(v.sha) },
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/liberacao/documentos/cadastro-institucional`;
  const pedir = async (caminho: string, corpo?: unknown) => {
    const r = await fetch(`${base}${caminho}`, corpo === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    return { status: r.status, corpo: await r.json() as any };
  };
  return { pedir, como: (a: AcessoDaPessoa | null) => { quem = a; }, fechar: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Conta (e bloqueia) qualquer chamada a OCR/IA ou download de anexo durante `fn`. */
async function semOcr<T>(fn: () => Promise<T>): Promise<{ r: T; chamadas: string[] }> {
  const chamadas: string[] = [];
  const g = gemini as unknown as Record<string, unknown>;
  const gr = graph as unknown as Record<string, unknown>;
  const originais = { doc: g.generateStructuredFromDocument, txt: g.generateStructured, anexo: gr.getAttachmentContent };
  g.generateStructuredFromDocument = async () => { chamadas.push('gemini.documento'); throw new Error('OCR proibido'); };
  g.generateStructured = async () => { chamadas.push('gemini.texto'); throw new Error('IA proibida'); };
  gr.getAttachmentContent = async () => { chamadas.push('graph.anexo'); throw new Error('download proibido'); };
  try {
    return { r: await fn(), chamadas };
  } finally {
    g.generateStructuredFromDocument = originais.doc; g.generateStructured = originais.txt; gr.getAttachmentContent = originais.anexo;
  }
}

test('O1.8 — cadastro institucional, signatário e conferência sobre o PostgreSQL', { skip: !url && 'DEMURRAGE_TEST_DATABASE_URL não definida' }, async (t) => {
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
      const r1 = await s.pedir('', { ...CADASTRO_COMPLETO, razaoSocial: 'NOME PROVISORIO SINTETICO', organizationId: outra.orgId, registradoPor: 'forjado' });
      assert.equal(r1.status, 201, JSON.stringify(r1.corpo));
      rel.avancar(60_000);
      const r2 = await s.pedir('', { ...CADASTRO_COMPLETO, motivo: 'razão social corrigida' });
      assert.equal(r2.status, 201);
      const g = await s.pedir('');
      assert.equal(g.status, 200);
      assert.deepEqual([g.corpo.vigente.cadastroId, g.corpo.vigente.cnpj, g.corpo.vigente.razaoSocial, g.corpo.vigente.registradoPor, g.corpo.vigente.motivo],
        [r2.corpo.id, CNPJ_ORG, CADASTRO_COMPLETO.razaoSocial, c.membershipCaixa, 'razão social corrigida']);
      assert.deepEqual(g.corpo.historico.map((h: { razaoSocial: string }) => h.razaoSocial), ['NOME PROVISORIO SINTETICO', CADASTRO_COMPLETO.razaoSocial], 'o histórico fica');
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
    });

    await t.test('[CI-13] histórico de alterações: append-only no banco; CNPJ inválido ou texto com quebra são recusados também pelo banco', async () => {
      const c = await cenario(pool, 'ci-hist');
      const ator = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const r = await registrarCadastroInstitucional(deps(), ator, CADASTRO_COMPLETO);
      assert.equal(r.tipo, 'REGISTRADO');
      const id = (r as { id: string }).id;
      await assert.rejects(pool.query(`UPDATE organizacao_cadastro_institucional SET razao_social = 'OUTRA' WHERE id = $1`, [id]));
      await assert.rejects(pool.query(`DELETE FROM organizacao_cadastro_institucional WHERE id = $1`, [id]));
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, registrado_por_membership_id) VALUES ($1, $2, $3)`,
        [c.orgId, CNPJ_RUIM, c.membershipCaixa]), /check constraint/);
      await assert.rejects(pool.query(`INSERT INTO organizacao_cadastro_institucional (organization_id, cnpj, endereco, registrado_por_membership_id) VALUES ($1, $2, $3, $4)`,
        [c.orgId, CNPJ_ORG, 'RUA\nSALA', c.membershipCaixa]), /check constraint/);
      const consulta = await consultarCadastroInstitucional(deps(), ator);
      assert.deepEqual(consulta.tipo === 'OK' && consulta.historico.map((h) => h.cadastroId), [id], 'as tentativas recusadas não entram no histórico');
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
    });

    await t.test('[CI-15] signatário legal pela API: cadastro, poderes com evidência, revogação; revogado e inexistente são recusados; a fonte devolve o vigente', async () => {
      const c = await cenario(pool, 'ci-sig');
      s.como(acesso(c, c.membershipCaixa, 'ADMIN'));
      const cad = await s.pedir('/signatarios', SIGNATARIO);
      assert.equal(cad.status, 201, JSON.stringify(cad.corpo));
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE id = $1`, [cad.corpo.id])).rows[0].signatario_id;
      assert.equal((await s.pedir(`/signatarios/${sid}/poderes`, { evidencia: 'procuração sintética', validoAte: '2027-12-31' })).status, 201);
      const vigentes = await deps().fontes.signatariosLegais(c.orgId, rel.agora());
      assert.deepEqual(vigentes.map((v) => [v.nome, v.cpf, v.qualificacao, v.poderes?.validoAte]), [[SIGNATARIO.nome, CPF, SIGNATARIO.qualificacao, '2027-12-31']]);
      assert.equal(signatarioDaOrganizacao(vigentes).tipo, 'DEFINIDO');
      assert.equal((await s.pedir('/signatarios/00000000-0000-4000-8000-000000000000/poderes', { evidencia: 'x' })).status, 404);
      assert.equal((await s.pedir(`/signatarios/${sid}/revogar`, {})).status, 422, 'revogar exige motivo');
      assert.equal((await s.pedir(`/signatarios/${sid}/revogar`, { motivo: 'saída sintética' })).status, 201);
      assert.equal((await s.pedir(`/signatarios/${sid}/poderes`, { evidencia: 'x' })).status, 409, 'revogado não recebe mais nada');
      assert.deepEqual(await deps().fontes.signatariosLegais(c.orgId, rel.agora()), [], 'revogado: os campos de quem assina voltam a faltar');
      await assert.rejects(pool.query(`INSERT INTO organizacao_signatarios_legais (organization_id, signatario_id, evento, evidencia, registrado_por_membership_id) VALUES ($1, $2, 'PODERES_COMPROVADOS', 'x', $3)`,
        [c.orgId, sid, c.membershipCaixa]), /SIGNATARIO_REVOGADO/, 'o banco também recusa');
    });

    await t.test('[CI-16] identidade no MBL persistido: correspondente, divergente, ausente, inválido e múltiplos; múltiplas versões; Master de vários Houses; zero OCR', async () => {
      const c = await cenario(pool, 'ci-mbl');
      const ator = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const conferencia = async (processo: string) => deps().fontes.identidadeDoConsignatario!(c.orgId, await masterDe(pool, c.orgId, processo));
      await mbl(pool, c, { id: 'p1', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 1, consignee: CONSIGNATARIO_ORG });
      assert.equal(motivo(await conferencia('IM901')), 'CADASTRO_INSTITUCIONAL_AUSENTE', 'antes do cadastro, nada se presume');
      await registrarCadastroInstitucional(deps(), ator, CADASTRO_COMPLETO);
      const { r, chamadas } = await semOcr(() => conferencia('IM901'));
      assert.deepEqual(chamadas, [], 'nenhuma chamada a OCR, IA ou anexo');
      assert.equal(motivo(r), 'VERIFICADA');
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
      // Múltiplas versões do MBL: só formatação (CRLF × LF) verifica; uma versão com outro texto diverge (E1).
      await mbl(pool, c, { id: 'p1-v2', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 2, consignee: CONSIGNATARIO_ORG.replace(/\n/g, '\r\n'), recebida: '2026-10-02T08:00:00Z' });
      assert.equal(motivo(await conferencia('IM901')), 'VERIFICADA', 'SO_FORMATACAO');
      await mbl(pool, c, { id: 'p1-v3', processo: 'IM901', conhecimento: 'MEDU9010001', sha: 3, consignee: CONSIGNATARIO_ORG.replace('100', '300'), recebida: '2026-10-03T08:00:00Z' });
      assert.equal(motivo(await conferencia('IM901')), 'VERSOES_DIVERGENTES');
      // Master compartilhado por vários Houses: a mesma identidade para o Master, de qualquer processo.
      await mbl(pool, c, { id: 'h1', processo: 'IM910', conhecimento: 'MEDU9100001', sha: 10, consignee: CONSIGNATARIO_ORG });
      await mbl(pool, c, { id: 'h2', processo: 'IM911', conhecimento: 'MEDU9100001', sha: 10, consignee: CONSIGNATARIO_ORG, recebida: '2026-10-02T08:00:00Z' });
      assert.equal(await masterDe(pool, c.orgId, 'IM910'), await masterDe(pool, c.orgId, 'IM911'));
      const compartilhado = await conferencia('IM910');
      assert.deepEqual([compartilhado.tipo, compartilhado.evidencias.filter((e) => e.fonte === 'auditoria').length], ['VERIFICADA', 2], 'as duas origens ficam');
      // Outra organização com o mesmo MBL e outro consignatário não interfere.
      const outra = await cenario(pool, 'ci-mbl-outra');
      await mbl(pool, outra, { id: 'o1', processo: 'IM910', conhecimento: 'MEDU9100001', sha: 10, consignee: `X\nCNPJ ${mascara(CNPJ_OUTRA)}` });
      assert.equal(motivo(await conferencia('IM910')), 'VERIFICADA');
    });

    await t.test('[CI-17] os quatro modelos reutilizam o MESMO cadastro: fixos do cadastro e do signatário; variáveis das fontes do embarque; consignatário segue faltando', async () => {
      const c = await cenario(pool, 'ci-modelos');
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      const analista = { organizationId: c.orgId, membershipId: c.membershipPessoa };
      await registrarCadastroInstitucional(deps(), admin, CADASTRO_COMPLETO);
      const sig = await registrarSignatarioLegal(deps(), admin, SIGNATARIO);
      const sid = (await pool.query(`SELECT signatario_id FROM organizacao_signatarios_legais WHERE id = $1`, [(sig as { id: string }).id])).rows[0].signatario_id;
      await registrarPoderesDoSignatario(deps(), admin, sid, { evidencia: 'procuração sintética' });
      const casos: Array<[TipoDocumento, string, string]> = [
        ['MEMORANDO_MSC', 'MSC', 'IM920'], ['MEMORANDO_HAPAG_ROCHAMAR', 'HAPAG_LLOYD', 'IM921'], ['MEMORANDO_ZIM_ROCHAMAR', 'ZIM', 'IM922'], ['TERMO_EVERGREEN', 'EVERGREEN', 'IM923'],
      ];
      const FIXOS: Record<string, string> = {
        ORGANIZACAO_RAZAO_SOCIAL: CADASTRO_COMPLETO.razaoSocial, ORGANIZACAO_CNPJ: CNPJ_ORG, ORGANIZACAO_ENDERECO: CADASTRO_COMPLETO.endereco,
        ORGANIZACAO_TELEFONE: CADASTRO_COMPLETO.telefone, CONTATO_SOBREESTADIA_NOME: CADASTRO_COMPLETO.contatoSobreestadiaNome,
        CONTATO_SOBREESTADIA_EMAIL: CADASTRO_COMPLETO.contatoSobreestadiaEmail, EMAILS_PARA_RECIBO: CADASTRO_COMPLETO.emailsParaRecibo,
        SIGNATARIO_NOME: SIGNATARIO.nome, SIGNATARIO_CPF: CPF,
      };
      for (const [tipo, codigo, processo] of casos) {
        const r = await cadastrarModelo(deps(), analista, { tipo, versao: `oficial-${tipo}`, arquivo: arquivoSintetico(tipo, 'o18'), definicao: DEFINICOES_PROPOSTAS[tipo] });
        assert.equal((await validarModelo(deps(), admin, (r as { modeloId: string }).modeloId)).tipo, 'OK', tipo);
        await mbl(pool, c, { id: processo, processo, conhecimento: `MEDU${processo.slice(2)}0001`, sha: Number(processo.slice(2)), consignee: CONSIGNATARIO_ORG });
        const masterId = await masterDe(pool, c.orgId, processo);
        codigos.set(masterId, codigo);
        const informados = DEFINICOES_PROPOSTAS[tipo].campos.filter((x) => x.fontesAceitas.includes('ANALISTA'))
          .map((x) => ({ dado: x.dado, valor: VALORES_SINTETICOS[x.dado], por: c.membershipPessoa, em: rel.agora().toISOString() }));
        const escolhas = ESCOLHAS_SINTETICAS[tipo].map((e) => ({ ...e, por: c.membershipPessoa, em: rel.agora().toISOString() }));
        const { r: av, chamadas } = await semOcr(() => avaliarDocumentacao(deps(), c.orgId, masterId, { informados, escolhas }));
        assert.deepEqual(chamadas, [], `${tipo}: zero OCR`);
        const p = av.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'INCOMPLETO' }>;
        assert.equal(p?.tipo, 'INCOMPLETO', tipo);
        const def = DEFINICOES_PROPOSTAS[tipo];
        const consignatario = def.campos.filter((x) => /CONSIGNATARIO/.test(x.dado)).map((x) => x.id);
        assert.deepEqual(p.faltantes.map((f) => [f.campo, f.naoPublicados?.map((n) => n.motivo)]), consignatario.map((x) => [x, ['CONSIGNATARIO_SEM_CRITERIO_APROVADO']]),
          `${tipo}: só o consignatário falta (escrita pelo cadastro aguarda validação)`);
        assert.deepEqual([p.divergentes, p.problemasDeOpcao], [[], []], tipo);
        const resolvido = new Map(p.resolvidos.campos.map((x) => [x.campo, x.valor]));
        for (const campo of def.campos.filter((x) => !consignatario.includes(x.id))) {
          const v = resolvido.get(campo.id);
          if (campo.fontesAceitas.includes('CADASTRO_DA_ORGANIZACAO') || campo.fontesAceitas.includes('CADASTRO_DO_SIGNATARIO_LEGAL')) {
            assert.equal(v, FIXOS[campo.dado], `${tipo}/${campo.id}: dado fixo do cadastro`);
          } else if (campo.dado === 'MBL') assert.equal(v, `MEDU${processo.slice(2)}0001`, `${tipo}/BL: do S6, do embarque`);
          else if (campo.dado === 'NAVIO_E_VIAGEM') assert.equal(v, 'NAVIO SINTETICO DE TESTE V001T', `${tipo}/navio: do MBL do embarque`);
          else if (campo.dado === 'CONTEINERES_DO_MASTER') assert.equal(v, `${C1}\n${C2}`, `${tipo}/contêineres: do MBL do embarque`);
          else if (campo.fontesAceitas.includes('ANALISTA')) assert.equal(v, VALORES_SINTETICOS[campo.dado], `${tipo}/${campo.id}: informado`);
          else assert.ok(v, `${tipo}/${campo.id}: ${JSON.stringify(v)}`);
        }
        assert.equal(av.identidadeDoConsignatario?.tipo, 'VERIFICADA', `${tipo}: identidade conferida pelo CNPJ`);
        // Nenhuma decisão nova na L1b: sem preparação, nenhum fato; a conferência não chega lá.
        const fatos = fatosDocumentaisParaL1b(masterId, situacaoDaAgencia(masterId, armador(codigo, masterId)), av.documentos, av.assinaturas, av.tentativas, av.conferencias);
        assert.deepEqual(fatos.eventos, [], `${tipo}: nada novo para a L1b`);
        assert.ok(!JSON.stringify(fatos).includes(CNPJ_ORG), 'nenhum dado do cadastro chega à L1b');
      }
      // Um cadastro só: corrigir a razão social muda os quatro modelos de uma vez; os dados do embarque não mudam.
      rel.avancar(60_000);
      await registrarCadastroInstitucional(deps(), admin, { ...CADASTRO_COMPLETO, razaoSocial: 'ORGANIZACAO SINTETICA CORRIGIDA LTDA' });
      for (const [tipo, , processo] of casos) {
        const masterId = await masterDe(pool, c.orgId, processo);
        const av = await avaliarDocumentacao(deps(), c.orgId, masterId);
        const p = av.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'INCOMPLETO' }>;
        const empresas = DEFINICOES_PROPOSTAS[tipo].campos.filter((x) => x.dado === 'ORGANIZACAO_RAZAO_SOCIAL').map((x) => p.resolvidos.campos.find((y) => y.campo === x.id)?.valor);
        assert.ok(empresas.every((e) => e === 'ORGANIZACAO SINTETICA CORRIGIDA LTDA'), `${tipo}: ${JSON.stringify(empresas)}`);
        assert.equal(p.resolvidos.campos.find((y) => y.campo === 'BL')?.valor, `MEDU${processo.slice(2)}0001`);
      }
    });

    await t.test('[CI-18] exceção de CNPJ não bloqueia nada: o documento fica como antes (consignatário faltando), sem pendência nova nem tarefa', async () => {
      const c = await cenario(pool, 'ci-excecao');
      const admin = { organizationId: c.orgId, membershipId: c.membershipCaixa };
      await registrarCadastroInstitucional(deps(), admin, CADASTRO_COMPLETO);
      await registrarSignatarioLegal(deps(), admin, SIGNATARIO);
      const r = await cadastrarModelo(deps(), { organizationId: c.orgId, membershipId: c.membershipPessoa }, { tipo: 'MEMORANDO_MSC', versao: 'o18', arquivo: arquivoSintetico('MEMORANDO_MSC', 'excecao'), definicao: DEFINICOES_PROPOSTAS.MEMORANDO_MSC });
      await validarModelo(deps(), admin, (r as { modeloId: string }).modeloId);
      const situacoes = [];
      for (const [processo, consignee] of [['IM930', CONSIGNATARIO_ORG], ['IM931', `X\nCNPJ ${mascara(CNPJ_OUTRA)}`]] as const) {
        await mbl(pool, c, { id: processo, processo, conhecimento: `MEDU${processo.slice(2)}0001`, sha: Number(processo.slice(2)), consignee });
        const masterId = await masterDe(pool, c.orgId, processo);
        codigos.set(masterId, 'MSC');
        situacoes.push(await avaliarDocumentacao(deps(), c.orgId, masterId));
      }
      const [verificada, divergente] = situacoes;
      assert.deepEqual([verificada.identidadeDoConsignatario?.tipo, divergente.identidadeDoConsignatario?.tipo === 'EXCECAO' && divergente.identidadeDoConsignatario.motivo],
        ['VERIFICADA', 'CNPJ_DIVERGENTE']);
      const passos = (a: typeof verificada) => a.situacao.pendencias.map((p) => p.passo);
      assert.deepEqual(passos(divergente), passos(verificada), 'a exceção não cria pendência nem tarefa: a situação é a mesma');
      const incompleto = (a: typeof verificada) => a.situacao.preenchimento as Extract<ResultadoDoPreenchimento, { tipo: 'INCOMPLETO' }>;
      for (const a of [verificada, divergente]) {
        assert.equal(incompleto(a).resolvidos.campos.find((x) => x.campo === 'CONSIGNATARIO'), undefined, 'nunca substituído pelos dados do cadastro');
        assert.deepEqual(incompleto(a).faltantes.map((f) => [f.campo, f.naoPublicados?.map((n) => n.motivo)]), [['CONSIGNATARIO', ['CONSIGNATARIO_SEM_CRITERIO_APROVADO']]],
          'o campo fica como antes, com o motivo da 14.18');
      }
      assert.equal(await contar(pool, `SELECT count(*) n FROM documentos_apresentacao WHERE organization_id = $1`, [c.orgId]), 0, 'nada é gerado nem presumido');
    });
  } finally {
    await s.fechar();
    await pool.end();
  }
});
