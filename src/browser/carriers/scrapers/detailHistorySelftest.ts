import { extractEventsWithDetails } from './dispatch';
import { extractYangMingDetailEvents, isYangMingDetailPage } from './yangming';
import { deriveContainers } from './hapag';
import { classifyEvent } from '../eventTypes';
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

// Linhas REAIS do resumo da ONE (sem SVG e sem style, de resto intactas).
const ONE_ROW_1 = `<div class="flex"><div role="row" class="Table_tr__oVzeh" data-testid="tnt-cargo-tracking-table-row"><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_booking-number-cell-pinned-alias__rCt2w flex gap-2 3xl:ml-2 2xl:ml-2 w-[172px] xl:w-[208px] 2xl:w-[200px] 3xl:w-[212px]"><div class="TableColumn_checkbox-icon-booking__yGLmw"><input class="CheckBox_input__BUu17" data-cy="checkbox" type="checkbox" id="cop-checkbox-CNBO6706325589" data-testid="tnt-cop-checkbox" value="CNBO6706325589"><div class="CheckBox_checkbox__94fv2 TableColumn_table-cell-checkbox__Zsvbb"></div><div class="relative text-ds-grey-darker-2 cursor-pointer"><span class="absolute -top-44"></span></div><div class="relative flex flex-col flex-1 pl-2"><div class="flex gap-2"><span class="ds-text-body text-ds-grey-darker-1 after:absolute after:w-[0.5px] after:h-[10px] after:top-[7px]">NB6IAM548300</span></div></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_container-number-cell-pinned-alias__iZRGE h-full 3xl:w-[248px] xl:w-[240px] w-[144px]"><div class="flex items-center gap-2"><span class="uppercase text-ds-secondary cursor-pointer"><span class="TextUnderLine_text-underline__8MCal">FCIU9747738 </span></span></div><div class="flex ds-text-body-small text-ds-grey-darker-2 xl:gap-2 xl:flex-row xxs:gap-1 xxs:flex-col"><span class="xl:flex-shrink-0">40'DRY HC.</span><span class="xl:pl-2 xl:border-l">20,763.390 KGS</span></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_place-selector-alias__b0bQj h-full"><div class="TableColumn_place-container__MIThh"><div class="TableColumn_location-name__mJCZC" data-testid="tnt-place-location-name-0">SINGAPORE</div><div class="TableColumn_yard-item__uMEU1" data-testid="tnt-place-yard-name-0"><span class="TextUnderLine_text-underline__8MCal"><span data-testid="tnt-place-information-hyperlink-0" data-ga-cargo-tracking-place-information-popup="true">PSA CORPORATION LIMITED</span> </span></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_event-status-selector-alias__25gMz h-full"><div class="ds-text-body text-ds-grey-darker-1">Departure from Transshipment Port</div><div class="ds-text-body text-ds-grey-darker-1 flex gap-2"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>2026-10-04 </span><div class="EventDate_time-icon__zy1uD"><span>22:40 </span></div></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_pod-vessel-arrival-selector-alias__KNe51"><div>ITAPOA, BRAZIL</div><div class="ds-text-body text-ds-grey-darker-1 flex items-center gap-1"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>2026-10-29 </span><div class="EventDate_time-icon__zy1uD"><span>05:00 </span><div data-headlessui-state=""><span><div class="cursor-pointer"></div></span></div></div></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_seal-selector-alias__k5VXi h-full w-[148px] xl:w-44 3xl:w-50"><div class="TableColumn_seal-item__sRJ9I" data-testid="tnt-seal-no-item-0">********</div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_purchase-order-no-selector-alias__4uBZD h-full 3xl:w-[182px] 2xl:w-[172px] xl:w-[164px] w-[144px]"></div></div></div></div><div role="row" class="Table_tr__oVzeh row-detail-alias "></div>`;
const ONE_ROW_2 = `<div class="flex"><div role="row" class="Table_tr__oVzeh" data-testid="tnt-cargo-tracking-table-row"><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_booking-number-cell-pinned-alias__rCt2w flex gap-2 3xl:ml-2 2xl:ml-2 w-[172px] xl:w-[208px] 2xl:w-[200px] 3xl:w-[212px]"><div class="TableColumn_checkbox-icon-booking__yGLmw"><input class="CheckBox_input__BUu17" data-cy="checkbox" type="checkbox" id="cop-checkbox-CNBO6706325313" data-testid="tnt-cop-checkbox" value="CNBO6706325313"><div class="CheckBox_checkbox__94fv2 TableColumn_table-cell-checkbox__Zsvbb"></div><div class="relative text-ds-grey-darker-2 cursor-pointer"><span class="absolute -top-44"></span></div><div class="relative flex flex-col flex-1 pl-2"><div class="flex gap-2"><span class="ds-text-body text-ds-grey-darker-1 after:absolute after:w-[0.5px] after:h-[10px] after:top-[7px]">NB6IAM548300</span></div></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_container-number-cell-pinned-alias__iZRGE h-full 3xl:w-[248px] xl:w-[240px] w-[144px]"><div class="flex items-center gap-2"><span class="uppercase text-ds-secondary cursor-pointer"><span class="TextUnderLine_text-underline__8MCal">ONEU4374427 </span></span></div><div class="flex ds-text-body-small text-ds-grey-darker-2 xl:gap-2 xl:flex-row xxs:gap-1 xxs:flex-col"><span class="xl:flex-shrink-0">40'DRY HC.</span><span class="xl:pl-2 xl:border-l">19,767.700 KGS</span></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_place-selector-alias__b0bQj h-full"><div class="TableColumn_place-container__MIThh"><div class="TableColumn_location-name__mJCZC" data-testid="tnt-place-location-name-1">SINGAPORE</div><div class="TableColumn_yard-item__uMEU1" data-testid="tnt-place-yard-name-1"><span class="TextUnderLine_text-underline__8MCal"><span data-testid="tnt-place-information-hyperlink-1" data-ga-cargo-tracking-place-information-popup="true">PSA CORPORATION LIMITED</span> </span></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_event-status-selector-alias__25gMz h-full"><div class="ds-text-body text-ds-grey-darker-1">Departure from Transshipment Port</div><div class="ds-text-body text-ds-grey-darker-1 flex gap-2"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>2026-10-04 </span><div class="EventDate_time-icon__zy1uD"><span>22:40 </span></div></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_pod-vessel-arrival-selector-alias__KNe51"><div>ITAPOA, BRAZIL</div><div class="ds-text-body text-ds-grey-darker-1 flex items-center gap-1"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>2026-10-29 </span><div class="EventDate_time-icon__zy1uD"><span>05:00 </span><div data-headlessui-state=""><span><div class="cursor-pointer"></div></span></div></div></div></div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_seal-selector-alias__k5VXi h-full w-[148px] xl:w-44 3xl:w-50"><div class="TableColumn_seal-item__sRJ9I" data-testid="tnt-seal-no-item-0">********</div></div></div><div role="cell" class="Table_td__ildVm"><div class="TableColumn_cell-default-content__agj3A Table_purchase-order-no-selector-alias__4uBZD h-full 3xl:w-[182px] 2xl:w-[172px] xl:w-[164px] w-[144px]"></div></div></div></div><div role="row" class="Table_tr__oVzeh row-detail-alias "></div>`;
// Histórico REAL de FCIU9747738 (EventTable; ícones de data preservados).
const ONE_DETAIL_FCIU = `<table class="EventTable_table-container__Qioyi"><tr data-testid="tnt-cop-event-row" class="EventTable_border-line-transparent__zxr19 EventTable_table-row__yVKnA"><td class="EventTable_table-col-relative__keAE6 EventTable_logout__PsWHJ EventTable_padding-top-row__1p891 EventTable_padding-bottom-row__eJzG4"><div class="EventTable_country-terminal__UuBQc"><div class="EventTable_country-name__fax8l text-ds-grey-darker-1">NINGBO, ZHEJIANG, CHINA</div><span class="TextUnderLine_text-underline__8MCal"><span class="EventTable_terminal-name__5cbvF" data-ga-cargo-tracking-place-information-popup="true">NINGBO DAXIE CONTAINER TERMINAL CO., LTD.</span> </span></div><div class="EventProgressBar_bottom-line__LLnDj border-primary"></div><div class="EventProgressBar_icon-container__uzQvw"><div class="EventProgressBar_icon__L5WPm"><div class="EventProgressBar_start-icon__6_fB1"></div></div></div></td><td class="EventTable_table-col__Da66I"><div class="EventTable_cop-event-details__Og6pM EventTable_padding-top-row__1p891 EventTable_padding-bottom-row__eJzG4"><div class="EventTable_event-name-vessel-group__sDbkT"><div class="text-ds-grey-darker-1" data-testid="tnt-cop-event-name">Empty Container Release to Shipper</div></div><div class="EventTable_actual-estimate-schedule__dlQ1t"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>2026-08-16 </span><div class="EventDate_time-icon__zy1uD"><span>17:32 </span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" rx="8" fill="#00506D"></rect><path d="M10.9652 12.0002H12.7992L9.04519 3.2002H6.95325L3.19922 12.0002H5.03325L5.73534 10.3114H10.2631L10.9652 12.0002ZM7.99922 4.50634L9.79026 8.95252H6.20817L7.99922 4.50634Z" fill="white"></path></svg></div></div></div><div class="EventTable_alert-container__WJP_i EventTable_logout__PsWHJ"><div class="AlertList_alert-list__HMvgw EventTable_alert-list-lg__UPYNg"></div></div></div></td></tr><tr data-testid="tnt-cop-event-row" class="EventTable_border-line__mBVBY EventTable_table-row__yVKnA"><td class="EventTable_table-col-relative__keAE6 EventTable_logout__PsWHJ EventTable_padding-top-row__1p891 EventTable_padding-bottom-row__eJzG4"><div class="EventTable_country-terminal__UuBQc absolute"><span class="TextUnderLine_text-underline__8MCal"><span class="EventTable_terminal-name__5cbvF" data-ga-cargo-tracking-place-information-popup="true">NINGBO BEILUN INTL CONTAINER TERMINAL</span> </span></div><div class="EventProgressBar_top-line__HsJuF border-primary"></div><div class="EventProgressBar_bottom-line__LLnDj border-primary"></div><div class="EventProgressBar_icon-container__uzQvw"><div class="EventProgressBar_icon__L5WPm"><div><svg width="7" height="5" viewBox="0 0 7 5" fill="none" xmlns="http://www.w3.org/2000/svg" color="#BD0F72"><path d="M4 6L0 0H7L4 5Z" fill="currentColor"></path></svg></div><div class="EventProgressBar_transport-icon__n2ASt"></div></div></div></td><td class="EventTable_table-col__Da66I"><div class="EventTable_cop-event-details__Og6pM EventTable_padding-top-row__1p891 EventTable_padding-bottom-cell__3Tupd"><div class="EventTable_event-name-vessel-group__sDbkT"><div class="text-ds-grey-darker-1" data-testid="tnt-cop-event-name">Gate In to Outbound Terminal</div></div><div class="EventTable_actual-estimate-schedule__dlQ1t"><div class="EventDate_event-date-container__dLSip text-ds-grey-darker-1"><span>2026-08-25 </span><div class="EventDate_time-icon__zy1uD"><span>18:03 </span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16" rx="8" fill="#00506D"></rect><path d="M10.9652 12.0002H12.7992L9.04519 3.2002H6.95325L3.19922 12.0002H5.03325L5.73534 10.3114H10.2631L10.9652 12.0002ZM7.99922 4.50634L9.79026 8.95252H6.20817L7.99922 4.50634Z" fill="white"></path></svg></div></div></div><div class="EventTable_alert-container__WJP_i EventTable_logout__PsWHJ"><div class="AlertList_alert-list__HMvgw EventTable_alert-list-lg__UPYNg"></div></div></div></td></tr></table>`;

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

console.log('[selftest] Maersk — eventos REAIS (274142590 / MRSU2327730, layout antigo, 10/10/2026)');
const mk = (date: string, status: string, location: string, vessel: string | null = null) => ({
  date, status, location, vessel, voyage: null, type: classifyEvent(status), container: 'MRSU2327730',
});
const MAERSK_REAL = [
  mk('2026-07-23', 'Gate out Empty', 'Antwerp'),
  mk('2026-07-24', 'Gate in', 'ANTWERP'),
  mk('2026-07-27', 'Load', 'ANTWERP', 'MAERSK LANCO'),
  mk('2026-07-28', 'Vessel departure', 'ANTWERP', 'MAERSK LANCO'),
  mk('2026-08-01', 'Vessel arrival', 'PORT TANGIER MEDITERRANEE', 'MAERSK LANCO'),
  mk('2026-08-01', 'Discharge', 'PORT TANGIER MEDITERRANEE', 'MAERSK LANCO'),
  mk('2026-08-02', 'Load', 'PORT TANGIER MEDITERRANEE', 'MAERSK LEON'),
  mk('2026-08-03', 'Vessel departure', 'PORT TANGIER MEDITERRANEE', 'MAERSK LEON'),
  mk('2026-08-23', 'Vessel arrival', 'ITAPOA', 'MAERSK LEON'),
  mk('2026-08-24', 'Discharge', 'ITAPOA', 'MAERSK LEON'),
  mk('2026-08-29', 'Gate out for delivery', 'ITAPOA'),
  mk('2026-08-31', 'Empty container return', 'Itapoa'),
];
const mkc = deriveContainers(MAERSK_REAL, null)[0];
check('BL completo: descarga = 2026-08-24 (Itapoá, destino)', mkc?.dischargeDate === '2026-08-24', String(mkc?.dischargeDate));
check('retirada = 2026-08-29', mkc?.gateOut === '2026-08-29', String(mkc?.gateOut));
check('devolução = 2026-08-31', mkc?.emptyReturn === '2026-08-31', String(mkc?.emptyReturn));
// O cenário perigoso: o BL ainda NAVEGANDO de Tânger para o Brasil. A Maersk
// escreve só "Discharge" em Tânger (sem a palavra transbordo).
const emTransito = MAERSK_REAL.filter((e) => e.date <= '2026-08-03');
const tc = deriveContainers(emTransito, null)[0];
check('navegando após Tânger: descarga de transbordo NÃO inicia a contagem', tc?.dischargeDate == null, String(tc?.dischargeDate));
check('navegando após Tânger: segue em espera de trânsito (72h)', scrapeIntervalMs(base(emTransito, [{ ...ct, numero: 'MRSU2327730' }]), 12 * H, 72 * H) === 72 * H);
const atracado = MAERSK_REAL.filter((e) => e.date <= '2026-08-23');
check('navio atracou em Itapoá (sem nova partida): ritmo ativo (12h)', scrapeIntervalMs(base(atracado, [{ ...ct, numero: 'MRSU2327730' }]), 12 * H, 72 * H) === 12 * H);
// Entrega no interior por trem depois da descarga NÃO é transbordo.
const comTrem = [...MAERSK_REAL.slice(0, 10), mk('2026-08-25', 'Load on rail', 'ITAPOA'), mk('2026-08-27', 'Gate out for delivery', 'JOINVILLE')];
check('"Load on rail" após a descarga não cancela a descarga', deriveContainers(comTrem, null)[0]?.dischargeDate === '2026-08-24', String(deriveContainers(comTrem, null)[0]?.dischargeDate));

// --- ONE (site novo, www.one-line.com): RESUMO real do BL NB6IAM548300 (2
// contêineres, capturado em 10/10) + histórico de FCIU9747738 (linhas reais do
// EventTable, ícone "A" = realizado). O resumo traz só o último evento; a coluna
// "POD/ Vessel Arrival" (29/10) é ETA — previsão, não pode virar evento. ---
console.log('[selftest] ONE — resumo do site novo (2 contêineres) + histórico por clique');
const ONE_SUMMARY = `<div role="rowgroup" class="Table_body__JrCVh">${ONE_ROW_1}${ONE_ROW_2}</div>`;
const oneSum = extractEventsWithDetails(ONE_SUMMARY);
console.log('    resumo:', JSON.stringify(oneSum.map((e) => `${e.container} ${e.date} ${e.type} ${e.status} @${e.location} [${e.tipo}]`)));
check('resumo: 1 evento por contêiner (FCIU9747738 e ONEU4374427)', oneSum.length === 2 && oneSum.some((e) => e.container === 'FCIU9747738') && oneSum.some((e) => e.container === 'ONEU4374427'), String(oneSum.length));
check('resumo: último evento "Departure from Transshipment Port" em 04/10, Singapura', oneSum.every((e) => e.date === '2026-10-04' && e.status === 'Departure from Transshipment Port' && e.location === 'SINGAPORE'));
check('resumo: saída do transbordo é `other` (não retirada)', oneSum.every((e) => e.type === 'other'));
check('resumo: tipo 40\'DRY HC do resumo', oneSum.every((e) => e.tipo === "40'DRY HC"), String(oneSum[0]?.tipo));
check('resumo: ETA 29/10 do POD não vira evento', !oneSum.some((e) => e.date === '2026-10-29'));
const oneMerged = extractEventsWithDetails(ONE_SUMMARY, undefined, [{ container: 'FCIU9747738', html: `<html><body>${ONE_DETAIL_FCIU}</body></html>` }]);
console.log('    com detalhe:', JSON.stringify(oneMerged.map((e) => `${e.container} ${e.date} ${e.status}`)));
check('detalhe: FCIU9747738 ganha o histórico (eventos herdam o nº)', oneMerged.filter((e) => e.container === 'FCIU9747738').length === 2 && oneMerged.some((e) => e.container === 'FCIU9747738' && e.status === 'Empty Container Release to Shipper'));
check('detalhe: ONEU4374427 (sem detalhe) segue com o evento do resumo', oneMerged.some((e) => e.container === 'ONEU4374427' && e.date === '2026-10-04'));
check('detalhe: o tipo do resumo passa para os eventos do histórico', oneMerged.filter((e) => e.container === 'FCIU9747738').every((e) => e.tipo === "40'DRY HC"));

console.log('');
if (fail === 0) {
  console.log(`[selftest] ✅ histórico completo por contêiner: ${pass} checagens OK`);
} else {
  console.log(`[selftest] ❌ histórico completo por contêiner: ${fail} falha(s) em ${pass + fail}`);
  process.exit(1);
}
