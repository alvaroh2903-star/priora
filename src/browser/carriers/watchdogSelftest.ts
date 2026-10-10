import { classifyHealth, overallSeverity, parseSeedEnv, CarrierHealth } from './watchdog';
import { getCarrier } from './registry';
import { CarrierMeta, TrackingResult } from './types';

/**
 * Priora — Self-test OFFLINE da camada 3 (watchdog). Puro (sem navegador/rede):
 * exercita a LÓGICA de classificação de saúde — o ponto que decide se a gente é
 * avisada de uma quebra. Prova cada estado:
 *  - healthy (parser dedicado), degraded_ai (caiu pra IA → cravar parser),
 *  - stale_ref (BL expirado), thin (render magro), broken (investigar),
 *  - captcha, blocked_by_design (scrapeBlocked), no_ref, error;
 *  - mapeamento de gravidade e parseSeedEnv.
 *
 *   npm run watchdog:selftest
 */

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

/** TrackingResult sintético com os campos que a classificação usa. */
function mkResult(over: Partial<TrackingResult>): TrackingResult {
  return {
    carrierId: 'x',
    carrierName: 'X',
    reference: 'REF',
    referenceType: 'bl',
    sourceUrl: 'http://x',
    ok: false,
    needsLogin: false,
    needsCaptcha: false,
    containers: [],
    events: [],
    fetchedAt: new Date().toISOString(),
    ...over,
  };
}

const maersk = getCarrier('maersk') as CarrierMeta;
const cma = getCarrier('cmacgm') as CarrierMeta; // scrapeBlocked
const evt = { date: '2026-08-28', status: 'Discharged', location: null, vessel: null, voyage: null };

function expectHealth(name: string, carrier: CarrierMeta, result: TrackingResult | null, opts: any, want: CarrierHealth) {
  const { health } = classifyHealth(carrier, result, opts);
  check(`${name} => ${want}`, health === want, `veio '${health}'`);
}

console.log('[selftest] classifyHealth');
// Parser dedicado OK.
expectHealth('parser dedicado extraiu', maersk, mkResult({ ok: true, events: [evt] }), {}, 'healthy');
// IA cobrindo (layout mudou).
expectHealth(
  'IA cobriu (organizedByAI)',
  maersk,
  mkResult({ ok: true, events: [evt], organizedByAI: true, aiDiag: { tried: true, rawLen: 12000, events: 1, error: null } }),
  {},
  'degraded_ai',
);
// BL expirado (portal sem dados).
expectHealth(
  'portal "is invalid" => stale_ref',
  maersk,
  mkResult({ ok: false, message: 'Portal respondeu SEM dados: referência inválida/expirada...' }),
  {},
  'stale_ref',
);
expectHealth(
  'portal "no results" => stale_ref',
  maersk,
  mkResult({ ok: false, message: 'No results found for this reference.' }),
  {},
  'stale_ref',
);
// Render magro.
expectHealth(
  'render magro => thin',
  maersk,
  mkResult({ ok: false, raw: 'x'.repeat(800), aiDiag: { tried: true, rawLen: 800, events: 0, error: null } }),
  {},
  'thin',
);
// Página cheia mas parser+IA não extraíram.
expectHealth(
  'renderizou cheio sem evento => broken',
  maersk,
  mkResult({ ok: false, aiDiag: { tried: true, rawLen: 18000, events: 0, error: null } }),
  {},
  'broken',
);
// Captcha.
expectHealth(
  'captcha => captcha',
  maersk,
  mkResult({ ok: false, needsCaptcha: true, message: 'Portal exigiu CAPTCHA...' }),
  {},
  'captcha',
);
// scrapeBlocked (independe do resultado).
expectHealth('scrapeBlocked => blocked_by_design', cma, null, { blocked: true }, 'blocked_by_design');
expectHealth('scrapeBlocked pelo flag do carrier', cma, mkResult({ ok: true, events: [evt] }), {}, 'blocked_by_design');
// Sem referência.
expectHealth('sem canário => no_ref', maersk, null, {}, 'no_ref');
// Exceção.
expectHealth('exceção => error', maersk, null, { error: 'ECONNRESET' }, 'error');

// Guard importante: stale_ref ANTES de thin/broken (mensagem de inválido tem
// prioridade mesmo com rawLen pequeno).
expectHealth(
  'stale tem prioridade sobre thin',
  maersk,
  mkResult({ ok: false, message: 'B/L is invalid', aiDiag: { tried: true, rawLen: 500, events: 0, error: null } }),
  {},
  'stale_ref',
);

console.log('[selftest] gravidade (severity)');
check('healthy => ok', overallSeverity([{ severity: 'ok' }]) === 'ok');
check('warn presente => warn', overallSeverity([{ severity: 'ok' }, { severity: 'warn' }]) === 'warn');
check('fail domina => fail', overallSeverity([{ severity: 'ok' }, { severity: 'warn' }, { severity: 'fail' }]) === 'fail');
check('vazio => ok', overallSeverity([]) === 'ok');

console.log('[selftest] parseSeedEnv');
check('JSON válido', JSON.stringify(parseSeedEnv('{"maersk":"123","msc":" MEDU1 "}')) === JSON.stringify({ maersk: '123', msc: 'MEDU1' }));
check('vazio => {}', JSON.stringify(parseSeedEnv('')) === '{}');
check('JSON inválido => {}', JSON.stringify(parseSeedEnv('{nope')) === '{}');
check('array => {}', JSON.stringify(parseSeedEnv('["a"]')) === '{}');
check('valor não-string ignorado', JSON.stringify(parseSeedEnv('{"maersk":1,"msc":"ok"}')) === JSON.stringify({ msc: 'ok' }));

console.log('');
if (fail === 0) {
  console.log(`[selftest] ✅ watchdog: ${pass} checagens OK`);
} else {
  console.log(`[selftest] ❌ watchdog: ${fail} falha(s) em ${pass + fail} checagens`);
  process.exit(1);
}
