import { extractCmaEvents } from './cma';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser DEDICADO da CMA CGM. Puro (sem browser).
 * Base: tela real (B/L QGD3084148, contêiner FBIU5227675) + movimentos anteriores
 * (histórico do "Display Previous Moves") p/ exercitar descarga/gate-out. Prova:
 *  - lê a tabela Date|Moves|Location|Vessel, contêiner vindo do cabeçalho;
 *  - "GATE IN EMPTY AT DEPOT" → empty_return (jeito da CMA falar devolução);
 *  - "DISCHARGED"/"GATE OUT FULL" classificados; captura navio/voyage.
 *
 *   npm run cma:selftest
 */

const FIXTURE = `<header><span>CMA CGM</span></header>
<div>Tracking details <b>Container FBIU5227675</b> 45R1 (40RH)</div>
<div>Booking reference <b>QGD3084148</b></div>
<table>
  <thead><tr><th>Date</th><th></th><th>Moves</th><th>Location/Terminal</th><th>Vessel (Voyage)</th></tr></thead>
  <tbody>
    <tr><td>Tuesday, 25-AUG-2026</td><td>09:18 PM</td><td>GATE IN EMPTY AT DEPOT</td><td>PARANAGUA BRPNGDLEC</td><td></td></tr>
    <tr><td>Friday, 22-AUG-2026</td><td>02:00 PM</td><td>GATE OUT FULL FOR DELIVERY</td><td>PARANAGUA</td><td></td></tr>
    <tr><td>Monday, 18-AUG-2026</td><td>05:42 AM</td><td>DISCHARGED</td><td>PARANAGUA TCP</td><td>CMA CGM THORIUM (0BDOKW1MA)</td></tr>
  </tbody>
</table>`;

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] extractCmaEvents — tabela Date|Moves|Location|Vessel');
  const events = extractCmaEvents(FIXTURE);
  console.log('    eventos:', JSON.stringify(events));
  check('3 eventos', events.length === 3, events.length);
  check('todos no contêiner FBIU5227675', events.every((e) => e.container === 'FBIU5227675'));
  check('GATE IN EMPTY AT DEPOT → empty_return', events.some((e) => /GATE IN EMPTY/i.test(e.status) && e.type === 'empty_return'));
  check('GATE OUT FULL → gate_out', events.some((e) => /GATE OUT FULL/i.test(e.status) && e.type === 'gate_out'));
  check('DISCHARGED → discharge', events.some((e) => e.status === 'DISCHARGED' && e.type === 'discharge'));
  const disc = events.find((e) => e.type === 'discharge');
  check('descarga captura navio', disc?.vessel === 'CMA CGM THORIUM', disc?.vessel);
  check('descarga captura voyage', disc?.voyage === '0BDOKW1MA', disc?.voyage);
  check('descarga local = PARANAGUA TCP', disc?.location === 'PARANAGUA TCP', disc?.location);

  console.log('[selftest] deriveContainers — datas de demurrage');
  const [c] = deriveContainers(events, null);
  console.log('    contêiner:', JSON.stringify(c));
  check('numero = FBIU5227675', c?.numero === 'FBIU5227675', c?.numero);
  check('descarga = 2026-08-18', c?.dischargeDate === '2026-08-18', c?.dischargeDate);
  check('retirada = 2026-08-22', c?.gateOut === '2026-08-22', c?.gateOut);
  check('devolução = 2026-08-25', c?.emptyReturn === '2026-08-25', c?.emptyReturn);

  console.log('[selftest] guarda de assinatura — HTML não-CMA → vazio');
  check('sem cma-cgm → 0 eventos', extractCmaEvents('<table><tr><td>DISCHARGED</td><td>18-AUG-2026</td></tr></table>').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser CMA CGM: lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
