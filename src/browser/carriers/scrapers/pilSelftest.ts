import { extractPilEvents } from './pil';
import { deriveContainers } from './hapag';
import { extractCarrierEvents } from './dispatch';

/**
 * Priora — Self-test OFFLINE do parser da PIL (Container T&T). Puro (sem browser).
 * Usa o DOM REAL capturado ao vivo (BL NNPL50072500, contêiner PCIU9028668):
 *  - HISTÓRICO (Trace → tbody.sub-info-table#container_info_sub_<cont>): timeline
 *    completa → descarga (Navegantes, não o transbordo de Singapura), gate-out,
 *    devolução; "O/B Empty Container Released" (origem) NÃO polui `available`;
 *  - RESUMO (fallback): só o último evento, quando o Trace não carregou.
 *
 *   npm run pil:selftest
 */

// Fixture REAL: resumo (1 linha) + histórico completo (sub-info-table). Copiado
// do HTML renderizado ao vivo (datas/eventos reais do contêiner PCIU9028668).
const FIXTURE_REAL = `<div class="mypil-table"><table class="table">
<thead><tr><td>Container #</td><td>Size/Type</td><td>Movement Type</td><td>Date</td><td>Latest Event</td><td>Place</td></tr></thead>
<tbody><tr><td><b class="cont-numb">PCIU9028668</b> <a class="trackinfo float-right smallest-button" href="javascript:void(0);" name="trackinfo::job::NNPL50072500::PCIU9028668"><b>Trace</b></a></td><td>40HC</td><td>FCL/FCL</td><td>10-Feb-2026 14:29:00</td><td>I/B Empty Container Returned</td><td>NAVEGANTES</td></tr></tbody>
<tbody class="sub-info-table" id="container_info_sub_PCIU9028668">
<tr class="bg-lightblue text-fc-black text-fw-bold"><td class="d-none d-md-block"></td><td>Vessel</td><td>Voyage</td><td>Event Date</td><td>Event Name</td><td>Event Location</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>13-Dec-2025 17:03:00</td><td>O/B Empty Container Released</td><td>QINZHOU</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>15-Dec-2025 19:55:00</td><td>Truck Gate In to O/B Terminal</td><td>QINZHOU</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>KOTA NAZAR</td><td>KNZR0384S</td><td>21-Dec-2025 02:18:00</td><td>Vessel Loading</td><td>QINZHOU</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>KOTA NAZAR</td><td>KNZR0384S</td><td>27-Dec-2025 16:59:00</td><td>Vessel Discharge</td><td>SINGAPORE</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>EVER FIT</td><td>VFIT0024W</td><td>06-Jan-2026 15:33:00</td><td>Vessel Loading</td><td>SINGAPORE</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>EVER FIT</td><td>VFIT0024W</td><td>03-Feb-2026 22:47:00</td><td>Vessel Discharge</td><td>NAVEGANTES</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>10-Feb-2026 09:24:00</td><td>Truck Gate Out from I/B Terminal</td><td>NAVEGANTES</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>10-Feb-2026 14:29:00</td><td>I/B Empty Container Returned</td><td>NAVEGANTES</td></tr>
<tr class="empty-tr"></tr>
</tbody></table></div>`;

// Fixture RESUMO (Trace não carregou): só a tabela de contêiner, sem sub-info-table.
const FIXTURE_SUMMARY = `<div class="mypil-table"><table class="table">
<thead><tr><td>Container #</td><td>Size/Type</td><td>Movement Type</td><td>Date</td><td>Latest Event</td><td>Place</td></tr></thead>
<tbody><tr><td><b class="cont-numb">PCIU9028668</b> <a class="trackinfo" name="trackinfo::job::NNPL50072500::PCIU9028668">Trace</a></td><td>40HC</td><td>FCL/FCL</td><td>10-Feb-2026 14:29:00</td><td>I/B Empty Container Returned</td><td>NAVEGANTES</td></tr></tbody>
</table></div>`;

// Fixture REAL (BL CKXC60038800, contêiner BSIU2861010, capturado em 10/10/2026):
// navio ainda NAVEGANDO para Santos. A descarga em Santos vem com ASTERISCO
// ("* 03-Oct-2026") = previsão vencida que o portal não atualizou; retirada e
// devolução ainda "Information Not Available". E a página traz a lista de navios
// do site — com navios "OOCL …" — que fazia o parser da OOCL roubar a extração.
const FIXTURE_ESTIMADO = `<div class="ss-container"><div class="port-code-options-container"><a class="custom-dd-op" id="OOBR">OOCL BRISBANE</a><a class="custom-dd-op" id="CGTH">CMA CGM THORIUM</a></div></div>
<div class="mypil-table"><table class="table"><thead class="bg-darkblue"><tr><td>Container #</td><td>Size/Type</td><td>Movement Type</td><td>Date</td><td>Latest Event</td><td>Place</td></tr></thead><tbody><tr><td><b class="cont-numb">BSIU2861010</b> <a class="trackinfo float-right smallest-button" href="javascript:void(0);" name="trackinfo::job::CKXC60038800::BSIU2861010"><b>Trace</b></a><span class="loader search-loader hidden" id="search-loaderBSIU2861010"></span></td><td>20GP</td><td>FCL/FCL</td><td>04-Sep-2026 14:29:00</td><td>Vessel Loading</td><td>SHANGHAI</td></tr></tbody>
<tbody class="sub-info-table" id="container_info_sub_BSIU2861010">
<tr class="bg-lightblue text-fc-black text-fw-bold"><td class="d-none d-md-block"></td><td>Vessel</td><td>Voyage</td><td>Event Date</td><td>Event Name</td><td>Event Location</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>05-Aug-2026 11:16:00</td><td>O/B Empty Container Released</td><td>CHONGQING</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>05-Aug-2026 11:17:00</td><td>Truck Gate In to O/B Terminal</td><td>CHONGQING</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>SHANG QING 8</td><td>XSQ82231N</td><td>08-Aug-2026 23:55:00</td><td>Vessel Loading</td><td>CHONGQING</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>SHANG QING 8</td><td>XSQ82231N</td><td>26-Aug-2026 07:07:00</td><td>Vessel Discharge</td><td>SHANGHAI</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>KOTA PAHLAWAN</td><td>KPLW0045W</td><td>04-Sep-2026 14:29:00</td><td>Vessel Loading</td><td>SHANGHAI</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td>KOTA PAHLAWAN</td><td>KPLW0045W</td><td>* 03-Oct-2026 04:00:00</td><td>Vessel Discharge</td><td>SANTOS</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>Information Not Available</td><td>Truck Gate Out from I/B Terminal</td><td>SANTOS</td></tr>
<tr class="bg-lightblue text-fc-black"><td class="d-none d-md-block"></td><td></td><td></td><td>Information Not Available</td><td>I/B Empty Container Returned</td><td>SANTOS</td></tr>
<tr class="empty-tr"></tr></tbody></table></div>
<div class="justify-txt-wrapper"> All fields marked with * are estimated.<br></div>`;

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] extractPilEvents — HISTÓRICO completo (Trace, DOM real)');
  const events = extractPilEvents(FIXTURE_REAL);
  console.log('    eventos:', events.length, JSON.stringify(events.map((e) => `${e.date} ${e.type} ${e.status}`)));
  check('8 eventos da timeline', events.length === 8, events.length);
  check('todos amarrados ao contêiner', events.every((e) => e.container === 'PCIU9028668'));
  check('Vessel Discharge → discharge', events.some((e) => e.status === 'Vessel Discharge' && e.type === 'discharge'));
  check('Truck Gate Out → gate_out', events.some((e) => /Gate Out/i.test(e.status) && e.type === 'gate_out'));
  check('I/B Empty Returned → empty_return', events.some((e) => e.type === 'empty_return'));
  check('O/B Empty Released → other (não available)', events.find((e) => /O\/B Empty Container Released/i.test(e.status))?.type === 'other', events.find((e) => /Released/i.test(e.status))?.type);
  check('captura vessel/voyage (KOTA NAZAR/KNZR0384S)', events.some((e) => e.vessel === 'KOTA NAZAR' && e.voyage === 'KNZR0384S'));

  console.log('[selftest] deriveContainers — datas de demurrage');
  const [c] = deriveContainers(events, null);
  console.log('    contêiner:', JSON.stringify(c));
  check('numero = PCIU9028668', c?.numero === 'PCIU9028668', c?.numero);
  check('tipo = 40HC (do resumo)', c?.tipo === '40HC', c?.tipo);
  check('descarga = 2026-02-03 (Navegantes, não Singapura 27-Dez)', c?.dischargeDate === '2026-02-03', c?.dischargeDate);
  check('gate-out (retirada) = 2026-02-10', c?.gateOut === '2026-02-10', c?.gateOut);
  check('devolução do vazio = 2026-02-10', c?.emptyReturn === '2026-02-10', c?.emptyReturn);
  check('availableDate = null (origem não polui)', c?.availableDate === null, c?.availableDate);
  check('lastFreeDay null (exige login)', c?.lastFreeDay === null);

  console.log('[selftest] extractPilEvents — RESUMO (fallback, sem Trace)');
  const sum = extractPilEvents(FIXTURE_SUMMARY);
  console.log('    eventos:', JSON.stringify(sum));
  check('1 evento (Latest Event)', sum.length === 1, sum.length);
  check('resumo: empty_return + tipo 40HC', sum[0]?.type === 'empty_return' && sum[0]?.tipo === '40HC');

  console.log('[selftest] PIL BSIU2861010 — previsão "*" e página com navios OOCL/CMA');
  const est = extractCarrierEvents(FIXTURE_ESTIMADO);
  console.log('    eventos:', JSON.stringify(est.map((e) => `${e.date} ${e.type} ${e.status} @${e.location}`)));
  check('despachante escolhe a PIL (navio "OOCL …" na página não rouba)', est.length > 0 && est.every((e) => e.container === 'BSIU2861010'), est.map((e) => e.container));
  check('status/local nas colunas certas (nada de "FCL/FCL"/"XSQ82231N")', !est.some((e) => /FCL\/FCL|XSQ82231N|KPLW0045W/.test(e.status)) && est.some((e) => e.status === 'Vessel Loading' && e.location === 'SHANGHAI'));
  check('5 eventos realizados (a descarga "* 03-Oct" é previsão)', est.length === 5, est.length);
  check('vessel/voyage nas colunas certas (KOTA PAHLAWAN/KPLW0045W)', est.some((e) => e.vessel === 'KOTA PAHLAWAN' && e.voyage === 'KPLW0045W'));
  const [b] = deriveContainers(est, null);
  console.log('    contêiner:', JSON.stringify(b));
  check('descarga null: Xangai é transbordo (reembarcou) e Santos é previsão', b?.dischargeDate === null, b?.dischargeDate);
  check('tipo = 20GP (do resumo)', b?.tipo === '20GP', b?.tipo);
  check('retirada/devolução null ("Information Not Available")', b?.gateOut === null && b?.emptyReturn === null);

  console.log('[selftest] guarda de assinatura — HTML não-PIL retorna vazio');
  check('sem trackinfo/container_info_sub → 0 eventos', extractPilEvents('<table><tr><td>PCIU9028668</td><td>2026-02-10</td></tr></table>').length === 0);

  if (failures === 0) {
    console.log('\n[selftest] ✅ parser PIL (Container T&T): histórico + resumo OK');
  } else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
