import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromOrdinal, toOrdinal } from '../temporal/civilDate';

/** Calendário de referência independente do módulo testado: avança um dia de cada vez. */
function* walkDays(fromYear: number, toYear: number): Generator<string> {
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (let y = fromYear; y <= toYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const last = m === 2 && leap(y) ? 29 : lengths[m - 1];
      for (let d = 1; d <= last; d++) {
        yield `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }
  }
}

test('civilDate: ida e volta dia a dia de 1900-01-01 a 2100-12-31 contra um calendário independente', () => {
  let expectedOrdinal = toOrdinal('1900-01-01');
  let count = 0;
  for (const day of walkDays(1900, 2100)) {
    assert.equal(toOrdinal(day), expectedOrdinal, `toOrdinal(${day})`);
    assert.equal(fromOrdinal(expectedOrdinal), day, `fromOrdinal(${expectedOrdinal})`);
    expectedOrdinal++;
    count++;
  }
  assert.equal(count, 73414, '201 anos, com 1900 e 2100 não bissextos e 2000 bissexto');
});

test('civilDate: âncoras absolutas do calendário gregoriano proléptico', () => {
  assert.equal(toOrdinal('0001-01-01'), 1);
  assert.equal(toOrdinal('2000-01-01'), 730120);
  assert.equal(fromOrdinal(1), '0001-01-01');
  assert.equal(fromOrdinal(3652059), '9999-12-31');
});

test('civilDate: 29 de fevereiro só existe em ano bissexto (regra dos séculos incluída)', () => {
  assert.doesNotThrow(() => toOrdinal('2028-02-29'));
  assert.doesNotThrow(() => toOrdinal('2000-02-29'));
  assert.throws(() => toOrdinal('2026-02-29'), RangeError);
  assert.throws(() => toOrdinal('1900-02-29'), RangeError);
  assert.throws(() => toOrdinal('2100-02-29'), RangeError);
});

test('civilDate: rejeita tudo que não é data civil AAAA-MM-DD', () => {
  assert.throws(() => toOrdinal(new Date(0) as unknown as string), /nunca é um Date/);
  assert.throws(() => toOrdinal('2026-09-01T00:00:00Z'), RangeError, 'timestamp não é data civil');
  assert.throws(() => toOrdinal('2026-9-1'), RangeError);
  assert.throws(() => toOrdinal('01/09/2026'), RangeError);
  assert.throws(() => toOrdinal('2026-13-01'), RangeError);
  assert.throws(() => toOrdinal('2026-04-31'), RangeError);
  assert.throws(() => toOrdinal('0000-01-01'), RangeError);
  assert.throws(() => toOrdinal(null as unknown as string), TypeError);
  assert.throws(() => toOrdinal(20260901 as unknown as string), TypeError);
});

test('civilDate: fromOrdinal rejeita ordinais fora do calendário suportado', () => {
  assert.throws(() => fromOrdinal(0), RangeError);
  assert.throws(() => fromOrdinal(-5), RangeError);
  assert.throws(() => fromOrdinal(1.5), RangeError);
  assert.throws(() => fromOrdinal(3652060), RangeError);
});
