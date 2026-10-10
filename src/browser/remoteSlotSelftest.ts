/**
 * Priora — Self-test OFFLINE das vagas de navegador remoto (remoteSlot).
 * Prova as três garantias que mantêm a instância de pé e os jobs vivos:
 *  - nunca passa do limite de sessões simultâneas (REMOTE_BROWSER_MAX, padrão 1);
 *  - a fila anda em ORDEM DE CHEGADA (ninguém fura a fila na troca de vaga);
 *  - uma raspagem que lança erro LIBERA a vaga (sem travar todo mundo atrás).
 *
 *   npm run remoteslot:selftest
 */
delete process.env.REMOTE_BROWSER_MAX; // garante o padrão (1 vaga)

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { withRemoteSlot, remoteSlotStatus } = await import('./remoteSlot');

  console.log('[selftest] limite de 1 sessão por vez + ordem de chegada');
  let simultaneas = 0;
  let pico = 0;
  const ordem: number[] = [];
  const tarefas = [0, 1, 2, 3, 4].map((i) =>
    withRemoteSlot(async () => {
      simultaneas++;
      pico = Math.max(pico, simultaneas);
      ordem.push(i);
      await sleep(15);
      simultaneas--;
      return i;
    }),
  );
  await sleep(1);
  const st = remoteSlotStatus();
  check('status: 1 vaga, 1 em uso, 4 na fila', st.max === 1 && st.active === 1 && st.queued === 4, JSON.stringify(st));
  const res = await Promise.all(tarefas);
  check('pico de sessões simultâneas = 1', pico === 1, `pico=${pico}`);
  check('fila em ordem de chegada (0,1,2,3,4)', ordem.join(',') === '0,1,2,3,4', ordem.join(','));
  check('cada tarefa devolve o próprio resultado', res.join(',') === '0,1,2,3,4');
  const fim = remoteSlotStatus();
  check('ao final: nada em uso, fila vazia', fim.active === 0 && fim.queued === 0, JSON.stringify(fim));

  console.log('[selftest] erro numa raspagem libera a vaga');
  const quebra = withRemoteSlot(async () => {
    await sleep(5);
    throw new Error('portal caiu');
  });
  const depois = withRemoteSlot(async () => 'seguiu');
  let erroPropagado = false;
  try {
    await quebra;
  } catch (e) {
    erroPropagado = (e as Error).message === 'portal caiu';
  }
  check('o erro chega a quem chamou', erroPropagado);
  check('a próxima da fila roda mesmo assim', (await depois) === 'seguiu');
  const pos = remoteSlotStatus();
  check('vaga devolvida após o erro', pos.active === 0 && pos.queued === 0, JSON.stringify(pos));

  console.log('');
  if (fail === 0) {
    console.log(`[selftest] ✅ remoteSlot: ${pass} checagens OK`);
  } else {
    console.log(`[selftest] ❌ remoteSlot: ${fail} falha(s) em ${pass + fail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
