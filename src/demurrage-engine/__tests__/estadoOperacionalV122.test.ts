import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocoPrazoRelogio, diasDemurrageOperacionais, relogioOperacional } from '../lifecycle/prazoFreeTime';
import { derivarApuracaoDemurrageStatusOperacional, derivarEstadoContainer } from '../lifecycle/containerState';
import { derivarPrioridadeContainer, ordenarTodos } from '../lifecycle/priorityEngine';
import { derivarResponsabilidade } from '../lifecycle/responsabilidade';
import { ClockFact, ContainerLifecycle, ContainerLifecycleFacts } from '../lifecycle/types';
import { envelopeDeValor } from '../leitura/contrato';

/**
 * Fase D12 v1.2.2 — dias de demurrage OPERACIONAIS (correção autorizada da
 * derivação pura da Fase 7). Funções puras, sem banco. Cobre os 12 casos
 * exigidos (o 12º também em integração, com `passagemDoCalendario` real).
 *
 * Os fatos são montados como o `LifecycleRepository` monta: relógios do
 * CACHE em `facts`, status de apuração por `derivarApuracaoDemurrageStatusOperacional`.
 */

const LFD = '2026-09-20';
const ok = (over: Partial<ClockFact> = {}): ClockFact => ({ status: 'OK', diasDemurrage: 0, ultimoDiaLivre: LFD, ...over });
const pendente: ClockFact = { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null };
const invalido: ClockFact = { status: 'INVALID', diasDemurrage: 0, ultimoDiaLivre: null };

function facts(p: { hoje: string; cliente?: ClockFact; rocket?: ClockFact; emptyReturn?: boolean; limiar?: number | null }): ContainerLifecycleFacts {
  const clienteClock = p.cliente ?? ok();
  const rocketClock = p.rocket ?? ok();
  const emptyReturn = p.emptyReturn ?? false;
  const apuracaoDemurrageStatus = derivarApuracaoDemurrageStatusOperacional(clienteClock, rocketClock, p.hoje, emptyReturn);
  return {
    containerId: 'c', hoje: p.hoje, clienteClock, rocketClock, emptyReturn,
    apuracaoDemurrageStatus,
    // Mesma derivação do repositório: responsabilidade sem decisão gravada.
    responsabilidadeEmAnalise: derivarResponsabilidade(apuracaoDemurrageStatus, null) === 'EM_ANALISE',
    divergenciaValor: false, documentaryStatus: emptyReturn ? 'MINUTA_RECEBIDA' : 'NAO_APLICAVEL',
    cadenciaVencida: false, ultimaConsultaValida: null, falhaTrackingAtiva: false,
    valorCliente: { total: null, moeda: null, disponivel: false },
    exposicaoRocket: { total: null, moeda: null, disponivel: false },
    prazoProximoThresholdDias: p.limiar === undefined ? 4 : p.limiar,
  };
}
function pacote(f: ContainerLifecycleFacts): ContainerLifecycle {
  const state = derivarEstadoContainer(f);
  return { facts: f, state, priority: derivarPrioridadeContainer(state) };
}

/* ------------------------------------------------------------------ *
 * Regra pura — semântica de dia civil.
 * ------------------------------------------------------------------ */

test('v1.2.2 regra: no LFD → 0; LFD+1 → 1; LFD+7 → 7; LFD+15 → 15 (cache em 0, sem tick)', () => {
  assert.equal(diasDemurrageOperacionais(ok(), '2026-09-20', false), 0);
  assert.equal(diasDemurrageOperacionais(ok(), '2026-09-21', false), 1);
  assert.equal(diasDemurrageOperacionais(ok(), '2026-09-27', false), 7);
  assert.equal(diasDemurrageOperacionais(ok(), '2026-10-05', false), 15);
  assert.equal(diasDemurrageOperacionais(ok(), '2026-09-10', false), 0, 'antes do LFD');
});

test('v1.2.2 regra: relógio PENDING ou INVALID nunca é extrapolado', () => {
  assert.equal(diasDemurrageOperacionais(pendente, '2026-12-31', false), 0);
  assert.equal(diasDemurrageOperacionais(invalido, '2026-12-31', false), 0);
  assert.deepEqual(relogioOperacional(pendente, '2026-12-31', false), pendente, 'relógio não OK volta intacto');
});

test('v1.2.2 regra: OK sem ultimoDiaLivre nunca é extrapolado', () => {
  assert.equal(diasDemurrageOperacionais(ok({ ultimoDiaLivre: null, diasDemurrage: 2 }), '2026-12-31', false), 2);
});

test('v1.2.2 regra: a função é pura — o ClockFact de entrada nunca é alterado', () => {
  const c = ok();
  relogioOperacional(c, '2026-10-05', false);
  assert.deepEqual(c, { status: 'OK', diasDemurrage: 0, ultimoDiaLivre: LFD });
});

/* ------------------------------------------------------------------ *
 * Casos 1–11 exigidos.
 * ------------------------------------------------------------------ */

test('caso 1: ativo, hoje = LFD → zero dias, ainda dentro do Free Time', () => {
  const f = facts({ hoje: '2026-09-20' });
  const s = derivarEstadoContainer(f);
  assert.equal(s.severidadeDias, 0);
  assert.equal(s.estado, 'PRAZO_PROXIMO', 'no último dia livre, dentro do limiar de 4 dias');
  assert.ok(!s.clienteEmDemurrage && !s.rocketExposta);
  assert.equal(f.apuracaoDemurrageStatus, 'ZERO_CONFIRMADO');
  const b = blocoPrazoRelogio(f.clienteClock, f.hoje, 4, false);
  assert.equal(b.dentroDoFreeTime, true);
  assert.equal(b.diasRestantes, 0);
  assert.equal(b.vencido, false);
});

test('caso 2: ativo, hoje = LFD + 1 (cache ainda 0) → 1 dia operacional, EM_DEMURRAGE_ATENCAO, ATENCAO_1_6', () => {
  const f = facts({ hoje: '2026-09-21' });
  const p = pacote(f);
  assert.equal(p.state.estado, 'EM_DEMURRAGE_ATENCAO');
  assert.equal(p.state.severidadeDias, 1);
  assert.equal(p.priority.balde, 'ATENCAO_1_6');
  assert.ok(p.state.badges.includes('clienteEmDemurrage') && p.state.badges.includes('rocketExposta'));
  assert.equal(blocoPrazoRelogio(f.clienteClock, f.hoje, 4, false).vencido, true);
});

test('caso 3: ativo, hoje = LFD + 6 → 6 dias, atenção', () => {
  const p = pacote(facts({ hoje: '2026-09-26' }));
  assert.equal(p.state.severidadeDias, 6);
  assert.equal(p.state.estado, 'EM_DEMURRAGE_ATENCAO');
  assert.equal(p.priority.balde, 'ATENCAO_1_6');
});

test('caso 4: ativo, hoje = LFD + 7 → crítico', () => {
  const p = pacote(facts({ hoje: '2026-09-27' }));
  assert.equal(p.state.severidadeDias, 7);
  assert.equal(p.state.estado, 'EM_DEMURRAGE_CRITICO');
  assert.equal(p.priority.balde, 'CRITICA_7_14');
  assert.equal(p.state.escalationRequired, false);
});

test('caso 5: ativo, hoje = LFD + 15 → crítico com escalada', () => {
  const p = pacote(facts({ hoje: '2026-10-05' }));
  assert.equal(p.state.severidadeDias, 15);
  assert.equal(p.state.estado, 'EM_DEMURRAGE_CRITICO');
  assert.equal(p.state.escalationRequired, true);
  assert.ok(p.state.badges.includes('escalationRequired'));
  assert.equal(p.priority.balde, 'CRITICA_15');
});

test('caso 6: relógio do cliente vencido, Rocket ainda livre → só o badge do cliente', () => {
  const s = derivarEstadoContainer(facts({ hoje: '2026-09-22', cliente: ok({ ultimoDiaLivre: '2026-09-20' }), rocket: ok({ ultimoDiaLivre: '2026-09-30' }) }));
  assert.equal(s.estado, 'EM_DEMURRAGE_ATENCAO');
  assert.equal(s.severidadeDias, 2);
  assert.ok(s.clienteEmDemurrage && s.badges.includes('clienteEmDemurrage'));
  assert.ok(!s.rocketExposta && !s.badges.includes('rocketExposta'));
});

test('caso 7: relógio Rocket vencido, cliente ainda livre → só o badge de exposição Rocket', () => {
  const s = derivarEstadoContainer(facts({ hoje: '2026-09-22', cliente: ok({ ultimoDiaLivre: '2026-09-30' }), rocket: ok({ ultimoDiaLivre: '2026-09-20' }) }));
  assert.equal(s.estado, 'EM_DEMURRAGE_ATENCAO');
  assert.ok(s.rocketExposta && s.badges.includes('rocketExposta'));
  assert.ok(!s.clienteEmDemurrage && !s.badges.includes('clienteEmDemurrage'));
});

test('caso 8: um relógio pendente e o outro vencido → estado de demurrage com o badge de dado faltante', () => {
  const f = facts({ hoje: '2026-09-23', cliente: pendente, rocket: ok({ ultimoDiaLivre: '2026-09-20' }) });
  const s = derivarEstadoContainer(f);
  assert.equal(s.estado, 'EM_DEMURRAGE_ATENCAO');
  assert.equal(s.severidadeDias, 3);
  assert.ok(s.badges.includes('pendenciaDadosCliente'));
  assert.ok(s.badges.includes('rocketExposta'));
  assert.equal(f.apuracaoDemurrageStatus, 'DEMURRAGE_CONFIRMADA');
});

test('caso 9: Empty Return DENTRO do Free Time, hoje muito depois do LFD → continua zero e pode concluir', () => {
  const f = facts({ hoje: '2026-12-31', emptyReturn: true });
  assert.equal(diasDemurrageOperacionais(f.clienteClock, f.hoje, true), 0);
  assert.equal(f.apuracaoDemurrageStatus, 'ZERO_CONFIRMADO');
  const s = derivarEstadoContainer(f);
  assert.equal(s.severidadeDias, 0);
  assert.equal(s.estado, 'CONCLUIDO_PARA_ROCKET', 'regra de conclusão existente, sem demurrage');
  const b = blocoPrazoRelogio(f.clienteClock, f.hoje, 4, true);
  assert.equal(b.vencido, false);
  assert.equal(b.encerradoPorDevolucao, true);
  assert.equal(b.proximoMarco, null);
});

test('caso 10: Empty Return DEPOIS do LFD → preserva os dias do cache até a devolução, nunca acumula depois', () => {
  // Cache apurado com a data de devolução: 4 dias. Hoje está 60 dias depois.
  const devolvido = ok({ diasDemurrage: 4 });
  const f = facts({ hoje: '2026-11-25', cliente: devolvido, rocket: devolvido, emptyReturn: true });
  assert.equal(diasDemurrageOperacionais(devolvido, f.hoje, true), 4);
  const s = derivarEstadoContainer(f);
  assert.equal(s.severidadeDias, 4);
  assert.equal(s.estado, 'DEVOLVIDO_AGUARDANDO_TRATAMENTO');
  const b = blocoPrazoRelogio(devolvido, f.hoje, 4, true);
  assert.equal(b.vencido, true);
  assert.equal(b.encerradoPorDevolucao, true);
  assert.equal(b.diasRestantes, null);
});

test('caso 11: cache MAIOR que a extrapolação civil → nunca reduz o cache', () => {
  const adiantado = ok({ diasDemurrage: 9 });
  const f = facts({ hoje: '2026-09-23', cliente: adiantado, rocket: adiantado });
  assert.equal(diasDemurrageOperacionais(adiantado, f.hoje, false), 9);
  const p = pacote(f);
  assert.equal(p.state.severidadeDias, 9);
  assert.equal(p.priority.balde, 'CRITICA_7_14');
  assert.equal(blocoPrazoRelogio(adiantado, f.hoje, 4, false).vencido, true, 'bloco de prazo e estado concordam');
});

test('caso 12 (puro): mesmo resultado antes do tick (cache 0) e depois do tick (cache atualizado)', () => {
  for (const [hoje, diasAposTick] of [['2026-09-21', 1], ['2026-09-27', 7], ['2026-10-05', 15]] as const) {
    const antes = pacote(facts({ hoje }));
    const depois = pacote(facts({ hoje, cliente: ok({ diasDemurrage: diasAposTick }), rocket: ok({ diasDemurrage: diasAposTick }) }));
    assert.deepEqual(antes.state, depois.state, `estado idêntico em ${hoje}`);
    assert.deepEqual(antes.priority, depois.priority, `prioridade idêntica em ${hoje}`);
    assert.equal(antes.facts.apuracaoDemurrageStatus, depois.facts.apuracaoDemurrageStatus);
    assert.deepEqual(
      blocoPrazoRelogio(antes.facts.clienteClock, hoje, 4, false),
      blocoPrazoRelogio(depois.facts.clienteClock, hoje, 4, false),
    );
  }
});

/* ------------------------------------------------------------------ *
 * Status de apuração, responsabilidade, prioridade e envelope financeiro.
 * ------------------------------------------------------------------ */

test('apuração: contêiner ativo com relógio válido além do LFD nunca é ZERO_CONFIRMADO', () => {
  assert.equal(derivarApuracaoDemurrageStatusOperacional(ok(), ok(), '2026-09-21', false), 'DEMURRAGE_CONFIRMADA');
  assert.equal(derivarApuracaoDemurrageStatusOperacional(ok(), ok(), '2026-09-20', false), 'ZERO_CONFIRMADO');
  // O outro relógio pendente continua representado pela regra existente (nenhum vencido → INDETERMINADA).
  assert.equal(derivarApuracaoDemurrageStatusOperacional(pendente, ok(), '2026-09-20', false), 'INDETERMINADA');
});

test('responsabilidade: vira EM_ANALISE pela regra existente — nunca uma decisão, nunca Rocket automática', () => {
  const status = derivarApuracaoDemurrageStatusOperacional(ok(), ok(), '2026-09-21', false);
  const r = derivarResponsabilidade(status, null);
  assert.equal(r, 'EM_ANALISE');
  assert.notEqual(r, 'CONFIRMADA_ROCKET');
  assert.notEqual(r, 'CONFIRMADA_CLIENTE');
});

test('prioridade: o contêiner que acabou de vencer (sem tick) passa à frente do que ainda está dentro do Free Time', () => {
  const vencido = pacote({ ...facts({ hoje: '2026-09-21' }), containerId: 'vencido' });
  const dentro = pacote({ ...facts({ hoje: '2026-09-21', cliente: ok({ ultimoDiaLivre: '2026-09-22' }), rocket: ok({ ultimoDiaLivre: '2026-09-22' }) }), containerId: 'dentro' });
  assert.equal(ordenarTodos([dentro, vencido])[0].facts.containerId, 'vencido');
});

test('envelope financeiro: dias operacionais > dias do valor (cache atrasado) → PENDENTE, nunca "sem demurrage" nem valor fabricado', () => {
  const valorZero = { confirmationStatus: 'CONFIRMED' as const, total: 0, moeda: 'BRL' };
  const e = envelopeDeValor({ relogioStatus: 'OK', diasDemurrage: 1, valor: valorZero, valorDefasado: true });
  assert.deepEqual(e, { situacao: 'PENDENTE', total: null, moeda: null });
  // Valor apurado para os dias atuais segue normal.
  const atual = envelopeDeValor({ relogioStatus: 'OK', diasDemurrage: 1, valor: { confirmationStatus: 'ESTIMATED', total: 150, moeda: 'USD' }, valorDefasado: false });
  assert.equal(atual.situacao, 'ESTIMADO');
});
