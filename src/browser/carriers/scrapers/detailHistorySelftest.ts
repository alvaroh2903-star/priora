import { extractEventsWithDetails } from './dispatch';
import { extractYangMingDetailEvents, isYangMingDetailPage } from './yangming';
import { deriveContainers } from './hapag';
import { scrapeIntervalMs } from '../../../demurrage/demurrageBotStore';
import { TrackingResult } from '../types';

/**
 * Priora — Self-test OFFLINE do HISTÓRICO COMPLETO por contêiner (páginas de
 * detalhe). O problema que isto cobre: vários portais mostram no resumo só o
 * ÚLTIMO evento de cada contêiner — num BL já devolvido, some a DESCARGA, que é
 * o início da contagem do demurrage. Fixtures tirados das capturas AO VIVO de
 * 10/10/2026:
 *  - Evergreen: popup "Container Move Detail" de EGSU8138081 (HTML real; as 3
 *    primeiras linhas, cortadas no recorte, foram repostas com os dados extraídos
 *    na mesma captura);
 *  - Yang Ming: grade DCSA da página de detalhe de FFAU6989181 (estrutura real
 *    react-aria: rowheader com a data + gridcells).
 *
 *   npm run detailhistory:selftest
 */

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// Resumo da Evergreen: 1 linha por contêiner, só o ÚLTIMO status (o problema).
const EVG_SUMMARY = `<div class="ec-header">ShipmentLink</div>
<a href="https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do">Cargo Tracking</a>
<table>
  <thead><tr><th>Container No.</th><th>Size/Type</th><th>Seal No.</th><th>Service Type</th><th>Quantity</th><th>Method</th><th>VGM</th><th>Current Status</th><th>Date</th></tr></thead>
  <tbody>
    <tr><td><a href="javascript:frmCntrMoveDetail('EGSU8138081');">EGSU8138081</a></td><td>40'(SH)</td><td>EMC1</td><td>FCL/FCL</td><td>1 CARTONS</td><td>1</td><td>20000 KGS</td><td>Empty container returned at SANTOS (BR)</td><td>OCT-02-2026</td></tr>
    <tr><td><a href="javascript:frmCntrMoveDetail('TGBU6521228');">TGBU6521228</a></td><td>40'(SH)</td><td>EMC2</td><td>FCL/FCL</td><td>1 CARTONS</td><td>1</td><td>20000 KGS</td><td>Discharged (FCL) at SANTOS (BR)</td><td>SEP-19-2026</td></tr>
  </tbody>
</table>`;

// Popup "Container Move Detail" de EGSU8138081 — HTML REAL da captura.
const EVG_POPUP = `<html><head><title>ShipmentLink - Cargo Tracking Container Move Detail</title></head><body>
<table><tbody>
<tr><td>Date</td><td>Moves</td><td>Location</td><td>Vessel Voyage</td></tr>
<tr><td>JUL-15-2026</td><td>Empty pick-up by merchant haulage</td><td>QINGDAO, CHINA (CN)</td><td></td></tr>
<tr><td>JUL-15-2026</td><td>Received</td><td>QINGDAO, CHINA (CN)</td><td></td></tr>
<tr><td>JUL-17-2026</td><td>Despatched by truck</td><td>QINGDAO, CHINA (CN)</td><td></td></tr>
<tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">JUL-17-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Received (FCL)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">QINGDAO, CHINA (CN)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap=""></td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">JUL-19-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Loaded (FCL) on vessel</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">QINGDAO, CHINA (CN)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">ITAL UNICA 0842-192S</td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">JUL-25-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Discharged and waiting for transshipping</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">NINGBO, CHINA (CN)(via GUNSAN KOREA)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">ITAL UNICA 0842-192S</td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">JUL-29-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Despatched by truck</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">NINGBO, CHINA (CN)(via GUNSAN KOREA)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap=""></td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">JUL-29-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Received (FCL)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">NINGBO, CHINA (CN)(via GUNSAN KOREA)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap=""></td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">AUG-13-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Loaded (FCL) on vessel</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">NINGBO, CHINA (CN)(via GUNSAN KOREA)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">COSCO SHIPPING RHINE 042W</td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">SEP-19-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Discharged (FCL)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">SANTOS (BR)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">COSCO SHIPPING RHINE 042W</td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">SEP-20-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Full import container received at inland depot</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">SANTOS (BR)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap=""></td> </tr> <tr> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">OCT-02-2026</td> <td align="left" class="#f12rown1 ec-fs-16">Empty container returned</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap="">SANTOS (BR)</td> <td align="center" class="#f12rown1 ec-fs-16" nowrap=""></td> </tr> </tbody></table>
</body></html>`;

// Página de detalhe da Yang Ming — estrutura real (react-aria), dados reais.
const ymRow = (date: string, ev: string, at: string, to = '', mode = '') =>
  `<tr role="row"><td role="rowheader"><span>${date}</span></td><td role="gridcell"><span>${ev}</span></td>` +
  `<td role="gridcell"><div>${at}</div></td><td role="gridcell"><div><span>${to}</span></div></td>` +
  `<td role="gridcell"><div>${mode}</div></td></tr>`;
const YM_DETAIL = `<html><body><a href="/en/esolution/tracking/cargo_tracking_detail?trackNo=FFAU6989181&position=BL_CT&refNo=B240071209"></a>
<div>Container No.<span>FFAU6989181</span><span>40'/HQ(9'6'' container)</span></div>
<div>Container Status [Events compliant with DCSA standard]</div>
<table role="grid"><thead><tr role="row"><th>Date/Time</th><th>Event</th><th>At Facility</th><th>To Facility</th><th>Mode</th></tr></thead><tbody>
${ymRow('2026/09/30 15:07', 'Empty Returned', 'NAVEGANTES - Atlantis Terminais de Containers Vazios')}
${ymRow('2026/09/29 23:51', 'Full to Consignee', 'NAVEGANTES - Portonave S/A . Terminais Portuarios de Navegantes', 'NAVEGANTES (Portonave S/A . Terminais Portuarios de Navegantes)')}
${ymRow('2026/09/25 22:08', 'Discharged', 'NAVEGANTES - Portonave S/A . Terminais Portuarios de Navegantes')}
${ymRow('2026/07/29 13:00', 'On Board', 'QINGDAO - QINGDAO NEW QIANWAN CONTAINER TERMINAL CO.,LTD', 'NAVEGANTES', 'COSCO SHIPPING PERU (009W)')}
${ymRow('2026/07/22 10:00', 'Received at Origin', 'QINGDAO - Qingdao Ganglianyun International Logistics Co.,Ltd.')}
${ymRow('2026/07/20 15:58', 'Empty to Shipper', 'QINGDAO - Qingdao Ganglianyun International Logistics Co.,Ltd.', '-')}
</tbody></table></body></html>`;

console.log('[selftest] Evergreen — resumo SÓ com o último evento (o problema)');
const soResumo = deriveContainers(extractEventsWithDetails(EVG_SUMMARY), null);
const egsuResumo = soResumo.find((c) => c.numero === 'EGSU8138081');
check('sem detalhe: EGSU8138081 fica SEM data de descarga', egsuResumo?.dischargeDate == null, String(egsuResumo?.dischargeDate));

console.log('[selftest] Evergreen — resumo + popup de detalhe');
const evs = extractEventsWithDetails(EVG_SUMMARY, undefined, [{ container: 'EGSU8138081', html: EVG_POPUP }]);
const cs = deriveContainers(evs, null);
const egsu = cs.find((c) => c.numero === 'EGSU8138081');
const tgbu = cs.find((c) => c.numero === 'TGBU6521228');
check('12 eventos do popup atribuídos a EGSU8138081', evs.filter((e) => e.container === 'EGSU8138081').length === 12, String(evs.filter((e) => e.container === 'EGSU8138081').length));
check('descarga = 2026-09-19 em SANTOS (não o transbordo de Ningbo em 07-25)', egsu?.dischargeDate === '2026-09-19', String(egsu?.dischargeDate));
check('retirada = 2026-09-20 (cheio recebido no depósito do interior)', egsu?.gateOut === '2026-09-20', String(egsu?.gateOut));
check('devolução = 2026-10-02', egsu?.emptyReturn === '2026-10-02', String(egsu?.emptyReturn));
check("tipo herdado do resumo (40'(SH))", (evs.find((e) => e.container === 'EGSU8138081')?.tipo || '').includes('40'), String(evs.find((e) => e.container === 'EGSU8138081')?.tipo));
check('contêiner SEM detalhe (TGBU6521228) mantém o evento do resumo', tgbu?.dischargeDate === '2026-09-19', String(tgbu?.dischargeDate));
const tsNingbo = evs.find((e) => /transshipping/i.test(e.status));
check('"Discharged and waiting for transshipping" NÃO conta como descarga', tsNingbo?.type === 'other', String(tsNingbo?.type));

console.log('[selftest] Yang Ming — página de detalhe (histórico DCSA)');
check('assinatura de página de detalhe reconhecida', isYangMingDetailPage(YM_DETAIL));
const ym = extractYangMingDetailEvents(YM_DETAIL, null);
check('6 eventos', ym.length === 6, String(ym.length));
check('contêiner do cabeçalho (FFAU6989181)', ym.every((e) => e.container === 'FFAU6989181'));
check('tipo 40HQ do cabeçalho', ym[0]?.tipo === '40HQ', String(ym[0]?.tipo));
const ymc = deriveContainers(ym, null)[0];
check('descarga = 2026-09-25 (era o que o resumo escondia)', ymc?.dischargeDate === '2026-09-25', String(ymc?.dischargeDate));
check('retirada = 2026-09-29 (Full to Consignee)', ymc?.gateOut === '2026-09-29', String(ymc?.gateOut));
check('devolução = 2026-09-30', ymc?.emptyReturn === '2026-09-30', String(ymc?.emptyReturn));
const onBoard = ym.find((e) => e.status === 'On Board');
check('navio/viagem lidos da coluna Mode', onBoard?.vessel === 'COSCO SHIPPING PERU' && onBoard?.voyage === '009W', `${onBoard?.vessel} / ${onBoard?.voyage}`);
check('"Empty to Shipper" (origem) não vira devolução', ym.find((e) => e.status === 'Empty to Shipper')?.type === 'other');
const ymViaHint = extractYangMingDetailEvents(YM_DETAIL.replace(/Container No\.[\s\S]*?<\/div>/, ''), 'FFAU6989181');
check('sem cabeçalho, usa o contêiner do link (hint)', ymViaHint.length === 6 && ymViaHint.every((e) => e.container === 'FFAU6989181'));

console.log('[selftest] cadência — navio atracou, descarga ainda não');
const H = 3_600_000;
const base = (events: TrackingResult['events'], containers: TrackingResult['containers']): TrackingResult => ({
  carrierId: 'cosco', carrierName: 'COSCO', reference: 'X', referenceType: 'bl', sourceUrl: '', ok: true,
  needsLogin: false, needsCaptcha: false, containers, events, fetchedAt: new Date().toISOString(),
});
const ct = { numero: 'CSNU8710333', tipo: null, status: null, dischargeDate: null, availableDate: null, gateOut: null, emptyReturn: null, lastFreeDay: null };
const ev = (type: 'berth' | 'other', status: string) => ({ date: '2026-10-08', status, location: null, vessel: null, voyage: null, type, container: 'CSNU8710333' });
check('em alto mar → espera de trânsito (72h)', scrapeIntervalMs(base([ev('other', 'Departed')], [ct]), 12 * H, 72 * H) === 72 * H);
check('navio chegou ao destino → ritmo ativo (12h)', scrapeIntervalMs(base([ev('berth', 'Vessel arrived at Last POD')], [ct]), 12 * H, 72 * H) === 12 * H);

console.log('');
if (fail === 0) {
  console.log(`[selftest] ✅ histórico completo por contêiner: ${pass} checagens OK`);
} else {
  console.log(`[selftest] ❌ histórico completo por contêiner: ${fail} falha(s) em ${pass + fail}`);
  process.exit(1);
}
