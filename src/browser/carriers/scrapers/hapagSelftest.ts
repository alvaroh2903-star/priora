import { withPage, closeBrowser } from '../../browser';
import { CarrierMeta } from '../types';
import { ScrapeContext } from '../scraperTypes';
import { scrapeHapag, parseDateToISO } from './hapag';

/**
 * Priora — Self-test OFFLINE do scraper da Hapag-Lloyd.
 * Carrega um HTML representativo da tabela de resultados via page.setContent()
 * (sem rede) e verifica que os eventos, o gate-out e a devolução do vazio são
 * extraídos corretamente. Prova a LÓGICA de extração; os seletores/consentimento
 * finos são validados num run ao vivo (Render/proxy).
 *
 *   npm run carriers:selftest
 */

// Fixture: estrutura parecida com a página de resultados da Hapag (cabeçalho +
// eventos de importação, com datas em formatos variados). Dados fictícios.
const FIXTURE_HTML = `<!doctype html><meta charset="utf-8"><title>Tracing</title>
<button id="onetrust-accept-btn-handler">Accept All Cookies</button>
<h1>Tracing details for B/L HLCUSHA2606GIPM7</h1>
<table>
  <thead><tr><th>Status</th><th>Location</th><th>Date</th><th>Time</th><th>Transport</th></tr></thead>
  <tbody>
    <tr><td>Vessel departed</td><td>Shanghai, China</td><td>2026-05-13</td><td>14:20</td><td>YM WELLNESS 071W</td></tr>
    <tr><td>Vessel arrived</td><td>Santos, Brazil</td><td>13.06.2026</td><td>08:00</td><td></td></tr>
    <tr><td>Discharged</td><td>Santos, Brazil</td><td>14-Jun-2026</td><td></td><td></td></tr>
    <tr><td>Import loaded on truck for delivery to consignee</td><td>Santos, Brazil</td><td>18/06/2026</td><td></td><td></td></tr>
    <tr><td>Empty container returned to depot</td><td>Santos, Brazil</td><td>25.06.2026</td><td></td><td></td></tr>
  </tbody>
</table>`;

const HAPAG: CarrierMeta = {
  id: 'hapag',
  name: 'Hapag-Lloyd',
  scac: ['HLCU'],
  containerPrefixes: ['HLXU'],
  trackingUrl: 'https://www.hapag-lloyd.com/',
  needsLoginForDemurrage: true,
};

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('[selftest] parseDateToISO');
  check('ISO 2026-05-13', parseDateToISO('2026-05-13 14:20') === '2026-05-13');
  check('13.06.2026 (DD.MM.AAAA)', parseDateToISO('13.06.2026') === '2026-06-13', parseDateToISO('13.06.2026'));
  check('14-Jun-2026', parseDateToISO('14-Jun-2026') === '2026-06-14', parseDateToISO('14-Jun-2026'));
  check('18/06/2026 (DD/MM/AAAA)', parseDateToISO('18/06/2026') === '2026-06-18', parseDateToISO('18/06/2026'));
  check('May 13, 2026', parseDateToISO('May 13, 2026') === '2026-05-13', parseDateToISO('May 13, 2026'));
  check('texto sem data', parseDateToISO('Santos, Brazil') === null);

  console.log('[selftest] scrapeHapag sobre fixture (referência B/L)');
  const outBl = await withPage(async (page) => {
    await page.setContent(FIXTURE_HTML);
    const ctx: ScrapeContext = {
      reference: 'HLCUSHA2606GIPM7',
      referenceType: 'bl',
      carrier: HAPAG,
    };
    return scrapeHapag(page, ctx);
  });

  console.log('    eventos:', JSON.stringify(outBl.events, null, 0));
  console.log('    contêiner:', JSON.stringify(outBl.containers, null, 0));
  check('extraiu 5 eventos', outBl.events?.length === 5, outBl.events?.length);
  check('ok = true', outBl.ok === true);
  check('sem login/captcha', !outBl.needsLogin && !outBl.needsCaptcha);
  check('gate-out (retirada) = 2026-06-18', outBl.containers?.[0]?.gateOut === '2026-06-18', outBl.containers?.[0]?.gateOut);
  check('devolução do vazio = 2026-06-25', outBl.containers?.[0]?.emptyReturn === '2026-06-25', outBl.containers?.[0]?.emptyReturn);
  check('status = último evento', outBl.containers?.[0]?.status === 'Empty container returned to depot', outBl.containers?.[0]?.status);
  check('lastFreeDay null (exige login)', outBl.containers?.[0]?.lastFreeDay === null);
  check('numero null p/ B/L', outBl.containers?.[0]?.numero === null, outBl.containers?.[0]?.numero);
  check('evento tem location', outBl.events?.some((e) => e.location?.includes('Santos')) === true);

  console.log('[selftest] scrapeHapag sobre fixture (referência contêiner)');
  const outCt = await withPage(async (page) => {
    await page.setContent(FIXTURE_HTML);
    const ctx: ScrapeContext = {
      reference: 'HLXU1234567',
      referenceType: 'container',
      carrier: HAPAG,
    };
    return scrapeHapag(page, ctx);
  });
  check('numero = referência do contêiner', outCt.containers?.[0]?.numero === 'HLXU1234567', outCt.containers?.[0]?.numero);

  await closeBrowser();

  if (failures === 0) {
    console.log('\n[selftest] ✅ scraper Hapag-Lloyd: lógica de extração OK');
  } else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('[selftest] erro:', err);
  await closeBrowser().catch(() => undefined);
  process.exit(1);
});
