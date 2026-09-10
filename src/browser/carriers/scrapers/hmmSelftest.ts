import { extractHmmEvents } from './hmm';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser DEDICADO da HMM. Puro (sem browser).
 * Base: DOM REAL capturado ao vivo (B/L SGNM68262800 / contêiner HMMU5432619),
 * que está EM TRÂNSITO (só eventos de origem/transbordo). Prova:
 *  - lê só a tabela #shipmentProgress (Date|Time|Location|Status|Mode);
 *  - descarga de TRANSBORDO ("Feeder Discharged at T/S Port") NÃO vira discharge
 *    → dischargeDate fica null enquanto não chega ao destino;
 *  - num cenário JÁ ENTREGUE, descarga/retirada/devolução no destino são derivadas.
 *
 *   npm run hmm:selftest
 */

// Cabeçalho + tabela Shipment History reais (em trânsito, só origem/transbordo).
const ROWS_TRANSIT = `
<tr class="clsMoves"><td><div class="text">2026-08-08</div></td><td><div class="text">02:13</div></td><td><div class="text">SINGAPORE</div></td><td><div class="text">Vessel Departure from T/S Port</div></td><td><div class="text">ONE CONTINUITY 0078W</div></td></tr>
<tr class="clsMoves clsPreviousMoves"><td><div class="text">2026-07-23</div></td><td><div class="text">17:49</div></td><td><div class="text">SINGAPORE</div></td><td><div class="text">Feeder Discharged at T/S Port</div></td><td><div class="text">Feeder</div></td></tr>
<tr class="clsMoves clsPreviousMoves"><td><div class="text">2026-07-23</div></td><td><div class="text">13:20</div></td><td><div class="text">SINGAPORE</div></td><td><div class="text">Feeder Arrival at T/S Port</div></td><td><div class="text">Feeder</div></td></tr>
<tr class="clsMoves clsPreviousMoves"><td><div class="text">2026-07-17</div></td><td><div class="text">05:35</div></td><td><div class="text">HOCHIMINH, VIETNAM</div></td><td><div class="text">Export Empty Container Released</div></td><td><div class="text">Truck</div></td></tr>`;

const wrap = (rows: string) =>
  `<div id="scope"><input type="hidden" id="thisCntr" value="HMMU5432619">
   <div class="table-wrap" id="shipmentProgress"><table><thead><tr><th>Date</th><th>Time</th><th>Location</th><th>Status Description</th><th>Mode</th></tr></thead>
   <tbody>${rows}</tbody></table></div></div>`;

const FIXTURE_TRANSIT = wrap(ROWS_TRANSIT);

// Cenário JÁ ENTREGUE: acrescenta descarga/retirada/devolução no DESTINO (Santos).
const FIXTURE_DELIVERED = wrap(
  `<tr class="clsMoves"><td><div class="text">2026-09-20</div></td><td><div class="text">09:00</div></td><td><div class="text">SANTOS, BRAZIL</div></td><td><div class="text">Empty Container Returned</div></td><td><div class="text">Truck</div></td></tr>
   <tr class="clsMoves"><td><div class="text">2026-09-18</div></td><td><div class="text">14:00</div></td><td><div class="text">SANTOS, BRAZIL</div></td><td><div class="text">Import Truck Gate Out from Terminal</div></td><td><div class="text">Truck</div></td></tr>
   <tr class="clsMoves"><td><div class="text">2026-09-15</div></td><td><div class="text">10:00</div></td><td><div class="text">SANTOS, BRAZIL</div></td><td><div class="text">Discharged</div></td><td><div class="text">ONE CONTINUITY 0078W</div></td></tr>` +
    ROWS_TRANSIT,
);

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] HMM em trânsito — transbordo NÃO conta como descarga');
  const t = extractHmmEvents(FIXTURE_TRANSIT);
  console.log('    eventos:', JSON.stringify(t.map((e) => `${e.date} ${e.type} ${e.status}`)));
  check('4 eventos', t.length === 4, t.length);
  check('todos no contêiner HMMU5432619', t.every((e) => e.container === 'HMMU5432619'));
  check('"Feeder Discharged at T/S Port" → other (não discharge)', t.find((e) => /Feeder Discharged/i.test(e.status))?.type === 'other', t.find((e) => /Feeder Discharged/i.test(e.status))?.type);
  check('"Export Empty Container Released" → other', t.find((e) => /Empty Container Released/i.test(e.status))?.type === 'other');
  const [ct] = deriveContainers(t, null);
  console.log('    contêiner:', JSON.stringify(ct));
  check('EM TRÂNSITO: dischargeDate null (transbordo não conta)', ct?.dischargeDate === null, ct?.dischargeDate);
  check('EM TRÂNSITO: gateOut/emptyReturn null', ct?.gateOut === null && ct?.emptyReturn === null);

  console.log('[selftest] HMM entregue — descarga/retirada/devolução no destino');
  const d = extractHmmEvents(FIXTURE_DELIVERED);
  const [cd] = deriveContainers(d, null);
  console.log('    contêiner:', JSON.stringify(cd));
  check('"Discharged" (Santos) → discharge', d.find((e) => e.status === 'Discharged')?.type === 'discharge', d.find((e) => e.status === 'Discharged')?.type);
  check('descarga (destino) = 2026-09-15', cd?.dischargeDate === '2026-09-15', cd?.dischargeDate);
  check('retirada = 2026-09-18', cd?.gateOut === '2026-09-18', cd?.gateOut);
  check('devolução = 2026-09-20', cd?.emptyReturn === '2026-09-20', cd?.emptyReturn);

  console.log('[selftest] guarda de assinatura — HTML não-HMM → vazio');
  check('sem hmm21/shipmentProgress → 0 eventos', extractHmmEvents('<table><tr class="clsMoves"><td>2026-09-15</td></tr></table>').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser HMM: lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
