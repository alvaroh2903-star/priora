import { cmaQueryCandidates } from './cmacgm';
import { dcsaToTracking } from '../dcsaMapper';
import { hasApiSource } from '../apiSources';

/**
 * Priora — Self-test OFFLINE do cliente da API da CMA CGM (sem rede, sem chave).
 * O payload é montado no FORMATO DCSA Track & Trace (spec pública) — não é uma
 * resposta real da CMA; serve para travar o caminho chave → eventos → datas.
 *
 *   npm run cmaapi:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

const ev = (code: string, date: string, loc: string, cls = 'ACT', empty = 'LADEN') => ({
  eventType: 'EQUIPMENT',
  eventClassifierCode: cls,
  equipmentEventTypeCode: code,
  eventDateTime: `${date}T10:00:00Z`,
  equipmentReference: 'CMAU1234560',
  emptyIndicatorCode: empty,
  eventLocation: { locationName: loc },
});

function main(): void {
  console.log('[selftest] cmaQueryCandidates');
  const bl = cmaQueryCandidates('qgd3293058', 'booking');
  check('BL/booking → tenta transportDocumentReference e carrierBookingReference', bl.length === 2 && bl[0].param === 'transportDocumentReference' && bl[1].param === 'carrierBookingReference');
  check('referência em maiúsculas', bl[0].value === 'QGD3293058');
  const ct = cmaQueryCandidates('CMAU1234560', 'container');
  check('contêiner → equipmentReference', ct.length === 1 && ct[0].param === 'equipmentReference');

  console.log('[selftest] sem CMA_API_KEY → produção não chama a API (segue o fluxo atual)');
  check('hasApiSource("cmacgm") = false sem chave', hasApiSource('cmacgm') === (process.env.CMA_API_KEY ? true : false));

  console.log('[selftest] payload DCSA → datas de demurrage');
  const { events, containers } = dcsaToTracking([
    ev('LOAD', '2026-08-01', 'QINGDAO'),
    ev('DISC', '2026-09-10', 'SANTOS'),
    ev('GTOT', '2026-09-12', 'SANTOS'),
    ev('DROP', '2026-09-20', 'SANTOS', 'ACT', 'EMPTY'),
    ev('DROP', '2026-12-01', 'SANTOS', 'EST', 'EMPTY'), // estimado → fora
  ]);
  const [c] = containers;
  console.log('    contêiner:', JSON.stringify(c));
  check('evento estimado (EST) não entra', events.length === 4, events.length);
  check('descarga 10/09', c?.dischargeDate === '2026-09-10', c?.dischargeDate);
  check('retirada 12/09', c?.gateOut === '2026-09-12', c?.gateOut);
  check('devolução 20/09', c?.emptyReturn === '2026-09-20', c?.emptyReturn);

  if (failures === 0) console.log('\n[selftest] ✅ cliente da API CMA: lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
