import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Priora — Self-test OFFLINE do disparo automático (autoSync) e do serviço de
 * enriquecimento. Sem rede e sem Azure: prova as garantias que protegem custo e
 * consistência, que são justamente as que não se vê num teste ao vivo:
 *  - sem conta Microsoft vinculada, a volta termina 'sem_conta' (não quebra, não raspa);
 *  - single-flight: duas chamadas simultâneas = UMA volta;
 *  - enrichOne compartilha a raspagem quando dois pedidos chegam juntos p/ o mesmo BL
 *    (sem isso, botão + disparo automático pagariam duas sessões pelo mesmo dado).
 *
 *   npm run autosync:selftest
 */

// Store isolado num diretório temporário (não suja o .data local) e sem Azure.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'priora-autosync-'));
process.env.DATA_DIR = tmp;
delete process.env.AZURE_CLIENT_ID;
delete process.env.AZURE_CLIENT_SECRET;

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

async function main(): Promise<void> {
  // Import DEPOIS de ajustar o ambiente (config lê process.env na carga).
  const { runAutoSyncOnce, getAutoSyncStatus } = await import('./autoSync');
  const { enrichOne } = await import('./enrichService');

  console.log('[selftest] autoSync sem conta vinculada');
  const a = runAutoSyncOnce();
  const b = runAutoSyncOnce();
  check('single-flight: 2 chamadas simultâneas = a MESMA volta', a === b);
  const run = await a;
  check("outcome 'sem_conta'", run.outcome === 'sem_conta', run.outcome);
  check('mensagem explicando o que fazer', Boolean(run.message && /login/i.test(run.message)), String(run.message));
  check('finishedAt preenchido', Boolean(run.finishedAt));
  check('nenhuma ref raspada', run.scraped === 0 && run.refsFound === 0);

  const st = getAutoSyncStatus();
  check('status expõe a última volta', st.lastRun?.outcome === 'sem_conta');
  check('status não fica preso em "rodando"', st.running === false);
  check('intervalo e teto configurados', st.intervalMin >= 15 && st.maxRefsPerRun >= 1);

  console.log('[selftest] enrichOne compartilha raspagem simultânea do mesmo BL');
  // OOCL está em scrapeBlocked → trackShipment devolve na hora, SEM abrir sessão
  // remota. Serve para exercitar o caminho de raspagem offline. (Era o CMA até
  // 10/10, quando ele passou a ser raspado pela API da Scrapfly.)
  const ref = 'OOLU2335731403';
  const p1 = enrichOne(ref, undefined, true);
  const p2 = enrichOne(ref, undefined, true);
  const [r1, r2] = await Promise.all([p1, p2]);
  check('dois pedidos simultâneos recebem o MESMO resultado (uma raspagem só)', r1 === r2);
  check('resultado não veio do cache (refresh)', r1.cached === false);
  check('armador detectado (OOCL)', r1.carrier.id === 'oocl', r1.carrier.id);

  const r3 = await enrichOne(ref);
  check('3º pedido (sem refresh) sai do cache', r3.cached === true);
  check('organizedByAI vem do registro gravado (não fixo)', r3.organizedByAI === (r1.organizedByAI === true));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('');
  if (fail === 0) {
    console.log(`[selftest] ✅ autoSync + enrichService: ${pass} checagens OK`);
  } else {
    console.log(`[selftest] ❌ autoSync + enrichService: ${fail} falha(s) em ${pass + fail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
