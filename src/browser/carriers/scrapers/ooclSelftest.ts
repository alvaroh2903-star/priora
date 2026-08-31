import { extractOoclEvents } from './oocl';
import { deriveContainers } from './hapag';

/**
 * Priora — Self-test OFFLINE do parser DEDICADO da OOCL (SCCT pbcontroltower).
 * Puro (sem browser). Usa a estrutura REAL vista ao vivo (B/L 2038860350,
 * contêiner OERU4232132): bloco "Container No. XXXX" + tabela de eventos
 * Event|Time|Location|Stage|Transport Mode. Prova:
 *  - eventos amarrados ao contêiner (pelo cabeçalho mais recente);
 *  - descarga/retirada/devolução classificadas e derivadas certas;
 *  - guarda de assinatura (HTML sem "oocl/pbcontroltower" → vazio).
 *
 *   npm run oocl:selftest
 */

const FIXTURE = `<div class="header"><img alt="OOCL"><span>pbcontroltower</span></div>
<h1>Cargo Tracking : B/L 2038860350</h1>
<div class="container-block">
  <span>Container No. :</span> <b class="cont">OERU4232132</b> <span>40RQ</span>
  <table>
    <thead><tr><th>Event</th><th>Time</th><th>Location</th><th>Stage</th><th>Transport Mode</th></tr></thead>
    <tbody>
      <tr><td>Empty Return</td><td>28 Aug 2026 14:32 BRT</td><td>Lechman Terminais LTDA Navegantes,Santa Catarina, Brazil</td><td>Inbound</td><td>Truck</td></tr>
      <tr><td>Gate Out</td><td>26 Aug 2026 17:06 BRT</td><td>Portonave S.A.-Navegacao Port Tml Navegantes,Santa Catarina, Brazil</td><td>Inbound</td><td>Truck</td></tr>
      <tr><td>Discharged</td><td>18 Aug 2026 05:42 BRT</td><td>Portonave S.A.-Navegacao Port Tml Navegantes</td><td>Ocean</td><td>Vessel</td></tr>
    </tbody>
  </table>
</div>`;

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] extractOoclEvents — tabela de eventos por contêiner');
  const events = extractOoclEvents(FIXTURE);
  console.log('    eventos:', JSON.stringify(events));
  check('3 eventos', events.length === 3, events.length);
  check('todos amarrados a OERU4232132', events.every((e) => e.container === 'OERU4232132'));
  check('Discharged → discharge', events.some((e) => e.status === 'Discharged' && e.type === 'discharge'));
  check('Gate Out → gate_out', events.some((e) => e.status === 'Gate Out' && e.type === 'gate_out'));
  check('Empty Return → empty_return', events.some((e) => e.status === 'Empty Return' && e.type === 'empty_return'));
  const disc = events.find((e) => e.type === 'discharge');
  check('descarga data = 2026-08-18', disc?.date === '2026-08-18', disc?.date);
  check('local capturado (Portonave)', /Portonave/i.test(disc?.location || ''), disc?.location);

  console.log('[selftest] deriveContainers — datas de demurrage');
  const [c] = deriveContainers(events, null);
  console.log('    contêiner:', JSON.stringify(c));
  check('numero = OERU4232132', c?.numero === 'OERU4232132', c?.numero);
  check('descarga = 2026-08-18', c?.dischargeDate === '2026-08-18', c?.dischargeDate);
  check('retirada = 2026-08-26', c?.gateOut === '2026-08-26', c?.gateOut);
  check('devolução = 2026-08-28', c?.emptyReturn === '2026-08-28', c?.emptyReturn);

  console.log('[selftest] guarda de assinatura — HTML não-OOCL → vazio');
  check('sem oocl/pbcontroltower → 0 eventos', extractOoclEvents('<table><tr><td>Discharged</td><td>18 Aug 2026</td></tr></table>').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser OOCL (SCCT pbcontroltower): lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
