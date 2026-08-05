import { calculateDemurrage } from './calculator';
import { getDefaultTariff } from './tariffs';

/**
 * Priora — Self-test da calculadora de demurrage (blueprint §6/§8).
 * Reproduz o exemplo do blueprint e cobre multi-faixa e "dentro do free time".
 *   npm run demurrage:calc
 */

let fails = 0;
const ok = (label: string, cond: boolean, got?: unknown) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (cond ? '' : ` -> ${JSON.stringify(got)}`));
  if (!cond) fails++;
};

// Exemplo do blueprint (§6): descarga 2026-07-20T14:00Z, gate_out 2026-07-28T09:00Z,
// free time 7 -> daysElapsed 8, daysOverdue 1, total 120 (faixa 1-5).
const r1 = calculateDemurrage({
  startDate: '2026-07-20T14:00:00Z',
  returnDate: '2026-07-28T09:00:00Z',
  freeTimeDays: 7,
  tariffTable: getDefaultTariff('maersk'),
});
console.log('[calc] exemplo do blueprint:', JSON.stringify(r1));
ok('daysElapsed = 8', r1.daysElapsed === 8, r1.daysElapsed);
ok('daysOverdue = 1', r1.daysOverdue === 1, r1.daysOverdue);
ok('total = 120', r1.total === 120, r1.total);
ok('currency = USD', r1.currency === 'USD');
ok('breakdown dia 1 = faixa 1-5 @ 120', r1.breakdown[0].tier === '1-5' && r1.breakdown[0].rate === 120, r1.breakdown[0]);

// Multi-faixa: 19 dias corridos, free time 7 -> 12 excedentes.
// 5×120 + 5×180 + 2×250 = 600 + 900 + 500 = 2000.
const r2 = calculateDemurrage({
  startDate: '2026-01-01T00:00:00Z',
  returnDate: '2026-01-20T00:00:00Z',
  freeTimeDays: 7,
  tariffTable: getDefaultTariff(),
});
ok('multi-faixa daysOverdue = 12', r2.daysOverdue === 12, r2.daysOverdue);
ok('multi-faixa total = 2000', r2.total === 2000, r2.total);

// Dentro do free time -> sem custo.
const r3 = calculateDemurrage({
  startDate: '2026-01-01T00:00:00Z',
  returnDate: '2026-01-05T00:00:00Z',
  freeTimeDays: 7,
  tariffTable: getDefaultTariff(),
});
ok('dentro do free time -> total 0', r3.total === 0 && r3.daysOverdue === 0, r3);

console.log(fails === 0 ? '\n[calc] ✅ calculadora de demurrage OK' : `\n[calc] ❌ ${fails} falha(s)`);
process.exit(fails === 0 ? 0 : 1);
