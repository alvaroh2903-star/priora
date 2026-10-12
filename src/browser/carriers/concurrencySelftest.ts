import { mapLanes } from './concurrency';

/**
 * Priora — Self-test OFFLINE das PISTAS paralelas (mapLanes) e da escolha de
 * pista por armador (enrichLane):
 *  - as pistas andam ao mesmo tempo, cada uma no seu limite;
 *  - o resultado sai na ordem original;
 *  - CMA/ZIM vão para a pista 'api' só com chave da Scrapfly; o resto, 'browser'.
 *
 *   npm run lanes:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('[selftest] mapLanes');
  const items = ['api1', 'nav1', 'api2', 'api3', 'nav2', 'api4'];
  const active: Record<string, number> = { api: 0, nav: 0 };
  const peak: Record<string, number> = { api: 0, nav: 0 };
  const t0 = Date.now();
  const out = await mapLanes(
    items,
    (s) => s.replace(/\d+$/, ''),
    { api: 3, nav: 1 },
    async (s) => {
      const lane = s.replace(/\d+$/, '');
      active[lane]++;
      peak[lane] = Math.max(peak[lane], active[lane]);
      await sleep(200);
      active[lane]--;
      return s.toUpperCase();
    },
  );
  const ms = Date.now() - t0;
  check('ordem original preservada', JSON.stringify(out) === JSON.stringify(items.map((s) => s.toUpperCase())), out);
  check('pista api: até 3 em paralelo', peak.api === 3, peak);
  check('pista nav: um por vez', peak.nav === 1, peak);
  // Sequencial seriam 6×200 = 1200 ms; com as pistas, ~400 ms (api: 2 ondas; nav: 2).
  check(`pistas simultâneas (${ms} ms < 700)`, ms < 700, ms);

  console.log('[selftest] enrichLane');
  delete process.env.SCRAPFLY_API_KEY;
  delete process.env.SCRAPE_BROWSER_WSS;
  delete process.env.SCRAPE_BROWSER_WSS_HEAVY;
  const { enrichLane } = await import('../../demurrage/enrichService');
  check('sem chave da Scrapfly: CMA vai para o navegador', enrichLane('CMDU1234567') === 'browser');
  process.env.SCRAPFLY_API_KEY = 'teste';
  check('com chave: CMA → api', enrichLane('CMDU1234567') === 'api');
  check('com chave: ZIM → api', enrichLane('ZIMU1234567') === 'api');
  check('com chave: OOCL → navegador', enrichLane('OOLU2335731403') === 'browser');
  check('com chave: MSC → navegador', enrichLane('MSCU1234567') === 'browser');
  delete process.env.SCRAPFLY_API_KEY;

  if (failures === 0) console.log('\n[selftest] ✅ pistas paralelas (API x navegador) OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
