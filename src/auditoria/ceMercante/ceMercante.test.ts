/**
 * PB-002 — CE Mercante · testes determinísticos (node:test). Rode: npm test
 * Contêineres válidos ISO 6346: BMOU9784013, TEMU1234565.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerDoc, DocPreAlerta, Evidencia } from '../preAlerta/modelo';
import { executarCeMercante, OperacaoCE, ehComponenteCE, numeroBaseDoNome } from './index';

const C1 = 'BMOU9784013';
const C2 = 'TEMU1234565';

function ct(numero: string | null, over: Partial<ContainerDoc> = {}): ContainerDoc {
  return { numero, pesoBrutoKg: null, pesoLiquidoKg: null, cubagemM3: null, lacre: null, ncm: [], ...over };
}
function doc(nome: string, containers: ContainerDoc[], over: Partial<DocPreAlerta> = {}): DocPreAlerta {
  return {
    tipo: 'MBL', nome, legivel: true, containers,
    pesoBrutoTotalKg: null, pesoLiquidoTotalKg: null, cubagemTotalM3: null,
    qtdVolumesTotal: null, tipoVolume: null, descricaoMercadoria: null, ncm: [],
    pol: null, pod: null, placeOfReceipt: null, placeOfDelivery: null, transbordos: [],
    ...over,
  };
}
const sub = (evs: Evidencia[], s: string): Evidencia | undefined => evs.find((e) => e.subvalidacao === s);

// ---- Ingestão: nomes REAIS do CE (nº do BL + "dados básicos"/"item N") ----
test('ehComponenteCE: reconhece "dados básicos" e "item N"; ignora os BLs', () => {
  assert.equal(ehComponenteCE('SHYY26010120 dados básicos.pdf'), true);
  assert.equal(ehComponenteCE('SHYY26010120 item 1.pdf'), true);
  assert.equal(ehComponenteCE('SHYY26010120 item 4.pdf'), true);
  assert.equal(ehComponenteCE('263463180-OMBL.pdf'), false);
  assert.equal(ehComponenteCE('SHYY26010120-OHBL.PDF'), false);
});

test('numeroBaseDoNome: extrai o nº do BL do nome (liga CE ao seu BL)', () => {
  // Todos os componentes do CE deste House compartilham o mesmo número-base.
  assert.equal(numeroBaseDoNome('SHYY26010120 dados básicos.pdf'), 'SHYY26010120');
  assert.equal(numeroBaseDoNome('SHYY26010120 item 1.pdf'), 'SHYY26010120');
  assert.equal(numeroBaseDoNome('SHYY26010120 item 4.pdf'), 'SHYY26010120');
  assert.equal(numeroBaseDoNome('SHYY26010120-OHBL.PDF'), 'SHYY26010120'); // casa com o HBL
  assert.equal(numeroBaseDoNome('263463180-OMBL.pdf'), '263463180'); // casa com o MBL
});

test('CE Mercante: Master↔MBL e House↔HBL batendo (todos os campos) → Consistente', () => {
  // Match COMPLETO: container + peso + cubagem + NCM (campo ausente vira
  // NaoAvaliada e domina o Consistente na consolidação — regra do blueprint).
  const cheio = { pesoBrutoTotalKg: 1000, cubagemTotalM3: 20, ncm: ['12345678'] };
  const op: OperacaoCE = {
    processo: 'IM1',
    mbl: doc('MBL.pdf', [ct(C1)], { ...cheio, conhecimentoNumero: 'MBL123' }),
    hbls: [doc('HBL.pdf', [ct(C1)], { ...cheio, conhecimentoNumero: 'HBL999' })],
    ceMaster: doc('CE-MASTER.pdf', [ct(C1)], { ...cheio, conhecimentoNumero: 'MBL123' }),
    ceHouses: [doc('CE-HOUSE.pdf', [ct(C1)], { ...cheio, conhecimentoNumero: 'HBL999' })],
  };
  const r = executarCeMercante(op);
  assert.equal(r.resultado, 'Consistente');
});

test('CE Mercante: container do CE Master diverge do MBL → Divergencia', () => {
  const op: OperacaoCE = {
    processo: 'IM2',
    mbl: doc('MBL.pdf', [ct(C1)], { pesoBrutoTotalKg: 1000 }),
    hbls: [],
    ceMaster: doc('CE-MASTER.pdf', [ct(C2)], { pesoBrutoTotalKg: 1000 }),
    ceHouses: [],
  };
  const r = executarCeMercante(op);
  assert.equal(r.resultado, 'Divergencia');
});

test('CE Mercante: part lot — mesmo container em 2 Houses NÃO é duplicidade; Σ peso = Master', () => {
  const op: OperacaoCE = {
    processo: 'IM3',
    mbl: doc('MBL.pdf', [ct(C1)], { pesoBrutoTotalKg: 1000 }),
    hbls: [doc('H1.pdf', [ct(C1)]), doc('H2.pdf', [ct(C1)])],
    ceMaster: doc('CE-M.pdf', [ct(C1)], { pesoBrutoTotalKg: 1000 }),
    ceHouses: [
      doc('CE-H1.pdf', [ct(C1)], { pesoBrutoTotalKg: 600 }),
      doc('CE-H2.pdf', [ct(C1)], { pesoBrutoTotalKg: 400 }),
    ],
  };
  const r = executarCeMercante(op);
  const cons = sub(r.evidencias, 'V-015.1'); // Σ Houses = Master (600+400=1000)
  assert.equal(cons?.resultado, 'Consistente');
  const contCons = sub(r.evidencias, 'V-015.2'); // container único do Master nos Houses
  assert.equal(contCons?.resultado, 'Consistente');
});

test('CE Mercante: sem CE Master → V-001 NaoAvaliada (não inventa consistente)', () => {
  const op: OperacaoCE = { processo: 'IM4', mbl: doc('MBL.pdf', [ct(C1)]), hbls: [], ceMaster: null, ceHouses: [] };
  const r = executarCeMercante(op);
  assert.equal(r.resultado, 'NaoAvaliada');
});

test('CE Mercante: HBL sem CE House correspondente → Divergencia (filhote faltando)', () => {
  const op: OperacaoCE = {
    processo: 'IM5',
    mbl: doc('MBL.pdf', [ct(C1)], { pesoBrutoTotalKg: 1000, conhecimentoNumero: 'M1' }),
    hbls: [doc('HBL.pdf', [ct(C1)], { conhecimentoNumero: 'H1' })],
    ceMaster: doc('CE-M.pdf', [ct(C1)], { pesoBrutoTotalKg: 1000, conhecimentoNumero: 'M1' }),
    ceHouses: [], // nenhum filhote
  };
  const r = executarCeMercante(op);
  assert.equal(r.resultado, 'Divergencia');
});
