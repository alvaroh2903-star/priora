import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockFact } from '../lifecycle/types';
import {
  ValorAtivoSelecionado, agregarFinanceiroProcesso, envelopeDoRelogio, selecionarValorAtivo,
} from '../leitura/contrato';

/**
 * Fase D12 v1.2.3 — frescor do valor financeiro decidido pelos dias cobrados
 * da PRÓPRIA linha ativa escolhida (`valores_apurados.dias_cobrados`), nunca
 * pelo cache do relógio. Funções puras, sem banco; `envelopeDoRelogio` é o
 * helper único usado pela fila, pelo detalhe de processo e pelo detalhe de
 * contêiner.
 *
 * LFD 2026-09-20, hoje 2026-09-25 → 5 dias operacionais (contêiner ativo).
 */

const LFD = '2026-09-20';
const HOJE = '2026-09-25';
const relogio = (diasCache: number): ClockFact => ({ status: 'OK', diasDemurrage: diasCache, ultimoDiaLivre: LFD });
const valor = (diasCobrados: number | null, over: Partial<ValorAtivoSelecionado> = {}): ValorAtivoSelecionado => ({
  confirmationStatus: 'ESTIMATED', total: diasCobrados === null ? null : 150 * diasCobrados, moeda: 'USD', diasCobrados, ...over,
});
const PENDENTE = { situacao: 'PENDENTE', total: null, moeda: null };

test('1: operacional 5, relógio 5, valor 4 → PENDENTE (relógio em dia, recálculo financeiro não)', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, valor(4)), PENDENTE);
});

test('2: operacional 5, relógio 5, valor 5 → valor normal', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, valor(5)), { situacao: 'ESTIMADO', total: 750, moeda: 'USD' });
});

test('3: operacional 5, relógio 4, valor 4 → PENDENTE', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(4), HOJE, false, valor(4)), PENDENTE);
});

test('4: operacional 5, relógio 4, valor 5 → valor normal (a validade do relógio não decide o frescor do valor)', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(4), HOJE, false, valor(5)), { situacao: 'ESTIMADO', total: 750, moeda: 'USD' });
});

test('5: operacional 0 → NAO_APLICAVEL (mesmo com um valor guardado)', () => {
  assert.equal(envelopeDoRelogio(relogio(0), LFD, false, valor(3)).situacao, 'NAO_APLICAVEL');
  assert.equal(envelopeDoRelogio(relogio(0), LFD, false, null).situacao, 'NAO_APLICAVEL');
});

test('6: sem valor escolhido → PENDENTE', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, null), PENDENTE);
});

test('7: UNAVAILABLE (dias cobrados null por schema) → INDISPONIVEL, nunca zero, nunca pendente', () => {
  const indisponivel = valor(null, { confirmationStatus: 'UNAVAILABLE' });
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, indisponivel), { situacao: 'INDISPONIVEL', total: null, moeda: null });
  // Mesmo com os dias operacionais avançando além do cache.
  assert.equal(envelopeDoRelogio(relogio(3), HOJE, false, indisponivel).situacao, 'INDISPONIVEL');
});

test('8: zero confirmado que cobre os dias atuais → CONFIRMADO zero; se não cobre, PENDENTE', () => {
  const zeroAtual = valor(5, { confirmationStatus: 'CONFIRMED', total: 0, moeda: 'BRL' });
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, zeroAtual), { situacao: 'CONFIRMADO', total: 0, moeda: 'BRL' });
  const zeroAntigo = valor(4, { confirmationStatus: 'CONFIRMED', total: 0, moeda: 'BRL' });
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, zeroAntigo), PENDENTE);
});

test('9: ESTIMADO e ESTIMADO_PROVISORIO seguem a mesma regra de frescor (e CONFIRMADO também)', () => {
  for (const [status, situacao] of [['ESTIMATED', 'ESTIMADO'], ['ESTIMATED_PROVISIONAL', 'ESTIMADO_PROVISORIO'], ['CONFIRMED', 'CONFIRMADO']] as const) {
    assert.equal(envelopeDoRelogio(relogio(5), HOJE, false, valor(5, { confirmationStatus: status })).situacao, situacao);
    assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, valor(4, { confirmationStatus: status })), PENDENTE, status);
  }
});

test('10: cliente e Rocket podem ter frescor diferente — cada lado com seu relógio e seu valor', () => {
  // Cliente (House): LFD 09-20 → 5 dias; valor de 5 dias → atual.
  const cliente = envelopeDoRelogio(relogio(5), HOJE, false, valor(5));
  // Rocket (Master): LFD 09-22 → 3 dias; valor de 2 dias → defasado.
  const rocket = envelopeDoRelogio({ status: 'OK', diasDemurrage: 3, ultimoDiaLivre: '2026-09-22' }, HOJE, false, valor(2));
  assert.equal(cliente.situacao, 'ESTIMADO');
  assert.equal(rocket.situacao, 'PENDENTE');
  const agregado = agregarFinanceiroProcesso([{ cliente, rocket }]);
  assert.equal(agregado.cliente.completo, true);
  assert.equal(agregado.rocket.completo, false);
  assert.equal(agregado.rocket.pendentes, 1);
});

test('invariante: valor que cobre MAIS dias que os operacionais é exibido como está — nunca reduzido nem reescrito', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, valor(7)), { situacao: 'ESTIMADO', total: 1050, moeda: 'USD' });
});

test('defensivo: valor conhecido sem dias cobrados (o schema proíbe) → PENDENTE, nunca exibido como atual', () => {
  assert.deepEqual(envelopeDoRelogio(relogio(5), HOJE, false, valor(5, { diasCobrados: null })), PENDENTE);
});

test('Empty Return: o valor apurado até a devolução continua atual por mais tarde que seja hoje', () => {
  const devolvido = relogio(4); // cache apurado até a devolução
  assert.equal(envelopeDoRelogio(devolvido, '2026-12-31', true, valor(4)).situacao, 'ESTIMADO');
});

test('seleção: carrega os dias cobrados da PRÓPRIA linha escolhida, por motor aplicável e lado', () => {
  const linhas = [
    { relogio_tipo: 'cliente', motor_comercial: 'termo_embarque', total: '600.00', moeda: 'USD', confirmation_status: 'ESTIMATED' as const, dias_cobrados: 4 },
    { relogio_tipo: 'cliente', motor_comercial: 'termo_unico', total: '900.00', moeda: 'USD', confirmation_status: 'ESTIMATED' as const, dias_cobrados: 6 },
    { relogio_tipo: 'rocket', motor_comercial: 'exposicao_armador', total: '300.00', moeda: 'USD', confirmation_status: 'ESTIMATED' as const, dias_cobrados: 3 },
  ];
  // Só o motor aplicável ao modelo do processo concorre do lado do cliente.
  assert.deepEqual(selecionarValorAtivo(linhas, 'cliente', 'termo_embarque'), { confirmationStatus: 'ESTIMATED', total: 600, moeda: 'USD', diasCobrados: 4 });
  assert.equal(selecionarValorAtivo(linhas, 'cliente', 'termo_unico')!.diasCobrados, 6);
  assert.equal(selecionarValorAtivo(linhas, 'rocket', null)!.diasCobrados, 3);
  const indisponivel = [{ relogio_tipo: 'rocket', motor_comercial: 'exposicao_armador', total: null, moeda: null, confirmation_status: 'UNAVAILABLE' as const, dias_cobrados: null }];
  assert.equal(selecionarValorAtivo(indisponivel, 'rocket', null)!.diasCobrados, null);
});
