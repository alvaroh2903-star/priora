import { extractCoscoEvents } from './cosco';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser da COSCO (app SCCT). Puro (sem navegador):
 * roda extractCoscoEvents + deriveContainers sobre um HTML representativo do DOM
 * REAL (capturado ao vivo do deep-link scct/public/ct/base). Prova:
 *  - só as linhas do Transport Detail (com contêiner) viram evento — Schedule
 *    Detail (navios) é ignorado;
 *  - eventos POR contêiner (o BL 6502154060 tem 2: CSNU7761510 e FBLU0140793);
 *  - dedupe quando o Ant duplica a linha (tabela de cabeçalho fixo);
 *  - classificação: Discharged→discharge, Gate Out→gate_out, Empty→empty_return.
 *
 *   npm run cosco:selftest
 */

// Fixture: reproduz a estrutura das duas <table> reais da COSCO. A 1ª linha do
// Transport Detail vem DUPLICADA de propósito (o Ant repete a linha na tabela de
// cabeçalho fixo) para exercitar o dedupe.
const FIXTURE_HTML = `<!doctype html><title>SCCT</title>
<div id="scct">
  <div>Latest Status Discharged at Last POD Happened in Portonave S.A.-Navegacao Port Tml, 2026-08-28 17:42:00</div>
  <div>Transport Detail The current phase is at the Ocean stage</div>
  <table>
    <thead><tr><th>#</th><th>Container#</th><th>Transport Mode</th><th>Traffic Term</th><th>Current Location</th><th>Latest Status</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>CSNU7761510</td><td>Vessel</td><td>CY | CY</td><td>Portonave S.A.-Navegacao Port Tml</td><td>Discharged at Last POD At 2026-08-28 17:42:00</td></tr>
      <tr><td>1</td><td>CSNU7761510</td><td>Vessel</td><td>CY | CY</td><td>Portonave S.A.-Navegacao Port Tml</td><td>Discharged at Last POD At 2026-08-28 17:42:00</td></tr>
      <tr><td>2</td><td>FBLU0140793</td><td>Vessel</td><td>CY | CY</td><td>Portonave S.A.-Navegacao Port Tml</td><td>Discharged at Last POD At 2026-08-28 17:27:00</td></tr>
    </tbody>
  </table>
  <div>Schedule Detail</div>
  <table>
    <thead><tr><th>Vessel</th><th>Service / Voyage</th><th>POL</th><th>Departure Date</th><th>POD</th><th>Arrival Date</th></tr></thead>
    <tbody>
      <tr><td>XINMINGZHOU80</td><td>CF21 26524N</td><td>Fuzhou</td><td>Expected：2026-06-13 06:00:00 Actual：2026-06-13 16:44:00</td><td>Ningbo</td><td>Expected：2026-06-14 18:00:00 Actual：2026-06-14 18:00:00</td></tr>
      <tr><td>COSCO SHIPPING MEXICO</td><td>ESA2 009W</td><td>Ningbo</td><td>Expected：2026-07-20 08:00:00 Actual：2026-07-20 08:58:06</td><td>Navegantes</td><td>Expected：2026-08-27 19:00:00 Actual：2026-08-27 18:13:51</td></tr>
    </tbody>
  </table>
</div>`;

// Fixture 2: um BL mais adiantado — retirada do cheio e devolução do vazio já
// aconteceram (o "Latest Status" de cada contêiner avança com o tempo).
const FIXTURE_ADVANCED = `<div id="scct"><table>
  <tr><th>#</th><th>Container#</th><th>Transport Mode</th><th>Traffic Term</th><th>Current Location</th><th>Latest Status</th></tr>
  <tr><td>1</td><td>CSNU7761510</td><td>Truck</td><td>CY | CY</td><td>Navegantes, BR</td><td>Gate Out for Delivery to Consignee At 2026-09-02 09:15:00</td></tr>
  <tr><td>2</td><td>FBLU0140793</td><td>Truck</td><td>CY | CY</td><td>Itajai Depot</td><td>Empty Container Returned At 2026-09-05 14:00:00</td></tr>
</table></div>`;

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
  console.log('[selftest] extractCoscoEvents — Transport Detail (2 contêineres, descarga)');
  const events = extractCoscoEvents(FIXTURE_HTML);
  console.log('    eventos:', JSON.stringify(events));
  check('2 eventos (1 por contêiner, dedupe do Ant aplicado)', events.length === 2, events.length);
  check('ignora Schedule Detail (nenhum evento de navio)', !events.some((e) => /XINMINGZHOU|COSCO SHIPPING MEXICO/i.test(e.status)));
  check('CSNU7761510 presente', events.some((e) => e.container === 'CSNU7761510'));
  check('FBLU0140793 presente', events.some((e) => e.container === 'FBLU0140793'));
  const csnu = events.find((e) => e.container === 'CSNU7761510');
  check('CSNU data = 2026-08-28', csnu?.date === '2026-08-28', csnu?.date);
  check('CSNU status limpo (sem data)', csnu?.status === 'Discharged at Last POD', csnu?.status);
  check('CSNU type = discharge', csnu?.type === 'discharge', csnu?.type);
  check('CSNU location = terminal', csnu?.location === 'Portonave S.A.-Navegacao Port Tml', csnu?.location);

  console.log('[selftest] deriveContainers — agrupa por contêiner (multi)');
  const containers = deriveContainers(events, 'CSNU7761510');
  console.log('    contêineres:', JSON.stringify(containers));
  check('2 contêineres derivados', containers.length === 2, containers.length);
  const c1 = containers.find((c) => c.numero === 'CSNU7761510');
  const c2 = containers.find((c) => c.numero === 'FBLU0140793');
  check('CSNU dischargeDate = 2026-08-28', c1?.dischargeDate === '2026-08-28', c1?.dischargeDate);
  check('FBLU dischargeDate = 2026-08-28', c2?.dischargeDate === '2026-08-28', c2?.dischargeDate);
  check('gateOut/emptyReturn ainda null (só descarga)', c1?.gateOut === null && c1?.emptyReturn === null);
  check('lastFreeDay null (exige login)', c1?.lastFreeDay === null);

  console.log('[selftest] extractCoscoEvents — BL adiantado (gate_out + empty_return)');
  const adv = extractCoscoEvents(FIXTURE_ADVANCED);
  console.log('    eventos:', JSON.stringify(adv));
  const advC = deriveContainers(adv, null);
  const a1 = advC.find((c) => c.numero === 'CSNU7761510');
  const a2 = advC.find((c) => c.numero === 'FBLU0140793');
  check('gate_out classificado', adv.some((e) => e.type === 'gate_out'), adv.map((e) => e.type));
  check('empty_return classificado', adv.some((e) => e.type === 'empty_return'));
  check('CSNU gateOut = 2026-09-02', a1?.gateOut === '2026-09-02', a1?.gateOut);
  check('FBLU emptyReturn = 2026-09-05', a2?.emptyReturn === '2026-09-05', a2?.emptyReturn);

  console.log('[selftest] guarda de assinatura — HTML não-COSCO retorna vazio');
  check('sem id=scct → 0 eventos', extractCoscoEvents('<table><tr><td>CSNU7761510</td><td>2026-08-28</td></tr></table>').length === 0);

  if (failures === 0) {
    console.log('\n[selftest] ✅ parser COSCO (SCCT): lógica de extração OK');
  } else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
