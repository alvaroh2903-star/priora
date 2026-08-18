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
import { familiaV012, ncmCompativeis } from './v012Ncm';
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

// ---- pipeline ----
test('executarPreAlerta: caminho feliz consolida Consistente (7 famílias)', () => {
  const cheio = (nome: 'MBL' | 'HBL', file: string): DocPreAlerta =>
    doc(nome, file, [ct(C1, { pesoBrutoKg: 8000, pesoLiquidoKg: 7000, cubagemM3: 30.78, lacre: 'ML123', ncm: ['3926'] })], {
      pesoBrutoTotalKg: 8000, pesoLiquidoTotalKg: 7000, cubagemTotalM3: 30.78,
      qtdVolumesTotal: 100, tipoVolume: 'CARTONS', descricaoMercadoria: 'SILICONE SEALANT', ncm: ['3926'],
    });
  const op: Operacao = { processo: 'IM18', master: cheio('MBL', 'MBL.pdf'), houses: [cheio('HBL', 'HBL-A')] };
  const r = executarPreAlerta(op);
  assert.equal(r.resultado, 'Consistente');
  assert.equal(r.familias.length, 7); // V-003,004,005,006,007,008,012
  assert.ok(r.evidencias.length > 0);
});
