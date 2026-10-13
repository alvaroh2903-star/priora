import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConferenciaMbl, EstadoDoFato, Instante, aplicarObservacao, compararInstantes, estadoInicial } from '../index';
import { DISPONIVEL, ev } from './fixtures';

/** Precisão do N-16: a ordem das observações oficiais é exata além do milissegundo, sem inventar instantes. */

const US = (micro: string): Instante => `2026-10-13T10:00:00.${micro}Z`;
const oficial = (estado: EstadoDoFato<ConferenciaMbl>, valor: ConferenciaMbl, em: Instante, ref: string) =>
  aplicarObservacao<ConferenciaMbl>(estado, { tipo: 'OFICIAL', valor, observadoEm: em, evidencia: ev(ref) });

test('instante: microssegundos dentro do mesmo milissegundo têm ordem; empate é empate', () => {
  assert.equal(compararInstantes(US('123400'), US('123600')) < 0, true);
  assert.equal(compararInstantes(US('123600'), US('123400')) > 0, true);
  assert.equal(compararInstantes(US('123456'), US('123456')), 0);
  assert.equal(compararInstantes(US('123'), US('123000')), 0, 'mesma fração com outro número de dígitos');
});

test('instante: fuso equivalente compara igual (instante absoluto)', () => {
  assert.equal(compararInstantes('2026-10-13T10:00:00.123456Z', '2026-10-13T07:00:00.123456-03:00'), 0);
  assert.equal(compararInstantes('2026-10-13T10:00:00.123456+02:00', '2026-10-13T08:00:00.123457Z') < 0, true);
  assert.equal(compararInstantes('2026-10-13T23:30:00.5-03:00', '2026-10-14T02:30:00.500000Z'), 0, 'troca de dia pelo fuso');
});

test('instante: timestamps comuns em ms se comportam exatamente como antes (Date.parse)', () => {
  const comuns = ['2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.001Z', '2026-10-01T12:00:01Z', '2026-10-01T09:00:00-03:00',
    '2026-10-01T12:00Z', '2026-09-30T23:59:59.999Z'];
  for (const a of comuns) {
    for (const b of comuns) {
      assert.equal(Math.sign(compararInstantes(a, b)), Math.sign(Date.parse(a) - Date.parse(b)), `${a} × ${b}`);
    }
  }
  assert.throws(() => compararInstantes('ontem', US('1')), /instante inválido/);
});

test('N-16 preciso: valor oficial diferente, posterior no mesmo milissegundo, NÃO é descartado', () => {
  const r = oficial(estadoInicial(DISPONIVEL), 'RECEBIDO', US('123100'), 'c1').estado;
  const depois = oficial(r, 'AUSENTE_NA_CONFERENCIA', US('123700'), 'c2');
  assert.equal(depois.material, true);
  assert.deepEqual(depois.estado.oficial, { valor: 'AUSENTE_NA_CONFERENCIA', vigenteDesde: US('123700'), ultimaConfirmacaoEm: US('123700'), evidencia: ev('c2') });
  assert.deepEqual(depois.estado.historico.map((h) => h.valor), ['RECEBIDO']);
  // Anterior de verdade (microssegundos antes da última confirmação) continua rejeitado.
  const velho = oficial(depois.estado, 'RECEBIDO', US('123500'), 'c0');
  assert.deepEqual([velho.material, velho.estado.oficial?.valor], [false, 'AUSENTE_NA_CONFERENCIA']);
});

test('N-16 preciso: reconfirmação no mesmo milissegundo avança o frescor exato sem mover o vigenteDesde', () => {
  const r = oficial(estadoInicial(DISPONIVEL), 'RECEBIDO', US('123100'), 'c1').estado;
  const reconf = oficial(r, 'RECEBIDO', US('123600'), 'c2');
  assert.deepEqual(reconf.mudancas, [{ tipo: 'CONFIRMACAO_ATUALIZADA', em: US('123600') }]);
  assert.deepEqual([reconf.estado.oficial?.vigenteDesde, reconf.estado.oficial?.ultimaConfirmacaoEm], [US('123100'), US('123600')]);
  const mesma = oficial(reconf.estado, 'RECEBIDO', US('123600'), 'c3');
  assert.deepEqual(mesma.mudancas, [], 'o mesmo instante exato não é reconfirmação nova');
});
