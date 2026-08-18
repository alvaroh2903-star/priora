/**
 * Testes determinísticos do núcleo do Pré-Alerta (PB-001, Fase 1).
 * Runner nativo do Node (node:test) — sem dependências externas.
 * Rode com: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizarNumero,
  numeroIgual,
  validaISO6346,
} from './normalizacao';
import { ContainerDoc, DocPreAlerta, Operacao, Evidencia } from './modelo';
import { familiaV003 } from './v003Containers';
import { familiaV005 } from './v005PesoBruto';
import { executarPreAlerta } from './index';

// ---- fábricas ----
function ct(numero: string | null, over: Partial<ContainerDoc> = {}): ContainerDoc {
  return {
    numero,
    pesoBrutoKg: null,
    pesoLiquidoKg: null,
    cubagemM3: null,
    lacre: null,
    ncm: [],
    qtdVolumes: null,
    tipoVolume: null,
    ...over,
  };
}
function doc(
  tipo: 'MBL' | 'HBL',
  nome: string,
  containers: ContainerDoc[],
  totals: Partial<DocPreAlerta> = {},
): DocPreAlerta {
  return {
    tipo,
    nome,
    legivel: true,
    containers,
    pesoBrutoTotalKg: null,
    pesoLiquidoTotalKg: null,
    cubagemTotalM3: null,
    ...totals,
  };
}
const sub = (evs: Evidencia[], s: string): Evidencia | undefined => evs.find((e) => e.subvalidacao === s);
const subsResult = (evs: Evidencia[], s: string) => evs.filter((e) => e.subvalidacao === s).map((e) => e.resultado);

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
  assert.equal(normalizarNumero('23.300,00 KG'), 23300); // ignora unidade textual
  assert.equal(normalizarNumero(''), null);
  assert.equal(normalizarNumero(null), null);
});

test('numeroIgual: zero tolerância com equivalência de formato', () => {
  assert.equal(numeroIgual(8000, 8000.0), true);
  assert.equal(numeroIgual(30.78, 30.78), true);
  assert.equal(numeroIgual(8000, 8001), false);
});

// ---- ISO 6346 (dígito verificador) ----
test('validaISO6346: dígito verificador', () => {
  assert.equal(validaISO6346('BMOU9784013'), true); // contêiner real da amostra
  assert.equal(validaISO6346('bmou9784013'), true); // normaliza caixa
  assert.equal(validaISO6346('BMOU9784014'), false); // dígito verificador errado
  assert.equal(validaISO6346('ABC123'), false); // formato inválido
});

// ---- V-003 Containers ----
test('V-003: House único consistente cria relacionamento', () => {
  const op: Operacao = {
    processo: 'IM0001',
    master: doc('MBL', 'MBL.pdf', [ct('BMOU9784013')]),
    houses: [doc('HBL', 'HBL-A', [ct('BMOU9784013')])],
  };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 1);
  assert.equal(familia.resultado, 'Consistente');
  assert.equal(sub(familia.evidencias, 'V-003.2')?.resultado, 'Consistente');
  assert.equal(sub(familia.evidencias, 'V-003.3')?.resultado, 'Consistente');
});

test('V-003: leitura incerta do número → Validação Humana, sem relacionamento', () => {
  const op: Operacao = {
    processo: 'IM0002',
    master: doc('MBL', 'MBL.pdf', [ct('BMOU9784013')]),
    houses: [doc('HBL', 'HBL-A', [ct('BMOU9784013', { leituraIncerta: ['numero'] })])],
  };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 0);
  assert.equal(sub(familia.evidencias, 'V-003.2')?.resultado, 'ValidacaoHumana');
  assert.equal(familia.resultado, 'ValidacaoHumana');
});

test('V-003: contêiner ausente/divergente → divergência de existência', () => {
  const op: Operacao = {
    processo: 'IM0003',
    master: doc('MBL', 'MBL.pdf', [ct('BMOU9784013')]),
    houses: [doc('HBL', 'HBL-A', [ct('TEMU1234561')])],
  };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 0);
  assert.equal(familia.resultado, 'Divergencia');
  // existência falha nos dois sentidos: House sem par no MBL e MBL sem par em House
  assert.ok(subsResult(familia.evidencias, 'V-003.1').every((r) => r === 'Divergencia'));
});

test('V-003: múltiplos Houses — cada contêiner vincula ao seu House', () => {
  const op: Operacao = {
    processo: 'IM0004',
    master: doc('MBL', 'MBL.pdf', [ct('BMOU9784013'), ct('TEMU1234561')]),
    houses: [
      doc('HBL', 'HBL-1', [ct('BMOU9784013')]),
      doc('HBL', 'HBL-2', [ct('TEMU1234561')]),
    ],
  };
  const { relacoes, familia } = familiaV003(op);
  assert.equal(relacoes.length, 2);
  assert.equal(familia.resultado, 'Consistente');
  assert.deepEqual(
    relacoes.map((r) => r.houseId).sort(),
    ['HBL-1', 'HBL-2'],
  );
});

// ---- V-005 Peso Bruto (zero tolerância) ----
function opPeso(masterKg: number | null, houseKg: number | null, totalM: number | null, totalH: number | null): Operacao {
  return {
    processo: 'IM0005',
    master: doc('MBL', 'MBL.pdf', [ct('BMOU9784013', { pesoBrutoKg: masterKg })], { pesoBrutoTotalKg: totalM }),
    houses: [doc('HBL', 'HBL-A', [ct('BMOU9784013', { pesoBrutoKg: houseKg })], { pesoBrutoTotalKg: totalH })],
  };
}

test('V-005.1: peso igual por contêiner → consistente', () => {
  const op = opPeso(8000, 8000, 8000, 8000);
  const { relacoes } = familiaV003(op);
  const fam = familiaV005(op, relacoes);
  assert.equal(sub(fam.evidencias, 'V-005.1')?.resultado, 'Consistente');
  assert.equal(fam.resultado, 'Consistente');
});

test('V-005.1: 1 kg de diferença → divergência (zero tolerância)', () => {
  const op = opPeso(8000, 8001, 8000, 8001);
  const { relacoes } = familiaV003(op);
  const fam = familiaV005(op, relacoes);
  assert.equal(sub(fam.evidencias, 'V-005.1')?.resultado, 'Divergencia');
  assert.equal(fam.resultado, 'Divergencia');
});

test('V-005.2: soma dos Houses = total do Master → consistente', () => {
  const op: Operacao = {
    processo: 'IM0006',
    master: doc('MBL', 'MBL.pdf', [ct('BMOU9784013', { pesoBrutoKg: 8000 }), ct('TEMU1234561', { pesoBrutoKg: 12000 })], { pesoBrutoTotalKg: 20000 }),
    houses: [
      doc('HBL', 'HBL-1', [ct('BMOU9784013', { pesoBrutoKg: 8000 })], { pesoBrutoTotalKg: 8000 }),
      doc('HBL', 'HBL-2', [ct('TEMU1234561', { pesoBrutoKg: 12000 })], { pesoBrutoTotalKg: 12000 }),
    ],
  };
  const { relacoes } = familiaV003(op);
  const fam = familiaV005(op, relacoes);
  assert.equal(sub(fam.evidencias, 'V-005.2')?.resultado, 'Consistente');
  assert.equal(fam.resultado, 'Consistente');
});

test('V-005.2: soma dos Houses ≠ total do Master → divergência', () => {
  const op = opPeso(8000, 8000, 20000, 8000); // total master 20000, só um House 8000
  const { relacoes } = familiaV003(op);
  const fam = familiaV005(op, relacoes);
  assert.equal(sub(fam.evidencias, 'V-005.2')?.resultado, 'Divergencia');
  assert.equal(fam.resultado, 'Divergencia');
});

// ---- pipeline ----
test('executarPreAlerta: caminho feliz consolida Consistente', () => {
  const op = opPeso(8000, 8000, 8000, 8000);
  const r = executarPreAlerta(op);
  assert.equal(r.resultado, 'Consistente');
  assert.equal(r.familias.length, 2); // V-003 + V-005
  assert.ok(r.evidencias.length > 0);
});
