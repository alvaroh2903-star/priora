/**
 * ASS-010 (entrega parcial) — evidência documental por processo (docAssociation):
 * conteúdo físico × associação, com origem estável. Puro: sem rede, sem IA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indiceComOrigem, mencoesDocumentais, MencaoDocumental } from './docAssociation';
import { docResolutionFromText } from './docResolution';
import { MAX_SHARED_PROCESSES } from './referenceResolver';

const vazio = indiceComOrigem([]);
const de = (texto: string, processos: string[], indice = vazio, messageId = 'msg-1') =>
  mencoesDocumentais([{ messageId, texto }], processos, indice).mencoes;
const resumo = (m: MencaoDocumental) =>
  [m.tipo, m.conteudo.situacao, m.associacao.situacao, m.associacao.processo, m.associacao.via] as const;

/* ---------------- conteúdo físico ---------------- */

test('conteúdo: lista simples e "seguem/enclosed" afirmam o documento no envelope', () => {
  for (const t of ['IM2101 - OMBL', 'OMBL enclosed', 'Seguem OMBL e OHBL.', 'Documentos a seguir: OMBL, OHBL', 'Master B/L SHYY12345678', 'Docs: MBL/HBL']) {
    for (const m of de(t, ['IM2101'])) assert.deepEqual([m.conteudo.situacao, m.conteudo.motivo], ['afirmado', null], t);
  }
});

test('conteúdo: negação, "to follow"/futuro, liberação eletrônica, destino e cópia não comprovam', () => {
  const casos: Array<[string, string]> = [
    ['OHBL not sent', 'negado'],
    ['OHBL has not been sent', 'negado'],
    ['No original OHBL in this envelope', 'negado'],
    ['Sem OHBL neste envelope', 'negado'],
    ['OHBL não enviado', 'negado'],
    ['OHBL to follow', 'a-seguir-ou-pendente'],
    ['OHBL will follow by next courier', 'a-seguir-ou-pendente'],
    ['OHBL seguirá no próximo courier', 'a-seguir-ou-pendente'],
    ['OHBL pending payment', 'a-seguir-ou-pendente'],
    ['Can you send the OHBL?', 'a-seguir-ou-pendente'],
    ['OHBL will be sent separately', 'a-seguir-ou-pendente'],
    ['OHBL telex released', 'liberacao-eletronica'],
    ['OHBL surrendered at origin', 'liberacao-eletronica'],
    ['OMBL issued as sea waybill', 'liberacao-eletronica'],
    ['OHBL issued at destination', 'emissao-no-destino'],
    ['OHBL copy attached', 'copia-ou-anexo'],
    ['Cópia do OMBL em anexo', 'copia-ou-anexo'],
  ];
  for (const [t, motivo] of casos) {
    const [m] = de(t, ['IM2101']);
    assert.deepEqual([m.conteudo.situacao, m.conteudo.motivo], ['nao-comprovado', motivo], t);
  }
});

test('conteúdo: a leitura é por oração — um documento afirmado ao lado de outro "a seguir"', () => {
  const [ombl, ohbl] = de('OMBL enclosed, OHBL to follow', ['IM2101']);
  assert.deepEqual([ombl.tipo, ombl.conteudo.situacao], ['OMBL', 'afirmado']);
  assert.deepEqual([ohbl.tipo, ohbl.conteudo.situacao], ['OHBL', 'nao-comprovado']);
});

/* ---------------- associação ---------------- */

test('associação: IM único na linha confirma; IM2204 com OMBL e IM2205 com OHBL não se cruzam', () => {
  const ms = de('IM2204 - OMBL\nIM2205 - OHBL', ['IM2204', 'IM2205']);
  assert.deepEqual(ms.map(resumo), [
    ['OMBL', 'afirmado', 'confirmada', 'IM2204', 'linha'],
    ['OHBL', 'afirmado', 'confirmada', 'IM2205', 'linha'],
  ]);
});

test('associação: vários IMs na linha ficam ambíguos, com os candidatos — nunca replicados', () => {
  const [m] = de('IM2204 / IM2205 - OMBL', ['IM2204', 'IM2205']);
  assert.deepEqual([m.associacao.situacao, m.associacao.processo, m.associacao.candidatos], ['ambigua', null, ['IM2204', 'IM2205']]);
});

test('associação: sem IM numa linha de envelope com vários processos fica sem processo', () => {
  const [m] = de('OHBL SHYY1234567 enclosed', ['IM2204', 'IM2205']);
  assert.deepEqual([m.associacao.situacao, m.associacao.candidatos, m.fonte.ref], ['sem-processo', [], 'SHYY1234567']);
});

test('associação: referência de BL que aponta para um único processo em OUTRO e-mail confirma', () => {
  const indice = indiceComOrigem([{ id: 'pre-alerta', subject: 'Pre-alert IM2205', body: 'HBL SHYY2222333 IM2205' }]);
  const [m] = de('OHBL SHYY2222333 enclosed', ['IM2204', 'IM2205'], indice);
  assert.deepEqual(resumo(m), ['OHBL', 'afirmado', 'confirmada', 'IM2205', 'referencia']);
});

test('associação: a proximidade de linha dentro do PRÓPRIO e-mail do courier não confirma por referência', () => {
  const texto = 'IM2204 shipment\nIM2205 shipment\nSHYY99998888 OHBL';
  // O índice global liga SHYY99998888 ao IM mais próximo DESTE e-mail (IM2205)...
  const indice = indiceComOrigem([{ id: 'msg-1', subject: '', body: texto }]);
  assert.deepEqual(Array.from(indice.get('SHYY99998888')!.processos.keys()), ['IM2205']);
  // ...mas isso não vale como prova: a menção fica sem processo.
  const [m] = de(texto, ['IM2204', 'IM2205'], indice, 'msg-1');
  assert.deepEqual([m.associacao.situacao, m.associacao.processo], ['sem-processo', null]);
});

test('associação: referência 1:N ou de booking fica ambígua', () => {
  const indice = indiceComOrigem([
    { id: 'a', subject: '', body: 'IM2204 MBL MSCU1234567890' },
    { id: 'b', subject: '', body: 'IM2205 MBL MSCU1234567890' },
    { id: 'c', subject: '', body: 'IM2204 BOOKING BK7777666' },
  ]);
  const [mbl] = de('OMBL MSCU1234567890', ['IM2204', 'IM2205'], indice);
  assert.deepEqual([mbl.associacao.situacao, mbl.associacao.candidatos], ['ambigua', ['IM2204', 'IM2205']]);
  const [bk] = de('OMBL booking BK7777666', ['IM2204', 'IM2205'], indice);
  assert.deepEqual([bk.associacao.situacao, bk.associacao.candidatos], ['ambigua', ['IM2204']]);
});

test('associação: processo único confirma — mas não vence IM ou BL em conflito', () => {
  assert.deepEqual(resumo(de('OHBL enclosed', ['IM2101'])[0]), ['OHBL', 'afirmado', 'confirmada', 'IM2101', 'processo-unico']);
  const im = de('IM2299 - OHBL', ['IM2101'])[0];
  assert.deepEqual([im.associacao.situacao, im.associacao.candidatos, im.associacao.externos], ['ambigua', ['IM2101'], ['IM2299']]);
  const indice = indiceComOrigem([{ id: 'x', subject: '', body: 'IM2299 HBL SHYY5555444' }]);
  const bl = de('OHBL SHYY5555444', ['IM2101'], indice)[0];
  assert.deepEqual([bl.associacao.situacao, bl.associacao.candidatos, bl.associacao.externos], ['ambigua', ['IM2101'], ['IM2299']]);
});

/** Índice em que o BL SHGEN00000001 aparece em pré-alertas de `n` processos distintos (IM2331, IM2332…). */
const indiceCompartilhado = (n: number) =>
  indiceComOrigem(Array.from({ length: n }, (_, k) => ({ id: `pre-${k}`, subject: `Pre-alert IM${2331 + k}`, body: 'HBL SHGEN00000001' })));

test('referência acima do limite (processo único): não vira "sem evidência" nem confirma por processo único', () => {
  const indice = indiceCompartilhado(MAX_SHARED_PROCESSES + 1);
  const [m] = de('OHBL SHGEN00000001 enclosed', ['IM2101'], indice);
  assert.deepEqual(
    [m.associacao.situacao, m.associacao.processo, m.associacao.via, m.associacao.candidatos, m.associacao.externos, m.associacao.referenciasCompartilhadas],
    ['ambigua', null, null, ['IM2101'], [], ['SHGEN00000001']],
  );
  // Sem o índice, a mesma linha seria "processo único": o sinal de incerteza é o que muda.
  assert.deepEqual(resumo(de('OHBL SHGEN00000001 enclosed', ['IM2101'])[0]), ['OHBL', 'afirmado', 'confirmada', 'IM2101', 'processo-unico']);
});

test('IM explícito + referência acima do limite: o conflito fica visível, sem confirmação arbitrária', () => {
  const indice = indiceCompartilhado(MAX_SHARED_PROCESSES + 3);
  for (const processos of [['IM2101'], ['IM2101', 'IM2102']]) {
    const [m] = de('IM2101 - OHBL SHGEN00000001', processos, indice);
    assert.deepEqual(
      [m.associacao.situacao, m.associacao.processo, m.associacao.candidatos, m.associacao.referenciasCompartilhadas],
      ['ambigua', null, ['IM2101'], ['SHGEN00000001']],
      processos.join(','),
    );
  }
  // Envelope com vários processos e linha sem IM: sem processo, mas com a incerteza registrada.
  const [semIm] = de('OHBL SHGEN00000001', ['IM2101', 'IM2102'], indice);
  assert.deepEqual([semIm.associacao.situacao, semIm.associacao.candidatos, semIm.associacao.referenciasCompartilhadas], ['ambigua', [], ['SHGEN00000001']]);
});

test('associações inequívocas não mudam: IM na linha, BL 1:1 de outro e-mail e processo único sem referência', () => {
  const indice = indiceComOrigem([{ id: 'pre', subject: 'Pre-alert IM2205', body: 'HBL SHYY2222333 IM2205' }]);
  const casos: Array<[string, string[], ReturnType<typeof resumo>]> = [
    ['IM2204 - OMBL', ['IM2204', 'IM2205'], ['OMBL', 'afirmado', 'confirmada', 'IM2204', 'linha']],
    ['OHBL SHYY2222333 enclosed', ['IM2204', 'IM2205'], ['OHBL', 'afirmado', 'confirmada', 'IM2205', 'referencia']],
    ['OHBL enclosed', ['IM2101'], ['OHBL', 'afirmado', 'confirmada', 'IM2101', 'processo-unico']],
    ['OHBL ZZUNKNOWN1234 enclosed', ['IM2101'], ['OHBL', 'afirmado', 'confirmada', 'IM2101', 'processo-unico']],
  ];
  for (const [texto, processos, esperado] of casos) {
    const [m] = de(texto, processos, indice);
    assert.deepEqual(resumo(m), esperado, texto);
    assert.deepEqual([m.associacao.candidatos, m.associacao.externos, m.associacao.referenciasCompartilhadas], [[], [], []], texto);
  }
});

test('associação: casa o processo pela base ("IM2204-26" = "IM 2204") e devolve o código da lista', () => {
  const [m] = de('IM 2204 - OHBL', ['IM2204-26', 'IM2205']);
  assert.deepEqual([m.associacao.situacao, m.associacao.processo], ['confirmada', 'IM2204-26']);
});

test('associação e conteúdo são independentes: menção negada ainda diz a qual processo se refere', () => {
  const [m] = de('IM2205 OHBL not sent', ['IM2204', 'IM2205']);
  assert.deepEqual(resumo(m), ['OHBL', 'nao-comprovado', 'confirmada', 'IM2205', 'linha']);
});

/* ---------------- origem estável e pureza ---------------- */

test('origem: cada menção traz mensagem, linha, referência e um id estável', () => {
  const texto = 'Prezados,\nIM2204 - OMBL SHYY12345678 / OHBL\nIM2205 - OHBL';
  const a = de(texto, ['IM2204', 'IM2205'], vazio, 'AAMk-sintetico');
  assert.deepEqual(a.map((m) => m.id), ['AAMk-sintetico#L1:OMBL:0', 'AAMk-sintetico#L1:OHBL:0', 'AAMk-sintetico#L2:OHBL:0']);
  assert.deepEqual(a.map((m) => [m.fonte.messageId, m.fonte.linha]), [['AAMk-sintetico', 1], ['AAMk-sintetico', 1], ['AAMk-sintetico', 2]]);
  assert.equal(a[0].fonte.ref, 'SHYY12345678');
  assert.deepEqual(de(texto, ['IM2204', 'IM2205'], vazio, 'AAMk-sintetico'), a, 'mesma entrada, mesma saída');
  // Sem trecho do e-mail na saída: só ids, linha, tipo e o código de BL.
  assert.ok(!JSON.stringify(a).includes('Prezados'));
});

test('pureza: não altera o texto do motor documental nem a resolução de telex/Wave/destino/importador', () => {
  const textos = ['HBL released via telex release.', 'Telex release pending payment.', 'OHBL sent to consignee', 'Wave BL', 'OHBL issued at destination'];
  for (const t of textos) {
    const antes = docResolutionFromText(t);
    de(t, ['IM2101']);
    assert.deepEqual(docResolutionFromText(t), antes, t);
  }
});
