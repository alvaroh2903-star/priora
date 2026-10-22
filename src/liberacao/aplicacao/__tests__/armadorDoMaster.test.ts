import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { AssinaturaDoDocumento, DeclaracaoDoTransportador, transportadorDoMbl } from '../../../auditoria/parser/transportador';
import { ARMADORES_DA_MATRIZ, DecisaoDoProcesso, decidirProcesso, entradaSemIntegracoes } from '../../dominio';
import { MBL_RECEBIDO, T, vinculo } from '../../dominio/__tests__/l1b/fixtures';
import {
  ArmadorAutomatico, LISTA_DE_TRANSPORTADORES, SITUACAO_DA_LISTA_DE_TRANSPORTADORES, armadorAutomatico, armadorParaL1b, codigoDaLista,
} from '../armadorDoMaster';

/**
 * Regra de USO do armador do Master (P1-A, preservada na O2.1-C): lista fechada em RASCUNHO, códigos da matriz, e a
 * tradução para a porta `armador` da L1b. PURA e NÃO LIGADA (nenhum caminho de produção a usa; a L1b segue recebendo
 * o armador como NAO_INTEGRADA). Fixtures sintéticas; só os nomes de transportador vêm da lista em rascunho.
 */

const SHA = (n: number) => n.toString(16).padStart(64, '0');
const MSC = 'MSC MEDITERRANEAN SHIPPING COMPANY S.A.';
const AGENCIA = 'AGENCIA MARITIMA SINTETICA LTDA';
const FONTE = 'ocr_mistral';

interface Lido { declaracoes: DeclaracaoDoTransportador[]; assinatura: AssinaturaDoDocumento | null }
const tr = (nome: string, trecho = `Carrier: ${nome}`, assinatura: AssinaturaDoDocumento | null = null): Lido =>
  ({ declaracoes: [{ nome, posicao: 'CAMPO_TRANSPORTADOR', trecho }], assinatura });
const SO_AGENCIA: Lido = {
  declaracoes: [{ nome: AGENCIA, posicao: 'CLAUSULA_DE_ASSINATURA', trecho: `Signed by ${AGENCIA} as agent for the Carrier` }],
  assinatura: { signatario: AGENCIA, papel: 'AGENTE_DO_TRANSPORTADOR' },
};

/** O adaptador sobre leituras sintéticas de qualquer fonte: [id, arquivo, declarações (ausente = a fonte não forneceu), instante]. */
const sobre = (...l: Array<[string, number, Lido | undefined, string?]>): ArmadorAutomatico => armadorAutomatico(transportadorDoMbl('M1', l.map(([id, sha, t, em]) => ({
  evidenciaRef: `evidencia:${id}`, arquivoSha256: SHA(sha), observadaEm: new Date(em ?? '2026-09-01T08:00:00.000Z'), extraidaEm: new Date(em ?? '2026-09-01T08:00:00.000Z'),
  ...(t ? { declaracoes: t.declaracoes, assinatura: t.assinatura } : {}),
}))));
const resumo = (r: ArmadorAutomatico) =>
  (r.tipo === 'FATO' ? ['FATO', r.armador.codigo, r.evidencias] : r.tipo === 'EXCECAO' ? ['EXCECAO', r.motivo, r.evidencias, r.nomes] : ['NAO_OBSERVADO']);

/** A L1b pura sobre a entrada de hoje (Master vinculado e conferido), com o que a porta entregaria. */
const decisao = (r: ArmadorAutomatico, processo = 'IM100'): DecisaoDoProcesso => decidirProcesso({
  ...entradaSemIntegracoes(processo, T(10), MBL_RECEBIDO()), vinculo: { tipo: 'VINCULADO', vinculo: vinculo(processo, 'M1') }, ...armadorParaL1b(r, FONTE),
});

test('[P1A-L01] lista fechada em RASCUNHO: só códigos da matriz congelada; comparação exata na forma normalizada (marca, prefixo e substring recusados)', () => {
  assert.equal(SITUACAO_DA_LISTA_DE_TRANSPORTADORES, 'PROPOSTA', 'a lista não está aprovada: só é exigida para LIGAR (P1-B)');
  for (const { codigo } of LISTA_DE_TRANSPORTADORES) assert.ok(ARMADORES_DA_MATRIZ.includes(codigo), `${codigo} é código da matriz`);
  assert.deepEqual([...new Set(LISTA_DE_TRANSPORTADORES.map((t) => t.codigo))].sort(), [...ARMADORES_DA_MATRIZ].sort(), 'cada código da matriz tem ao menos um nome');
  for (const { nome, codigo } of LISTA_DE_TRANSPORTADORES) assert.equal(codigoDaLista(nome.replace(/[^A-Z0-9]+/g, ' ').trim()), codigo);
  assert.equal(codigoDaLista('MSC MEDITERRANEAN SHIPPING COMPANY S A'), 'MSC');
  for (const fora of ['MSC', 'MAERSK', 'HAPAG LLOYD', 'MSC MEDITERRANEAN SHIPPING COMPANY', 'MSC MEDITERRANEAN SHIPPING COMPANY S A BRASIL', 'MAERSK BRASIL BRASMAR LTDA',
    'HAMBURG SUD', 'EVERGREEN LINE', 'CMA CGM DO BRASIL', '']) {
    assert.equal(codigoDaLista(fora), null, `fora da lista: "${fora}"`);
  }
});
test('[P1A-L02] regra de uso: FATO só com leituras concordantes, todas na lista e no MESMO código; o resto é exceção visível; sem declarações, não observado', () => {
  // MBL com Carrier explícito, nome da lista → fato, com a evidência da extração.
  assert.deepEqual(resumo(sobre(['x1', 1, tr(MSC)])), ['FATO', 'MSC', ['evidencia:x1']]);
  // Assinatura da agência "as agent for the Carrier X": o transportador é X.
  assert.deepEqual(resumo(sobre(['x1', 1, tr(MSC, `Signed by ${AGENCIA} as agent for and on behalf of the Carrier ${MSC}`, { signatario: AGENCIA, papel: 'AGENTE_DO_TRANSPORTADOR' })])),
    ['FATO', 'MSC', ['evidencia:x1']]);
  // Só a agência marítima → NAO_DECLARADO (P12).
  assert.deepEqual(resumo(sobre(['x1', 1, SO_AGENCIA])), ['EXCECAO', 'NAO_DECLARADO', ['evidencia:x1'], []]);
  // NVOCC e armador distintos: o NVOCC é recusado, vale o armador.
  assert.deepEqual(resumo(sobre(['x1', 1, {
    declaracoes: [{ nome: 'HAPAG-LLOYD AG', posicao: 'CAMPO_TRANSPORTADOR', trecho: 'Carrier: HAPAG-LLOYD AG' },
      { nome: 'CONSOLIDADORA SINTETICA LTDA', posicao: 'OUTRA_DECLARACAO', trecho: 'CONSOLIDADORA SINTETICA LTDA as NVOCC' }],
    assinatura: null,
  }])), ['FATO', 'HAPAG_LLOYD', ['evidencia:x1']]);
  // Ambíguo (papéis conflitantes) → exceção.
  assert.deepEqual(resumo(sobre(['x1', 1, tr(MSC, `Carrier: ${MSC} as agent`)])), ['EXCECAO', 'DECLARACAO_AMBIGUA', ['evidencia:x1'], []]);
  // Nome declarado fora da lista (marca sozinha, transportador fora da matriz) → exceção com o nome literal.
  assert.deepEqual(resumo(sobre(['x1', 1, tr('MSC')])), ['EXCECAO', 'NOME_FORA_DA_LISTA', ['evidencia:x1'], ['MSC']]);
  assert.deepEqual(resumo(sobre(['x1', 1, tr('HAMBURG SUD')])), ['EXCECAO', 'NOME_FORA_DA_LISTA', ['evidencia:x1'], ['HAMBURG SUD']]);
  // Versões divergentes: arquivos diferentes, códigos diferentes → exceção; grafias diferentes do MESMO código → fato.
  assert.deepEqual(resumo(sobre(['x1', 1, tr(MSC)], ['x2', 2, tr('MAERSK A/S')])),
    ['EXCECAO', 'TRANSPORTADORES_DIVERGENTES', ['evidencia:x1', 'evidencia:x2'], ['MAERSK A/S', MSC]]);
  assert.deepEqual(resumo(sobre(['x1', 1, tr('MAERSK A/S')], ['x2', 2, tr('A.P. MOLLER - MAERSK A/S')])),
    ['FATO', 'MAERSK', ['evidencia:x1', 'evidencia:x2']]);
  // O mesmo arquivo lido com resultados diferentes → exceção de leitura (nada é escolhido).
  assert.deepEqual(resumo(sobre(['x1', 1, tr(MSC)], ['x2', 1, SO_AGENCIA])),
    ['EXCECAO', 'LEITURAS_DIVERGENTES', ['evidencia:x1', 'evidencia:x2'], []]);
  // Outra versão sem declaração não contradiz a que declara.
  assert.deepEqual(resumo(sobre(['x1', 1, tr(MSC)], ['x2', 2, SO_AGENCIA])), ['FATO', 'MSC', ['evidencia:x1']]);
  // Fonte sem declarações → não observado; junto com uma que declara → vale a regra sobre a que declara.
  assert.deepEqual(resumo(sobre(['x1', 1, undefined], ['x2', 2, undefined])), ['NAO_OBSERVADO']);
  assert.deepEqual(resumo(sobre(['x1', 1, undefined], ['x2', 1, tr(MSC)])), ['FATO', 'MSC', ['evidencia:x2']]);
  assert.deepEqual(resumo(armadorAutomatico({ masterId: 'M1', leituras: [], arquivos: [] })), ['NAO_OBSERVADO']);
  // Frescor: a fonte desde a 1ª leitura com declarações; o fato vigente desde o documento mais antigo que declara; confirmado pela mais recente.
  const f = sobre(['x1', 1, tr(MSC), '2026-09-01T08:00:00.000Z'], ['x2', 2, tr(MSC), '2026-09-04T08:00:00.000Z']);
  assert.ok(f.tipo === 'FATO');
  if (f.tipo === 'FATO') {
    assert.deepEqual([f.fonteDesde, f.vigenteDesde, f.ultimaConfirmacaoEm].map((d) => d.toISOString()),
      ['2026-09-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z', '2026-09-04T08:00:00.000Z']);
  }
});

test('[P1A-L03] na L1b (sem mudar a L1b): FATO → agência da matriz; EXCECAO → P12; NAO_OBSERVADO → igual a hoje; Master compartilhado → o mesmo armador', () => {
  const hoje = decidirProcesso({ ...entradaSemIntegracoes('IM100', T(10), MBL_RECEBIDO()), vinculo: { tipo: 'VINCULADO', vinculo: vinculo('IM100', 'M1') } });
  const fato = sobre(['x1', 1, tr(MSC)]);
  assert.deepEqual(armadorParaL1b(fato, FONTE), {
    armador: {
      tipo: 'INTEGRADA', fonte: { disponivel: true, desde: '2026-09-01T08:00:00.000Z' },
      valor: {
        oficial: { valor: { masterId: 'M1', codigo: 'MSC' }, vigenteDesde: '2026-09-01T08:00:00.000Z', ultimaConfirmacaoEm: '2026-09-01T08:00:00.000Z', evidencia: { fonte: FONTE, ref: 'evidencia:x1' } },
        historico: [],
      },
    },
  });
  assert.deepEqual(decisao(fato).agencia, { tipo: 'MAPEADA', armador: 'MSC', codigoInformado: 'MSC', agencia: 'MSC', evidencia: { fonte: FONTE, ref: 'evidencia:x1' } });
  // Master compartilhado (dois Houses vinculados ao mesmo Master): o fato é do Master, o mesmo para os dois processos.
  assert.deepEqual([decisao(fato, 'IM100').agencia.tipo, decisao(fato, 'IM101').agencia.tipo], ['MAPEADA', 'MAPEADA']);
  const excecao = decisao(sobre(['x1', 1, SO_AGENCIA]));
  assert.equal(excecao.agencia.tipo, 'ARMADOR_NAO_IDENTIFICADO');
  assert.ok(excecao.itens.some((i) => i.acao === 'IDENTIFICAR_ARMADOR_DO_MASTER'), 'exceção visível (P12), nenhum dado incerto entra');
  assert.deepEqual(armadorParaL1b(sobre(['x1', 1, undefined]), FONTE), {}, 'não observado: a porta não entregaria nada');
  assert.deepEqual(decisao(sobre(['x1', 1, undefined])), hoje, 'sem declarações: a mesma decisão de hoje');
  assert.equal(hoje.agencia.tipo, 'NAO_DETERMINAVEL');
});

test('[P1A-L04] integração automática DESLIGADA: nada está ligado — projeção e documentos como no HEAD, nenhuma chave, nenhum I/O no adaptador', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..');
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'armadorDoMaster.ts'), 'utf8');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [, imp] of codigo.matchAll(/from\s+'([^']+)'/g)) assert.doesNotMatch(imp, /docExtractor|extracao|\/ai\/|gemini|graph|msal|extrair|documentos|identidade|vinculos|camposDoMbl/i, imp);
  assert.ok([...codigo.matchAll(/^import\s+(?!type\b).*from\s+'\.\.\/dominio'/gm)].length === 0, 'do domínio, só tipos (R33)');
  for (const proibido of ['process.env', 'PRIORA_', 'query(', 'decidirProcesso', 'entradaSemIntegracoes', 'aplicarPortaoCompartilhado', 'agenciaDoArmador',
    'codigoCanonicoDoArmador', 'ARMADORES_DA_MATRIZ', 'NAO_INTEGRADA', 'remetente', 'chaveMaster', 'prefixo', 'tracking', 'conhecimento']) {
    assert.ok(!codigo.includes(proibido), `armadorDoMaster.ts não usa ${proibido}`);
  }
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(d, e.name)) : [path.join(d, e.name)]));
  const producao = todos(raiz).filter((f) => f.endsWith('.ts') && !f.split(path.sep).includes('__tests__'));
  assert.deepEqual(producao.filter((f) => /from\s+'[^']*\/armadorDoMaster'/.test(fs.readFileSync(f, 'utf8'))), [], 'nenhum arquivo de produção usa o adaptador');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'projecao.ts'), 'utf8'), /opcoes\.posteriores \?\? SEM_FONTES_POSTERIORES/, 'a projeção segue sem fontes posteriores');
  assert.match(fs.readFileSync(path.join(raiz, 'liberacao', 'documentos', 'aplicacao', 'postgres.ts'), 'utf8'), /armador: FONTE_DO_ARMADOR_PENDENTE/, 'os documentos seguem com o armador pendente');
});
