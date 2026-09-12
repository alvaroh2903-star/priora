import { mergeEvents, saveBotResult, getBotResult, clearAll } from './demurrageBotStore';
import { TrackingResult } from '../browser/carriers';
import { TrackingEvent } from '../browser/carriers/types';

/**
 * Priora — Self-test OFFLINE da acumulação de eventos no store do bot.
 * Prova que raspagens sucessivas (que só mostram o ÚLTIMO evento — Evergreen/Yang
 * Ming) reconstroem o histórico completo: descarga numa raspagem, devolução na
 * seguinte → merge → contêiner com dischargeDate E emptyReturn.
 *
 *   npm run botstore:selftest
 *
 * ATENÇÃO: usa clearAll() — limpa o cache local de resultados do bot (dev/test).
 */

function ev(part: Partial<TrackingEvent>): TrackingEvent {
  return {
    date: null,
    status: '',
    location: null,
    vessel: null,
    voyage: null,
    type: 'other',
    ...part,
  };
}

function result(events: TrackingEvent[], ok = true): TrackingResult {
  return {
    carrierId: 'yangming',
    carrierName: 'Yang Ming',
    reference: 'YMJAB999',
    referenceType: 'bl',
    sourceUrl: 'https://example.test',
    ok,
    needsLogin: false,
    needsCaptcha: false,
    containers: [],
    events,
    fetchedAt: new Date().toISOString(),
  };
}

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

function main(): void {
  console.log('[selftest] mergeEvents — dedupe + acumulação');
  const a = [ev({ container: 'BMOU6332262', date: '2026-08-12', status: 'Discharged', type: 'discharge' })];
  const b = [
    ev({ container: 'BMOU6332262', date: '2026-08-12', status: 'Discharged', type: 'discharge' }), // dup
    ev({ container: 'BMOU6332262', date: '2026-08-25', status: 'Empty Returned', type: 'empty_return' }),
  ];
  const merged = mergeEvents(a, b);
  check('dedupe: 2 eventos (não 3)', merged.length === 2, merged.length);
  check('ordenado por data (descarga antes da devolução)', merged[0].date === '2026-08-12' && merged[1].date === '2026-08-25');

  console.log('[selftest] saveBotResult — acumula entre raspagens e re-deriva contêineres');
  clearAll();
  const ref = 'YMJAB999';
  // Raspagem 1: só a DESCARGA (contêiner ainda no porto).
  saveBotResult(ref, result([ev({ container: 'BMOU6332262', tipo: '40HQ', date: '2026-08-12', status: 'Discharged', type: 'discharge', location: 'RIO DE JANEIRO' })]));
  let rec = getBotResult(ref);
  check('após raspagem 1: dischargeDate 2026-08-12', rec?.result.containers?.[0]?.dischargeDate === '2026-08-12', rec?.result.containers?.[0]);
  check('após raspagem 1: emptyReturn null', rec?.result.containers?.[0]?.emptyReturn === null);

  // Raspagem 2 (dias depois): agora o portal só mostra a DEVOLUÇÃO (último evento).
  saveBotResult(ref, result([ev({ container: 'BMOU6332262', tipo: '40HQ', date: '2026-08-25', status: 'Empty Returned', type: 'empty_return', location: 'RIO DE JANEIRO' })]));
  rec = getBotResult(ref);
  check('após raspagem 2: 2 eventos acumulados', rec?.result.events.length === 2, rec?.result.events.length);
  check('após raspagem 2: dischargeDate PRESERVADO 2026-08-12', rec?.result.containers?.[0]?.dischargeDate === '2026-08-12', rec?.result.containers?.[0]?.dischargeDate);
  check('após raspagem 2: emptyReturn 2026-08-25', rec?.result.containers?.[0]?.emptyReturn === '2026-08-25', rec?.result.containers?.[0]?.emptyReturn);

  console.log('[selftest] saveBotResult — raspagem falha NÃO apaga o histórico');
  saveBotResult(ref, result([], false)); // nova consulta sem eventos e ok=false
  rec = getBotResult(ref);
  check('histórico preservado (2 eventos)', rec?.result.events.length === 2, rec?.result.events.length);
  check('ok=true pelo histórico', rec?.result.ok === true, rec?.result.ok);
  check('dischargeDate ainda 2026-08-12', rec?.result.containers?.[0]?.dischargeDate === '2026-08-12');

  clearAll();

  if (failures === 0) console.log('\n[selftest] ✅ store do bot: acumulação de eventos OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main();
