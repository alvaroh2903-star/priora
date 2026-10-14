import { readFileSync } from 'fs';
import { join } from 'path';
import { toIsoBrt } from './dates';
import { parseItapoa, extractItapoaToken, itapoaScriptUrls } from './itapoa';
import { parseRioBrasil, extractApimKey, rioBrasilBundleUrl } from './rioBrasil';
import { parseAppa } from './appa';
import { matchVessel, normVessel } from './index';

/**
 * Priora — Self-test OFFLINE do line-up dos PORTOS, com respostas REAIS
 * capturadas em 13–14/10/2026 (src/ports/fixtures, reduzidas):
 *  - Itapoá (JSON da API do site), Rio Brasil (JSON do Azure API Management),
 *    Paranaguá/APPA (tabelas HTML por situação);
 *  - datas → ISO -03:00; status normalizado; nunca inventar (ausente = null);
 *  - leitura do token/chave embutidos nos JS públicos (com valores FALSOS aqui);
 *  - busca de navio por nome/viagem.
 *
 *   npm run ports:selftest
 */

let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}
const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

console.log('[selftest] datas');
check('Itapoá "2026-09-15 05:30:00"', toIsoBrt('2026-09-15 05:30:00') === '2026-09-15T05:30:00-03:00', toIsoBrt('2026-09-15 05:30:00'));
check('Rio Brasil "06/10/26 06:55"', toIsoBrt('06/10/26 06:55') === '2026-10-06T06:55:00-03:00', toIsoBrt('06/10/26 06:55'));
check('APPA "13/10/2026 16:30"', toIsoBrt('13/10/2026 16:30') === '2026-10-13T16:30:00-03:00');
check('só data "13/10/2026"', toIsoBrt('13/10/2026') === '2026-10-13');
check('vazio/inválido → null', toIsoBrt('') === null && toIsoBrt(null) === null && toIsoBrt('31/13/2026 10:00') === null && toIsoBrt('xx') === null);

console.log('[selftest] Itapoá');
const it = parseItapoa(JSON.parse(fx('itapoa.json')));
check('7 escalas', it.length === 7, it.length);
const karun = it.find((c) => c.navio === 'MAERSK KARUN');
check('nome sem a viagem grudada + viagem "638N"', karun?.viagem === '638N' && karun?.viagemTerminal === 'MSKKA638N', karun);
check('DEPARTED → desatracado, com ATB/ATD reais', karun?.status === 'desatracado' && karun?.atb === '2026-09-15T05:30:00-03:00' && karun?.atd === '2026-09-16T04:16:00-03:00', karun);
check('gate e deadline', karun?.aberturaGate === '2026-09-10T04:00:00-03:00' && karun?.deadline === '2026-09-14T12:00:00-03:00');
check('WORKING → atracado', it.filter((c) => c.status === 'atracado').length === 2);
check('INBOUND já chegado → ao_largo', it.some((c) => c.status === 'ao_largo' && c.ata));
const labrea = it.find((c) => c.navio === 'MAERSK LABREA');
check('INBOUND sem chegada → esperado, ATA null (não inventa)', labrea?.status === 'esperado' && labrea?.ata === null, labrea);
check('Itapoá não informa IMO → null', it.every((c) => c.imo === null));

console.log('[selftest] Rio Brasil');
const rb = parseRioBrasil(JSON.parse(fx('riobrasil.json')));
const st = (s: string) => rb.filter((c) => c.status === s).length;
check('8 escalas, 2 por lista', rb.length === 8 && st('esperado') === 2 && st('atracado') === 2 && st('desatracado') === 2 && st('omitido') === 2, rb.map((c) => c.status));
const done = rb.find((c) => c.status === 'desatracado');
check('desatracado tem ATB e ATD reais', Boolean(done?.atb && done?.atd), done);
check('não-desatracado: ATD fica null (portal repete a previsão)', rb.filter((c) => c.status !== 'desatracado').every((c) => c.atd === null));
check('armador e serviço', rb.every((c) => c.armador && c.servico));
check('resposta sem lista → []', parseRioBrasil({}).length === 0 && parseRioBrasil(null).length === 0);

console.log('[selftest] Paranaguá (APPA)');
const ap = parseAppa(fx('appa.html'));
const by = (s: string) => ap.filter((c) => c.status === s);
check('seções lidas: atracado, programado, ao_largo, esperado, desatracado', ['atracado', 'programado', 'ao_largo', 'esperado', 'desatracado'].every((s) => by(s).length > 0), [...new Set(ap.map((c) => c.status))]);
check('apoio portuário e legenda ignorados', !ap.some((c) => /APOIO|LEGENDA/.test(c.situacaoOriginal || '')));
const xiamen = ap.find((c) => c.navio === 'XIAMEN EXPRESS');
check('TCP vem pela APPA (operador "TCP (…)")', /^TCP/.test(xiamen?.terminal || ''), xiamen?.terminal);
check('IMO, agência, berço, ATB e chegada', xiamen?.imo === '9630420' && xiamen?.agencia === 'ROCHAMAR' && xiamen?.berco === '216' && xiamen?.atb === '2026-10-13T16:30:00-03:00' && xiamen?.ata === '2026-10-11T23:06:00-03:00', xiamen);
check('acentos certos (UTF-8)', ap.some((c) => /CONTÊINERES/.test(c.mercadoria || '')));
check('esperado tem ETA', by('esperado').every((c) => c.eta));
check('HTML sem tabelas → []', parseAppa('<html></html>').length === 0);

console.log('[selftest] token/chave embutidos nos JS públicos (valores falsos)');
check('token Bearer do Itapoá', extractItapoaToken("x.setRequestHeader('Authorization','Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJh')") === 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJh');
check('JS sem token → null', extractItapoaToken('var a=1') === null);
const scripts = itapoaScriptUrls('<script src="https://www.portoitapoa.com/wp-includes/js/x.js"></script><script src="https://www.portoitapoa.com/wp-content/cache/min/1/abc.js"></script><script src="https://cdn.x.com/y.js"></script>');
check('JS do site, bundle minificado primeiro, sem terceiros', scripts.length === 1 && scripts[0].includes('/cache/min/'), scripts);
check('chave do Rio Brasil', extractApimKey('headers:{"Content-Type":"application/json","Ocp-Apim-Subscription-Key":"0123456789abcdef0123456789abcdef"}') === '0123456789abcdef0123456789abcdef');
check('bundle do Rio Brasil', rioBrasilBundleUrl('<script defer="defer" src="/static/js/main.766564d7.js"></script>') === 'https://servicosabertosriobrasil.azurewebsites.net/static/js/main.766564d7.js');

console.log('[selftest] busca de navio');
check('nome normalizado', normVessel('Maersk  Karun!') === 'MAERSKKARUN');
check('acha por nome (minúsculo) + viagem', matchVessel(it, 'maersk karun', '638n').length === 1);
check('viagem errada → nada', matchVessel(it, 'maersk karun', '999X').length === 0);
check('viagem pelo código do terminal', matchVessel(it, 'MAERSK KARUN', 'MSKKA638').length === 1);
check('acha na APPA por nome', matchVessel(ap, 'Xiamen Express').length === 1);
check('nome vazio → nada', matchVessel(it, '').length === 0);

if (failures === 0) console.log('\n[selftest] ✅ line-up dos portos (Itapoá, Rio Brasil, APPA) OK');
else {
  console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
  process.exit(1);
}
