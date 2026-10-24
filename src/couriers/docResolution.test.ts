/**
 * ASS-010 (entrega parcial) — resolução documental do OHBL com negação explícita.
 * Só a função pura; o caminho da rota está em docResolution.rota.test.ts.
 *
 * Três tipos de teste, rotulados no nome:
 *  - "ASS-010": comportamento corrigido (menção negada não é evidência afirmativa);
 *  - "preservado": comportamento anterior que tem de continuar igual;
 *  - "caracterização": LIMITAÇÃO CONHECIDA fora do escopo (atribuição por
 *    documento, cronologia, pendência, shipper…). Mostra o comportamento atual,
 *    herdado; NÃO é evidência de conformidade com o Blueprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docResolutionFromText, DocResolution } from './docResolution';

/** A função ANTES desta mudança (cópia literal), referência de equivalência. */
function legada(text: string): DocResolution {
  const t = text || '';
  return {
    telex: /telex\s*release|\btelex\b/i.test(t),
    wave: /wave\s*b\/?l|\bwave\s*release\b/i.test(t),
    destino: /destination\s+issuance|(?:emitid[oa]|issued)[^.\n]{0,30}(?:destino|destination)/i.test(t),
    importador: /(?:enviad[oa]|sent)[^.\n]{0,40}(?:importador|importer|consignee)/i.test(t),
  };
}

const telex = (t: string) => docResolutionFromText(t).telex;
const importador = (t: string) => docResolutionFromText(t).importador;

/* ---------------- casos pedidos na aprovação ---------------- */

test('ASS-010: "Telex released. Original HBL not required." → telex continua verdadeiro (a negação é de outra oração)', () => {
  assert.equal(telex('Telex released. Original HBL not required.'), true);
});

test('ASS-010: "Telex release not approved." → não é evidência afirmativa de telex', () => {
  assert.equal(legada('Telex release not approved.').telex, true, 'antes contava como telex');
  assert.equal(telex('Telex release not approved.'), false);
});

test('ASS-010: "Not only telex release but also…" → "not only" não é negação', () => {
  assert.equal(telex('Not only telex release but also the original HBL by courier.'), true);
});

test('ASS-010: "OHBL not sent to consignee." → importador falso', () => {
  assert.equal(legada('OHBL not sent to consignee.').importador, true, 'antes contava como enviado');
  assert.equal(importador('OHBL not sent to consignee.'), false);
});

test('ASS-010: "OHBL sent to consignee, not to the agent." → importador continua verdadeiro', () => {
  assert.equal(importador('OHBL sent to consignee, not to the agent.'), true);
});

/* ---------------- negação de telex ---------------- */

test('ASS-010: telex explicitamente negado na própria oração não é evidência (inglês e português)', () => {
  const negados = [
    'No telex release for this shipment, original HBL will follow by courier.',
    'NO TELEX. Originals sent by DHL.',
    'Please note: not telex.',
    'There is no telex release for IM2101.',
    'Please do not telex release the HBL.',
    "We can't telex release before payment confirmation.",
    'Telex release is not approved.',
    'Telex release has not been approved yet.',
    'Neither telex nor sea waybill.',
    'Non-telex release: originals required.',
    'Sem telex — OHBL segue no courier.',
    'Não haverá telex release para este processo.',
    'O telex não foi liberado.',
    'Telex release ainda não aprovado.',
    'Nem telex nem Wave BL.',
  ];
  for (const t of negados) {
    assert.equal(legada(t).telex, true, `fixture inválida (antes já era falso): ${t}`);
    assert.equal(telex(t), false, t);
  }
});

test('ASS-010: negação que não é do telex não o anula', () => {
  const afirmados = [
    'No problem, telex released.',
    'No problem telex released.',
    'Telex release, not original HBL.',
    'Telex released and original HBL not required.',
    'Telex release no later than Friday.',
    'Conforme informado no telex release, o HBL foi liberado.',
    'Telex release done; no original documents needed.',
    'HBL was not printed: telex release instead.',
  ];
  for (const t of afirmados) assert.equal(telex(t), true, t);
});

/* ---------------- negação do envio ao destinatário ---------------- */

test('ASS-010: envio ao destinatário explicitamente negado não é evidência (inglês e português)', () => {
  const negados = [
    'OHBL has not been sent to the consignee.',
    "Original HBL wasn't sent to importer.",
    'Original documents were never sent to the consignee.',
    'No original documents sent to the consignee.',
    'OHBL sent to the agent, not to the consignee.',
    'OHBL sent not to the consignee.',
    'OHBL não foi enviado ao importador.',
    'O OHBL nunca foi enviado ao importador.',
    'OHBL enviado ao agente, não ao importador.',
  ];
  for (const t of negados) {
    assert.equal(legada(t).importador, true, `fixture inválida (antes já era falso): ${t}`);
    assert.equal(importador(t), false, t);
  }
});

test('ASS-010: envio afirmado continua verdadeiro mesmo com negação em outra parte', () => {
  const afirmados = [
    'OHBL sent to consignee.',
    'OHBL enviado ao importador.',
    'OHBL sent without delay to the consignee.',
    'OHBL sent not only to the consignee but also to the agent.',
    'OHBL not sent to the agent but to the consignee.',
    'OHBL sent to the consignee; no copy to the agent.',
  ];
  for (const t of afirmados) assert.equal(importador(t), true, t);
});

/* ---------------- preservado ---------------- */

test('preservado: casos afirmativos de antes', () => {
  for (const t of ['HBL send via TELEX RELEASE', 'telex release ok', 'TELEXRELEASE', 'HBL via telex']) {
    assert.equal(telex(t), true, t);
  }
  for (const t of ['OHBL sent to consignee', 'documentos enviados ao importador', 'HBL enviado para o importador']) {
    assert.equal(importador(t), true, t);
  }
});

test('preservado: "HBL to cnee" sozinho não prova telex nem envio ao destinatário (ASS-010)', () => {
  assert.deepEqual(docResolutionFromText('HBL to cnee'), { telex: false, wave: false, destino: false, importador: false });
  assert.deepEqual(docResolutionFromText('HBL to cnee.'), legada('HBL to cnee.'));
});

test('preservado: interface (as mesmas quatro chaves) e texto vazio/ausente', () => {
  assert.deepEqual(Object.keys(docResolutionFromText('x')).sort(), ['destino', 'importador', 'telex', 'wave']);
  assert.deepEqual(docResolutionFromText(''), legada(''));
  assert.deepEqual(docResolutionFromText(undefined as unknown as string), legada(undefined as unknown as string));
});

test('preservado: Wave BL e emissão no destino não mudam, nem com negação', () => {
  const textos = [
    'Wave BL issued.', 'No wave BL.', 'Not a wave release.', 'Destination issuance confirmed.',
    'Not issued at destination.', 'HBL emitido no destino.', 'Não emitido no destino.',
  ];
  for (const t of textos) {
    const r = docResolutionFromText(t);
    const l = legada(t);
    assert.deepEqual([r.wave, r.destino], [l.wave, l.destino], t);
  }
});

/* ---------------- equivalência e monotonia ---------------- */

/** Gerador determinístico (mesma semente, mesmo corpus em todo run). */
function gerador(semente: number) {
  let s = semente >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const VOCAB_NEUTRO = [
  'telex', 'release', 'released', 'TELEX RELEASE', 'sent', 'enviado', 'enviada', 'consignee', 'importer',
  'importador', 'to', 'the', 'ao', 'HBL', 'OHBL', 'original', 'via', 'courier', 'wave', 'BL', 'wave bl',
  'destination', 'issuance', 'issued', 'emitido', 'destino', 'agent', 'by', 'DHL', 'IM2101', ',', '.', ';',
  '\n', 'and', 'but', 'mas', 'only', 'pending', 'after', 'payment', 'cnee', 'please', 'is', 'was', 'has', 'been',
];
const NEGADORES = ['not', 'no', 'never', "don't", 'não', 'sem', 'nunca', 'without', 'nor', 'cannot'];

function frase(r: () => number, vocab: string[], n: number): string {
  return Array.from({ length: n }, () => vocab[Math.floor(r() * vocab.length)]).join(' ');
}

test('preservado: sem nenhum negador no texto, o resultado é idêntico ao anterior (5.000 textos gerados)', () => {
  const r = gerador(20261024);
  for (let i = 0; i < 5000; i++) {
    const t = frase(r, VOCAB_NEUTRO, 3 + Math.floor(r() * 14));
    assert.deepEqual(docResolutionFromText(t), legada(t), JSON.stringify(t));
  }
});

test('ASS-010: com negadores, a correção só retira afirmações — nunca cria telex ou envio novos (5.000 textos)', () => {
  const r = gerador(42);
  const vocab = [...VOCAB_NEUTRO, ...NEGADORES, ...NEGADORES];
  let retirados = 0;
  for (let i = 0; i < 5000; i++) {
    const t = frase(r, vocab, 3 + Math.floor(r() * 14));
    const novo = docResolutionFromText(t);
    const antes = legada(t);
    if (novo.telex) assert.equal(antes.telex, true, JSON.stringify(t));
    if (novo.importador) assert.equal(antes.importador, true, JSON.stringify(t));
    assert.deepEqual([novo.wave, novo.destino], [antes.wave, antes.destino], JSON.stringify(t));
    if (novo.telex !== antes.telex || novo.importador !== antes.importador) retirados++;
  }
  assert.ok(retirados > 0, 'o corpus precisa exercitar a negação');
});

/* ---------------- caracterização: limitações conhecidas (fora do escopo) ---------------- */

test('caracterização (limitação conhecida, sem atribuição por documento): menções mistas no mesmo texto mantêm o resultado herdado', () => {
  // O resultado é por texto (envelope), como antes: uma menção não negada basta.
  // Atribuir telex ao documento/processo certo é outra etapa (E4); isto não prova conformidade.
  assert.equal(telex('No telex for IM2101. HBL IM2102 telex released.'), true);
  assert.equal(importador('OHBL not sent to consignee. Other OHBL sent to importer.'), true);
});

test('caracterização (limitação conhecida, sem cronologia): cancelamento posterior não restaura a expectativa', () => {
  // Retomada do envio físico (ASS-009) e ordem das mensagens ficam fora do escopo.
  assert.equal(telex('Telex released. Update: telex cancelled, original HBL by courier.'), true);
});

test('caracterização (limitação conhecida, pendente/condicional): segue como antes', () => {
  for (const t of ['Telex release pending payment.', 'Telex release upon payment.', 'Awaiting telex release.']) {
    assert.equal(telex(t), legada(t).telex, t);
    assert.equal(telex(t), true, t);
  }
});

test('caracterização (limitação conhecida): negação separada por vírgula ou travessão não é lida', () => {
  // A vírgula é fronteira de oração de propósito ("Telex release, not original HBL").
  assert.equal(telex('Telex release, not approved.'), true);
  assert.equal(telex('Telex release — not approved.'), true);
});

test('caracterização (limitação conhecida): shipper e "cnee" não são reconhecidos como destinatário (como antes)', () => {
  assert.equal(importador('OHBL sent to shipper.'), false);
  assert.equal(importador('OHBL sent to cnee.'), false);
});
