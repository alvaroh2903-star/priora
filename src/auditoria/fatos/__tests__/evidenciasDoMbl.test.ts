import '../../../operacional/__tests__/ambiente';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import * as gemini from '../../../ai/geminiClient';
import * as graph from '../../../graph/graphService';
import { testDatabaseUrl, testPool } from '../../../demurrage-engine/__tests__/testDb';
import { Cenario, cenario } from '../../../operacional/__tests__/cenario';
import { preparar } from '../../../liberacao/aplicacao/__tests__/apoio';
import { validaISO6346 } from '../../preAlerta/normalizacao';
import { CamposDocumentaisExtraidos, persistirExtracoesAuditoria } from '../extracoes';
import { LeituraDoMblDoMaster, evidenciasDoMblDoMaster, leiturasDoMblDoMaster } from '../camposDoMbl';
import { EvidenciasDoMbl, LeituraParaEvidencia, evidenciasDoMbl } from '../evidenciasDoMbl';
import {
  DADOS_DOS_MODELOS, DEFINICOES_PROPOSTAS, LeituraDoMbl, TipoDocumento, dadosDoMbl, estadoDoDado, fontesConfiaveisPostgres,
} from '../../../liberacao/documentos';
import { valorEscritoNoLugar } from '../../../liberacao/documentos/dominio/formatos';

/**
 * E1 — contrato de evidências do MBL (dono: Auditoria) consumido pela Liberação. O contrato diz o que as leituras JÁ
 * persistidas permitem afirmar (estado documental); a Liberação só aplica a sua regra de uso por cima (14.18 para o
 * consignatário). Fixtures sintéticas (nenhuma empresa, BL ou contêiner real); nenhum OCR, nenhuma IA, nenhum Graph.
 */

const url = testDatabaseUrl();
const SHA = (n: number) => n.toString(16).padStart(64, '0');

function conteiner(base: string): string {
  for (let d = 0; d <= 9; d++) if (validaISO6346(`${base}${d}`)) return `${base}${d}`;
  throw new Error(base);
}
const C1 = conteiner('TSTU000001');
const C2 = conteiner('TSTU000002');
const INVALIDO = `${C1.slice(0, 10)}${(Number(C1[10]) + 1) % 10}`;

const NAVIO = 'NAVIO_E_VIAGEM';
const CONTEINERES = 'CONTEINERES_DO_MASTER';
const CONSIGNATARIO = 'CONSIGNATARIO_RAZAO_SOCIAL';
const QUALIFICACAO = 'CONSIGNATARIO_QUALIFICACAO';
const TODOS = [NAVIO, CONTEINERES, CONSIGNATARIO, QUALIFICACAO];

/** Uma leitura do contrato S2, como `leiturasDoMblDoMaster` a devolveria. */
function leitura(id: string, campos: CamposDocumentaisExtraidos | null, o: { masterId?: string; recebida?: string; sha?: number; legivel?: boolean; processos?: string[] } = {}): LeituraParaEvidencia {
  const recebida = new Date(o.recebida ?? '2026-09-01T08:00:00.000Z');
  return {
    extracaoId: id, masterId: o.masterId ?? 'M1', processoIds: o.processos ?? ['P1'], conhecimento: 'MBLSINTETICO0001', campos,
    extrator: 'auditoria.docExtractor', extratorVersao: '2', modelo: 'modelo-teste', extraidaEm: recebida,
    origem: { messageId: `msg-${id}`, internetMessageId: `<${id}@agente.teste>`, attachmentId: `anexo-${id}`, attachmentNome: 'MBL.pdf', remetente: 'agente@agente.teste', recebidaEm: recebida, arquivoSha256: o.sha === undefined ? null : SHA(o.sha) },
    ...(o.legivel === undefined ? {} : { legivel: o.legivel }),
  };
}
const campos = (c: Partial<CamposDocumentaisExtraidos> = {}): CamposDocumentaisExtraidos =>
  ({ navio: 'NAVIO SINTETICO A V.001', consignee: 'EMPRESA SINTETICA DE TESTE LTDA', conteineres: [C1, C2], ...c });

/** A Liberação recebe as versões do contrato (o mesmo mapeamento do adaptador PostgreSQL). */
const paraLiberacao = (ev: EvidenciasDoMbl): LeituraDoMbl[] =>
  ev.versoes.map((v) => ({ extracaoId: v.extracaoId, masterId: ev.masterId, observadoEm: v.observadoEm.toISOString(), estados: v.estados }));

/* ------------------------------------------------ puro ------------------------------------------------ */

test('[E1C-01] MBL com evidências consistentes: cada campo presente e concordante entre versões, com a origem, o hash e a versão do extrator', () => {
  const ev = evidenciasDoMbl('M1', true, [
    leitura('v1', campos({ navio: 'NAVIO SINTETICO A  V.001', conteineres: [`${C1.slice(0, 4)} ${C1.slice(4)}`, C2.toLowerCase()] }), { sha: 1 }),
    leitura('v2', campos(), { sha: 2, recebida: '2026-09-03T08:00:00.000Z' }),
  ]);
  assert.equal(ev.vinculo, 'VINCULADO');
  assert.deepEqual(ev.situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO A  V.001', 'NAVIO SINTETICO A V.001'] },
    'espaços repetidos não contam (DOC-31.B); os dois textos originais ficam, nenhum é escolhido');
  assert.deepEqual(ev.situacao.conteineres, { tipo: 'IGUAL', valores: [`${C1}\n${C2}`] }, 'normalização do PB-001');
  assert.deepEqual(ev.situacao.consignee, { tipo: 'IGUAL', valores: ['EMPRESA SINTETICA DE TESTE LTDA'] });
  assert.deepEqual(ev.versoes[0].campos, campos({ navio: 'NAVIO SINTETICO A  V.001', conteineres: [`${C1.slice(0, 4)} ${C1.slice(4)}`, C2.toLowerCase()] }), 'os campos como persistidos');
  assert.deepEqual(ev.versoes.map((v) => [v.extracaoId, v.evidencia.ref, v.origem.arquivoSha256, v.extrator, v.extratorVersao, v.modelo, v.observadoEm.toISOString()]), [
    ['v1', 'auditoria_extracao:v1', SHA(1), 'auditoria.docExtractor', '2', 'modelo-teste', '2026-09-01T08:00:00.000Z'],
    ['v2', 'auditoria_extracao:v2', SHA(2), 'auditoria.docExtractor', '2', 'modelo-teste', '2026-09-03T08:00:00.000Z'],
  ]);
  assert.deepEqual(ev.versoes[0].estados.navio, { tipo: 'PRESENTE', valor: 'NAVIO SINTETICO A  V.001' }, 'por versão: o texto como foi lido (pontas aparadas)');
});

test('[E1C-02] campo ausente: não lido pelo OCR ou não preservado (anterior à 0106) — nada é inventado', () => {
  const ev = evidenciasDoMbl('M1', true, [leitura('v1', campos({ navio: '   ', consignee: null, conteineres: [] })), leitura('v0', null)]);
  assert.deepEqual(ev.versoes.map((v) => [v.estados.navio, v.estados.consignee, v.estados.conteineres]), [
    [{ tipo: 'AUSENTE', motivo: 'NAO_LIDO' }, { tipo: 'AUSENTE', motivo: 'NAO_LIDO' }, { tipo: 'AUSENTE', motivo: 'NAO_LIDO' }],
    [{ tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' }, { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' }, { tipo: 'AUSENTE', motivo: 'NAO_PRESERVADO' }],
  ]);
  assert.deepEqual(ev.situacao, { navio: { tipo: 'AUSENTE' }, consignee: { tipo: 'AUSENTE' }, conteineres: { tipo: 'AUSENTE' } });
  assert.deepEqual(evidenciasDoMbl('M1', true, []).situacao.navio, { tipo: 'AUSENTE' }, 'vinculado sem leitura do MBL');
  const r = dadosDoMbl('M1', paraLiberacao(ev), TODOS);
  assert.deepEqual([r.valores, r.naoPublicados], [[], []], 'a Liberação não recebe valor nem motivo inventado');
});

test('[E1C-03] documento ilegível: não traz campo nenhum, não decide nada; só ilegíveis → não utilizável', () => {
  const so = evidenciasDoMbl('M1', true, [leitura('ruim', campos(), { legivel: false })]);
  assert.deepEqual(so.versoes[0].estados.navio, { tipo: 'NAO_UTILIZAVEL', motivo: 'DOCUMENTO_ILEGIVEL' });
  assert.deepEqual(so.situacao.navio, { tipo: 'NAO_UTILIZAVEL', motivos: ['DOCUMENTO_ILEGIVEL'] });
  const misto = evidenciasDoMbl('M1', true, [leitura('ruim', campos({ navio: 'OUTRO' }), { legivel: false }), leitura('boa', campos())]);
  assert.deepEqual(misto.situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO A V.001'] }, 'a versão ilegível não cria divergência');
  const r = dadosDoMbl('M1', paraLiberacao(misto), [NAVIO]);
  assert.deepEqual(r.valores.map((v) => [v.valor, v.evidencia.ref]), [['NAVIO SINTETICO A V.001', 'auditoria_extracao:boa']], 'na Liberação a ilegível não conta (como antes: o S2 nem a vincula)');
  assert.deepEqual(dadosDoMbl('M1', paraLiberacao(so), TODOS), { valores: [], naoPublicados: [] });
});

test('[E1C-04] versões divergentes: todos os valores ficam, nenhum vence; leitura não utilizável em qualquer versão retém o campo', () => {
  const ev = evidenciasDoMbl('M1', true, [
    leitura('v1', campos({ navio: 'NAVIO A', conteineres: [C1, INVALIDO] })),
    leitura('v2', campos({ navio: 'NAVIO B', conteineres: [C1, C2] }), { recebida: '2026-09-05T08:00:00.000Z' }),
  ]);
  assert.deepEqual(ev.situacao.navio, { tipo: 'DIVERGENTE', valores: ['NAVIO A', 'NAVIO B'] });
  assert.deepEqual(ev.situacao.conteineres, { tipo: 'NAO_UTILIZAVEL', motivos: ['CONTEINER_FORA_DO_PADRAO_ISO_6346'] });
  const repetido = evidenciasDoMbl('M1', true, [leitura('v3', campos({ conteineres: [C1, C1.toLowerCase()] }))]);
  assert.deepEqual(repetido.situacao.conteineres, { tipo: 'NAO_UTILIZAVEL', motivos: ['CONTEINER_REPETIDO'] }, 'DOC-27');
  // A Liberação mantém o comportamento: cada versão do navio segue (a divergência é do preenchimento); a lista fica retida.
  const r = dadosDoMbl('M1', paraLiberacao(ev), [NAVIO, CONTEINERES]);
  assert.deepEqual(r.valores.map((v) => [v.dado, v.valor, v.evidencia.ref]), [[NAVIO, 'NAVIO A', 'auditoria_extracao:v1'], [NAVIO, 'NAVIO B', 'auditoria_extracao:v2']]);
  assert.deepEqual(r.naoPublicados.map((n) => [n.dado, n.motivo, n.evidencia.ref]), [
    [CONTEINERES, 'CONTEINER_FORA_DO_PADRAO_ISO_6346', 'auditoria_extracao:v1'], [CONTEINERES, 'OUTRA_VERSAO_SEM_LEITURA_CONFIAVEL', 'auditoria_extracao:v2'],
  ]);
});

test('[E1C-05] anexos repetidos com o mesmo conteúdo: cada origem fica (nada é deduplicado nem escolhido) e o campo é consistente', () => {
  const ev = evidenciasDoMbl('M1', true, [leitura('e1', campos(), { sha: 7 }), leitura('e2', campos(), { sha: 7, recebida: '2026-09-02T08:00:00.000Z' })]);
  assert.deepEqual(ev.versoes.map((v) => [v.origem.messageId, v.origem.attachmentId, v.origem.arquivoSha256]), [['msg-e1', 'anexo-e1', SHA(7)], ['msg-e2', 'anexo-e2', SHA(7)]]);
  assert.deepEqual(ev.situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO A V.001'] });
});

test('[E1C-08a] sem vínculo documental confiável: nenhuma leitura é do Master, mesmo que venha na entrada; leitura de outro Master nunca entra', () => {
  const sem = evidenciasDoMbl('M1', false, [leitura('v1', campos())]);
  assert.deepEqual([sem.vinculo, sem.versoes, sem.situacao.navio, sem.situacao.consignee], ['SEM_VINCULO_VALIDO', [], { tipo: 'SEM_VINCULO_DOCUMENTAL' }, { tipo: 'SEM_VINCULO_DOCUMENTAL' }]);
  const outro = evidenciasDoMbl('M1', true, [leitura('v1', campos({ navio: 'DO OUTRO' }), { masterId: 'M2' })]);
  assert.deepEqual([outro.versoes, outro.situacao.navio], [[], { tipo: 'AUSENTE' }]);
});

test('[E1C-09] consignatário: a Auditoria o informa como PRESENTE (texto lido); a Liberação continua sem publicá-lo (14.18)', () => {
  const ev = evidenciasDoMbl('M1', true, [leitura('v1', campos({ consignee: '  EMPRESA SINTETICA LTDA\nRUA FICTICIA 1  ' }))]);
  assert.deepEqual(ev.versoes[0].estados.consignee, { tipo: 'PRESENTE', valor: 'EMPRESA SINTETICA LTDA\nRUA FICTICIA 1' }, 'texto literal: quebra de linha preservada');
  const [l] = paraLiberacao(ev);
  for (const d of [CONSIGNATARIO, QUALIFICACAO]) assert.deepEqual(estadoDoDado(l, d), { tipo: 'NAO_CONFIAVEL', motivo: 'CONSIGNATARIO_SEM_CRITERIO_APROVADO' });
  const r = dadosDoMbl('M1', [l], [CONSIGNATARIO, QUALIFICACAO]);
  assert.deepEqual(r.valores, [], 'nenhum valor de consignatário chega ao documento');
  assert.deepEqual(r.naoPublicados.map((n) => n.motivo), ['CONSIGNATARIO_SEM_CRITERIO_APROVADO', 'CONSIGNATARIO_SEM_CRITERIO_APROVADO']);
  assert.ok(!JSON.stringify(r).includes('EMPRESA SINTETICA'), 'nem o texto aparece no que a Liberação devolve');
});

/* ------------- O1.6: IGUAL, SO_FORMATACAO e DIVERGENTE — na dúvida, diverge; nada é escolhido ------------- */

type Tipo = 'IGUAL' | 'SO_FORMATACAO' | 'DIVERGENTE';
type CampoDeTexto = 'navio' | 'consignee';
const comCampo = (campo: CampoDeTexto, t: string) => (campo === 'navio' ? campos({ navio: t }) : campos({ consignee: t }));
/** As versões de UM campo de texto, nesta ordem de leitura, pelo contrato. */
const evDe = (campo: CampoDeTexto, textos: ReadonlyArray<string>) =>
  evidenciasDoMbl('M1', true, textos.map((t, i) => leitura(`t${i}`, comCampo(campo, t), { recebida: new Date(Date.UTC(2026, 8, 1 + i, 8)).toISOString() })));
const situacaoDe = (campo: CampoDeTexto, textos: ReadonlyArray<string>) => evDe(campo, textos).situacao[campo];
const distintos = (textos: ReadonlyArray<string>) => [...new Set(textos.map((t) => t.trim()))];

const ALFA = 'EMPRESA SINTETICA ALFA LTDA';
const RUA = 'RUA FICTICIA DAS FLORES, 100';
/** Os 22 casos sintéticos da investigação O1.5, com a classificação exigida pela O1.6. */
const CASOS_O15: ReadonlyArray<[string, CampoDeTexto, string, string, Tipo, string]> = [
  ['F1', 'consignee', `${ALFA}\n${RUA}`, `${ALFA} ${RUA}`, 'DIVERGENTE', 'quebra retirada entre textos: muda onde termina a razão social'],
  ['F2', 'consignee', 'EMPRESA  SINTETICA   ALFA LTDA', ALFA, 'IGUAL', 'espaços repetidos (DOC-31.B)'],
  ['F3', 'consignee', `${ALFA}\r\n${RUA}`, `${ALFA}\n${RUA}`, 'SO_FORMATACAO', 'CRLF × LF'],
  ['F4', 'consignee', `${ALFA} \n${RUA}`, `${ALFA}\n  ${RUA}`, 'DIVERGENTE', 'indentação da linha seguinte conta (o espaço no fim da linha, não)'],
  ['F5', 'consignee', `EMPRESA SINTETICA ALFA COMERCIO DE\nPRODUTOS LTDA\n${RUA}`, `EMPRESA SINTETICA ALFA COMERCIO DE PRODUTOS LTDA\n${RUA}`, 'DIVERGENTE', 'quebra a mais dentro do nome'],
  ['F6', 'consignee', `${ALFA}\n${RUA}\nSAO PAULO SP`, `${ALFA} ${RUA}\nSAO PAULO SP`, 'DIVERGENTE', 'razão social e endereço na mesma linha numa versão'],
  ['S1', 'consignee', `${ALFA}\n${RUA}`, `EMPRESA SINTETICA ALFA\nLTDA ${RUA}`, 'DIVERGENTE', 'quebra em outro lugar: outra razão social'],
  ['S2', 'consignee', 'EMPRESA SINTETICA\nALFA COMERCIO LTDA', 'EMPRESA SINTETICA ALFA\nCOMERCIO LTDA', 'DIVERGENTE', 'duas quebras de layout do mesmo nome'],
  ['S3', 'consignee', `${ALFA}\n\n${RUA}`, `${ALFA}\n${RUA}`, 'DIVERGENTE', 'linha em branco conta'],
  ['R1', 'consignee', ALFA, 'EMPRESA SINTETICA ALFE LTDA', 'DIVERGENTE', 'nome empresarial alterado'],
  ['R2', 'consignee', `${ALFA}\nCNPJ 12.345.678/0001-00`, `${ALFA}\nCNPJ 12.345.678/0001-01`, 'DIVERGENTE', 'CNPJ alterado'],
  ['R3', 'consignee', `${ALFA}\n${RUA}`, `${ALFA}\nRUA FICTICIA DAS FLORES, 1000`, 'DIVERGENTE', 'endereço alterado'],
  ['R4', 'consignee', `${ALFA}\n${RUA}`, `EMPRESA SINTETICA ALFA S.A.\n${RUA}`, 'DIVERGENTE', 'natureza jurídica alterada'],
  ['N1', 'consignee', 'RUA FICTICIA DAS FLORES, 10\n0', RUA, 'DIVERGENTE', 'juntar linhas sem espaço criaria "100"'],
  ['N2', 'consignee', 'EMPRESA SINTETICA AL FA LTDA', ALFA, 'DIVERGENTE', 'tirar todos os espaços juntaria palavras'],
  ['N3', 'consignee', 'CNPJ 12.345.678/0001-00', 'CNPJ 12345678000100', 'DIVERGENTE', 'máscara do CNPJ: equivalência não demonstrada sem regra aprovada'],
  ['N4', 'consignee', 'Empresa Sintetica Alfa Ltda', ALFA, 'DIVERGENTE', 'caixa: equivalência não demonstrada sem regra aprovada'],
  ['N5', 'consignee', 'EMPRESA SINTETICA FLO-\nRES LTDA', 'EMPRESA SINTETICA FLORES LTDA', 'DIVERGENTE', 'hifenização: equivalência não demonstrada sem regra aprovada'],
  ['V1', 'navio', 'NAVIO SINTETICO A\nV.001', 'NAVIO SINTETICO A V.001', 'DIVERGENTE', 'quebra entre navio e viagem'],
  ['V2', 'navio', 'NAVIO SINTETICO A  V.001', 'NAVIO SINTETICO A V.001', 'IGUAL', 'espaços repetidos'],
  ['V3', 'navio', 'NAVIO SINTETICO A / V.001', 'NAVIO SINTETICO A V.001', 'DIVERGENTE', 'separador diferente'],
  ['V4', 'navio', 'NAVIO SINTETICO A V.001', 'NAVIO SINTETICO A V.002', 'DIVERGENTE', 'viagem diferente'],
];

/** Adversariais: espaços, CRLF, quebras relevantes e cosméticas, razão social/endereço, CNPJ, caracteres e campo de uma linha. */
const ADVERSARIAIS: ReadonlyArray<[string, CampoDeTexto, string, string, Tipo]> = [
  ['tabulação', 'consignee', 'EMPRESA\tSINTETICA ALFA LTDA', ALFA, 'IGUAL'],
  ['espaço sem quebra (NBSP)', 'consignee', 'EMPRESA SINTETICA ALFA LTDA', ALFA, 'IGUAL'],
  ['CR isolado: espaço horizontal na DOC-31.B (o PDF imprime igual)', 'consignee', 'EMPRESA SINTETICA\rALFA LTDA', ALFA, 'IGUAL'],
  ['espaços no fim da linha', 'consignee', `${ALFA}   \n${RUA}`, `${ALFA}\n${RUA}`, 'SO_FORMATACAO'],
  ['CRLF com espaço no fim da linha', 'consignee', `${ALFA} \r\n${RUA}`, `${ALFA}\n${RUA}`, 'SO_FORMATACAO'],
  ['linha só de espaços × linha vazia', 'consignee', `${ALFA}\n \n${RUA}`, `${ALFA}\n\n${RUA}`, 'SO_FORMATACAO'],
  ['indentação repetida', 'consignee', `${ALFA}\n    ${RUA}`, `${ALFA}\n ${RUA}`, 'IGUAL'],
  ['indentação × sem indentação', 'consignee', `${ALFA}\n ${RUA}`, `${ALFA}\n${RUA}`, 'DIVERGENTE'],
  ['quebra acrescentada no endereço', 'consignee', `${ALFA}\nRUA FICTICIA DAS\nFLORES, 100`, `${ALFA}\n${RUA}`, 'DIVERGENTE'],
  ['CNPJ quebrado entre linhas', 'consignee', `${ALFA}\nCNPJ 12.345.678/0001-\n00`, `${ALFA}\nCNPJ 12.345.678/0001-00`, 'DIVERGENTE'],
  ['CNPJ: só CRLF × LF', 'consignee', `${ALFA}\r\nCNPJ 12.345.678/0001-00`, `${ALFA}\nCNPJ 12.345.678/0001-00`, 'SO_FORMATACAO'],
  ['CNPJ: espaço dentro do número', 'consignee', 'CNPJ 12.345.678/0001-00', 'CNPJ 12.345.678/0001 -00', 'DIVERGENTE'],
  ['hífen: só CRLF × LF', 'consignee', 'EMPRESA SINTETICA FLO-\r\nRES LTDA', 'EMPRESA SINTETICA FLO-\nRES LTDA', 'SO_FORMATACAO'],
  ['caractere invisível (largura zero)', 'consignee', 'EMPRESA SINTETICA AL​FA LTDA', ALFA, 'DIVERGENTE'],
  ['letra parecida de outro alfabeto', 'consignee', 'EMPRESA SINTETICA АLFA LTDA', ALFA, 'DIVERGENTE'],
  ['pontuação', 'consignee', 'EMPRESA SINTETICA ALFA LTDA.', ALFA, 'DIVERGENTE'],
  ['uma linha: CRLF × LF', 'navio', 'NAVIO SINTETICO A\r\nV.001', 'NAVIO SINTETICO A\nV.001', 'SO_FORMATACAO'],
  ['uma linha: espaço antes da quebra', 'navio', 'NAVIO SINTETICO A \nV.001', 'NAVIO SINTETICO A\nV.001', 'SO_FORMATACAO'],
  ['uma linha: tabulação', 'navio', 'NAVIO SINTETICO A\tV.001', 'NAVIO SINTETICO A V.001', 'IGUAL'],
  ['uma linha: quebra × espaço', 'navio', 'NAVIO SINTETICO A\r\nV.001', 'NAVIO SINTETICO A V.001', 'DIVERGENTE'],
];

/** O que a Liberação faz com as versões de um campo: exatamente o mesmo, qualquer que seja a classificação do contrato. */
function liberacaoInalterada(campo: CampoDeTexto, textos: ReadonlyArray<string>, rotulo: string) {
  const r = dadosDoMbl('M1', paraLiberacao(evDe(campo, textos)), [NAVIO, CONSIGNATARIO]);
  if (campo === 'navio') {
    assert.deepEqual(r.valores.filter((v) => v.dado === NAVIO).map((v) => [v.valor, v.evidencia.ref]), textos.map((t, i) => [t.trim(), `auditoria_extracao:t${i}`]), `${rotulo}: um valor por versão, o texto lido`);
  } else {
    assert.deepEqual(r.valores.filter((v) => v.dado === CONSIGNATARIO), [], `${rotulo}: 14.18`);
    assert.deepEqual(r.naoPublicados.filter((n) => n.dado === CONSIGNATARIO).map((n) => n.motivo), textos.map(() => 'CONSIGNATARIO_SEM_CRITERIO_APROVADO'), `${rotulo}: 14.18`);
  }
}

test('[E1C-13] os 22 casos da O1.5: só o comprovadamente cosmético não diverge; nas duas ordens, com todos os originais e a Liberação inalterada', () => {
  assert.equal(CASOS_O15.length, 22);
  for (const [id, campo, a, b, esperado, nota] of CASOS_O15) {
    for (const textos of [[a, b], [b, a]]) {
      assert.deepEqual(situacaoDe(campo, textos), { tipo: esperado, valores: distintos(textos) }, `${id}: ${nota}`);
      liberacaoInalterada(campo, textos, id);
    }
  }
});

test('[E1C-14] adversariais: espaços, CRLF, quebras relevantes e cosméticas, razão social e endereço, CNPJ, caracteres e campo de uma linha', () => {
  for (const [rotulo, campo, a, b, esperado] of ADVERSARIAIS) {
    for (const textos of [[a, b], [b, a]]) {
      assert.deepEqual(situacaoDe(campo, textos), { tipo: esperado, valores: distintos(textos) }, rotulo);
      liberacaoInalterada(campo, textos, rotulo);
    }
  }
  // Contêineres: a forma de cada número é a do PB-001 (regra aprovada); ordem, falta ou troca de contêiner divergem.
  const lista = (...conteineres: string[][]) => evidenciasDoMbl('M1', true, conteineres.map((c, i) => leitura(`c${i}`, campos({ conteineres: c })))).situacao.conteineres;
  assert.deepEqual(lista([C1, C2], [`${C1.slice(0, 4)}\n${C1.slice(4)}`, C2.toLowerCase()]), { tipo: 'IGUAL', valores: [`${C1}\n${C2}`] }, 'PB-001');
  assert.deepEqual(lista([C1, C2], [C2, C1]), { tipo: 'DIVERGENTE', valores: [`${C1}\n${C2}`, `${C2}\n${C1}`] }, 'ordem diferente');
  assert.deepEqual(lista([C1, C2], [C1]), { tipo: 'DIVERGENTE', valores: [`${C1}\n${C2}`, C1] }, 'um contêiner a menos');
  const C3 = conteiner('TSTU000003');
  assert.deepEqual(lista([C1, C2], [C1, C3]), { tipo: 'DIVERGENTE', valores: [`${C1}\n${C2}`, `${C1}\n${C3}`] }, 'outro contêiner');
});

test('[E1C-15] múltiplas versões em qualquer ordem de leitura: a classificação não depende da ordem; todos os originais ficam, na ordem lida; nenhum valor único é escolhido', () => {
  const X = `${ALFA}\n${RUA}`;
  const permutacoes = (xs: string[]): string[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutacoes([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
  const grupos: Array<[string[], Tipo]> = [
    [[X, X.replace('SINTETICA ', 'SINTETICA   ')], 'IGUAL'],
    [[` ${X}\n`, X], 'IGUAL'],
    [[X, X.replace('\n', '\r\n'), X.replace('\n', '  \n')], 'SO_FORMATACAO'],
    [[X, X.replace('SINTETICA ', 'SINTETICA   '), X.replace('\n', '\r\n')], 'SO_FORMATACAO'],
    [[X, X, X.replace('\n', ' ')], 'DIVERGENTE'],
    [[X, X.replace('\n', '\r\n'), X.replace('100', '101')], 'DIVERGENTE'],
    [[X, X.replace('\n', '\r\n'), X.replace('\n', '\n\n')], 'DIVERGENTE'],
  ];
  for (const [textos, esperado] of grupos) {
    for (const p of permutacoes(textos)) {
      const s = situacaoDe('consignee', p);
      assert.deepEqual(s, { tipo: esperado, valores: distintos(p) }, `${esperado}: ${JSON.stringify(p)}`);
      assert.ok(!('valor' in s), 'nenhum valor único escolhido');
      const ev = evDe('consignee', p);
      assert.deepEqual(ev.versoes.map((v) => v.campos?.consignee), p, 'cada versão com o texto exatamente como persistido');
      liberacaoInalterada('consignee', p, esperado);
    }
  }
});

test('[E1C-16] coerência com a DOC-31.B e segurança: IGUAL ⇔ mesmo valor escrito no lugar; IGUAL ou SO_FORMATACAO nunca mudam o conteúdo visível de linha nenhuma', () => {
  const textos = [...new Set([...CASOS_O15, ...ADVERSARIAIS].flatMap(([, , a, b]) => [a, b]))];
  const lugares: Array<[TipoDocumento, string]> = [
    ['MEMORANDO_MSC', DADOS_DOS_MODELOS.NAVIO_E_VIAGEM], ['MEMORANDO_MSC', DADOS_DOS_MODELOS.CONSIGNATARIO_RAZAO_SOCIAL], ['TERMO_EVERGREEN', DADOS_DOS_MODELOS.CONSIGNATARIO_QUALIFICACAO],
  ];
  /** Conteúdo visível de cada linha (independente da implementação: tira TODO espaço de dentro da linha). */
  const linhasVisiveis = (t: string) => t.trim().split(/\r?\n/).map((l) => l.replace(/\s/g, ''));
  let pares = 0;
  for (const x of textos) for (const y of textos) {
    const tipo = situacaoDe('consignee', [x, y]).tipo;
    for (const [modelo, dado] of lugares) {
      const d = DEFINICOES_PROPOSTAS[modelo];
      const campo = d.campos.find((c) => c.dado === dado)!.id;
      assert.equal(tipo === 'IGUAL', valorEscritoNoLugar(d, campo, x.trim()) === valorEscritoNoLugar(d, campo, y.trim()), `${modelo}/${campo}: ${JSON.stringify([x, y])}`);
    }
    if (tipo === 'IGUAL' || tipo === 'SO_FORMATACAO') {
      assert.deepEqual(linhasVisiveis(x), linhasVisiveis(y), `${tipo} não pode mudar linha nenhuma: ${JSON.stringify([x, y])}`);
    }
    assert.equal(situacaoDe('navio', [x, y]).tipo, tipo, 'a mesma regra para o campo de uma linha');
    pares++;
  }
  assert.ok(textos.length >= 50 && pares === textos.length ** 2, `pares: ${pares}`);
});

test('[E1C-10a] nenhum OCR, IA ou Graph no contrato nem no caminho da Liberação (imports)', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..');
  for (const f of ['auditoria/fatos/evidenciasDoMbl.ts', 'auditoria/fatos/camposDoMbl.ts', 'liberacao/documentos/dominio/fatosDoMbl.ts', 'liberacao/documentos/aplicacao/postgres.ts']) {
    const fonte = fs.readFileSync(path.join(raiz, f), 'utf8');
    for (const [, imp] of fonte.matchAll(/from\s+'([^']+)'/g)) {
      assert.doesNotMatch(imp, /docExtractor|extracaoPreAlerta|shippingInstructions|geminiClient|\/ai\/|graphService|auditClara|mistral/i, `${f} importa ${imp}`);
    }
    assert.doesNotMatch(fonte, /generateStructured|getAttachmentContent|fetch\(/, `${f} não chama provedor nem baixa anexo`);
  }
});

test('[E1C-11a] a decisão da L1b não consome o contrato: nenhum arquivo da L1a/L1b, da projeção (L2) ou da reconstrução (G-3c) o importa', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..');
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(d, e.name)) : [path.join(d, e.name)]));
  const arquivos = [...todos(path.join(raiz, 'liberacao', 'dominio')), ...todos(path.join(raiz, 'liberacao', 'aplicacao'))].filter((f) => f.endsWith('.ts') && !f.includes('__tests__'));
  assert.ok(arquivos.length > 10);
  for (const f of arquivos) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /evidenciasDoMbl|camposDoMbl|fatosDoMbl/, path.relative(raiz, f));
});

/* ------------------------------------------------ PostgreSQL ------------------------------------------------ */

/** Uma versão do MBL entra pelo caminho do DONO (S2), com os campos como o OCR os teria devolvido. */
async function mbl(pool: Pool, c: Cenario, v: {
  id: string; processo: string; conhecimento: string; sha: number; recebida?: string; legivel?: boolean; campos?: CamposDocumentaisExtraidos | null;
}) {
  const recebida = new Date(v.recebida ?? '2026-09-01T08:00:00Z');
  const [r] = await persistirExtracoesAuditoria(pool, c.ctx, [{
    proveniencia: {
      messageId: `msg-${v.id}`, internetMessageId: `<${v.id}@agente.teste>`, attachmentId: `anexo-${v.id}`, attachmentNome: 'MBL.pdf', contentType: 'application/pdf',
      remetente: 'agente@agente.teste', recebidaEm: recebida, referenciasBrutas: [v.processo], associacao: 'CITADA',
    },
    resultado: {
      tipoPorNome: 'MBL', tipoDetectado: 'MBL', legivel: v.legivel ?? true, conhecimento: v.conhecimento,
      camposDocumentais: v.campos === undefined ? campos() : v.campos, arquivoSha256: SHA(v.sha),
    },
    modelo: 'modelo-teste', extraidaEm: recebida,
  }]);
  return r.extracaoId;
}
const masterDoProcesso = async (pool: Pool, org: string, codigo: string): Promise<string[]> => (await pool.query(
  `SELECT DISTINCT v.master_id FROM processo_master_vinculos v JOIN processos p ON p.id = v.processo_id
    WHERE v.organization_id = $1 AND p.numero_processo = $2 ORDER BY v.master_id`, [org, codigo])).rows.map((r) => r.master_id);
const processoId = async (pool: Pool, org: string, codigo: string): Promise<string> =>
  (await pool.query(`SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`, [org, codigo])).rows[0].id;
const pedidos = [NAVIO, CONTEINERES, CONSIGNATARIO].map((dado) => ({ dado, fonte: 'S2_AUDITORIA' as const }));

/** Conta (e bloqueia) qualquer chamada a provedor de OCR/IA ou download de anexo durante `fn`. */
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

test('E1 — contrato de evidências do MBL sobre o S2 persistido', { skip: !url && 'DEMURRAGE_TEST_DATABASE_URL não definida' }, async (t) => {
  const pool = testPool();
  await preparar(pool);
  try {
    await t.test('[E1C-05b/12] anexos repetidos persistidos: duas origens, mesmo hash; o contrato espelha 1:1 as leituras que os consumidores já usam', async () => {
      const c = await cenario(pool, 'e1c-rep');
      await mbl(pool, c, { id: 'r1', processo: 'IM100', conhecimento: 'MEDU1000001', sha: 11 });
      await mbl(pool, c, { id: 'r2', processo: 'IM100', conhecimento: 'MEDU1000001', sha: 11, recebida: '2026-09-02T08:00:00Z' });
      const [m] = await masterDoProcesso(pool, c.orgId, 'IM100');
      const ev = await evidenciasDoMblDoMaster(pool, c.orgId, m);
      const leituras: LeituraDoMblDoMaster[] = await leiturasDoMblDoMaster(pool, c.orgId, m);
      assert.equal(ev.vinculo, 'VINCULADO');
      assert.deepEqual(ev.versoes.map((v) => [v.origem.messageId, v.origem.arquivoSha256]), [['msg-r1', SHA(11)], ['msg-r2', SHA(11)]]);
      assert.deepEqual(ev.versoes.map((v) => v.extracaoId), leituras.map((l) => l.extracaoId), 'mesmas leituras, mesma ordem');
      assert.deepEqual(ev.versoes.map((v) => [v.origem, v.extrator, v.extratorVersao, v.modelo, v.conhecimento, v.campos]), leituras.map((l) => [l.origem, l.extrator, l.extratorVersao, l.modelo, l.conhecimento, l.campos]));
      assert.deepEqual(ev.situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO A V.001'] });
    });

    await t.test('[E1C-06] Master com múltiplos Houses: as versões trazem cada processo; a Liberação lê o mesmo dado para o Master, de cada origem', async () => {
      const c = await cenario(pool, 'e1c-houses');
      await mbl(pool, c, { id: 'h1', processo: 'IM200', conhecimento: 'MEDU2000001', sha: 21 });
      await mbl(pool, c, { id: 'h2', processo: 'IM201', conhecimento: 'MEDU2000001', sha: 21, recebida: '2026-09-02T08:00:00Z' });
      const [m1] = await masterDoProcesso(pool, c.orgId, 'IM200');
      assert.deepEqual(await masterDoProcesso(pool, c.orgId, 'IM201'), [m1], 'os dois Houses no mesmo Master');
      const [p200, p201] = [await processoId(pool, c.orgId, 'IM200'), await processoId(pool, c.orgId, 'IM201')];
      const ev = await evidenciasDoMblDoMaster(pool, c.orgId, m1);
      assert.deepEqual(ev.versoes.map((v) => v.processoIds), [[p200], [p201]]);
      const valores = await fontesConfiaveisPostgres(pool).valores(c.orgId, m1, [p200, p201], pedidos);
      assert.deepEqual(valores.filter((v) => v.dado === NAVIO).map((v) => [v.valor, v.escopo]), [
        ['NAVIO SINTETICO A V.001', { tipo: 'MASTER', masterId: m1 }], ['NAVIO SINTETICO A V.001', { tipo: 'MASTER', masterId: m1 }],
      ], 'um valor por versão, escopo do Master');
    });

    await t.test('[E1C-07] isolamento entre organizações: o mesmo MBL e o mesmo conteúdo em outra organização nunca aparecem', async () => {
      const a = await cenario(pool, 'e1c-org-a');
      const b = await cenario(pool, 'e1c-org-b');
      const ea = await mbl(pool, a, { id: 'oa', processo: 'IM300', conhecimento: 'MEDU3000001', sha: 31 });
      const eb = await mbl(pool, b, { id: 'ob', processo: 'IM300', conhecimento: 'MEDU3000001', sha: 31, campos: campos({ navio: 'NAVIO DA OUTRA ORGANIZACAO' }) });
      const [ma] = await masterDoProcesso(pool, a.orgId, 'IM300');
      const [mb] = await masterDoProcesso(pool, b.orgId, 'IM300');
      assert.notEqual(ma, mb);
      assert.deepEqual((await evidenciasDoMblDoMaster(pool, a.orgId, ma)).versoes.map((v) => v.extracaoId), [ea]);
      assert.deepEqual((await evidenciasDoMblDoMaster(pool, b.orgId, mb)).versoes.map((v) => v.extracaoId), [eb]);
      const cruzado = await evidenciasDoMblDoMaster(pool, b.orgId, ma);
      assert.deepEqual([cruzado.vinculo, cruzado.versoes], ['SEM_VINCULO_VALIDO', []], 'Master de outra organização: nada');
      assert.deepEqual((await evidenciasDoMblDoMaster(pool, a.orgId, ma)).situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO A V.001'] });
    });

    await t.test('[E1C-08] sem vínculo documental confiável (CONFLITO no S2): o Master não recebe nenhuma leitura; a Liberação não recebe nada', async () => {
      const c = await cenario(pool, 'e1c-conflito');
      await mbl(pool, c, { id: 'x', processo: 'IM400', conhecimento: 'MEDU4000001', sha: 41 });
      await mbl(pool, c, { id: 'y', processo: 'IM400', conhecimento: 'MSCU4000002', sha: 42 });
      const masters = await masterDoProcesso(pool, c.orgId, 'IM400');
      assert.equal(masters.length, 2, 'o mesmo processo cita dois MBLs: conflito');
      const p400 = await processoId(pool, c.orgId, 'IM400');
      for (const m of masters) {
        const ev = await evidenciasDoMblDoMaster(pool, c.orgId, m);
        assert.deepEqual([ev.vinculo, ev.versoes, ev.situacao.navio], ['SEM_VINCULO_VALIDO', [], { tipo: 'SEM_VINCULO_DOCUMENTAL' }]);
        assert.deepEqual(await fontesConfiaveisPostgres(pool).valores(c.orgId, m, [p400], pedidos), []);
      }
    });

    await t.test('[E1C-03b] MBL ilegível persistido: não vincula, não vira leitura do Master e nada é inventado', async () => {
      const c = await cenario(pool, 'e1c-ilegivel');
      const boa = await mbl(pool, c, { id: 'boa', processo: 'IM500', conhecimento: 'MEDU5000001', sha: 51 });
      await mbl(pool, c, { id: 'ruim', processo: 'IM500', conhecimento: 'MEDU5000001', sha: 52, legivel: false, campos: campos({ navio: 'NAVIO LIDO DE DOCUMENTO ILEGIVEL' }) });
      const [m] = await masterDoProcesso(pool, c.orgId, 'IM500');
      const ev = await evidenciasDoMblDoMaster(pool, c.orgId, m);
      assert.deepEqual(ev.versoes.map((v) => v.extracaoId), [boa], 'só a versão legível');
      assert.deepEqual(ev.situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO A V.001'] });
    });

    await t.test('[E1C-09b] consignatário persistido: presente no contrato, retido na Liberação pela 14.18', async () => {
      const c = await cenario(pool, 'e1c-consig');
      await mbl(pool, c, { id: 'k', processo: 'IM600', conhecimento: 'MEDU6000001', sha: 61 });
      const [m] = await masterDoProcesso(pool, c.orgId, 'IM600');
      const ev = await evidenciasDoMblDoMaster(pool, c.orgId, m);
      assert.deepEqual(ev.situacao.consignee, { tipo: 'IGUAL', valores: ['EMPRESA SINTETICA DE TESTE LTDA'] });
      const fontes = fontesConfiaveisPostgres(pool);
      const p = await processoId(pool, c.orgId, 'IM600');
      assert.deepEqual((await fontes.valores(c.orgId, m, [p], pedidos)).filter((v) => v.dado === CONSIGNATARIO), []);
      assert.deepEqual((await fontes.dadosNaoPublicados!(c.orgId, m, pedidos)).map((n) => [n.dado, n.motivo]), [[CONSIGNATARIO, 'CONSIGNATARIO_SEM_CRITERIO_APROVADO']]);
    });

    await t.test('[E1C-17] formatação persistida: CRLF × LF fica SO_FORMATACAO, quebra retirada diverge; originais e proveniência intactos; Liberação inalterada; outra organização não interfere; zero OCR', async () => {
      const a = await cenario(pool, 'e1c-fmt-a');
      const b = await cenario(pool, 'e1c-fmt-b');
      const crlf = campos({ navio: 'NAVIO SINTETICO C\r\nV.003', consignee: `${ALFA}\r\n${RUA}` });
      const lf = campos({ navio: 'NAVIO SINTETICO C\nV.003 ', consignee: `${ALFA}\n${RUA}` });
      const e1 = await mbl(pool, a, { id: 'f1', processo: 'IM800', conhecimento: 'MEDU8000001', sha: 81, campos: crlf });
      const e2 = await mbl(pool, a, { id: 'f2', processo: 'IM800', conhecimento: 'MEDU8000001', sha: 82, recebida: '2026-09-02T08:00:00Z', campos: lf });
      // A outra organização tem o mesmo MBL e o mesmo arquivo com o navio numa linha só: se vazasse, o navio de A divergiria.
      await mbl(pool, b, { id: 'f3', processo: 'IM800', conhecimento: 'MEDU8000001', sha: 81, campos: campos({ navio: 'NAVIO SINTETICO C V.003' }) });
      const [m] = await masterDoProcesso(pool, a.orgId, 'IM800');
      const p = await processoId(pool, a.orgId, 'IM800');
      const fontes = fontesConfiaveisPostgres(pool);
      const { r, chamadas } = await semOcr(async () => ({ ev: await evidenciasDoMblDoMaster(pool, a.orgId, m), valores: await fontes.valores(a.orgId, m, [p], pedidos) }));
      assert.deepEqual(chamadas, [], 'nenhuma chamada a provedor nem download');
      assert.deepEqual(r.ev.versoes.map((v) => v.extracaoId), [e1, e2], 'só as versões desta organização');
      assert.deepEqual(r.ev.versoes.map((v) => v.campos), [crlf, lf], 'os campos como persistidos: CR, quebras e pontas preservados');
      assert.deepEqual(r.ev.versoes.map((v) => [v.evidencia.ref, v.origem.arquivoSha256]), [[`auditoria_extracao:${e1}`, SHA(81)], [`auditoria_extracao:${e2}`, SHA(82)]]);
      assert.deepEqual(r.ev.situacao.navio, { tipo: 'SO_FORMATACAO', valores: ['NAVIO SINTETICO C\r\nV.003', 'NAVIO SINTETICO C\nV.003'] });
      assert.deepEqual(r.ev.situacao.consignee, { tipo: 'SO_FORMATACAO', valores: [`${ALFA}\r\n${RUA}`, `${ALFA}\n${RUA}`] });
      // A Liberação: como antes — um valor por versão, o texto lido, a evidência de cada uma; nada escolhido nem bloqueado.
      assert.deepEqual(r.valores.filter((v) => v.dado === NAVIO).map((v) => [v.valor, v.evidencia.ref]), [
        ['NAVIO SINTETICO C\r\nV.003', `auditoria_extracao:${e1}`], ['NAVIO SINTETICO C\nV.003', `auditoria_extracao:${e2}`],
      ]);
      // Uma terceira versão com a quebra retirada: não é comprovadamente cosmética → o campo diverge, com os três originais.
      const e4 = await mbl(pool, a, { id: 'f4', processo: 'IM800', conhecimento: 'MEDU8000001', sha: 84, recebida: '2026-09-03T08:00:00Z', campos: campos({ navio: 'NAVIO SINTETICO C V.003' }) });
      const depois = await evidenciasDoMblDoMaster(pool, a.orgId, m);
      assert.deepEqual(depois.versoes.map((v) => v.extracaoId), [e1, e2, e4]);
      assert.deepEqual(depois.situacao.navio, { tipo: 'DIVERGENTE', valores: ['NAVIO SINTETICO C\r\nV.003', 'NAVIO SINTETICO C\nV.003', 'NAVIO SINTETICO C V.003'] });
      const [mb] = await masterDoProcesso(pool, b.orgId, 'IM800');
      assert.deepEqual((await evidenciasDoMblDoMaster(pool, b.orgId, mb)).situacao.navio, { tipo: 'IGUAL', valores: ['NAVIO SINTETICO C V.003'] }, 'e a outra organização só vê o seu');
    });

    await t.test('[E1C-10] zero chamadas de OCR, IA ou download de anexo: contrato e adaptador da Liberação só leem o banco', async () => {
      const c = await cenario(pool, 'e1c-ocr');
      await mbl(pool, c, { id: 'z', processo: 'IM700', conhecimento: 'MEDU7000001', sha: 71 });
      const [m] = await masterDoProcesso(pool, c.orgId, 'IM700');
      const p = await processoId(pool, c.orgId, 'IM700');
      const fontes = fontesConfiaveisPostgres(pool);
      const { r, chamadas } = await semOcr(async () => ({
        ev: await evidenciasDoMblDoMaster(pool, c.orgId, m),
        valores: await fontes.valores(c.orgId, m, [p], pedidos),
        retidos: await fontes.dadosNaoPublicados!(c.orgId, m, pedidos),
      }));
      assert.deepEqual(chamadas, [], 'nenhuma chamada a provedor nem download');
      assert.equal(r.ev.versoes.length, 1);
      assert.deepEqual(r.valores.map((v) => v.dado).sort(), [CONTEINERES, NAVIO]);
      assert.deepEqual(r.retidos.map((n) => n.dado), [CONSIGNATARIO]);
    });
  } finally {
    await pool.end();
  }
});
