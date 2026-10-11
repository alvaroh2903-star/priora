import { readFileSync } from 'fs';
import { join } from 'path';
import { extractOoclEvents, extractOoclStoreEvents } from './oocl';
import { deriveContainers } from './hapag';
import { extractCarrierEvents } from './dispatch';

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

  // Store REAL do app (11/10, B/L 2335731403 pelo ExpressLink): resposta da
  // consulta inteira, 2 contêineres com o histórico completo.
  console.log('[selftest] extractOoclStoreEvents — store do app (JSON real)');
  const store = readFileSync(join(__dirname, '..', 'fixtures', 'oocl-store.json'), 'utf8');
  const se = extractOoclStoreEvents(store);
  check('16 eventos (8 por contêiner)', se.length === 16, se.length);
  check('dispatcher escolhe o store', extractCarrierEvents('<html></html>', store).length === 16);
  const byCnt = (n: string) => se.filter((e) => e.container === n);
  check('CSGU7796499 e CSGU7791100', byCnt('CSGU7796499').length === 8 && byCnt('CSGU7791100').length === 8);
  check('tipo 40HQ', se.every((e) => e.tipo === '40HQ'));
  const sdisc = se.find((e) => e.container === 'CSGU7796499' && e.type === 'discharge');
  check('navio na descarga = COSCO SHIPPING RHINE 042W', sdisc?.vessel === 'COSCO SHIPPING RHINE' && sdisc?.voyage === '042W', sdisc);
  check('Empty Pick Up (origem) NÃO é retirada', se.filter((e) => e.type === 'gate_out').every((e) => /Santos/.test(e.location || '')));
  const cs = deriveContainers(se, null);
  const c1 = cs.find((c) => c.numero === 'CSGU7796499');
  const c2 = cs.find((c) => c.numero === 'CSGU7791100');
  console.log('    contêineres:', JSON.stringify(cs));
  check('CSGU7796499: descarga 19/09, retirada 20/09, devolução 06/10',
    c1?.dischargeDate === '2026-09-19' && c1?.gateOut === '2026-09-20' && c1?.emptyReturn === '2026-10-06', c1);
  check('CSGU7791100: descarga 19/09, retirada 20/09, devolução 06/10',
    c2?.dischargeDate === '2026-09-19' && c2?.gateOut === '2026-09-20' && c2?.emptyReturn === '2026-10-06', c2);
  check('store vazio → 0 eventos', extractOoclStoreEvents('{"ooclStore":{"summaryList":[]}}').length === 0);
  check('JSON inválido → 0 eventos', extractOoclStoreEvents('{nao é json').length === 0);

  console.log('[selftest] tabela "B/L Information" não vira evento');
  const blInfo = '<span>pbcontroltower</span><h2>B/L Information</h2><table><tr><td>2335731403</td><td>Held at 21 Aug 2026 07:55 GMT</td><td>Not Cleared</td><td>COSCO SHIPPING RHINE 042 W</td></tr></table>';
  check('0 eventos da tabela de liberação', extractOoclEvents(blInfo).length === 0, extractOoclEvents(blInfo));

  console.log('[selftest] guarda de assinatura — HTML não-OOCL → vazio');
  check('sem oocl/pbcontroltower → 0 eventos', extractOoclEvents('<table><tr><td>Discharged</td><td>18 Aug 2026</td></tr></table>').length === 0);

  if (failures === 0) console.log('\n[selftest] ✅ parser OOCL (SCCT pbcontroltower): lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
