import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRAZO_PROXIMO_DIAS_PADRAO, diasAteUltimoDiaLivre, estaEmPrazoProximo, blocoPrazoRelogio,
  escolherProximoVencimentoProcesso, CandidatoProximoVencimento,
} from '../lifecycle/prazoFreeTime';
import { ClockFact } from '../lifecycle/types';
import { agregarFinanceiroProcesso, envelopeDeValor, ValorEnvelope } from '../leitura/contrato';

/**
 * Fase D12 v1.2 — DV-05 (bloco de prazo por relógio + próximo vencimento do
 * processo) e DV-01 (agregação financeira por moeda/lado), em funções PURAS,
 * sem banco. Casos de borda exigidos no pedido.
 */

const ok = (over: Partial<ClockFact> = {}): ClockFact => ({ status: 'OK', diasDemurrage: 0, ultimoDiaLivre: '2026-09-20', ...over });
const pending: ClockFact = { status: 'PENDING', diasDemurrage: 0, ultimoDiaLivre: null };

test('DV-05: padrão operacional do limiar é 4 dias corridos', () => {
  assert.equal(PRAZO_PROXIMO_DIAS_PADRAO, 4);
});

test('DV-05 borda: faltam 5 dias → dentro do Free Time, NÃO em Prazo Próximo', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20' }), '2026-09-15', 4);
  assert.equal(b.diasRestantes, 5);
  assert.equal(b.dentroDoFreeTime, true);
  assert.equal(b.emPrazoProximo, false);
  assert.equal(b.vencido, false);
  assert.deepEqual(b.proximoMarco, { tipo: 'FIM_FREE_TIME', data: '2026-09-20', diasRestantes: 5 });
});

test('DV-05 borda: faltam EXATAMENTE 4 dias → em Prazo Próximo (limiar inclusivo)', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20' }), '2026-09-16', 4);
  assert.equal(b.diasRestantes, 4);
  assert.equal(b.emPrazoProximo, true);
  assert.equal(b.vencido, false);
});

test('DV-05 borda: falta 1 dia → em Prazo Próximo', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20' }), '2026-09-19', 4);
  assert.equal(b.diasRestantes, 1);
  assert.equal(b.emPrazoProximo, true);
});

test('DV-05 borda: hoje É o último dia livre → diasRestantes = 0, ainda dentro do Free Time, em Prazo Próximo', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20' }), '2026-09-20', 4);
  assert.equal(b.diasRestantes, 0);
  assert.equal(b.dentroDoFreeTime, true);
  assert.equal(b.emPrazoProximo, true);
  assert.equal(b.vencido, false);
});

test('DV-05 borda: primeiro dia de demurrage (1 dia após o último dia livre) → vencido, SEM diasRestantes negativo, SEM marco', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 1 }), '2026-09-21', 4);
  assert.equal(b.diasRestantes, null, 'nunca um negativo');
  assert.equal(b.dentroDoFreeTime, false);
  assert.equal(b.emPrazoProximo, false);
  assert.equal(b.vencido, true);
  assert.equal(b.proximoMarco, null);
});

test('DV-05 borda: Free Time ZERO ainda é válido (status OK, não pendente)', () => {
  // FT=0 ⇒ LFD = descarga − 1 ⇒ no dia da descarga já é o primeiro dia de demurrage.
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-04', diasDemurrage: 1 }), '2026-09-05', 4);
  assert.equal(b.vencido, true); // confirma que FT=0 não gera PENDING — chega a vencido, não a pendente.
});

test('DV-05: relógio PENDING (Free Time ausente ou sem descarga) → bloco pendente, nunca vencido nem em Prazo Próximo', () => {
  const b = blocoPrazoRelogio(pending, '2026-09-20', 4);
  assert.equal(b.diasRestantes, null);
  assert.equal(b.dentroDoFreeTime, false);
  assert.equal(b.emPrazoProximo, false);
  assert.equal(b.vencido, false);
  assert.equal(b.proximoMarco, null);
});

test('DV-05: House ≠ Master — cada relógio dá seu próprio bloco, nunca fundidos', () => {
  const house = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20' }), '2026-09-18', 4); // dentro, 2 restantes
  const master = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-25' }), '2026-09-18', 4); // dentro, 7 restantes
  assert.equal(house.diasRestantes, 2);
  assert.equal(master.diasRestantes, 7);
  assert.equal(house.emPrazoProximo, true);
  assert.equal(master.emPrazoProximo, false);
});

test('DV-05: limiar null desliga Prazo Próximo (mantém dentro do Free Time)', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20' }), '2026-09-19', null);
  assert.equal(b.diasRestantes, 1);
  assert.equal(b.dentroDoFreeTime, true);
  assert.equal(b.emPrazoProximo, false);
});

test('diasAteUltimoDiaLivre/estaEmPrazoProximo: funções de base usadas por blocoPrazoRelogio (sem cálculo paralelo)', () => {
  assert.equal(diasAteUltimoDiaLivre('2026-09-20', '2026-09-16'), 4);
  assert.equal(estaEmPrazoProximo(4, 4), true);
  assert.equal(estaEmPrazoProximo(5, 4), false);
  assert.equal(estaEmPrazoProximo(null, 4), false);
  assert.equal(estaEmPrazoProximo(4, null), false);
});

test('DV-05: próximo vencimento do processo — vários contêineres/relógios, escolhe o menor diasRestantes', () => {
  const candidatos: CandidatoProximoVencimento[] = [
    { containerId: 'c1', numero: 'AAAA1111116', relogio: 'cliente', marco: { tipo: 'FIM_FREE_TIME', data: '2026-09-25', diasRestantes: 7 } },
    { containerId: 'c2', numero: 'BBBB2222229', relogio: 'rocket', marco: { tipo: 'FIM_FREE_TIME', data: '2026-09-20', diasRestantes: 2 } },
    { containerId: 'c3', numero: 'CCCC3333332', relogio: 'cliente', marco: { tipo: 'FIM_FREE_TIME', data: '2026-09-22', diasRestantes: 4 } },
  ];
  const v = escolherProximoVencimentoProcesso(candidatos);
  assert.equal(v?.containerId, 'c2');
  assert.equal(v?.relogio, 'rocket');
  assert.equal(v?.diasRestantes, 2);
});

test('DV-05: sem candidatos (todos pendentes/vencidos) → próximo vencimento null', () => {
  assert.equal(escolherProximoVencimentoProcesso([]), null);
});

test('DV-05: desempate determinístico — mesmo diasRestantes, decide por data, depois contêiner, depois cliente antes de rocket', () => {
  const candidatos: CandidatoProximoVencimento[] = [
    { containerId: 'c2', numero: 'B', relogio: 'rocket', marco: { tipo: 'FIM_FREE_TIME', data: '2026-09-20', diasRestantes: 2 } },
    { containerId: 'c2', numero: 'B', relogio: 'cliente', marco: { tipo: 'FIM_FREE_TIME', data: '2026-09-20', diasRestantes: 2 } },
  ];
  const v = escolherProximoVencimentoProcesso(candidatos);
  assert.equal(v?.relogio, 'cliente', 'cliente antes de rocket no desempate final');
});

/* -------------------------------------------------------------------- *
 * DV-01 — agregação financeira pura.
 * -------------------------------------------------------------------- */

function env(situacao: ValorEnvelope['situacao'], total: number | null, moeda: string | null): ValorEnvelope {
  return { situacao, total, moeda };
}

test('DV-01: um contêiner confirmado → grupo único, completo', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('CONFIRMADO', 500, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente.length, 1);
  assert.deepEqual(r.cliente[0], { moeda: 'BRL', subtotalConhecido: 500, confirmados: 1, estimados: 0, estimativasProvisorias: 0, pendentes: 0, indisponiveis: 0, semAplicacao: 0, completo: true });
  assert.equal(r.rocket.length, 1);
  assert.equal(r.rocket[0].moeda, null);
  assert.equal(r.rocket[0].semAplicacao, 1);
  assert.equal(r.rocket[0].completo, true, 'sem demurrage não é incompleto');
});

test('DV-01: vários contêineres na MESMA moeda somam no mesmo grupo', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('CONFIRMADO', 200, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.length, 1);
  assert.equal(r.cliente[0].subtotalConhecido, 500);
  assert.equal(r.cliente[0].confirmados, 2);
});

test('DV-01: moedas diferentes NUNCA somam — grupos separados', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('CONFIRMADO', 200, 'USD'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.length, 2);
  const brl = r.cliente.find((g) => g.moeda === 'BRL')!;
  const usd = r.cliente.find((g) => g.moeda === 'USD')!;
  assert.equal(brl.subtotalConhecido, 300);
  assert.equal(usd.subtotalConhecido, 200);
});

test('DV-01: confirmado + estimado na mesma moeda — subtotal soma os dois, contagens separadas', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('ESTIMADO', 150, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente[0].subtotalConhecido, 450);
  assert.equal(r.cliente[0].confirmados, 1);
  assert.equal(r.cliente[0].estimados, 1);
  assert.equal(r.cliente[0].completo, true);
});

test('DV-01: conhecido + indisponível — grupo em BRL completo, indisponível vai para o grupo sem moeda e marca incompleto', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('INDISPONIVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.length, 2);
  const brl = r.cliente.find((g) => g.moeda === 'BRL')!;
  const semMoeda = r.cliente.find((g) => g.moeda === null)!;
  assert.equal(brl.completo, true, 'o grupo BRL em si está completo');
  assert.equal(semMoeda.indisponiveis, 1);
  assert.equal(semMoeda.completo, false, 'indisponível nunca fica oculto como zero — marca incompleto');
  assert.equal(semMoeda.subtotalConhecido, null, 'nada de conhecido no grupo sem moeda');
});

test('DV-01: conhecido + pendente — mesma lógica do indisponível (pendente nunca some)', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('PENDENTE', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  const semMoeda = r.cliente.find((g) => g.moeda === null)!;
  assert.equal(semMoeda.pendentes, 1);
  assert.equal(semMoeda.completo, false);
});

test('DV-01: todos indisponíveis — nenhum grupo por moeda, só o grupo sem moeda, incompleto', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('INDISPONIVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('INDISPONIVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.length, 1);
  assert.equal(r.cliente[0].moeda, null);
  assert.equal(r.cliente[0].indisponiveis, 2);
  assert.equal(r.cliente[0].completo, false);
});

test('DV-01: zero confirmado (NAO_APLICAVEL em todos) continua zero — nenhum grupo "fantasma" com moeda', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('NAO_APLICAVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.length, 1);
  assert.equal(r.cliente[0].moeda, null);
  assert.equal(r.cliente[0].semAplicacao, 1);
  assert.equal(r.cliente[0].pendentes, 0);
  assert.equal(r.cliente[0].indisponiveis, 0);
  assert.equal(r.cliente[0].completo, true, '"sem demurrage" nunca marca incompleto — distinto de "sem informação"');
});

test('DV-01: cliente e Rocket com moedas/situações DIFERENTES nunca se cruzam', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('ESTIMADO', 90, 'USD') },
  ]);
  assert.equal(r.cliente[0].moeda, 'BRL');
  assert.equal(r.rocket[0].moeda, 'USD');
  assert.equal(r.cliente[0].subtotalConhecido, 300);
  assert.equal(r.rocket[0].subtotalConhecido, 90);
});

test('DV-01: estimado nunca vira confirmado nas contagens', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('ESTIMADO', 100, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente[0].confirmados, 0);
  assert.equal(r.cliente[0].estimados, 1);
});

test('DV-01: estimativa provisória contada em categoria própria, nunca junto de estimado/confirmado', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('ESTIMADO_PROVISORIO', 80, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente[0].estimativasProvisorias, 1);
  assert.equal(r.cliente[0].estimados, 0);
  assert.equal(r.cliente[0].confirmados, 0);
});
