import { TrackingEvent } from '../types';
import { classifyEvent } from '../eventTypes';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test da NORMALIZAÇÃO de eventos (classifyEvent + deriveContainers)
 * com dados REAIS de Maersk e ONE. Trava dois comportamentos:
 *  - retirada/devolução só contam A PARTIR da descarga no destino (gate-outs de
 *    origem/transbordo não poluem);
 *  - "Vessel Arrival at Port of Discharge" é chegada (berth), não descarga —
 *    a palavra "Discharge" ali é o NOME do porto.
 *
 *   npm run events:selftest
 */

// Constrói um evento aplicando a classificação real (como no pipeline).
const ev = (date: string, status: string, container?: string): TrackingEvent => ({
  date,
  status,
  location: null,
  vessel: null,
  voyage: null,
  type: classifyEvent(status),
  container,
});

// Maersk 274319835 (contêiner TRHU1477661) — timeline real (resumida).
const MAERSK = [
  ev('2026-07-21', 'Gate out Empty', 'TRHU1477661'), // ORIGEM (vazio) → other
  ev('2026-07-25', 'Gate out', 'TRHU1477661'), // ORIGEM (posicionamento) → gate_out
  ev('2026-08-13', 'Discharge', 'TRHU1477661'), // TRANSBORDO (Tanger)
  ev('2026-08-26', 'Discharge', 'TRHU1477661'), // DESTINO (Salvador)
  ev('2026-08-27', 'Gate out for delivery', 'TRHU1477661'), // retirada no destino
];

// ONE ONEYTA6RA1675800 (contêiner OTPU6050252) — timeline real (resumida).
const ONE = [
  ev('2026-06-15', 'Empty Container Release to Shipper', 'OTPU6050252'), // ORIGEM → other
  ev('2026-07-01', 'Unloaded from Vessel at Transshipment Port', 'OTPU6050252'), // transbordo
  ev('2026-08-22', 'Vessel Arrival at Port of Discharge', 'OTPU6050252'), // chegada (berth!)
  ev('2026-08-23', 'Unloaded from Vessel at Port of Discharging', 'OTPU6050252'), // descarga
  ev('2026-08-23', 'Gate Out from Inbound Terminal for Delivery to Consignee', 'OTPU6050252'),
  ev('2026-08-24', 'Empty Container Returned from Customer', 'OTPU6050252'),
];

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] classifyEvent — casos que confundiam');
  check('"Gate out Empty" (origem) → other', classifyEvent('Gate out Empty') === 'other', classifyEvent('Gate out Empty'));
  check('"Empty Container Release to Shipper" → other', classifyEvent('Empty Container Release to Shipper') === 'other');
  check('"Vessel Arrival at Port of Discharge" → berth', classifyEvent('Vessel Arrival at Port of Discharge') === 'berth', classifyEvent('Vessel Arrival at Port of Discharge'));
  check('"Vessel Discharge" → discharge', classifyEvent('Vessel Discharge') === 'discharge');
  check('"Discharged at Last POD" → discharge', classifyEvent('Discharged at Last POD') === 'discharge');
  check('"Gate out for delivery" → gate_out', classifyEvent('Gate out for delivery') === 'gate_out');
  check('"Unloaded from Vessel..." → discharge', classifyEvent('Unloaded from Vessel at Port of Discharging') === 'discharge');

  console.log('[selftest] Maersk — retirada no destino, não na origem');
  const [m] = deriveContainers(MAERSK, null);
  console.log('    contêiner:', JSON.stringify(m));
  check('descarga = 2026-08-26 (Salvador, não Tanger)', m?.dischargeDate === '2026-08-26', m?.dischargeDate);
  check('retirada = 2026-08-27 (destino, não 07-25 origem)', m?.gateOut === '2026-08-27', m?.gateOut);
  check('devolução null (ainda não houve)', m?.emptyReturn === null);

  console.log('[selftest] ONE — chegada vs descarga + devolução');
  const [o] = deriveContainers(ONE, null);
  console.log('    contêiner:', JSON.stringify(o));
  check('descarga = 2026-08-23 (não a chegada 08-22)', o?.dischargeDate === '2026-08-23', o?.dischargeDate);
  check('retirada = 2026-08-23', o?.gateOut === '2026-08-23', o?.gateOut);
  check('devolução = 2026-08-24', o?.emptyReturn === '2026-08-24', o?.emptyReturn);

  console.log('[selftest] robustez — gate-out SÓ de origem, sem descarga no destino');
  const midJourney = [ev('2026-07-25', 'Gate out', 'X'), ev('2026-07-27', 'Gate out', 'X')];
  const [x] = deriveContainers(midJourney, null);
  // Sem descarga (dischargeDate null), o RESUMO manda: mantém a mais recente.
  // (No pipeline real, a contagem de demurrage só começa com dischargeDate.)
  check('sem descarga → dischargeDate null', x?.dischargeDate === null, x?.dischargeDate);

  if (failures === 0) console.log('\n[selftest] ✅ normalização de eventos (Maersk/ONE) OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
