import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { freeTimeClock, FreeTimeClockInput } from '../temporal/freeTimeClock';
import { fromOrdinal, toOrdinal } from '../temporal/civilDate';
import { CASOS_MOTOR_TEMPORAL, CasoMotorTemporal, CategoriaMotorTemporal } from '../__fixtures__/casosOficiais';

/** Converte a entrada da fixture (vocabulário do Blueprint) na entrada do motor. */
function inputDaFixture(caso: CasoMotorTemporal): FreeTimeClockInput {
  return {
    dischargeDate: caso.entrada.descarga,
    freeTimeDays: caso.entrada.freeTimeDias,
    finalDate: caso.entrada.dataFinal,
  };
}

/* ------------------------------------------------------------------ *
 * Fixtures oficiais — um teste por caso
 * ------------------------------------------------------------------ */

for (const caso of CASOS_MOTOR_TEMPORAL) {
  test(`fixture ${caso.id} [${caso.categoria}] ${caso.descricao}`, () => {
    assert.deepEqual(freeTimeClock(inputDaFixture(caso)), caso.esperado);
  });
}

test('fixtures: todas as categorias exigidas na revisão 5 estão cobertas', () => {
  const exigidas: CategoriaMotorTemporal[] = [
    'off-by-one',
    'ft-zero',
    'ft-ausente',
    'virada-de-mes',
    'virada-de-ano',
    'fevereiro',
    'data-final-anterior-a-descarga',
    'devolucao-ultimo-dia-livre',
    'devolucao-primeiro-dia-demurrage',
  ];
  const presentes = new Set(CASOS_MOTOR_TEMPORAL.map((c) => c.categoria));
  for (const categoria of exigidas) assert.ok(presentes.has(categoria), `falta fixture da categoria ${categoria}`);

  const ids = CASOS_MOTOR_TEMPORAL.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids de fixture devem ser únicos');
});

test('fixtures: a tabela literal do Blueprint (Cap. 23.1) está presente e intacta', () => {
  const tabela = CASOS_MOTOR_TEMPORAL.filter((c) => c.categoria === 'off-by-one').map((c) => [
    c.entrada.descarga,
    c.entrada.freeTimeDias,
    c.entrada.dataFinal,
    c.esperado.status === 'OK' ? c.esperado.diasDemurrage : null,
  ]);
  assert.deepEqual(tabela, [
    ['2026-09-01', 14, '2026-09-14', 0],
    ['2026-09-01', 14, '2026-09-15', 1],
    ['2026-09-01', 14, '2026-09-16', 2],
    ['2026-09-01', 14, '2026-09-20', 6],
  ]);
});

/* ------------------------------------------------------------------ *
 * Propriedades das regras
 * ------------------------------------------------------------------ */

test('FT 0 é diferente de FT ausente, para as mesmas datas', () => {
  const zero = freeTimeClock({ dischargeDate: '2026-09-01', freeTimeDays: 0, finalDate: '2026-09-01' });
  const ausente = freeTimeClock({ dischargeDate: '2026-09-01', freeTimeDays: null, finalDate: '2026-09-01' });
  assert.equal(zero.status, 'OK');
  assert.deepEqual(ausente, { status: 'PENDING', pendencias: ['FREE_TIME_AUSENTE'] });
});

test('nunca produz número negativo; conta +1 por dia corrido a partir do primeiro dia de demurrage', () => {
  const descarga = '2026-12-20'; // atravessa virada de ano no intervalo varrido
  const d0 = toOrdinal(descarga);
  for (const ft of [0, 1, 7, 14, 21]) {
    for (let offset = -30; offset <= 60; offset++) {
      const finalDate = fromOrdinal(d0 + offset);
      const r = freeTimeClock({ dischargeDate: descarga, freeTimeDays: ft, finalDate });
      if (offset < 0) {
        assert.equal(r.status, 'INVALID', `FT ${ft}, final ${finalDate}`);
        continue;
      }
      assert.equal(r.status, 'OK');
      if (r.status !== 'OK') return;
      assert.equal(r.primeiroDiaDemurrage, fromOrdinal(d0 + ft));
      assert.equal(r.ultimoDiaLivre, fromOrdinal(d0 + ft - 1));
      assert.equal(r.diasDemurrage, Math.max(0, offset - ft + 1), `FT ${ft}, final ${finalDate}`);
      assert.ok(r.diasDemurrage >= 0);
    }
  }
});

test('determinístico e sem efeito colateral na entrada', () => {
  const input: FreeTimeClockInput = { dischargeDate: '2026-09-01', freeTimeDays: 14, finalDate: '2026-09-20' };
  const copia = { ...input };
  const a = freeTimeClock(input);
  const b = freeTimeClock(input);
  assert.deepEqual(a, b);
  assert.deepEqual(input, copia);
});

/* ------------------------------------------------------------------ *
 * Contrato de entrada — data civil, âncora única
 * ------------------------------------------------------------------ */

test('contrato: Date do JavaScript nunca é aceito como dia operacional', () => {
  assert.throws(
    () => freeTimeClock({ dischargeDate: new Date(0) as unknown as string, freeTimeDays: 14, finalDate: '2026-09-20' }),
    /nunca é um Date/,
  );
  assert.throws(
    () => freeTimeClock({ dischargeDate: '2026-09-01', freeTimeDays: 14, finalDate: new Date(0) as unknown as string }),
    /nunca é um Date/,
  );
});

test('contrato: timestamp (com hora) não é data civil', () => {
  assert.throws(
    () => freeTimeClock({ dischargeDate: '2026-09-01T10:30:00-03:00', freeTimeDays: 14, finalDate: '2026-09-20' }),
    RangeError,
  );
});

test('contrato: Gate Out (ou qualquer outra data) não pode ser passado ao motor', () => {
  assert.throws(
    () =>
      freeTimeClock({
        dischargeDate: null,
        freeTimeDays: 14,
        finalDate: '2026-09-20',
        gateOutDate: '2026-09-05',
      } as unknown as FreeTimeClockInput),
    /campo não aceito 'gateOutDate'/,
  );
});

test('contrato: ausência precisa ser declarada com null, não omitida', () => {
  assert.throws(
    () => freeTimeClock({ freeTimeDays: 14, finalDate: '2026-09-20' } as unknown as FreeTimeClockInput),
    /campo obrigatório ausente 'dischargeDate'/,
  );
  assert.throws(
    () => freeTimeClock({ dischargeDate: '2026-09-01', freeTimeDays: 14, finalDate: null } as unknown as FreeTimeClockInput),
    /finalDate é obrigatório/,
  );
});

test('contrato: FT precisa ser inteiro não negativo', () => {
  const base = { dischargeDate: '2026-09-01', finalDate: '2026-09-20' };
  assert.throws(() => freeTimeClock({ ...base, freeTimeDays: -1 }), RangeError);
  assert.throws(() => freeTimeClock({ ...base, freeTimeDays: 14.5 }), TypeError);
  assert.throws(() => freeTimeClock({ ...base, freeTimeDays: Number.NaN }), TypeError);
  assert.throws(() => freeTimeClock({ ...base, freeTimeDays: '14' as unknown as number }), TypeError);
});

/* ------------------------------------------------------------------ *
 * Pureza — o motor não depende de banco, tracking, Outlook ou tarifa
 * ------------------------------------------------------------------ */

test('pureza: o código do motor temporal só importa módulos vizinhos e não usa o relógio/objetos Date', () => {
  const dir = path.join(__dirname, '..', 'temporal');
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(arquivos.length >= 2);
  for (const arquivo of arquivos) {
    const codigo = fs
      .readFileSync(path.join(dir, arquivo), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const imports = [...codigo.matchAll(/from\s+'([^']+)'/g), ...codigo.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(
      (m) => m[1],
    );
    for (const spec of imports) {
      assert.ok(spec.startsWith('./'), `${arquivo} importa '${spec}' — o motor temporal só pode depender de módulos do próprio diretório`);
    }
    assert.doesNotMatch(codigo, /new Date\b|Date\.(now|UTC|parse)\b|getTimezoneOffset|toISOString/, `${arquivo} usa Date/relógio`);
  }
});
