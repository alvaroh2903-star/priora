import { extractEvergreenEvents } from './evergreen';
import { deriveContainers } from './hapag';
import { parseDateToISO } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser DEDICADO da Evergreen (ShipmentLink).
 * Base: tabela real "Container(s) information on B/L" (B/L 010600577145). 1ª linha
 * é o dado REAL (em trânsito, "Loaded"); as outras são cenário JÁ ENTREGUE p/
 * exercitar descarga/devolução + a data MON-DD-YYYY ("SEP-15-2026").
 *
 *   npm run evergreen:selftest
 */

const FIXTURE = `<div class="ec-header">ShipmentLink</div>
<a href="https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do">Cargo Tracking</a>
<table>
  <thead><tr><th>Container No.</th><th>Size/Type</th><th>Seal No.</th><th>Service Type</th><th>Quantity</th><th>Method</th><th>VGM</th><th>Current Status</th><th>Date</th></tr></thead>
  <tbody>
    <tr><td>TGBU6521228</td><td>40'(SH)</td><td>EMCDUP5565</td><td>FCL/FCL</td><td>2,186 CARTONS</td><td>2</td><td>15723 KGS</td><td>Loaded (FCL) on EVER LEADER 0044-080W at NINGBO, CHINA (CN)</td><td>JUL-16-2026</td></tr>
    <tr><td>EISU9876543</td><td>40'(HQ)</td><td>SEAL999</td><td>FCL/FCL</td><td>1,000 CARTONS</td><td>1</td><td>20000 KGS</td><td>Discharged (FCL) at NAVEGANTES</td><td>SEP-15-2026</td></tr>
    <tr><td>EGHU1112223</td><td>20'(GP)</td><td>SEAL111</td><td>FCL/FCL</td><td>500 CARTONS</td><td>1</td><td>10000 KGS</td><td>Empty Returned to Depot at NAVEGANTES</td><td>SEP-20-2026</td></tr>
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
  console.log('[selftest] parseDateToISO — formato MON-DD-YYYY (Evergreen)');
  check('JUL-16-2026 → 2026-07-16', parseDateToISO('JUL-16-2026') === '2026-07-16', parseDateToISO('JUL-16-2026'));
  check('SEP-15-2026 → 2026-09-15', parseDateToISO('SEP-15-2026') === '2026-09-15');
  check('13 May 2026 ainda funciona (DD Mon YYYY)', parseDateToISO('13 May 2026') === '2026-05-13', parseDateToISO('13 May 2026'));

  console.log('[selftest] extractEvergreenEvents — tabela de contêineres');
  const events = extractEvergreenEvents(FIXTURE);
  console.log('    eventos:', JSON.stringify(events.map((e) => `${e.container} ${e.date} ${e.type} ${e.tipo}`)));
  check('3 eventos (1 por contêiner)', events.length === 3, events.length);
  const tg = events.find((e) => e.container === 'TGBU6521228');
  check('TGBU: Loaded → other, data 2026-07-16', tg?.type === 'other' && tg?.date === '2026-07-16', [tg?.type, tg?.date]);
  check('TGBU: tipo 40\'(SH)', tg?.tipo === "40'(SH)", tg?.tipo);
  check('TGBU: vessel "EVER LEADER"', tg?.vessel === 'EVER LEADER', tg?.vessel);
  check('TGBU: voyage "0044-080W"', tg?.voyage === '0044-080W', tg?.voyage);
  check('TGBU: location "NINGBO, CHINA (CN)"', tg?.location === 'NINGBO, CHINA (CN)', tg?.location);
  const eisu = events.find((e) => e.container === 'EISU9876543');
  check('EISU: Discharged → discharge', eisu?.type === 'discharge');
  check('EISU: location "NAVEGANTES" (sem navio)', eisu?.location === 'NAVEGANTES' && eisu?.vessel === null, [eisu?.location, eisu?.vessel]);
  check('EGHU: Empty Returned → empty_return', events.find((e) => e.container === 'EGHU1112223')?.type === 'empty_return');

  console.log('[selftest] deriveContainers — por contêiner');
  const cs = deriveContainers(events, null);
  check('3 contêineres', cs.length === 3, cs.length);
  check('EISU dischargeDate = 2026-09-15', cs.find((c) => c.numero === 'EISU9876543')?.dischargeDate === '2026-09-15', cs.find((c) => c.numero === 'EISU9876543')?.dischargeDate);
  check('EGHU emptyReturn = 2026-09-20', cs.find((c) => c.numero === 'EGHU1112223')?.emptyReturn === '2026-09-20');
  check('TGBU (em trânsito) dischargeDate null', cs.find((c) => c.numero === 'TGBU6521228')?.dischargeDate === null);

  console.log('[selftest] guarda de assinatura — HTML não-Evergreen → vazio');
  check('sem shipmentlink → 0 eventos', extractEvergreenEvents('<table><tr><td>EISU9876543</td><td>SEP-15-2026</td></tr></table>').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser Evergreen (ShipmentLink): lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
