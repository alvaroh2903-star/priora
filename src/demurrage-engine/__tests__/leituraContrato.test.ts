import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envelopeDeValor, normalizarMotivoInvalidacao } from '../leitura/contrato';

/**
 * Fase D12 (Gate G1) — testes PUROS do contrato de leitura (sem banco).
 * Cobrem os mapeamentos obrigatórios: UNAVAILABLE nunca vira zero, estimado
 * nunca vira confirmado, PENDENTE/NAO_APLICAVEL corretos por combinação de
 * relógio × valor, e a normalização das duas grafias de invalidação da D11.
 */

test('envelopeDeValor: relógio não-OK é sempre PENDENTE, mesmo com valor presente', () => {
  for (const status of ['PENDING', 'INVALID'] as const) {
    const env = envelopeDeValor({
      relogioStatus: status,
      diasDemurrage: null,
      valor: { confirmationStatus: 'CONFIRMED', total: 999, moeda: 'BRL', diasCobrados: 5 },
    });
    assert.equal(env.situacao, 'PENDENTE');
    assert.equal(env.total, null);
    assert.equal(env.moeda, null);
  }
});

test('envelopeDeValor: relógio OK sem dias é NAO_APLICAVEL (nunca confirmado/zero)', () => {
  const env = envelopeDeValor({ relogioStatus: 'OK', diasDemurrage: 0, valor: null });
  assert.equal(env.situacao, 'NAO_APLICAVEL');
  assert.equal(env.total, null);
});

test('envelopeDeValor: relógio OK com dias e sem valor ativo é PENDENTE', () => {
  const env = envelopeDeValor({ relogioStatus: 'OK', diasDemurrage: 5, valor: null });
  assert.equal(env.situacao, 'PENDENTE');
  assert.equal(env.total, null);
});

test('envelopeDeValor: UNAVAILABLE nunca vira zero — total e moeda permanecem null', () => {
  const env = envelopeDeValor({
    relogioStatus: 'OK',
    diasDemurrage: 5,
    valor: { confirmationStatus: 'UNAVAILABLE', total: null, moeda: null, diasCobrados: null },
  });
  assert.equal(env.situacao, 'INDISPONIVEL');
  assert.equal(env.total, null);
  assert.equal(env.moeda, null);
});

test('envelopeDeValor: ESTIMATED nunca aparece como CONFIRMADO', () => {
  const env = envelopeDeValor({
    relogioStatus: 'OK',
    diasDemurrage: 3,
    valor: { confirmationStatus: 'ESTIMATED', total: 450, moeda: 'USD', diasCobrados: 3 },
  });
  assert.equal(env.situacao, 'ESTIMADO');
  assert.notEqual(env.situacao, 'CONFIRMADO');
  assert.equal(env.total, 450);
  assert.equal(env.moeda, 'USD');
});

test('envelopeDeValor: ESTIMATED_PROVISIONAL é distinto de ESTIMATED e de CONFIRMADO', () => {
  const env = envelopeDeValor({
    relogioStatus: 'OK',
    diasDemurrage: 3,
    valor: { confirmationStatus: 'ESTIMATED_PROVISIONAL', total: 100, moeda: 'BRL', diasCobrados: 3 },
  });
  assert.equal(env.situacao, 'ESTIMADO_PROVISORIO');
});

test('envelopeDeValor: CONFIRMED com relógio OK e dias vira CONFIRMADO com o total exato', () => {
  const env = envelopeDeValor({
    relogioStatus: 'OK',
    diasDemurrage: 10,
    valor: { confirmationStatus: 'CONFIRMED', total: 1234.56, moeda: 'BRL', diasCobrados: 10 },
  });
  assert.deepEqual(env, { situacao: 'CONFIRMADO', total: 1234.56, moeda: 'BRL' });
});

test('normalizarMotivoInvalidacao: as duas grafias da D11 (0032/0033) mapeiam para códigos estáveis e distintos', () => {
  assert.equal(normalizarMotivoInvalidacao('relogio_recalculado'), 'RELOGIO_RECALCULADO');
  assert.equal(normalizarMotivoInvalidacao('VALOR_CLIENTE_RECALCULADO'), 'VALOR_CLIENTE_RECALCULADO');
  assert.notEqual(normalizarMotivoInvalidacao('relogio_recalculado'), normalizarMotivoInvalidacao('VALOR_CLIENTE_RECALCULADO'));
});
