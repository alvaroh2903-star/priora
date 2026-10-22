import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  AssinaturaDoDocumento, DeclaracaoDoTransportador, LeituraParaTransportador, TransportadorDaVersao, VeredictoDaDeclaracao, normalizarNome,
  transportadorDaVersao, transportadorDoMbl, veredictoDaDeclaracao,
} from '../transportador';

/**
 * Regra determinística do papel de transportador (P1-A, preservada na O2.1-C), PURA e independente de fonte: recebe
 * declarações candidatas (nome + trecho literal) e decide só pelo texto. Nenhuma extração Gemini, nenhum OCR, nenhum
 * banco. Fixtures sintéticas: empresas, BLs e agências fictícios.
 */

const SHA = (n: number) => n.toString(16).padStart(64, '0');
const CARRIER = 'NAVEGADORA SINTETICA ALFA S.A.';
const AGENCIA = 'AGENCIA MARITIMA BETA LTDA';
const NVOCC = 'GAMA CONSOLIDADORA DE CARGAS LTDA';

const declaracao = (nome: string | null, trecho: string | null, posicao: DeclaracaoDoTransportador['posicao'] = 'CAMPO_TRANSPORTADOR'): DeclaracaoDoTransportador =>
  ({ nome, posicao, trecho });
const t = (declaracoes: DeclaracaoDoTransportador[], assinatura: AssinaturaDoDocumento | null = null) => ({ declaracoes, assinatura });
const tv = (x: ReturnType<typeof t>) => transportadorDaVersao(x.declaracoes, x.assinatura);
const motivo = (v: VeredictoDaDeclaracao) => (v.tipo === 'ACEITA' ? 'ACEITA' : v.motivo);
const nomesDe = (e: TransportadorDaVersao) => (e.tipo === 'DECLARADO' ? e.nomes.map((n) => n.normalizado) : []);

/** Uma leitura de qualquer fonte documental (a referência da evidência é opaca para a regra). */
const leitura = (id: string, sha: number | null, declaracoes?: DeclaracaoDoTransportador[], recebida = '2026-09-01T08:00:00.000Z'): LeituraParaTransportador => ({
  evidenciaRef: `evidencia:${id}`, arquivoSha256: sha === null ? null : SHA(sha), observadaEm: new Date(recebida), extraidaEm: new Date(recebida),
  ...(declaracoes ? { declaracoes } : {}),
});

/* ------------------------------------------------ aceitação (pura, determinística) ------------------------------------------------ */

/* ------------------------------------------------ aceitação (pura, determinística) ------------------------------------------------ */

test('[P1A-01] MBL com Carrier explícito: o campo rotulado nomeia o transportador → declaração aceita, com o trecho e a posição', () => {
  for (const trecho of [`Carrier: ${CARRIER}`, `CARRIER ${CARRIER} SHIPPER EXPORTADORA SINTETICA`, `Ocean Carrier - ${CARRIER}`, `Transportador: ${CARRIER}`]) {
    const v = veredictoDaDeclaracao(declaracao(CARRIER, trecho), null);
    assert.deepEqual(v, { tipo: 'ACEITA', nome: CARRIER, normalizado: 'NAVEGADORA SINTETICA ALFA S A', posicao: 'CAMPO_TRANSPORTADOR', trecho }, trecho);
  }
  const e = tv(t([declaracao(CARRIER, `Carrier: ${CARRIER}`)]));
  assert.equal(e.tipo, 'DECLARADO');
  assert.deepEqual(e.tipo === 'DECLARADO' && e.nomes, [{ normalizado: 'NAVEGADORA SINTETICA ALFA S A', literais: [CARRIER] }]);
  // Outras posições documentais com o papel escrito valem igualmente (nenhum campo gráfico é exigido).
  for (const [posicao, trecho] of [
    ['CLAUSULA_DE_TERMOS', `The Carrier is ${CARRIER}`], ['OUTRA_DECLARACAO', `${CARRIER} (the Carrier)`], ['CLAUSULA_DE_ASSINATURA', `Signed by ${CARRIER} as Carrier`],
  ] as const) {
    assert.equal(motivo(veredictoDaDeclaracao(declaracao(CARRIER, trecho, posicao), null)), 'ACEITA', `${posicao}: ${trecho}`);
  }
  // A comparação ignora só caixa, acentos e pontuação.
  assert.equal(normalizarNome('Navegação  Sintética—Alfa, s.a.'), 'NAVEGACAO SINTETICA ALFA S A');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('Navegação Sintética Alfa', 'TRANSPORTADOR: NAVEGACAO SINTETICA ALFA'), null)), 'ACEITA');
});

test('[P1A-02] cláusula de assinatura: a agência que assina "as agent" nunca é o transportador; o transportador é quem ela representa', () => {
  const clausula = `Signed by ${AGENCIA} as agent for and on behalf of the Carrier ${CARRIER}`;
  const assinatura = { signatario: AGENCIA, papel: 'AGENTE_DO_TRANSPORTADOR' as const };
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(CARRIER, clausula, 'CLAUSULA_DE_ASSINATURA'), assinatura)), 'ACEITA');
  // Se o OCR confundir e devolver a agência como transportador, a declaração é recusada pelo próprio trecho.
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(AGENCIA, clausula, 'CLAUSULA_DE_ASSINATURA'), assinatura)), 'PAPEL_DE_AGENTE');
  const semPalavra = 'DELTA SHIPPING LTDA';
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(semPalavra, `Signed by ${semPalavra} as agents for the Carrier`), null)), 'PAPEL_DE_AGENTE',
    'o nome sem "agência" ainda é recusado: o trecho diz "as agents"');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(semPalavra, `${semPalavra} for the Carrier`), { signatario: semPalavra, papel: 'AGENTE_DO_TRANSPORTADOR' })),
    'SIGNATARIO_AGENTE', 'o signatário em papel de agente nunca é o transportador');
  // "as agents for X" sem dizer que X é o transportador: X não é aceito (o papel dele não está escrito).
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(CARRIER, `Signed as agents for ${CARRIER}`), null)), 'PAPEL_NAO_DECLARADO');
  // As duas declarações juntas: vale o transportador; a da agência fica visível como recusada.
  const e = tv(t([declaracao(CARRIER, clausula, 'CLAUSULA_DE_ASSINATURA'), declaracao(AGENCIA, clausula, 'CLAUSULA_DE_ASSINATURA')], assinatura));
  assert.deepEqual([e.tipo, nomesDe(e)], ['DECLARADO', ['NAVEGADORA SINTETICA ALFA S A']]);
  assert.deepEqual(e.tipo === 'DECLARADO' && e.recusadas.map(motivo), ['PAPEL_DE_AGENTE']);
});

test('[P1A-03] documento só com a agência marítima: nenhum transportador nomeado → NAO_DECLARADO (nada é deduzido da agência)', () => {
  const e = tv(t([
    declaracao(AGENCIA, `Signed by ${AGENCIA} as agent for the Carrier`, 'CLAUSULA_DE_ASSINATURA'),
    declaracao(AGENCIA, `For delivery apply to: ${AGENCIA}`, 'OUTRA_DECLARACAO'),
  ], { signatario: AGENCIA, papel: 'AGENTE_DO_TRANSPORTADOR' }));
  assert.equal(e.tipo, 'NAO_DECLARADO');
  assert.deepEqual(e.tipo === 'NAO_DECLARADO' && e.recusadas.map(motivo), ['PAPEL_DE_AGENTE', 'PAPEL_DE_AGENTE']);
  assert.deepEqual(tv(t([])), { tipo: 'NAO_DECLARADO', recusadas: [] }, 'o OCR não achou declaração: lista vazia');
  assert.deepEqual(tv(t([declaracao(null, null)])), { tipo: 'NAO_DECLARADO', recusadas: [] }, 'declaração sem nome é ausência');
});

test('[P1A-04] NVOCC e transportador distintos: só o transportador vale; NVOCC, agente de cargas e as partes do BL nunca', () => {
  const e = tv(t([
    declaracao(CARRIER, `Carrier: ${CARRIER}`),
    declaracao(NVOCC, `Shipper: ${NVOCC}`, 'OUTRA_DECLARACAO'),
    declaracao('GAMA LINES LTD', 'GAMA LINES LTD, a Non-Vessel Operating Common Carrier', 'OUTRA_DECLARACAO'),
    declaracao('EPSILON TRADING LTDA', 'Notify party: EPSILON TRADING LTDA', 'OUTRA_DECLARACAO'),
  ]));
  assert.deepEqual([e.tipo, nomesDe(e)], ['DECLARADO', ['NAVEGADORA SINTETICA ALFA S A']]);
  assert.deepEqual(e.tipo === 'DECLARADO' && e.recusadas.map(motivo), ['PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS', 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS', 'PAPEL_DE_OUTRA_PARTE']);
  // "NON VESSEL OPERATING COMMON CARRIER" contém "CARRIER", mas é NVOCC (a expressão mais longa vale).
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('ZETA LINES', 'ZETA LINES as Non Vessel Operating Common Carrier'), null)), 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS');
  for (const nome of ['ZETA LOGISTICS S.A.', 'ZETA FREIGHT FORWARDING', 'ZETA NVOCC LTDA']) {
    assert.equal(motivo(veredictoDaDeclaracao(declaracao(nome, `Carrier: ${nome}`), null)), 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS', nome);
  }
  // A expressão mais longa vale primeiro: "agente de cargas" não é "agente" (agência), "notify party" é parte do BL.
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('OMEGA LTDA', 'OMEGA LTDA como agente de cargas'), null)), 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('OMEGA LTDA', 'OMEGA LTDA as forwarding agent'), null)), 'PAPEL_DE_NVOCC_OU_AGENTE_DE_CARGAS');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('ETA EXPORTADORA', 'Shipper: ETA EXPORTADORA'), null)), 'PAPEL_DE_OUTRA_PARTE');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('THETA COMERCIO', 'Consignee THETA COMERCIO'), null)), 'PAPEL_DE_OUTRA_PARTE');
});

test('[P1A-05] documento ambíguo: papéis conflitantes, logotipo/cabeçalho, prefixo e remetente nunca viram transportador', () => {
  // O mesmo nome com dois papéis no trecho: AMBIGUO (nada é aceito, nem as outras declarações da versão).
  const conflito = tv(t([
    declaracao(CARRIER, `Carrier: ${CARRIER}`),
    declaracao(CARRIER, `Carrier: ${CARRIER} as agent`, 'CLAUSULA_DE_ASSINATURA'),
  ]));
  assert.equal(conflito.tipo, 'AMBIGUO');
  assert.deepEqual(conflito.tipo === 'AMBIGUO' && conflito.recusadas.map(motivo), ['PAPEIS_CONFLITANTES']);
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(CARRIER, `${CARRIER} as Carrier and ${CARRIER} as agent`), null)), 'PAPEIS_CONFLITANTES');
  // Dois transportadores diferentes declarados na mesma versão: os dois ficam; nada é escolhido aqui.
  const dois = tv(t([declaracao(CARRIER, `Carrier: ${CARRIER}`), declaracao('NAVEGADORA SINTETICA BETA', 'for the Carrier NAVEGADORA SINTETICA BETA', 'CLAUSULA_DE_ASSINATURA')]));
  assert.deepEqual(nomesDe(dois), ['NAVEGADORA SINTETICA ALFA S A', 'NAVEGADORA SINTETICA BETA']);
  // Sem o papel escrito no trecho: logotipo/cabeçalho, prefixo do BL, rastreamento ou remetente não são declaração.
  for (const [nome, trecho] of [
    [CARRIER, CARRIER], [CARRIER, `${CARRIER} BILL OF LADING`], ['SINT', 'B/L No. SINT1234567'], ['SINT', 'Container SINTU1234567'],
    ['ALFA', 'From: operacoes@alfa.teste'], ['ALFA', 'Tracking ALFA 1234'],
  ]) {
    assert.ok(['PAPEL_NAO_DECLARADO', 'NOME_FORA_DO_TRECHO'].includes(motivo(veredictoDaDeclaracao(declaracao(nome, trecho, 'OUTRA_DECLARACAO'), null))), trecho);
  }
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(CARRIER, 'Carrier: OUTRA EMPRESA'), null)), 'NOME_FORA_DO_TRECHO', 'o nome tem de estar no trecho');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao(CARRIER, null), null)), 'SEM_TRECHO');
  assert.equal(motivo(veredictoDaDeclaracao(declaracao('ALFA', `Carrier: ${CARRIER}`), null)), 'ACEITA',
    'parte do nome dentro do trecho é aceita no documental; a lista fechada da Liberação é exata (marca sozinha não entra)');
  const cabecalho = tv(t([declaracao(CARRIER, CARRIER, 'OUTRA_DECLARACAO')]));
  assert.equal(cabecalho.tipo, 'NAO_DECLARADO');
});

/* ------------------------------------------------ por leitura e por arquivo ------------------------------------------------ */

test('[P1A-06] versões documentais divergentes: cada leitura fica com o seu transportador; o mesmo arquivo lido com resultados diferentes é divergência de leitura', () => {
  const alfa = [declaracao(CARRIER, `Carrier: ${CARRIER}`)];
  const beta = [declaracao('NAVEGADORA SINTETICA BETA', 'Carrier: NAVEGADORA SINTETICA BETA')];
  const r = transportadorDoMbl('M1', [leitura('x1', 1, alfa), leitura('x2', 2, beta, '2026-09-05T08:00:00.000Z'), leitura('x3', 1, [], '2026-09-06T08:00:00.000Z')]);
  assert.deepEqual(r.leituras.map((l) => [l.evidenciaRef, l.estado.tipo, nomesDe(l.estado)]), [
    ['evidencia:x1', 'DECLARADO', ['NAVEGADORA SINTETICA ALFA S A']],
    ['evidencia:x2', 'DECLARADO', ['NAVEGADORA SINTETICA BETA']],
    ['evidencia:x3', 'NAO_DECLARADO', []],
  ], 'todas as leituras ficam, na ordem dada, com a referência de cada uma');
  assert.deepEqual(r.arquivos.map((a) => [a.arquivoSha256, a.evidenciaRefs, a.situacao]), [
    [SHA(1), ['evidencia:x1', 'evidencia:x3'], 'LEITURAS_DIVERGENTES'], [SHA(2), ['evidencia:x2'], 'CONCLUSIVO'],
  ]);
  // Mesmo arquivo, mesmas conclusões com trechos diferentes: concorda (o trecho exato não decide).
  const iguais = transportadorDoMbl('M1', [leitura('y1', 3, alfa), leitura('y2', 3, [declaracao(CARRIER, `Signed for the Carrier ${CARRIER}`, 'CLAUSULA_DE_ASSINATURA')])]);
  assert.deepEqual(iguais.arquivos.map((a) => a.situacao), ['CONCLUSIVO']);
  // Leitura sem hash é um arquivo próprio.
  const semHash = transportadorDoMbl('M1', [leitura('z1', null, alfa), leitura('z2', null, beta)]);
  assert.deepEqual(semHash.arquivos.map((a) => [a.evidenciaRefs, a.situacao]), [[['evidencia:z1'], 'CONCLUSIVO'], [['evidencia:z2'], 'CONCLUSIVO']]);
});

test('[P1A-07a] leitura sem declarações fornecidas pela fonte: NAO_EXTRAIDO (não contribui); OCR sem identificação: NAO_DECLARADO', () => {
  assert.deepEqual(transportadorDaVersao(undefined), { tipo: 'NAO_EXTRAIDO' });
  assert.deepEqual(transportadorDaVersao([]), { tipo: 'NAO_DECLARADO', recusadas: [] }, 'a fonte leu e não achou declaração');
  const r = transportadorDoMbl('M1', [leitura('a', 7), leitura('b', 7, [declaracao(CARRIER, `Carrier: ${CARRIER}`)])]);
  assert.deepEqual(r.leituras.map((l) => l.estado.tipo), ['NAO_EXTRAIDO', 'DECLARADO']);
  assert.deepEqual(r.arquivos.map((a) => a.situacao), ['CONCLUSIVO'], 'a leitura sem declarações não diverge: ela não leu o campo');
  assert.deepEqual(transportadorDoMbl('M1', [leitura('c', 8)]).arquivos.map((a) => a.situacao), ['SEM_LEITURA']);
});

test('[P1A-10] a regra é pura e isolada: nenhum import, nenhum I/O, nenhum nome de armador, e nenhum código de produção a usa', () => {
  const raiz = path.resolve(__dirname, '..', '..', '..');
  const fonte = fs.readFileSync(path.join(raiz, 'auditoria', 'parser', 'transportador.ts'), 'utf8');
  assert.deepEqual([...fonte.matchAll(/^\s*import\b.*$/gm)], [], 'nenhum import');
  const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /process\.env|require\(|fetch\(|generateStructured|getAttachmentContent|\bquery\(|MSC|MAERSK|HAPAG|SCAC/, 'sem I/O, IA, banco, armador ou prefixo');
  const todos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todos(path.join(d, e.name)) : [path.join(d, e.name)]));
  const producao = todos(raiz).filter((f) => f.endsWith('.ts') && !f.split(path.sep).includes('__tests__'));
  const usuarios = producao.filter((f) => /from\s+'[^']*parser\/transportador'/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(raiz, f));
  assert.deepEqual(usuarios, ['liberacao/aplicacao/armadorDoMaster.ts'], 'só o adaptador puro (também não ligado) a importa');
  assert.equal(normalizarNome('Navegação  Sintética—Alfa, s.a.'), 'NAVEGACAO SINTETICA ALFA S A');
});
