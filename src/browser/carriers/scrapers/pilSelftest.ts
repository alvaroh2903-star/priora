import { extractPilEvents } from './pil';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser da PIL (Container T&T). Puro (sem browser):
 * roda extractPilEvents + deriveContainers sobre um HTML representativo do DOM
 * REAL (deep-link ?refNo=). Prova:
 *  - só as linhas COM contêiner viram evento (tabela de viagem é ignorada);
 *  - data e status ("Latest Event") em células SEPARADAS são lidos certo;
 *  - captura o tipo (Size/Type = 40HC) e o local (Place);
 *  - classifica: Empty Container Returned→empty_return, Discharged→discharge.
 *
 *   npm run pil:selftest
 */

// Fixture: reproduz a tela real do PIL (BL NNPL50072500) — tabela de VIAGEM
// (sem contêiner) + tabela de CONTÊINER. O 2º contêiner é fictício (ainda na
// descarga) para exercitar multi-contêiner e a classificação de discharge.
const FIXTURE_HTML = `<div id="track-trace">
  <table>
    <tr><th>Arrival/Delivery</th><th>Location</th><th>Vessel/Voyage</th><th>Next Location</th></tr>
    <tr><td>20-Dec-2025 21-Dec-2025</td><td>Load Port QINZHOU CNQZH</td><td>KOTA NAZAR KNZR0384S</td><td>SGSIN 26-Dec-2025</td></tr>
    <tr><td>05-Jan-2026 06-Jan-2026</td><td>Discharge Port SINGAPORE SGSIN</td><td>EVER FIT VFIT0024W</td><td>BRNVT 03-Feb-2026</td></tr>
  </table>
  <table>
    <tr><th>Container #</th><th>Size/Type</th><th>Movement Type</th><th>Date</th><th>Latest Event</th><th>Place</th></tr>
    <tr><td>PCIU9028668 <a class="trackinfo float-right smallest-button" data="trackinfo::job::NNPL50072500::PCIU9028668">Trace</a></td><td>40HC</td><td>FCL/FCL</td><td>10-Feb-2026 14:29:00</td><td>I/B Empty Container Returned</td><td>NAVEGANTES</td></tr>
    <tr><td>TGHU1234567 <a class="trackinfo" data="trackinfo::job::NNPL50072500::TGHU1234567">Trace</a></td><td>20GP</td><td>FCL/FCL</td><td>03-Feb-2026 08:10:00</td><td>I/B Discharged from Vessel</td><td>NAVEGANTES</td></tr>
  </table>
</div>`;

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
  console.log('[selftest] extractPilEvents — tabela de contêiner (resumo)');
  const events = extractPilEvents(FIXTURE_HTML);
  console.log('    eventos:', JSON.stringify(events));
  check('2 eventos (1 por contêiner)', events.length === 2, events.length);
  check('ignora tabela de viagem (sem KOTA NAZAR/EVER FIT)', !events.some((e) => /KOTA NAZAR|EVER FIT/i.test(e.status)));

  const pciu = events.find((e) => e.container === 'PCIU9028668');
  check('PCIU9028668 presente', !!pciu);
  check('PCIU data = 2026-02-10', pciu?.date === '2026-02-10', pciu?.date);
  check('PCIU status = Latest Event (sem data)', pciu?.status === 'I/B Empty Container Returned', pciu?.status);
  check('PCIU type = empty_return', pciu?.type === 'empty_return', pciu?.type);
  check('PCIU tipo = 40HC', pciu?.tipo === '40HC', pciu?.tipo);
  check('PCIU location = NAVEGANTES', pciu?.location === 'NAVEGANTES', pciu?.location);

  const tghu = events.find((e) => e.container === 'TGHU1234567');
  check('TGHU discharge classificado', tghu?.type === 'discharge', tghu?.type);
  check('TGHU data = 2026-02-03', tghu?.date === '2026-02-03', tghu?.date);
  check('TGHU tipo = 20GP', tghu?.tipo === '20GP', tghu?.tipo);

  console.log('[selftest] deriveContainers — multi-contêiner + tipo');
  const containers = deriveContainers(events, null);
  console.log('    contêineres:', JSON.stringify(containers));
  check('2 contêineres', containers.length === 2, containers.length);
  const c1 = containers.find((c) => c.numero === 'PCIU9028668');
  const c2 = containers.find((c) => c.numero === 'TGHU1234567');
  check('PCIU emptyReturn = 2026-02-10', c1?.emptyReturn === '2026-02-10', c1?.emptyReturn);
  check('PCIU tipo propagado = 40HC', c1?.tipo === '40HC', c1?.tipo);
  check('TGHU dischargeDate = 2026-02-03', c2?.dischargeDate === '2026-02-03', c2?.dischargeDate);
  check('lastFreeDay null (exige login)', c1?.lastFreeDay === null);

  console.log('[selftest] guarda de assinatura — HTML não-PIL retorna vazio');
  check('sem trackinfo/container_info_sub → 0 eventos', extractPilEvents('<table><tr><td>PCIU9028668</td><td>2026-02-10</td></tr></table>').length === 0);

  if (failures === 0) {
    console.log('\n[selftest] ✅ parser PIL (Container T&T): lógica de extração OK');
  } else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
