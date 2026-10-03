import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRAZO_PROXIMO_DIAS_PADRAO, diasAteUltimoDiaLivre, estaEmPrazoProximo, blocoPrazoRelogio,
  escolherProximoVencimentoProcesso, CandidatoProximoVencimento,
} from '../lifecycle/prazoFreeTime';
import { ClockFact } from '../lifecycle/types';
import { agregarFinanceiroProcesso, envelopeDeValor, ValorEnvelope } from '../leitura/contrato';
import { centavosExatos, somarCentavosExatos, formatarCentavos } from '../leitura/moedaExata';

/**
 * Fase D12 v1.2 — DV-05 (bloco de prazo por relógio + próximo vencimento do
 * processo) e DV-01 (agregação financeira por moeda/lado), em funções PURAS,
 * sem banco. Casos de borda exigidos no pedido original, mais os achados
 * #1/#2/#3 da auditoria (v1.2.1).
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

test('DV-05 borda: primeiro dia de demurrage (cache JÁ recalculado, diasDemurrage=1) → vencido, SEM diasRestantes negativo, SEM marco', () => {
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

/* -------------------------------------------------------------------- *
 * v1.2.1, achado #1 — cache desatualizado NUNCA produz dias negativos. A
 * data civil (`hoje` × `ultimoDiaLivre`) é autoritativa; `diasDemurrage` do
 * cache NÃO é mais consultado por `blocoPrazoRelogio` para decidir vencido.
 * -------------------------------------------------------------------- */

test('v1.2.1 #1: cache diasDemurrage=0, hoje UM dia depois do LFD (relógio ainda não recalculado) → vencido, nunca negativo', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 0 }), '2026-09-21', 4);
  assert.equal(b.vencido, true);
  assert.equal(b.diasRestantes, null, 'nunca -1');
  assert.equal(b.dentroDoFreeTime, false);
  assert.equal(b.emPrazoProximo, false);
  assert.equal(b.proximoMarco, null);
});

test('v1.2.1 #1: cache diasDemurrage=0, hoje VÁRIOS dias depois do LFD (relógio ainda não recalculado) → vencido, nunca negativo', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 0 }), '2026-09-27', 4);
  assert.equal(b.vencido, true);
  assert.equal(b.diasRestantes, null, 'nunca -7');
  assert.equal(b.dentroDoFreeTime, false);
  assert.equal(b.proximoMarco, null);
});

test('v1.2.1 #1: cache diasDemurrage>=1, hoje depois do LFD → vencido (mesmo resultado, cache já recalculado ou não)', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 5 }), '2026-09-25', 4);
  assert.equal(b.vencido, true);
  assert.equal(b.diasRestantes, null);
  assert.equal(b.proximoMarco, null);
});

test('v1.2.1 #1: exatamente no LFD → dentro do Free Time, diasRestantes=0, nunca vencido', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 0 }), '2026-09-20', 4);
  assert.equal(b.vencido, false);
  assert.equal(b.dentroDoFreeTime, true);
  assert.equal(b.diasRestantes, 0);
});

test('v1.2.1 #1: antes do LFD → dentro do Free Time, diasRestantes positivo, nunca vencido', () => {
  const b = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 0 }), '2026-09-10', 4);
  assert.equal(b.vencido, false);
  assert.equal(b.dentroDoFreeTime, true);
  assert.equal(b.diasRestantes, 10);
});

test('v1.2.1 #1: relógio pendente permanece pendente na janela de cache desatualizado (nunca vencido por falta de dado)', () => {
  const b = blocoPrazoRelogio(pending, '2026-09-27', 4);
  assert.equal(b.vencido, false);
  assert.equal(b.dentroDoFreeTime, false);
  assert.equal(b.diasRestantes, null);
  assert.equal(b.proximoMarco, null);
});

test('v1.2.1 #1: próximo vencimento do processo NUNCA escolhe um prazo passado — o relógio vencido simplesmente não entra na lista de candidatos', () => {
  // Contêiner vencido: blocoPrazoRelogio não gera proximoMarco algum (confirmado acima) — então
  // ele nunca aparece como candidato. Só o relógio ainda dentro do prazo entra na disputa.
  const vencido = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-09-20', diasDemurrage: 0 }), '2026-09-27', 4);
  const dentro = blocoPrazoRelogio(ok({ ultimoDiaLivre: '2026-10-05', diasDemurrage: 0 }), '2026-09-27', 4);
  assert.equal(vencido.proximoMarco, null, 'contêiner vencido nunca produz marco');
  assert.ok(dentro.proximoMarco);

  const candidatos: CandidatoProximoVencimento[] = [
    ...(vencido.proximoMarco ? [{ containerId: 'vencido', numero: 'VENC', relogio: 'cliente' as const, marco: vencido.proximoMarco }] : []),
    { containerId: 'dentro', numero: 'DENT', relogio: 'cliente', marco: dentro.proximoMarco! },
  ];
  const v = escolherProximoVencimentoProcesso(candidatos);
  assert.equal(v?.containerId, 'dentro');
  assert.ok(v!.diasRestantes >= 0, 'nunca um diasRestantes negativo no próximo vencimento do processo');
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
 * v1.2.1, achado #3 — soma monetária exata (`moedaExata.ts`): centavos
 * `bigint` internamente, string decimal com duas casas na saída.
 * -------------------------------------------------------------------- */

const somar = (...valores: Array<number | string>) => formatarCentavos(somarCentavosExatos(valores.map(centavosExatos)));

test('v1.2.1 #3: 0.10 + 0.20 = "0.30" exatamente (a soma ingênua em ponto flutuante falha)', () => {
  assert.notEqual(0.1 + 0.2, 0.3, 'premissa: ponto flutuante falha aqui');
  assert.equal(somar(0.10, 0.20), '0.30');
});

test('v1.2.1 #3: 10.01 + 20.02 + 30.03 = "60.06" exatamente, em qualquer ordem', () => {
  assert.notEqual(20.02 + 30.03 + 10.01, 60.06, 'premissa: nesta ordem o ponto flutuante falha');
  assert.equal(somar(10.01, 20.02, 30.03), '60.06');
  assert.equal(somar(20.02, 30.03, 10.01), '60.06');
  assert.equal(somar(30.03, 10.01, 20.02), '60.06');
});

test('v1.2.1 #3: confirmado zero permanece exatamente zero', () => {
  assert.equal(somar(0), '0.00');
  assert.equal(somar(0, 0, '0.00'), '0.00');
});

test('v1.2.1 #3: valores no limite de NUMERIC(14,2) permanecem exatos, inclusive somas além de 15 dígitos significativos', () => {
  const limite = 999999999999.99; // 12 dígitos inteiros + 2 decimais
  assert.equal(somar(limite), '999999999999.99');
  assert.equal(somar(limite, 0.01), '1000000000000.00');
  // 100 parcelas no limite: 16 dígitos significativos — um `number` já não representaria isto.
  assert.equal(somar(...Array(100).fill(limite)), '99999999999999.00');
  assert.equal(somar(...Array(1000).fill(limite)), '999999999999990.00');
});

test('v1.2.1 #3: a string decimal do Postgres e o `number` equivalente produzem os mesmos centavos', () => {
  assert.equal(centavosExatos('1400.00'), centavosExatos(1400));
  assert.equal(centavosExatos('10.10'), centavosExatos(10.1));
  assert.equal(centavosExatos('167842472745.80'), 16784247274580n);
});

test('v1.2.1 #3: fuzz — 200.000 valores NUMERIC(14,2) aleatórios (string do Postgres → Number → centavos) voltam idênticos', () => {
  for (let i = 0; i < 200_000; i++) {
    const cents = BigInt(Math.floor(Math.random() * 99999999999999));
    const texto = `${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
    assert.equal(centavosExatos(Number(texto)), cents, texto);
    assert.equal(formatarCentavos(centavosExatos(Number(texto))), texto);
  }
});

test('v1.2.1 #3: valor não finito falha explicitamente', () => {
  assert.throws(() => centavosExatos(Infinity));
  assert.throws(() => centavosExatos(NaN));
});

test('v1.2.1 #3: mais de duas casas decimais falha explicitamente — nunca arredonda em silêncio', () => {
  assert.throws(() => centavosExatos(10.005));
  assert.throws(() => centavosExatos('10.005'));
  assert.throws(() => centavosExatos(0.001));
});

test('v1.2.1 #3: notação exponencial, texto malformado e valor acima de NUMERIC(14,2) falham explicitamente', () => {
  assert.throws(() => centavosExatos(1e-7));
  assert.throws(() => centavosExatos('1e3'));
  assert.throws(() => centavosExatos('12,50'));
  assert.throws(() => centavosExatos(''));
  assert.throws(() => centavosExatos('1000000000000.00'), /excede NUMERIC/);
  assert.throws(() => centavosExatos(1e13));
});

/* -------------------------------------------------------------------- *
 * DV-01 — agregação financeira pura (v1.2.1: completude no nível do LADO,
 * `AgregadoFinanceiroLado`, nunca mais um "grupo de moeda null").
 * -------------------------------------------------------------------- */

function env(situacao: ValorEnvelope['situacao'], total: number | null, moeda: string | null): ValorEnvelope {
  return { situacao, total, moeda };
}

test('DV-01: um contêiner confirmado → um grupo de moeda, lado completo', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('CONFIRMADO', 500, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente.gruposPorMoeda.length, 1);
  assert.deepEqual(r.cliente.gruposPorMoeda[0], { moeda: 'BRL', subtotalConhecido: '500.00', confirmados: 1, estimados: 0, estimativasProvisorias: 0 });
  assert.equal(r.cliente.pendentes, 0);
  assert.equal(r.cliente.indisponiveis, 0);
  assert.equal(r.cliente.completo, true);

  assert.equal(r.rocket.gruposPorMoeda.length, 0, 'sem aplicação nunca é um grupo de moeda');
  assert.equal(r.rocket.semAplicacao, 1);
  assert.equal(r.rocket.completo, true, 'sem demurrage não é incompleto');
});

test('DV-01: vários contêineres na MESMA moeda somam no mesmo grupo', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('CONFIRMADO', 200, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda.length, 1);
  assert.equal(r.cliente.gruposPorMoeda[0].subtotalConhecido, '500.00');
  assert.equal(r.cliente.gruposPorMoeda[0].confirmados, 2);
  assert.equal(r.cliente.completo, true);
});

test('DV-01: moedas diferentes NUNCA somam — grupos separados', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('CONFIRMADO', 200, 'USD'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda.length, 2);
  const brl = r.cliente.gruposPorMoeda.find((g) => g.moeda === 'BRL')!;
  const usd = r.cliente.gruposPorMoeda.find((g) => g.moeda === 'USD')!;
  assert.equal(brl.subtotalConhecido, '300.00');
  assert.equal(usd.subtotalConhecido, '200.00');
});

test('DV-01: confirmado + estimado na mesma moeda — subtotal soma os dois, contagens separadas', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('ESTIMADO', 150, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda[0].subtotalConhecido, '450.00');
  assert.equal(r.cliente.gruposPorMoeda[0].confirmados, 1);
  assert.equal(r.cliente.gruposPorMoeda[0].estimados, 1);
  assert.equal(r.cliente.completo, true);
});

test('DV-01 (achado #2): confirmado + indisponível — o LADO (não o grupo BRL) é que fica incompleto', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('INDISPONIVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  // Só UM grupo de moeda (BRL) — indisponível nunca é apresentado como "outra moeda".
  assert.equal(r.cliente.gruposPorMoeda.length, 1);
  assert.equal(r.cliente.gruposPorMoeda[0].moeda, 'BRL');
  assert.equal(r.cliente.gruposPorMoeda[0].subtotalConhecido, '300.00');
  assert.equal(r.cliente.indisponiveis, 1);
  assert.equal(r.cliente.completo, false, 'o LADO cliente fica incompleto mesmo com um grupo de moeda "ok"');
});

test('DV-01 (achado #2): confirmado + pendente — mesma lógica do indisponível, no nível do lado', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('PENDENTE', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.pendentes, 1);
  assert.equal(r.cliente.completo, false);
  assert.equal(r.cliente.gruposPorMoeda.length, 1, 'pendente não é um grupo de moeda');
});

test('DV-01 (achado #2): confirmado + NAO_APLICAVEL — não marca incompleto (sem demurrage ≠ sem informação)', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('NAO_APLICAVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.semAplicacao, 1);
  assert.equal(r.cliente.pendentes, 0);
  assert.equal(r.cliente.indisponiveis, 0);
  assert.equal(r.cliente.completo, true);
});

test('DV-01 (achado #2): todos indisponíveis — nenhum grupo de moeda, lado incompleto', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('INDISPONIVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('INDISPONIVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda.length, 0);
  assert.equal(r.cliente.indisponiveis, 2);
  assert.equal(r.cliente.completo, false);
});

test('DV-01 (achado #2): todos pendentes — nenhum grupo de moeda, lado incompleto', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('PENDENTE', null, null), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('PENDENTE', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda.length, 0);
  assert.equal(r.cliente.pendentes, 2);
  assert.equal(r.cliente.completo, false);
});

test('DV-01 (achado #2): todos NAO_APLICAVEL — nenhum grupo de moeda, lado COMPLETO (sem demurrage no processo)', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('NAO_APLICAVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('NAO_APLICAVEL', null, null), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda.length, 0);
  assert.equal(r.cliente.semAplicacao, 2);
  assert.equal(r.cliente.pendentes, 0);
  assert.equal(r.cliente.indisponiveis, 0);
  assert.equal(r.cliente.completo, true, '"sem demurrage" nunca marca incompleto — distinto de "sem informação"');
});

test('DV-01: zero confirmado (CONFIRMADO com total=0) continua exatamente zero e completo', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('CONFIRMADO', 0, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente.gruposPorMoeda.length, 1);
  assert.equal(r.cliente.gruposPorMoeda[0].subtotalConhecido, '0.00');
  assert.equal(r.cliente.gruposPorMoeda[0].confirmados, 1);
  assert.equal(r.cliente.completo, true);
});

test('DV-01: múltiplas moedas no mesmo lado — cada grupo soma só a sua própria moeda', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 10.01, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('CONFIRMADO', 20.02, 'USD'), rocket: env('NAO_APLICAVEL', null, null) },
    { cliente: env('CONFIRMADO', 30.03, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) },
  ]);
  assert.equal(r.cliente.gruposPorMoeda.length, 2);
  const brl = r.cliente.gruposPorMoeda.find((g) => g.moeda === 'BRL')!;
  const usd = r.cliente.gruposPorMoeda.find((g) => g.moeda === 'USD')!;
  assert.equal(brl.subtotalConhecido, '40.04', '10.01 + 30.03 exato');
  assert.equal(usd.subtotalConhecido, '20.02');
});

test('DV-01: cliente completo enquanto Rocket incompleto (e vice-versa) — lados sempre independentes', () => {
  const r1 = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('PENDENTE', null, null) },
  ]);
  assert.equal(r1.cliente.completo, true);
  assert.equal(r1.rocket.completo, false);

  const r2 = agregarFinanceiroProcesso([
    { cliente: env('INDISPONIVEL', null, null), rocket: env('CONFIRMADO', 90, 'USD') },
  ]);
  assert.equal(r2.cliente.completo, false);
  assert.equal(r2.rocket.completo, true);
});

test('DV-01: cliente e Rocket com moedas/situações DIFERENTES nunca se cruzam', () => {
  const r = agregarFinanceiroProcesso([
    { cliente: env('CONFIRMADO', 300, 'BRL'), rocket: env('ESTIMADO', 90, 'USD') },
  ]);
  assert.equal(r.cliente.gruposPorMoeda[0].moeda, 'BRL');
  assert.equal(r.rocket.gruposPorMoeda[0].moeda, 'USD');
  assert.equal(r.cliente.gruposPorMoeda[0].subtotalConhecido, '300.00');
  assert.equal(r.rocket.gruposPorMoeda[0].subtotalConhecido, '90.00');
});

test('DV-01: estimado nunca vira confirmado nas contagens', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('ESTIMADO', 100, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente.gruposPorMoeda[0].confirmados, 0);
  assert.equal(r.cliente.gruposPorMoeda[0].estimados, 1);
});

test('DV-01: estimativa provisória contada em categoria própria, nunca junto de estimado/confirmado', () => {
  const r = agregarFinanceiroProcesso([{ cliente: env('ESTIMADO_PROVISORIO', 80, 'BRL'), rocket: env('NAO_APLICAVEL', null, null) }]);
  assert.equal(r.cliente.gruposPorMoeda[0].estimativasProvisorias, 1);
  assert.equal(r.cliente.gruposPorMoeda[0].estimados, 0);
  assert.equal(r.cliente.gruposPorMoeda[0].confirmados, 0);
});
