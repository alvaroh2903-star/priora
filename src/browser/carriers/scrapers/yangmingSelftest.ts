import { extractYangMingEvents, ymDateToISO } from './yangming';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser DEDICADO da Yang Ming (tabela "Container
 * Status", grade react-aria). Base: a linha REAL (BMOU6332262, "Empty Returned")
 * + uma 2ª linha FICTÍCIA já "Discharged" para exercitar a descarga.
 *
 *   npm run yangming:selftest
 */

const FIXTURE = `<div>yangming.com</div>
<table><tbody>
  <tr>
    <td><a href="/en/esolution/tracking/cargo_tracking_detail?trackNo=BMOU6332262&refNo=B237020139">BMOU6332262</a></td>
    <td><span>40</span></td>
    <td><span>HQ-9'6'' container</span></td>
    <td><span>YMAW549070</span></td>
    <td><span>FCL/FCL</span></td>
    <td><span>2026/08/25 15:00</span></td>
    <td><span>Empty Returned</span></td>
    <td><div>RIO DE JANEIRO - Rio Brasil Terminal</div></td>
    <td>29350 KGS</td>
  </tr>
  <tr>
    <td><a href="/en/esolution/tracking/cargo_tracking_detail?trackNo=YMLU1234567&refNo=B237020139">YMLU1234567</a></td>
    <td><span>20</span></td>
    <td><span>GP container</span></td>
    <td><span>SEAL0001</span></td>
    <td><span>FCL/FCL</span></td>
    <td><span>2026/08/12 09:30</span></td>
    <td><span>Discharged</span></td>
    <td><div>RIO DE JANEIRO</div></td>
    <td>18000 KGS</td>
  </tr>
</tbody></table>`;

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] ymDateToISO — YYYY/MM/DD [HH:MM]');
  check('2026/08/25 15:00 → 2026-08-25', ymDateToISO('2026/08/25 15:00') === '2026-08-25', ymDateToISO('2026/08/25 15:00'));
  check('sem data → null', ymDateToISO('RIO DE JANEIRO') === null);
  check('mês inválido → null', ymDateToISO('2026/13/01') === null, ymDateToISO('2026/13/01'));

  console.log('[selftest] extractYangMingEvents — tabela Container Status');
  const events = extractYangMingEvents(FIXTURE);
  console.log('    eventos:', JSON.stringify(events.map((e) => `${e.container} ${e.date} ${e.type} ${e.tipo}`)));
  check('2 eventos (1 por contêiner)', events.length === 2, events.length);

  const bm = events.find((e) => e.container === 'BMOU6332262');
  check('BMOU: Empty Returned → empty_return', bm?.type === 'empty_return', bm?.type);
  check('BMOU: data 2026-08-25', bm?.date === '2026-08-25', bm?.date);
  check('BMOU: tipo "40HQ"', bm?.tipo === '40HQ', bm?.tipo);
  check('BMOU: location "RIO DE JANEIRO - Rio Brasil Terminal"', bm?.location === 'RIO DE JANEIRO - Rio Brasil Terminal', bm?.location);

  const ym = events.find((e) => e.container === 'YMLU1234567');
  check('YMLU: Discharged → discharge', ym?.type === 'discharge', ym?.type);
  check('YMLU: tipo "20GP"', ym?.tipo === '20GP', ym?.tipo);

  console.log('[selftest] deriveContainers — datas por contêiner');
  const cs = deriveContainers(events, null);
  check('2 contêineres', cs.length === 2, cs.length);
  check('BMOU emptyReturn 2026-08-25', cs.find((c) => c.numero === 'BMOU6332262')?.emptyReturn === '2026-08-25', cs.find((c) => c.numero === 'BMOU6332262')?.emptyReturn);
  check('YMLU dischargeDate 2026-08-12', cs.find((c) => c.numero === 'YMLU1234567')?.dischargeDate === '2026-08-12', cs.find((c) => c.numero === 'YMLU1234567')?.dischargeDate);

  console.log('[selftest] guarda de assinatura — HTML não-YangMing → vazio');
  check('sem yangming/detail → 0 eventos', extractYangMingEvents('<table><tr><td>BMOU6332262</td><td>2026/08/25</td></tr></table>').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser Yang Ming (Container Status): lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
