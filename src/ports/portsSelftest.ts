import { readFileSync } from 'fs';
import { join } from 'path';
import { toIsoBrt } from './dates';
import { parseItapoa, extractItapoaToken, itapoaScriptUrls } from './itapoa';
import { parseRioBrasil, extractApimKey, rioBrasilBundleUrl } from './rioBrasil';
import { parseAppa } from './appa';
import { parseSantosBrasil } from './santosBrasil';
import { parseBtp, btpFormValues } from './btp';
import { parseTeconRioGrande, extractJson } from './teconRioGrande';
import { parseCodeba } from './codeba';
import { matchVessel, normVessel, PORTS } from './index';

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

console.log('[selftest] datas "/Date(ms)/" do .NET (UTC → -03:00)');
check('/Date(1791812160000)/ → 12/10 10:36 BRT (bate com a "PrevisaoChegada" em texto da BTP)', toIsoBrt('/Date(1791812160000)/') === '2026-10-12T10:36:00-03:00', toIsoBrt('/Date(1791812160000)/'));
check('texto com segundos "12/10/2026 10:36:00"', toIsoBrt('12/10/2026 10:36:00') === '2026-10-12T10:36:00-03:00');

console.log('[selftest] Santos Brasil (Tecon Santos)');
const sb = parseSantosBrasil(JSON.parse(fx('santosbrasil.json')), 'tecon-santos');
const sbs = (s: string) => sb.filter((c) => c.status === s).length;
check('6 escalas: 2 desatracadas, 1 atracada, 1 ao largo, 2 esperadas', sb.length === 6 && sbs('desatracado') === 2 && sbs('atracado') === 1 && sbs('ao_largo') === 1 && sbs('esperado') === 2, sb.map((c) => c.status));
check('portId/terminal da unidade', sb.every((c) => c.portId === 'santosbrasil-santos' && /Tecon Santos/.test(c.terminal || '')));
check('viagem sem a repetição ("251N   251N" → "251N")', sb.every((c) => !c.viagem || !/\s/.test(c.viagem)), sb.map((c) => c.viagem));
const sbAtr = sb.find((c) => c.status === 'atracado');
check('atracado: ATB real, sem ATD', Boolean(sbAtr?.atb) && sbAtr?.atd === null, sbAtr);
check('esperado: sem chegada real (não inventa)', sb.filter((c) => c.status === 'esperado').every((c) => c.ata === null && c.atb === null));
check('resposta com Success=false → []', parseSantosBrasil({ Success: false }, 'tecon-santos').length === 0);

console.log('[selftest] BTP');
const bt = parseBtp(JSON.parse(fx('btp.json')));
check('8 escalas lidas', bt.length === 8, bt.length);
check('situação pelas datas reais', bt.filter((c) => c.status === 'atracado').length === 2 && bt.filter((c) => c.status === 'desatracado').length === 2);
const coringa = bt.find((c) => c.navio === 'TBN SANTANA');
check('data-coringa 01/01/2030 vira null (não é previsão)', coringa !== undefined && coringa.eta === null, coringa?.eta);
check('agência, berço e serviço', bt.filter((c) => c.status !== 'esperado').every((c) => c.agencia && c.berco && c.servico));
const form = btpFormValues(fx('btp-form.html'));
check('id e token do formulário', form.id === '999' && form.token === 'TOKEN-FALSO-123', form);
check('formulário sem token → null', btpFormValues('<input id="hdnId" value="1">').token === null);
check('resposta não-OK → []', parseBtp({ Result: 'ERROR' }).length === 0);

console.log('[selftest] Tecon Rio Grande (Navis N4, via Scrapfly)');
const tr = parseTeconRioGrande(JSON.parse(fx('tecon-riogrande.json')));
const trs = (s: string) => tr.filter((c) => c.status === s);
check('6 escalas: 2 esperadas, 1 atracada (50COMPLETE), 2 desatracadas, 1 omitida', tr.length === 6 && trs('esperado').length === 2 && trs('atracado').length === 1 && trs('desatracado').length === 2 && trs('omitido').length === 1, tr.map((c) => c.status));
const fechado = tr.find((c) => c.situacaoOriginal?.includes('70CLOSED'));
check('fechado: chegada à barra, atracação e partida reais', Boolean(fechado?.ata && fechado?.atb && fechado?.atd), fechado);
check('viagem sem o código do navio ("BTD0641N" → "0641N")', tr.every((c) => !c.viagem || !c.viagemTerminal || c.viagemTerminal.endsWith(c.viagem)), tr.map((c) => [c.viagemTerminal, c.viagem]));
check('cancelada não tem atracação/partida real', trs('omitido').every((c) => c.atb === null && c.atd === null));
check('nome sem espaço sobrando ("WIELAND ")', tr.every((c) => c.navio === c.navio.trim()));
check('IMO pelo LloydsId', tr.every((c) => /^\d{7}$/.test(c.imo || '')), tr.map((c) => c.imo));
check('JSON embrulhado em <pre> com &quot;', (extractJson('<html><pre>{&quot;Data&quot;:[]}</pre></html>') as { Data: unknown[] }).Data.length === 0);

console.log('[selftest] Salvador (CODEBA, inclui o Tecon Salvador)');
const sv = parseCodeba(fx('codeba-salvador.html'), 'salvador');
check('esperados e atracados lidos (4 + 3)', sv.filter((c) => c.status === 'esperado').length === 4 && sv.filter((c) => c.status === 'atracado').length === 3, sv.map((c) => c.status));
check('legenda ignorada', !sv.some((c) => /LEGENDA/i.test(c.navio)));
const carolina = sv.find((c) => c.navio === 'MSC CAROLINA');
check('colunas comentadas no HTML não desalinham (agência, berço, operador, carga)', carolina?.agencia === 'MSC MEDITERRANEAN SHIPPING DO BRASIL LTD' && carolina?.berco === 'CAIS SANTA DULCE' && carolina?.terminal === 'TECON SALVADOR S/A' && carolina?.mercadoria === 'CONTEINERES', carolina);
check('ETA com hora, ETD só data', carolina?.eta === '2026-10-12T15:00:00-03:00' && carolina?.etd === '2026-10-14', carolina && [carolina.eta, carolina.etd]);
check('sem datas reais (a página só publica previsões)', sv.every((c) => c.ata === null && c.atb === null && c.atd === null));
check('Tecon Salvador presente', sv.some((c) => c.terminal === 'TECON SALVADOR S/A'));
check('ISO-8859-1 decodificado (Ç/Ã)', new TextDecoder('latin1').decode(Uint8Array.from([0x50, 0x52, 0x4f, 0x47, 0x52, 0x41, 0x4d, 0x41, 0xc7, 0xc3, 0x4f])) === 'PROGRAMAÇÃO');

console.log('[selftest] registro');
check('9 fontes de porto ligadas', PORTS.length === 9, PORTS.map((p) => p.id));
check('ids únicos', new Set(PORTS.map((p) => p.id)).size === PORTS.length);

console.log('[selftest] busca de navio');
check('nome normalizado', normVessel('Maersk  Karun!') === 'MAERSKKARUN');
check('acha por nome (minúsculo) + viagem', matchVessel(it, 'maersk karun', '638n').length === 1);
check('viagem errada → nada', matchVessel(it, 'maersk karun', '999X').length === 0);
check('viagem pelo código do terminal', matchVessel(it, 'MAERSK KARUN', 'MSKKA638').length === 1);
check('acha na APPA por nome', matchVessel(ap, 'Xiamen Express').length === 1);
check('nome vazio → nada', matchVessel(it, '').length === 0);

if (failures === 0) console.log('\n[selftest] ✅ line-up dos portos (Itapoá, Rio Brasil, APPA, Santos Brasil, BTP, Tecon Rio Grande, Salvador) OK');
else {
  console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
  process.exit(1);
}
