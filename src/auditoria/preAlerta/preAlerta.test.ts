/**
 * Testes determinísticos do núcleo do Pré-Alerta (PB-001, Fase 1).
 * Runner nativo do Node (node:test) — sem dependências externas. Rode: npm test
 * Contêineres usados: BMOU9784013 e TEMU1234565 (ambos válidos em ISO 6346).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizarNumero, numeroIgual, validaISO6346 } from './normalizacao';
import { ContainerDoc, DocPreAlerta, Operacao, Evidencia } from './modelo';
import { familiaV003 } from './v003Containers';
import { familiaV004 } from './v004Volumes';
import { familiaV005 } from './v005PesoBruto';
import { familiaV006 } from './v006PesoLiquido';
import { familiaV007 } from './v007Cubagem';
import { familiaV008 } from './v008Lacres';
import { familiaV009 } from './v009Portos';
import { familiaV012, ncmCompativeis } from './v012Ncm';
import { equivalenciaPorto, resolveUnlocode } from './unlocode';
import { Extracao, mapExtracaoParaDoc, montarOperacao, baseDoBL } from './extracaoPreAlerta';
import { executarPreAlerta } from './index';

const C1 = 'BMOU9784013';
const C2 = 'TEMU1234565';

// ---- fábricas ----
function ct(numero: string | null, over: Partial<ContainerDoc> = {}): ContainerDoc {
  return { numero, pesoBrutoKg: null, pesoLiquidoKg: null, cubagemM3: null, lacre: null, ncm: [], ...over };
}
function doc(tipo: 'MBL' | 'HBL', nome: string, containers: ContainerDoc[], over: Partial<DocPreAlerta> = {}): DocPreAlerta {
  return {
    tipo, nome, legivel: true, containers,
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [],
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
    ...over,
  };
}
const sub = (evs: Evidencia[], s: string): Evidencia | undefined => evs.find((e) => e.subvalidacao === s);

// ---- normalização numérica ----
test('normalizarNumero: formatos equivalentes do playbook', () => {
  assert.equal(normalizarNumero('8.000,000'), 8000);
  assert.equal(normalizarNumero('8000.00'), 8000);
  assert.equal(normalizarNumero('8000'), 8000);
  assert.equal(normalizarNumero('27.162,300'), 27162.3);
  assert.equal(normalizarNumero('30,780'), 30.78);
  assert.equal(normalizarNumero('12,5'), 12.5);
  assert.equal(normalizarNumero('20.000'), 20000); // milhar (Q8)
  assert.equal(normalizarNumero('1.234.567'), 1234567);
  assert.equal(normalizarNumero('23.300,00 KG'), 23300);
  assert.equal(normalizarNumero(''), null);
  assert.equal(normalizarNumero(null), null);
});

test('numeroIgual: zero tolerância com equivalência de formato', () => {
  assert.equal(numeroIgual(8000, 8000.0), true);
  assert.equal(numeroIgual(30.78, 30.78), true);
  assert.equal(numeroIgual(8000, 8001), false);
});

test('validaISO6346: dígito verificador', () => {
  assert.equal(validaISO6346('BMOU9784013'), true);
  assert.equal(validaISO6346('TEMU1234565'), true);
  assert.equal(validaISO6346('bmou9784013'), true); // normaliza caixa
  assert.equal(validaISO6346('BMOU9784014'), false); // dígito verificador errado
  assert.equal(validaISO6346('ABC123'), false); // formato inválido
});

// ---- V-003 Containers ----
test('V-003: House único consistente cria relacionamento', () => {
  const op: Operacao = { processo: 'IM1', master: doc('MBL', 'MBL.pdf', [ct(C1)]), houses: [doc('HBL', 'HBL-A', [ct(C1)])] };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 1);
  assert.equal(familia.resultado, 'Consistente');
  assert.equal(sub(familia.evidencias, 'V-003.2')?.resultado, 'Consistente');
  assert.equal(sub(familia.evidencias, 'V-003.3')?.resultado, 'Consistente');
});

test('V-003: leitura incerta do número → Validação Humana, sem relacionamento', () => {
  const op: Operacao = { processo: 'IM2', master: doc('MBL', 'MBL.pdf', [ct(C1)]), houses: [doc('HBL', 'HBL-A', [ct(C1, { leituraIncerta: ['numero'] })])] };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 0);
  assert.equal(sub(familia.evidencias, 'V-003.2')?.resultado, 'ValidacaoHumana');
  assert.equal(familia.resultado, 'ValidacaoHumana');
});

test('V-003 (Q9): 1×1 número divergente → V-003.2 Divergência, sem relacionamento', () => {
  const op: Operacao = { processo: 'IM3', master: doc('MBL', 'MBL.pdf', [ct(C1)]), houses: [doc('HBL', 'HBL-A', [ct(C2)])] };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 0);
  assert.equal(sub(familia.evidencias, 'V-003.1')?.resultado, 'Consistente'); // existência OK (1 de cada lado)
  assert.equal(sub(familia.evidencias, 'V-003.2')?.resultado, 'Divergencia'); // número divergente
  assert.equal(familia.resultado, 'Divergencia');
});

test('V-003 (Q9): 1×1 divergente por leitura incerta → Validação Humana', () => {
  const op: Operacao = { processo: 'IM4', master: doc('MBL', 'MBL.pdf', [ct(C1)]), houses: [doc('HBL', 'HBL-A', [ct(C2, { leituraIncerta: ['numero'] })])] };
  const { familia } = familiaV003(op);
  assert.equal(sub(familia.evidencias, 'V-003.2')?.resultado, 'ValidacaoHumana');
});

test('V-003: sobra não-1×1 → divergência de existência', () => {
  const op: Operacao = { processo: 'IM5', master: doc('MBL', 'MBL.pdf', [ct(C1), ct(C2)]), houses: [doc('HBL', 'HBL-A', [ct(C1)])] };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 1); // C1 vinculado
  assert.equal(familia.resultado, 'Divergencia'); // C2 do MBL sem House
});

test('V-003: múltiplos Houses — cada contêiner vincula ao seu House', () => {
  const op: Operacao = {
    processo: 'IM6',
    master: doc('MBL', 'MBL.pdf', [ct(C1), ct(C2)]),
    houses: [doc('HBL', 'HBL-1', [ct(C1)]), doc('HBL', 'HBL-2', [ct(C2)])],
  };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 2);
  assert.equal(familia.resultado, 'Consistente');
  assert.deepEqual(relacoes.map((r) => r.houseId).sort(), ['HBL-1', 'HBL-2']);
});

// ---- Famílias numéricas (V-005/006/007) ----
function opNum(campo: 'pesoBrutoKg' | 'pesoLiquidoKg' | 'cubagemM3', total: 'pesoBrutoTotalKg' | 'pesoLiquidoTotalKg' | 'cubagemTotalM3', vM: number, vH: number, tM: number, tH: number): Operacao {
  return {
    processo: 'IM7',
    master: doc('MBL', 'MBL.pdf', [ct(C1, { [campo]: vM })], { [total]: tM }),
    houses: [doc('HBL', 'HBL-A', [ct(C1, { [campo]: vH })], { [total]: tH })],
  };
}

test('V-005: peso bruto igual → consistente; 1 kg de diferença → divergência (zero tolerância)', () => {
  const ok = opNum('pesoBrutoKg', 'pesoBrutoTotalKg', 8000, 8000, 8000, 8000);
  const r1 = familiaV005(ok, familiaV003(ok).relacoes);
  assert.equal(r1.resultado, 'Consistente');

  const bad = opNum('pesoBrutoKg', 'pesoBrutoTotalKg', 8000, 8001, 8000, 8001);
  const r2 = familiaV005(bad, familiaV003(bad).relacoes);
  assert.equal(sub(r2.evidencias, 'V-005.1')?.resultado, 'Divergencia');
  assert.equal(r2.resultado, 'Divergencia');
});

test('V-005.2: soma dos Houses = total do Master → consistente', () => {
  const op: Operacao = {
    processo: 'IM8',
    master: doc('MBL', 'MBL.pdf', [ct(C1, { pesoBrutoKg: 8000 }), ct(C2, { pesoBrutoKg: 12000 })], { pesoBrutoTotalKg: 20000 }),
    houses: [
      doc('HBL', 'HBL-1', [ct(C1, { pesoBrutoKg: 8000 })], { pesoBrutoTotalKg: 8000 }),
      doc('HBL', 'HBL-2', [ct(C2, { pesoBrutoKg: 12000 })], { pesoBrutoTotalKg: 12000 }),
    ],
  };
  const fam = familiaV005(op, familiaV003(op).relacoes);
  assert.equal(sub(fam.evidencias, 'V-005.2')?.resultado, 'Consistente');
  assert.equal(fam.resultado, 'Consistente');
});

test('V-006: peso líquido — mesmo motor, divergência detectada', () => {
  const bad = opNum('pesoLiquidoKg', 'pesoLiquidoTotalKg', 7000, 6999, 7000, 6999);
  const fam = familiaV006(bad, familiaV003(bad).relacoes);
  assert.equal(sub(fam.evidencias, 'V-006.1')?.resultado, 'Divergencia');
  assert.equal(fam.resultado, 'Divergencia');
});

test('V-007: cubagem — equivalência de formato 30.780 == 30,78', () => {
  const ok = opNum('cubagemM3', 'cubagemTotalM3', 30.78, 30.78, 30.78, 30.78);
  const fam = familiaV007(ok, familiaV003(ok).relacoes);
  assert.equal(sub(fam.evidencias, 'V-007.1')?.resultado, 'Consistente');
  assert.equal(fam.resultado, 'Consistente');
});

// ---- V-004 Volumes ----
test('V-004: quantidade + tipo consistentes; divergência de tipo (literal, Q2)', () => {
  const ok: Operacao = {
    processo: 'IM10',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { qtdVolumesTotal: 100, tipoVolume: 'CARTONS' }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { qtdVolumesTotal: 100, tipoVolume: 'CARTONS' })],
  };
  assert.equal(familiaV004(ok).resultado, 'Consistente');

  const tipoDif: Operacao = {
    processo: 'IM11',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { qtdVolumesTotal: 100, tipoVolume: 'CARTONS' }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { qtdVolumesTotal: 100, tipoVolume: 'PACKAGES' })],
  };
  assert.equal(sub(familiaV004(tipoDif).evidencias, 'V-004.2')?.resultado, 'Divergencia');
  assert.equal(familiaV004(tipoDif).resultado, 'Divergencia');
});

// ---- V-008 Lacres ----
test('V-008: correspondência OK; lacre divergente; ausência → Não Avaliada', () => {
  const ok: Operacao = { processo: 'IM12', master: doc('MBL', 'MBL.pdf', [ct(C1, { lacre: 'ML123' })]), houses: [doc('HBL', 'HBL-A', [ct(C1, { lacre: 'ml123' })])] };
  const fOk = familiaV008(ok, familiaV003(ok).relacoes);
  assert.equal(sub(fOk.evidencias, 'V-008.2')?.resultado, 'Consistente'); // normaliza caixa

  const dif: Operacao = { processo: 'IM13', master: doc('MBL', 'MBL.pdf', [ct(C1, { lacre: 'ML123' })]), houses: [doc('HBL', 'HBL-A', [ct(C1, { lacre: 'ML124' })])] };
  assert.equal(sub(familiaV008(dif, familiaV003(dif).relacoes).evidencias, 'V-008.2')?.resultado, 'Divergencia');

  const ausente: Operacao = { processo: 'IM14', master: doc('MBL', 'MBL.pdf', [ct(C1, { lacre: 'ML123' })]), houses: [doc('HBL', 'HBL-A', [ct(C1)])] };
  assert.equal(sub(familiaV008(ausente, familiaV003(ausente).relacoes).evidencias, 'V-008.1')?.resultado, 'NaoAvaliada');
});

test('V-008.3: lacre repetido em dois contêineres → divergência de unicidade', () => {
  const op: Operacao = {
    processo: 'IM15',
    master: doc('MBL', 'MBL.pdf', [ct(C1, { lacre: 'ML123' }), ct(C2, { lacre: 'ML123' })]),
    houses: [doc('HBL', 'HBL-A', [ct(C1, { lacre: 'ML123' }), ct(C2, { lacre: 'ML123' })])],
  };
  const fam = familiaV008(op, familiaV003(op).relacoes);
  assert.equal(sub(fam.evidencias, 'V-008.3')?.resultado, 'Divergencia');
});

// ---- V-012 NCM ----
test('ncmCompativeis: menor nível de dígitos comum', () => {
  assert.equal(ncmCompativeis('3926', '39269090'), true);
  assert.equal(ncmCompativeis('392690', '39269090'), true);
  assert.equal(ncmCompativeis('392690', '392790'), false);
  assert.equal(ncmCompativeis('39269090', '39269099'), false);
});

test('V-012: correspondência por prefixo; código ausente → divergência', () => {
  const ok: Operacao = {
    processo: 'IM16',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { ncm: ['3926', '8471'] }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { ncm: ['84713012', '39269090'] })],
  };
  assert.equal(familiaV012(ok).resultado, 'Consistente'); // ordem irrelevante + prefixo

  const falta: Operacao = {
    processo: 'IM17',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { ncm: ['3926', '8471', '8504'] }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { ncm: ['39269090', '84713012'] })],
  };
  assert.equal(sub(familiaV012(falta).evidencias, 'V-012.2')?.resultado, 'Divergencia');
});

// ---- V-009 Portos (UN/LOCODE) ----
test('resolveUnlocode / equivalenciaPorto: nome↔código, sem inferência geográfica', () => {
  assert.equal(resolveUnlocode('Shanghai'), 'CNSHA');
  assert.equal(resolveUnlocode('SHANGHAI, CHINA'), 'CNSHA');
  assert.equal(resolveUnlocode('BRSSZ'), 'BRSSZ');
  assert.equal(resolveUnlocode('Portinho Desconhecido'), null);
  assert.equal(equivalenciaPorto('Santos', 'BRSSZ'), 'igual');
  assert.equal(equivalenciaPorto('Qingdao', 'CNTAO'), 'igual');
  assert.equal(equivalenciaPorto('Shanghai', 'Ningbo'), 'diferente');
  assert.equal(equivalenciaPorto('Portinho X', 'Portinho Y'), 'incerto');
});

test('V-009: rota consistente; POD divergente; origem/destino invertidos', () => {
  const ok: Operacao = {
    processo: 'IM19',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { pol: 'Qingdao', pod: 'Paranagua' }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { pol: 'CNTAO', pod: 'BRPNG' })],
  };
  assert.equal(familiaV009(ok).resultado, 'Consistente');

  const podDif: Operacao = {
    processo: 'IM20',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { pol: 'Qingdao', pod: 'Santos' }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { pol: 'Qingdao', pod: 'Paranagua' })],
  };
  assert.equal(familiaV009(podDif).resultado, 'Divergencia');

  const invertido: Operacao = {
    processo: 'IM21',
    master: doc('MBL', 'MBL.pdf', [ct(C1)], { pol: 'Qingdao', pod: 'Santos' }),
    houses: [doc('HBL', 'HBL-A', [ct(C1)], { pol: 'Santos', pod: 'Qingdao' })],
  };
  assert.equal(sub(familiaV009(invertido).evidencias, 'V-009.3')?.resultado, 'Divergencia');
});

// ---- pipeline ----
test('executarPreAlerta: caminho feliz consolida Consistente (8 famílias)', () => {
  const cheio = (nome: 'MBL' | 'HBL', file: string): DocPreAlerta =>
    doc(nome, file, [ct(C1, { pesoBrutoKg: 8000, pesoLiquidoKg: 7000, cubagemM3: 30.78, lacre: 'ML123', ncm: ['3926'] })], {
      pesoBrutoTotalKg: 8000, pesoLiquidoTotalKg: 7000, cubagemTotalM3: 30.78,
      qtdVolumesTotal: 100, tipoVolume: 'CARTONS', descricaoMercadoria: 'SILICONE SEALANT', ncm: ['3926'],
      pol: 'Qingdao', pod: 'Paranagua',
    });
  const op: Operacao = { processo: 'IM22', master: cheio('MBL', 'MBL.pdf'), houses: [cheio('HBL', 'HBL-A')] };
  const r = executarPreAlerta(op);
  assert.equal(r.resultado, 'Consistente');
  assert.equal(r.familias.length, 8); // V-003,004,005,006,007,008,009,012
  assert.ok(r.evidencias.length > 0);
});

// ---- extração → modelo (wiring, funções puras) ----
function aiVazio(over: Partial<Extracao> = {}): Extracao {
  return {
    legivel: true, tipoDetectado: 'MBL',
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [], containers: [],
    ...over,
  };
}

test('mapExtracaoParaDoc: mapeia campos do conhecimento e contêineres', () => {
  const ai = aiVazio({
    pol: 'Qingdao', pod: 'Paranagua', pesoBrutoTotalKg: 27162.3, cubagemTotalM3: 30.78,
    qtdVolumesTotal: 1890, tipoVolume: 'CARTONS', ncm: ['3214', '3506'],
    containers: [{ numero: 'BMOU9784013', pesoBrutoKg: 27162.3, pesoLiquidoKg: 22000, cubagemM3: 30.78, lacre: 'M7636999', ncm: ['3214'] }],
  });
  const d = mapExtracaoParaDoc(ai, 'MBL.pdf', 'MBL');
  assert.equal(d.tipo, 'MBL');
  assert.equal(d.pol, 'Qingdao');
  assert.equal(d.pesoBrutoTotalKg, 27162.3);
  assert.equal(d.containers.length, 1);
  assert.equal(d.containers[0].lacre, 'M7636999');
  assert.equal(d.containers[0].pesoLiquidoKg, 22000);
});

test('montarOperacao: agrupa 1 Master × N Houses', () => {
  const docs = [
    mapExtracaoParaDoc(aiVazio(), 'MBL.pdf', 'MBL'),
    mapExtracaoParaDoc(aiVazio(), 'HBL1.pdf', 'HBL'),
    mapExtracaoParaDoc(aiVazio(), 'HBL2.pdf', 'HBL'),
  ];
  const op = montarOperacao('IM23', docs);
  assert.equal(op.master?.nome, 'MBL.pdf');
  assert.equal(op.houses.length, 2);
});

// ---- fixture do PROCESSO REAL (QGD3084071 × QDOS038996) ----
// Valores extraídos dos documentos reais enviados. Peso líquido não consta nos
// BLs → V-006 fica Não Avaliada (auditoria parcial), o resto bate.
const famRes = (r: { familias: { familia: string; resultado: string }[] }, cod: string) =>
  r.familias.find((f) => f.familia === cod)?.resultado;

function processoReal(over: Partial<import('./modelo').ContainerDoc> = {}): Operacao {
  const cont = (o: Partial<import('./modelo').ContainerDoc> = {}) =>
    ct('BMOU9784013', { pesoBrutoKg: 27162.3, cubagemM3: 30.78, lacre: 'M7636999', ncm: ['3214', '3506'], ...o });
  const geral = {
    pesoBrutoTotalKg: 27162.3, cubagemTotalM3: 30.78, qtdVolumesTotal: 1890, tipoVolume: 'CARTONS',
    descricaoMercadoria: 'PU MS SILICONE SEALANT', ncm: ['3214', '3506'],
  };
  return {
    processo: 'IM-REAL',
    master: doc('MBL', 'QGD3084071.pdf', [cont()], { ...geral, pol: 'Qingdao', pod: 'Paranagua' }),
    houses: [doc('HBL', 'QDOS038996.pdf', [cont(over)], { ...geral, pol: 'CNTAO', pod: 'BRPNG' })],
  };
}

test('PROCESSO REAL: consistente nos campos avaliáveis; parcial por falta de peso líquido', () => {
  const r = executarPreAlerta(processoReal());
  assert.equal(famRes(r, 'V-003'), 'Consistente'); // contêiner BMOU9784013
  assert.equal(famRes(r, 'V-004'), 'Consistente'); // 1890 CARTONS
  assert.equal(famRes(r, 'V-005'), 'Consistente'); // 27162.3 kg
  assert.equal(famRes(r, 'V-006'), 'NaoAvaliada'); // peso líquido ausente nos BLs
  assert.equal(famRes(r, 'V-007'), 'Consistente'); // 30.78 m³
  assert.equal(famRes(r, 'V-008'), 'Consistente'); // lacre M7636999
  assert.equal(famRes(r, 'V-009'), 'Consistente'); // Qingdao(CNTAO) → Paranaguá(BRPNG)
  assert.equal(famRes(r, 'V-012'), 'Consistente'); // NCM 3214/3506
  assert.equal(r.resultado, 'NaoAvaliada'); // parcial: não avaliou tudo (peso líquido)
});

test('PROCESSO REAL: lacre divergente no House → V-008 e consolidado em Divergência', () => {
  const r = executarPreAlerta(processoReal({ lacre: 'M7636998' })); // 1 caractere diferente
  assert.equal(famRes(r, 'V-008'), 'Divergencia');
  assert.equal(r.resultado, 'Divergencia');
});

// ---- agrupamento de PÁGINAS (multi-imagem do mesmo BL) ----
test('baseDoBL: páginas do mesmo BL caem na mesma base; docs distintos não', () => {
  // "... MBL-1/2/3.jpg" são páginas do MESMO Master → mesma base (1 OCR).
  assert.equal(baseDoBL('140655114952 MBL-1.jpg'), baseDoBL('140655114952 MBL-3.jpg'));
  assert.equal(baseDoBL('140655114952 MBL-1.jpg'), baseDoBL('140655114952 MBL-2.jpg'));
  // Documento distinto (identificador longo, sem marcador de página curto no fim).
  assert.notEqual(baseDoBL('140655114952 SE26071000008.jpg'), baseDoBL('140655114952 MBL-1.jpg'));
  // Marcador de página explícito também agrupa.
  assert.equal(baseDoBL('BL HOUSE pag 2.pdf'), baseDoBL('BL HOUSE pag 1.pdf'));
  assert.equal(baseDoBL('MASTER_page1.pdf'), baseDoBL('MASTER_page2.pdf'));
  // "(1)"/"(2)" são desambiguadores de nome duplicado do Outlook — podem ser
  // documentos DIFERENTES; por segurança NÃO agrupamos (evita fundir dois BLs).
  assert.notEqual(baseDoBL('conhecimento (1).png'), baseDoBL('conhecimento (2).png'));
});

// ---- operação sem par MBL×HBL (guarda anti-"0 kg") ----
test('montarOperacao: só MBL(s) → master definido, houses vazio', () => {
  const docs = [
    mapExtracaoParaDoc(aiVazio(), 'MBL-1.jpg', 'MBL'),
    mapExtracaoParaDoc(aiVazio(), 'MBL-2.jpg', 'MBL'),
  ];
  const op = montarOperacao('IM24', docs);
  assert.ok(op.master);
  assert.equal(op.houses.length, 0);
});

test('família numérica sem House: total NÃO vira 0 (Σ Houses = —, NaoAvaliada)', () => {
  const op: Operacao = {
    processo: 'IM25',
    master: doc('MBL', 'MBL.pdf', [ct(C1, { pesoBrutoKg: 8000 })], { pesoBrutoTotalKg: 8000 }),
    houses: [],
  };
  const fam = familiaV005(op, familiaV003(op).relacoes);
  const total = sub(fam.evidencias, 'V-005.2');
  assert.equal(total?.resultado, 'NaoAvaliada');
  assert.equal(total?.valores[1].valor, '—'); // Σ Houses não pode ser "0 kg"
});
