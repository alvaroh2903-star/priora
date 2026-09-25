import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSchedulerLoop, INTERVALO_PADRAO_MS } from '../scheduler/schedulerLoop';

/** Espera os microtasks/`void run()` pendentes drenarem. */
const drenar = () => new Promise((r) => setImmediate(r));

test('loop: dispara um tick logo no start (recuperação pós-boot), sem bloquear', async () => {
  let ticks = 0;
  const fakeSetInterval = () => 'H' as any; // não auto-dispara no teste
  const loop = startSchedulerLoop({
    // Tick com trabalho assíncrono (como o real): incrementa após um await.
    tick: async () => { await Promise.resolve(); ticks++; },
    runOnStart: true,
    setIntervalImpl: fakeSetInterval,
    clearIntervalImpl: () => {},
  });
  assert.equal(ticks, 0, 'o tick roda em background, não durante o start (não bloqueia o boot)');
  await drenar();
  assert.equal(ticks, 1, 'exatamente um tick logo após o start');
  loop.stop();
});

test('loop: agenda o tick periódico em ~1h e o dispara a cada intervalo', async () => {
  let ticks = 0;
  let intervalFn: (() => void) | null = null;
  let intervalMs = 0;
  const loop = startSchedulerLoop({
    tick: async () => { ticks++; },
    runOnStart: false,
    setIntervalImpl: (fn, ms) => { intervalFn = fn; intervalMs = ms; return 'H' as any; },
    clearIntervalImpl: () => {},
  });
  assert.equal(intervalMs, INTERVALO_PADRAO_MS);
  assert.equal(intervalMs, 60 * 60 * 1000, 'intervalo padrão ~1 hora');
  assert.equal(ticks, 0, 'runOnStart=false → nada no start');
  intervalFn!(); await drenar(); // simula o disparo do timer
  assert.equal(ticks, 1);
  intervalFn!(); await drenar();
  assert.equal(ticks, 2, 'cada disparo do timer roda um tick');
  loop.stop();
});

test('loop: guarda de overlap — dois disparos sobrepostos rodam UM tick só', async () => {
  let iniciados = 0;
  let liberar!: () => void;
  const bloqueio = new Promise<void>((res) => { liberar = res; });
  const loop = startSchedulerLoop({
    tick: async () => { iniciados++; await bloqueio; },
    runOnStart: false,
    setIntervalImpl: () => 'H' as any,
    clearIntervalImpl: () => {},
  });

  const p1 = loop.runNow();
  const p2 = loop.runNow(); // sobreposto → deve ser descartado
  assert.equal(iniciados, 1, 'o segundo disparo foi descartado enquanto o primeiro roda');
  assert.equal(loop.emAndamento(), true);
  liberar();
  await Promise.all([p1, p2]);
  assert.equal(loop.emAndamento(), false);

  await loop.runNow(); // após terminar, um novo disparo roda normalmente
  assert.equal(iniciados, 2);
  loop.stop();
});

test('loop: erro no tick não derruba o processo — vai para onError', async () => {
  const erros: unknown[] = [];
  const loop = startSchedulerLoop({
    tick: async () => { throw new Error('falha simulada'); },
    runOnStart: false,
    onError: (e) => erros.push(e),
    setIntervalImpl: () => 'H' as any,
    clearIntervalImpl: () => {},
  });
  await loop.runNow(); // não deve lançar
  assert.equal(erros.length, 1);
  assert.match((erros[0] as Error).message, /falha simulada/);
  assert.equal(loop.emAndamento(), false, 'a guarda é liberada mesmo após erro');
  loop.stop();
});

test('loop: stop() encerra o timer (clearInterval com o handle correto)', () => {
  const handle = { id: 42 };
  let limpado: unknown = null;
  const loop = startSchedulerLoop({
    tick: async () => {},
    runOnStart: false,
    setIntervalImpl: () => handle as any,
    clearIntervalImpl: (h) => { limpado = h; },
  });
  loop.stop();
  assert.equal(limpado, handle, 'stop limpa exatamente o handle retornado por setInterval');
});
