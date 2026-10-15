/**
 * PB-002 — CE Mercante · testes determinísticos (node:test). Rode: npm test
 * Contêineres válidos ISO 6346: BMOU9784013, TEMU1234565.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContainerDoc, DocPreAlerta, Evidencia } from '../preAlerta/modelo';
import {
  executarCeMercante,
  OperacaoCE,
  ehComponenteCE,
  numeroBaseDoNome,
  chaveResultadoCeMercante,
} from './index';
import { assinaturaFontesProcesso } from '../preAlerta/extracaoPreAlerta';

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
test('ehComponenteCE: reconhece "dados básicos", "item N" e "itemN" (sem espaço)', () => {
  assert.equal(ehComponenteCE('SHYY26010120 dados básicos.pdf'), true);
  assert.equal(ehComponenteCE('SHYY26010120 item 1.pdf'), true); // com espaço
  assert.equal(ehComponenteCE('HVNSE2605034 item1.pdf'), true); // SEM espaço (real)
  assert.equal(ehComponenteCE('ONEYHANG42654400 dados basicos.pdf'), true); // sem acento
  assert.equal(ehComponenteCE('263463180-OMBL.pdf'), false);
  assert.equal(ehComponenteCE('OHBL 2ND LEG.pdf'), false);
});

test('numeroBaseDoNome: extrai o nº do BL do nome (com/sem espaço no item)', () => {
  assert.equal(numeroBaseDoNome('SHYY26010120 dados básicos.pdf'), 'SHYY26010120');
  assert.equal(numeroBaseDoNome('SHYY26010120 item 1.pdf'), 'SHYY26010120');
  assert.equal(numeroBaseDoNome('HVNSE2605034 item1.pdf'), 'HVNSE2605034'); // House (sem espaço)
  assert.equal(numeroBaseDoNome('HVNSE2605034 dados basicos.pdf'), 'HVNSE2605034');
  assert.equal(numeroBaseDoNome('ONEYHANG42654400 item5.pdf'), 'ONEYHANG42654400'); // Master
  assert.equal(numeroBaseDoNome('263463180-OMBL.pdf'), '263463180');
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

// ---- Regressão: identidade de FONTE no cache de resultado (PB-002) --------
// Bug: a assinatura usava só `tipo:nome`. Um CE/BL reenviado com o MESMO nome
// (outro e-mail/anexo — ex.: CE ou BL corrigido) colidia e recebia o resultado
// ANTIGO. Correção: assinatura por identidade de fonte (tipo + e-mail + anexo +
// nome), independente da ordem, e chave persistente em v2 (aposenta o v1).
type Fonte = { tipo: string; emailId: string; attachmentId: string; nome: string };
const fonte = (over: Partial<Fonte> = {}): Fonte => ({
  tipo: 'CE_MASTER',
  emailId: 'email-1',
  attachmentId: 'att-1',
  nome: 'SHYY26010120 dados básicos.pdf',
  ...over,
});

test('assinaturaFontesProcesso: MESMO nome/tipo + anexo/e-mail diferente → assinatura DIFERENTE', () => {
  const original = [fonte()];
  const reenviado = [fonte({ emailId: 'email-2', attachmentId: 'att-2' })]; // mesmo tipo+nome, fonte nova
  assert.notEqual(assinaturaFontesProcesso(original), assinaturaFontesProcesso(reenviado));

  // A assinatura ANTIGA (só tipo:nome) colidia — exatamente o bug que a correção mata.
  const sigAntiga = (ds: Fonte[]) => ds.map((d) => `${d.tipo}:${d.nome}`).sort().join('|');
  assert.equal(sigAntiga(original), sigAntiga(reenviado));
});

test('assinaturaFontesProcesso: mesmo conjunto em ORDEM diferente → MESMA assinatura', () => {
  const a = fonte({ tipo: 'CE_MASTER', nome: 'A.pdf', attachmentId: 'a' });
  const b = fonte({ tipo: 'CE_HOUSE', nome: 'B.pdf', attachmentId: 'b' });
  const c = fonte({ tipo: 'HBL', nome: 'C.pdf', attachmentId: 'c' });
  assert.equal(assinaturaFontesProcesso([a, b, c]), assinaturaFontesProcesso([c, a, b]));
});

test('chaveResultadoCeMercante: v2 + fontes diferentes/contas diferentes → chaves diferentes', () => {
  const sigOrig = assinaturaFontesProcesso([fonte()]);
  const sigReenv = assinaturaFontesProcesso([fonte({ emailId: 'email-2', attachmentId: 'att-2' })]);
  const kOrig = chaveResultadoCeMercante({ escopoConta: 'contaA', processoBase: 'IM0001', assinaturaFontes: sigOrig });
  const kReenv = chaveResultadoCeMercante({ escopoConta: 'contaA', processoBase: 'IM0001', assinaturaFontes: sigReenv });

  assert.match(kOrig, /^resultado:v2:contaA:cemercante:IM0001:/); // aposenta o v1 filename-only
  assert.notEqual(kOrig, kReenv); // reenvio com mesmo nome → chave nova, nunca o resultado antigo

  // Tenant-scope: contas diferentes nunca compartilham chave (mesmo processo+fontes).
  const kOutraConta = chaveResultadoCeMercante({ escopoConta: 'contaB', processoBase: 'IM0001', assinaturaFontes: sigOrig });
  assert.notEqual(kOrig, kOutraConta);
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
