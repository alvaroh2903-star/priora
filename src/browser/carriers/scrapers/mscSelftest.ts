import { extractMscEvents, mscDateToISO } from './msc';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser DEDICADO da MSC (JSON da API interna).
 * Base: JSON REAL capturado ao vivo (BL MEDUY8275040, em trânsito) + um 2º
 * contêiner FICTÍCIO já ENTREGUE (descarga/retirada/devolução no DESTINO Manaus)
 * para exercitar as datas de demurrage e a guarda de transbordo (Pecem = T/S).
 *
 *   npm run msc:selftest
 */

const FIXTURE = JSON.stringify({
  IsSuccess: true,
  Data: {
    TrackingType: 'Bill Of Lading',
    TrackingNumber: 'MEDUY8275040',
    BillOfLadings: [
      {
        BillOfLadingNumber: 'MEDUY8275040',
        NumberOfContainers: 2,
        GeneralTrackingInfo: {
          PortOfLoad: 'QINGDAO, CN',
          PortOfDischarge: 'MANAUS, BR',
          Transshipments: ['PECEM, BR'],
        },
        ContainersInfo: [
          {
            // Contêiner REAL (em trânsito): só origem + transbordo.
            ContainerNumber: 'MSMU7811290',
            ContainerType: "40' HIGH CUBE",
            PodEtaDate: '12/09/2026',
            Delivered: false,
            Events: [
              { Order: 4, Date: '06/09/2026', Location: 'PECEM, BR', Description: 'Full Transshipment Loaded', Detail: ['NC BRAVO', '028N'] },
              { Order: 3, Date: '25/08/2026', Location: 'PECEM, BR', Description: 'Full Transshipment Discharged', Detail: ['MSC DARIA', 'UX635R'] },
              { Order: 2, Date: '05/07/2026', Location: 'QINGDAO, CN', Description: 'Export Loaded on Vessel', Detail: ['MSC DARIA', 'UX626A'] },
              { Order: 1, Date: '03/07/2026', Location: 'QINGDAO, CN', Description: 'Export received at CY', Detail: ['LADEN'] },
              { Order: 0, Date: '26/06/2026', Location: 'QINGDAO, CN', Description: 'Empty to Shipper', Detail: ['MSC DARIA', 'UX626A'] },
            ],
          },
          {
            // Contêiner FICTÍCIO já ENTREGUE — descarga/retirada/devolução no DESTINO.
            ContainerNumber: 'MEDU1234567',
            ContainerType: "20' DRY",
            PodEtaDate: '10/08/2026',
            Delivered: true,
            Events: [
              { Order: 6, Date: '20/08/2026', Location: 'MANAUS, BR', Description: 'Empty Returned to Depot', Detail: ['EMPTY'] },
              { Order: 5, Date: '15/08/2026', Location: 'MANAUS, BR', Description: 'Import Delivered to Consignee', Detail: ['LADEN'] },
              { Order: 4, Date: '12/08/2026', Location: 'MANAUS, BR', Description: 'Import Discharged from Vessel', Detail: ['MSC DARIA', 'UX635R'] },
              { Order: 3, Date: '25/08/2026', Location: 'PECEM, BR', Description: 'Full Transshipment Discharged', Detail: ['MSC DARIA', 'UX635R'] },
            ],
          },
        ],
      },
    ],
  },
});

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] mscDateToISO — formato DD/MM/YYYY');
  check('06/09/2026 → 2026-09-06', mscDateToISO('06/09/2026') === '2026-09-06', mscDateToISO('06/09/2026'));
  check('25/08/2026 → 2026-08-25', mscDateToISO('25/08/2026') === '2026-08-25');
  check('vazio → null', mscDateToISO('') === null);
  check('mês inválido (13) → null', mscDateToISO('06/13/2026') === null, mscDateToISO('06/13/2026'));

  console.log('[selftest] extractMscEvents — eventos por contêiner');
  const events = extractMscEvents(FIXTURE);
  check('9 eventos no total', events.length === 9, events.length);

  const ld = events.find((e) => e.container === 'MSMU7811290' && e.status === 'Full Transshipment Loaded');
  check('MSMU: data ISO 2026-09-06', ld?.date === '2026-09-06', ld?.date);
  check('MSMU: navio "NC BRAVO", viagem "028N"', ld?.vessel === 'NC BRAVO' && ld?.voyage === '028N', [ld?.vessel, ld?.voyage]);
  check('MSMU: location "PECEM, BR"', ld?.location === 'PECEM, BR', ld?.location);
  check('MSMU: tipo "40\' HIGH CUBE"', ld?.tipo === "40' HIGH CUBE", ld?.tipo);

  const tsDisc = events.find((e) => e.container === 'MSMU7811290' && e.status === 'Full Transshipment Discharged');
  check('Transbordo "Discharged" → other (NÃO discharge)', tsDisc?.type === 'other', tsDisc?.type);
  check('"Export received at CY" → other', events.find((e) => e.status === 'Export received at CY')?.type === 'other');
  check('"Empty to Shipper" → other', events.find((e) => e.status === 'Empty to Shipper')?.type === 'other');

  const impDisc = events.find((e) => e.container === 'MEDU1234567' && e.status === 'Import Discharged from Vessel');
  check('Destino "Import Discharged" → discharge', impDisc?.type === 'discharge', impDisc?.type);
  check('"Import Delivered to Consignee" → gate_out', events.find((e) => e.status === 'Import Delivered to Consignee')?.type === 'gate_out');
  check('"Empty Returned to Depot" → empty_return', events.find((e) => e.status === 'Empty Returned to Depot')?.type === 'empty_return');

  console.log('[selftest] deriveContainers — datas de demurrage por contêiner');
  const cs = deriveContainers(events, null);
  check('2 contêineres', cs.length === 2, cs.length);
  const inTransit = cs.find((c) => c.numero === 'MSMU7811290');
  check('MSMU (em trânsito): dischargeDate null', inTransit?.dischargeDate === null, inTransit?.dischargeDate);
  check('MSMU: emptyReturn null', inTransit?.emptyReturn === null, inTransit?.emptyReturn);
  const delivered = cs.find((c) => c.numero === 'MEDU1234567');
  check('MEDU: dischargeDate 2026-08-12 (destino, não T/S)', delivered?.dischargeDate === '2026-08-12', delivered?.dischargeDate);
  check('MEDU: emptyReturn 2026-08-20', delivered?.emptyReturn === '2026-08-20', delivered?.emptyReturn);

  console.log('[selftest] guarda — JSON inválido / não-MSC → vazio');
  check('JSON inválido → 0 eventos', extractMscEvents('{nope').length === 0);
  check('JSON sem BillOfLadings → 0 eventos', extractMscEvents('{"Data":{}}').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser MSC (JSON da API interna): lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
