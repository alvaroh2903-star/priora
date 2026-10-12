import { createLimiter, tokenMatches } from './rateLimit';
import { isAllowedDiagUrl, carrierPortalDomains } from '../browser/carriers/diagUrlPolicy';

/**
 * Priora — Self-test OFFLINE das travas de segurança do diagnóstico:
 *  - limitador por janela (bloqueia acima do teto, libera chaves independentes);
 *  - comparação do token em tempo constante (certo/errado/vazio);
 *  - `?url=` só abre portal de armador (https, domínio do registro ou
 *    DIAG_URL_ALLOW) — nada de site qualquer ou endereço interno.
 *
 *   npm run security:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

console.log('[selftest] limitador');
const lim = createLimiter({ windowMs: 60_000, max: 3 });
const hits = [1, 2, 3, 4].map(() => lim.hit('ip-a').ok);
check('3 passam, a 4ª é barrada', JSON.stringify(hits) === '[true,true,true,false]', hits);
check('Retry-After positivo', lim.hit('ip-a').retryAfterSec > 0);
check('outra chave não é afetada', lim.hit('ip-b').ok);
check('count não consome', lim.count('ip-b') === 1 && lim.count('ip-b') === 1);

console.log('[selftest] token');
check('token certo', tokenMatches('abc-123', 'abc-123'));
check('token errado', !tokenMatches('abc-124', 'abc-123'));
check('prefixo não basta', !tokenMatches('abc', 'abc-123'));
check('esperado vazio nunca casa', !tokenMatches('', ''));

console.log('[selftest] url do diagnóstico');
const doms = carrierPortalDomains();
check('12 domínios de portal', doms.size === 12, [...doms]);
for (const u of [
  'https://www.hapag-lloyd.com/en/online-business/track/track-by-booking-solution.html',
  'https://www.oocl.com/Pages/ExpressLink.aspx?eltype=ct',
  'https://pbcontroltower.digital.oocl.com/scct/public/moc/cargoTracking',
  'https://elines.coscoshipping.com/scct/public/ct/base',
]) {
  check(`libera ${new URL(u).hostname}`, isAllowedDiagUrl(u));
}
for (const u of [
  'https://example.com/',
  'http://www.maersk.com/tracking/1', // sem https
  'https://www.maersk.com.evil.com/', // sufixo enganoso
  'https://evilmaersk.com/',
  'https://169.254.169.254/latest/meta-data/', // metadados da nuvem
  'https://localhost:3000/health/jobs',
  'file:///etc/passwd',
  'não é url',
]) {
  check(`recusa ${u}`, !isAllowedDiagUrl(u));
}
process.env.DIAG_URL_ALLOW = 'httpbin.org, *.example.net';
check('DIAG_URL_ALLOW libera domínio extra', isAllowedDiagUrl('https://httpbin.org/ip'));
check('DIAG_URL_ALLOW aceita *.dominio', isAllowedDiagUrl('https://a.example.net/x'));
delete process.env.DIAG_URL_ALLOW;
check('sem DIAG_URL_ALLOW volta a recusar', !isAllowedDiagUrl('https://httpbin.org/ip'));

if (failures === 0) console.log('\n[selftest] ✅ travas de segurança do diagnóstico OK');
else {
  console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
  process.exit(1);
}
