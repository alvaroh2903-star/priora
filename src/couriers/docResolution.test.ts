/**
 * ASS-010 (entregas parciais) — resolução documental do OHBL: negação explícita e
 * Telex Release Confirmado × Pendente. Só a função pura; o caminho da rota está em
 * docResolution.rota.test.ts e a tela em docResolution.front.test.ts.
 *
 * Contrato: `telex` = Telex Release CONFIRMADO (conclusão explícita e nenhuma
 * menção pendente no texto); `telexPendente` = menção não negada sem conclusão
 * explícita (promessa, condição, pedido, pergunta, "approved" ou só a palavra).
 * Nunca os dois juntos. "Não negado" = confirmado OU pendente.
 *
 * Rótulos no nome:
 *  - "ASS-010": comportamento funcional exigido;
 *  - "preservado": comportamento anterior que tem de continuar igual;
 *  - "caracterização": LIMITAÇÃO CONHECIDA fora do escopo. Mostra o comportamento
 *    atual; NÃO é evidência de conformidade com o Blueprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docResolutionFromText, DocResolution } from './docResolution';

/** A função ANTES das entregas do ASS-010 (cópia literal), referência de equivalência. */
function legada(text: string): Omit<DocResolution, 'telexPendente'> {
  const t = text || '';
  return {
    telex: /telex\s*release|\btelex\b/i.test(t),
    wave: /wave\s*b\/?l|\bwave\s*release\b/i.test(t),
    destino: /destination\s+issuance|(?:emitid[oa]|issued)[^.\n]{0,30}(?:destino|destination)/i.test(t),
    importador: /(?:enviad[oa]|sent)[^.\n]{0,40}(?:importador|importer|consignee)/i.test(t),
  };
}

const r = (t: string) => docResolutionFromText(t);
const confirmado = (t: string) => r(t).telex;
const pendente = (t: string) => r(t).telexPendente;
/** Menção de telex NÃO negada (confirmada ou pendente). */
const naoNegado = (t: string) => r(t).telex || r(t).telexPendente;
const importador = (t: string) => r(t).importador;

function situacao(t: string): 'confirmado' | 'pendente' | 'nenhum' {
  const x = r(t);
  assert.ok(!(x.telex && x.telexPendente), `confirmado e pendente juntos: ${t}`);
  return x.telex ? 'confirmado' : x.telexPendente ? 'pendente' : 'nenhum';
}

/* ---------------- Telex Release Confirmado × Pendente ---------------- */

test('ASS-010 (confirmação): conclusão explícita do telex é Telex Release Confirmado', () => {
  for (const t of [
    'Telex release completed.',
    'HBL released via telex.',
    'Telex release confirmed.',
    'Telex released.',
    'O telex foi liberado.',
    'Telex realizado.',
    'Telex release done; no original documents needed.',
  ]) {
    assert.equal(situacao(t), 'confirmado', t);
  }
});

test('ASS-010 (pendência): promessa, previsão, condição, pedido e pergunta são Telex Release Pendente', () => {
  for (const t of [
    'Telex release pending payment.',
    'Awaiting telex release.',
    'Telex will be arranged.',
    'Telex will be arranged tomorrow.',
    'We will proceed with telex after payment.',
    'Telex subject to approval.',
    'Telex subject to shipper approval.',
    'Aguardando confirmação do telex.',
    'Telex será realizado amanhã.',
    'O telex será realizado após o pagamento.',
    'Estamos providenciando o telex.',
    'Please arrange telex release.',
    'Telex release requested.',
    'Can you do telex release?',
    'HBL will be released via telex.',
  ]) {
    assert.equal(situacao(t), 'pendente', t);
  }
});

test('ASS-010 (pendência): "approved" não é realização — fica Pendente (decisão de 25/10)', () => {
  assert.equal(situacao('Telex release approved.'), 'pendente');
  assert.equal(situacao('Telex aprovado.'), 'pendente');
});

test('ASS-010 (pendência): só a palavra "telex", sem conclusão explícita, fica Pendente (decisão de 25/10)', () => {
  for (const t of ['HBL send via TELEX RELEASE', 'HBL via telex release', 'B/L type: TELEX RELEASE', 'telex release ok', 'TELEXRELEASE', 'HBL via telex']) {
    assert.equal(legada(t).telex, true, `fixture inválida: ${t}`);
    assert.equal(situacao(t), 'pendente', t);
  }
});

test('ASS-010 (pendência): condição na mesma frase vence a conclusão ("confirmed, pending payment")', () => {
  assert.equal(situacao('Telex release confirmed, pending payment.'), 'pendente');
  assert.equal(situacao('Telex released after payment.'), 'pendente');
});

test('ASS-010 (envelope): uma menção pendente impede a confirmação de outra (sem atribuição por IM)', () => {
  // Não se usa a confirmação de um documento como prova para outro do mesmo envelope.
  assert.equal(situacao('HBL IM2101 telex released. HBL IM2102 telex release pending payment.'), 'pendente');
});

test('ASS-010: conclusão de outra coisa na mesma frase não confirma o telex', () => {
  assert.equal(situacao('Telex release, cargo released.'), 'pendente');
  assert.equal(situacao('Telex released, you can pick up the cargo.'), 'confirmado');
});

/* ---------------- negação e cancelamento ---------------- */

test('ASS-010 (negação): telex negado ou cancelado não é confirmação nem pendência', () => {
  for (const t of [
    'No telex release.',
    'Telex release not approved.',
    'Sem telex.',
    'O telex não foi liberado.',
    'Telex release cancelled.',
    'Telex release has been cancelled.',
    'Please cancel the telex release.',
    'Não haverá telex.',
    'HBL not released via telex.',
  ]) {
    assert.equal(legada(t).telex, true, `fixture inválida (antes já era falso): ${t}`);
    assert.equal(situacao(t), 'nenhum', t);
  }
});

test('ASS-010: "Telex released. Original HBL not required." → confirmado (a negação é de outra frase)', () => {
  assert.equal(situacao('Telex released. Original HBL not required.'), 'confirmado');
});

test('ASS-010: "Telex release not approved." → não é evidência afirmativa de telex', () => {
  assert.equal(situacao('Telex release not approved.'), 'nenhum');
});

test('ASS-010: "Not only telex release but also…" → "not only" não é negação', () => {
  assert.equal(naoNegado('Not only telex release but also the original HBL by courier.'), true);
});

test('ASS-010 (regressão): "no" depois de "please" ou de rótulo em inglês é negação', () => {
  for (const t of ['Please no telex release.', 'Status: no telex release.', 'Confirmed: no telex release.', 'Note: no telex.']) {
    assert.equal(legada(t).telex, true, `fixture inválida (antes já era falso): ${t}`);
    assert.equal(situacao(t), 'nenhum', t);
  }
});

test('ASS-010 (regressão do português): "no" = "em + o" não é negação', () => {
  for (const t of [
    'No telex release consta a liberação.',
    'Atenção: no telex release consta a liberação.',
    'Observação: no telex release consta o destinatário.',
    'Conforme informado no telex release, o HBL foi liberado.',
    'Consta no telex release o HBL IM2101.',
    'No telex release foi informado o destinatário.',
    'No problem, telex released.',
  ]) {
    assert.equal(legada(t).telex, true, `fixture inválida (antes já era falso): ${t}`);
    assert.equal(naoNegado(t), true, t);
  }
  // Classificação desses casos: sem conclusão explícita → pendente; "o HBL foi liberado" → confirmado.
  assert.equal(situacao('No telex release consta a liberação.'), 'pendente');
  assert.equal(situacao('Atenção: no telex release consta a liberação.'), 'pendente');
  assert.equal(situacao('Conforme informado no telex release, o HBL foi liberado.'), 'confirmado');
  assert.equal(situacao('No problem, telex released.'), 'confirmado');
});

test('ASS-010 (regressão): os dois-pontos não viram fronteira de oração', () => {
  assert.equal(situacao('Telex release: not approved.'), 'nenhum');
  assert.equal(naoNegado('HBL was not printed: telex release instead.'), true);
  assert.equal(importador('Status: OHBL not sent to consignee.'), false);
});

test('ASS-010: telex explicitamente negado na própria oração (inglês e português)', () => {
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
    assert.equal(situacao(t), 'nenhum', t);
  }
});

test('ASS-010: negação que não é do telex não o anula', () => {
  for (const t of [
    'No problem, telex released.',
    'No problem telex released.',
    'Telex release, not original HBL.',
    'Telex released and original HBL not required.',
    'Telex release no later than Friday.',
    'Conforme informado no telex release, o HBL foi liberado.',
    'Telex release done; no original documents needed.',
    'HBL was not printed: telex release instead.',
  ]) {
    assert.equal(naoNegado(t), true, t);
  }
});

/* ---------------- envio ao destinatário (inalterado nesta entrega) ---------------- */

test('ASS-010: "OHBL not sent to consignee." → importador falso', () => {
  assert.equal(legada('OHBL not sent to consignee.').importador, true, 'antes contava como enviado');
  assert.equal(importador('OHBL not sent to consignee.'), false);
});

test('ASS-010: "OHBL sent to consignee, not to the agent." → importador continua verdadeiro', () => {
  assert.equal(importador('OHBL sent to consignee, not to the agent.'), true);
});

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
  for (const t of [
    'OHBL sent to consignee.',
    'OHBL enviado ao importador.',
    'OHBL sent without delay to the consignee.',
    'OHBL sent not only to the consignee but also to the agent.',
    'OHBL not sent to the agent but to the consignee.',
    'OHBL sent to the consignee; no copy to the agent.',
  ]) {
    assert.equal(importador(t), true, t);
  }
});

/* ---------------- preservado ---------------- */

test('preservado: envio ao importador afirmativo de antes', () => {
  for (const t of ['OHBL sent to consignee', 'documentos enviados ao importador', 'HBL enviado para o importador']) {
    assert.equal(importador(t), true, t);
  }
});

test('preservado: "HBL to cnee" sozinho não prova telex nem envio ao destinatário (ASS-010)', () => {
  assert.deepEqual(r('HBL to cnee'), { telex: false, wave: false, destino: false, importador: false, telexPendente: false });
});

test('preservado: os quatro campos de antes continuam, com um campo novo; texto vazio/ausente', () => {
  assert.deepEqual(Object.keys(r('x')).sort(), ['destino', 'importador', 'telex', 'telexPendente', 'wave']);
  assert.deepEqual(r(''), { ...legada(''), telexPendente: false });
  assert.deepEqual(r(undefined as unknown as string), { ...legada(undefined as unknown as string), telexPendente: false });
});

test('preservado: Wave BL e emissão no destino não mudam, nem com negação', () => {
  for (const t of [
    'Wave BL issued.', 'No wave BL.', 'Not a wave release.', 'Destination issuance confirmed.',
    'Not issued at destination.', 'HBL emitido no destino.', 'Não emitido no destino.',
  ]) {
    const x = r(t);
    const l = legada(t);
    assert.deepEqual([x.wave, x.destino], [l.wave, l.destino], t);
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
  'completed', 'confirmed', 'will', 'awaiting', '?',
];
const NEGADORES = ['not', 'no', 'never', "don't", 'não', 'sem', 'nunca', 'without', 'nor', 'cannot', 'cancelled'];

function frase(g: () => number, vocab: string[], n: number): string {
  return Array.from({ length: n }, () => vocab[Math.floor(g() * vocab.length)]).join(' ');
}

test('preservado: sem negador, a menção de telex é detectada como antes e os outros campos são idênticos (5.000 textos)', () => {
  const g = gerador(20261024);
  for (let i = 0; i < 5000; i++) {
    const t = frase(g, VOCAB_NEUTRO, 3 + Math.floor(g() * 14));
    const x = r(t);
    const l = legada(t);
    assert.deepEqual([x.wave, x.destino, x.importador], [l.wave, l.destino, l.importador], JSON.stringify(t));
    assert.equal(x.telex || x.telexPendente, l.telex, JSON.stringify(t));
    assert.ok(!(x.telex && x.telexPendente), JSON.stringify(t));
  }
});

test('ASS-010: com negadores, nada é criado — só retirado; confirmado e pendente nunca juntos (5.000 textos)', () => {
  const g = gerador(42);
  const vocab = [...VOCAB_NEUTRO, ...NEGADORES, ...NEGADORES];
  let retirados = 0;
  for (let i = 0; i < 5000; i++) {
    const t = frase(g, vocab, 3 + Math.floor(g() * 14));
    const x = r(t);
    const l = legada(t);
    if (x.telex || x.telexPendente) assert.equal(l.telex, true, JSON.stringify(t));
    if (x.importador) assert.equal(l.importador, true, JSON.stringify(t));
    assert.deepEqual([x.wave, x.destino], [l.wave, l.destino], JSON.stringify(t));
    assert.ok(!(x.telex && x.telexPendente), JSON.stringify(t));
    if ((x.telex || x.telexPendente) !== l.telex || x.importador !== l.importador) retirados++;
  }
  assert.ok(retirados > 0, 'o corpus precisa exercitar a negação');
});

/* ---------------- caracterização: limitações conhecidas (fora do escopo) ---------------- */

test('caracterização (limitação conhecida, sem atribuição por documento): confirmação de um IM vale para o envelope', () => {
  // Sem pendência no texto, a confirmação de IM2102 encerra o OHBL do envelope inteiro
  // (inclusive IM2101, cujo telex foi negado). Atribuir por IM é outra etapa; não é conformidade.
  assert.equal(situacao('No telex for IM2101. HBL IM2102 telex released.'), 'confirmado');
  assert.equal(importador('OHBL not sent to consignee. Other OHBL sent to importer.'), true);
});

test('caracterização (limitação conhecida, sem cronologia — ASS-009): ordem das mensagens não é lida', () => {
  // Cancelamento depois da confirmação não restaura a expectativa…
  assert.equal(situacao('Telex released. Update: telex cancelled, original HBL by courier.'), 'confirmado');
  // …e confirmação depois da pendência não a encerra (fica pendente, lado seguro).
  assert.equal(situacao('Telex release pending payment. Telex released.'), 'pendente');
});

test('caracterização (limitação conhecida): negação separada por vírgula ou travessão não é lida — aparece como Pendente', () => {
  // A vírgula é fronteira de oração de propósito ("Telex release, not original HBL").
  assert.equal(situacao('Telex release, not approved.'), 'pendente');
  assert.equal(situacao('Telex release — not approved.'), 'pendente');
});

test('caracterização (limitação conhecida): "no" depois de rótulo fora da lista em inglês não é lido como negação', () => {
  // Conservador com a contração portuguesa: segue como menção não negada (Pendente).
  assert.equal(situacao('HBL: no telex release.'), 'pendente');
});

test('caracterização (limitação conhecida): shipper e "cnee" não são reconhecidos como destinatário (como antes)', () => {
  assert.equal(importador('OHBL sent to shipper.'), false);
  assert.equal(importador('OHBL sent to cnee.'), false);
});
