import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularDoisRelogios, DualClockInput } from '../temporal/dualClockCalculator';
import { freeTimeClock } from '../temporal/freeTimeClock';
import {
  CASOS_DOIS_RELOGIOS,
  CASOS_MULTIPLOS_CONTEINERES,
  CasoDoisRelogios,
} from '../__fixtures__/casosOficiais';

function inputDaFixture(caso: CasoDoisRelogios): DualClockInput {
  return {
    dischargeDate: caso.entrada.descarga,
    houseFreeTimeDays: caso.entrada.houseFreeTimeDias,
    masterFreeTimeDays: caso.entrada.masterFreeTimeDias,
    finalDate: caso.entrada.dataFinal,
  };
}

/* ------------------------------------------------------------------ *
 * Fixtures oficiais House × Master — um teste por caso
 * ------------------------------------------------------------------ */

for (const caso of CASOS_DOIS_RELOGIOS) {
  test(`fixture ${caso.id} [grupo ${caso.grupo}] ${caso.descricao}`, () => {
    const r = calcularDoisRelogios(inputDaFixture(caso));
    assert.deepEqual(r.cliente, caso.esperado.cliente, 'relógio do Cliente (House)');
    assert.deepEqual(r.rocket, caso.esperado.rocket, 'relógio Rocket (Master)');
  });
}

test('fixtures dois relógios: todos os grupos obrigatórios (A–K) estão cobertos e os ids são únicos', () => {
  const grupos = new Set(CASOS_DOIS_RELOGIOS.map((c) => c.grupo));
  for (const g of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K']) {
    assert.ok(grupos.has(g), `falta caso do grupo ${g}`);
  }
  const ids = CASOS_DOIS_RELOGIOS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids de fixture devem ser únicos');
});

/* ------------------------------------------------------------------ *
 * O motor não é reimplementado: cada relógio é exatamente uma chamada
 * ao freeTimeClock. Nenhuma fórmula duplicada, nenhum cálculo alternativo.
 * ------------------------------------------------------------------ */

test('cada relógio é idêntico a uma chamada isolada do freeTimeClock (sem fórmula duplicada)', () => {
  for (const caso of CASOS_DOIS_RELOGIOS) {
    const dual = calcularDoisRelogios(inputDaFixture(caso));
    const cliente = freeTimeClock({
      dischargeDate: caso.entrada.descarga,
      freeTimeDays: caso.entrada.houseFreeTimeDias,
      finalDate: caso.entrada.dataFinal,
    });
    const rocket = freeTimeClock({
      dischargeDate: caso.entrada.descarga,
      freeTimeDays: caso.entrada.masterFreeTimeDias,
      finalDate: caso.entrada.dataFinal,
    });
    assert.deepEqual(dual.cliente, cliente, `${caso.id}: cliente diverge da chamada direta`);
    assert.deepEqual(dual.rocket, rocket, `${caso.id}: rocket diverge da chamada direta`);
  }
});

/* ------------------------------------------------------------------ *
 * Independência entre os dois relógios de um contêiner
 * ------------------------------------------------------------------ */

test('um relógio PENDING não bloqueia o outro (House ausente → Cliente PENDING, Rocket calcula)', () => {
  const r = calcularDoisRelogios({
    dischargeDate: '2026-09-01',
    houseFreeTimeDays: null,
    masterFreeTimeDays: 21,
    finalDate: '2026-09-25',
  });
  assert.equal(r.cliente.status, 'PENDING');
  assert.equal(r.rocket.status, 'OK');
  if (r.rocket.status === 'OK') assert.equal(r.rocket.diasDemurrage, 4);
});

test('um relógio INVALID não bloqueia o outro, e não há "status geral"', () => {
  // Master válido, House ausente, data final antes da descarga.
  const r = calcularDoisRelogios({
    dischargeDate: '2026-09-10',
    houseFreeTimeDays: null,
    masterFreeTimeDays: 14,
    finalDate: '2026-09-05',
  });
  // Os dois são INVALID por data, mas cada um preserva SUA pendência.
  assert.deepEqual(r.cliente, {
    status: 'INVALID',
    motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA',
    pendencias: ['FREE_TIME_AUSENTE'],
  });
  assert.deepEqual(r.rocket, {
    status: 'INVALID',
    motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA',
    pendencias: [],
  });
  // O resultado é sempre o par: não existe um campo único de status somando os dois.
  assert.deepEqual(Object.keys(r).sort(), ['cliente', 'rocket']);
});

test('trocar o free time de um relógio não muda o outro', () => {
  const base = { dischargeDate: '2026-09-01', masterFreeTimeDays: 21, finalDate: '2026-09-22' } as const;
  const a = calcularDoisRelogios({ ...base, houseFreeTimeDays: 14 });
  const b = calcularDoisRelogios({ ...base, houseFreeTimeDays: 7 });
  assert.deepEqual(a.rocket, b.rocket, 'o relógio Rocket (Master) não pode depender do FT House');
  assert.notDeepEqual(a.cliente, b.cliente, 'o relógio do Cliente deve refletir a mudança de FT House');
});

/* ------------------------------------------------------------------ *
 * Múltiplos contêineres do mesmo processo — independência entre contêineres
 * ------------------------------------------------------------------ */

for (const caso of CASOS_MULTIPLOS_CONTEINERES) {
  test(`fixture ${caso.id}: ${caso.descricao}`, () => {
    for (const c of caso.conteineres) {
      const r = calcularDoisRelogios({
        dischargeDate: c.descarga,
        houseFreeTimeDays: c.houseFreeTimeDias,
        masterFreeTimeDays: c.masterFreeTimeDias,
        finalDate: caso.dataFinal,
      });
      assert.deepEqual(r.cliente, c.esperado.cliente, `${c.numero}: cliente`);
      assert.deepEqual(r.rocket, c.esperado.rocket, `${c.numero}: rocket`);
    }
  });
}

test('independência entre contêineres: a ordem de cálculo não altera nenhum resultado', () => {
  const caso = CASOS_MULTIPLOS_CONTEINERES[0];
  const calc = (c: (typeof caso.conteineres)[number]) =>
    calcularDoisRelogios({
      dischargeDate: c.descarga,
      houseFreeTimeDays: c.houseFreeTimeDias,
      masterFreeTimeDays: c.masterFreeTimeDias,
      finalDate: caso.dataFinal,
    });

  const naOrdem = caso.conteineres.map((c) => [c.numero, calc(c)] as const);
  const invertido = [...caso.conteineres].reverse().map((c) => [c.numero, calc(c)] as const);
  const porNumero = (pares: readonly (readonly [string, unknown])[]) =>
    Object.fromEntries(pares);
  assert.deepEqual(porNumero(invertido), porNumero(naOrdem), 'permutar a ordem não pode mudar nada');
});

/* ------------------------------------------------------------------ *
 * Contrato de entrada
 * ------------------------------------------------------------------ */

test('contrato: só descarga, os dois free times e a data final entram', () => {
  assert.throws(
    () =>
      calcularDoisRelogios({
        dischargeDate: '2026-09-01',
        houseFreeTimeDays: 14,
        masterFreeTimeDays: 21,
        finalDate: '2026-09-20',
        gateOutDate: '2026-09-05',
      } as unknown as DualClockInput),
    /campo não aceito 'gateOutDate'/,
  );
});

test('contrato: ausência declarada com null, não omitida', () => {
  assert.throws(
    () =>
      calcularDoisRelogios({
        dischargeDate: '2026-09-01',
        houseFreeTimeDays: 14,
        finalDate: '2026-09-20',
      } as unknown as DualClockInput),
    /campo obrigatório ausente 'masterFreeTimeDays'/,
  );
});
