/**
 * Laço in-process do scheduler (revisão 13 — acionamento aprovado).
 *
 * Roda dentro do Web Service existente (Render Starter, pago e sempre ativo):
 * um disparo logo após o boot + um tick a cada ~1h. NÃO cria serviço novo, NÃO
 * bloqueia o boot nem as requisições HTTP (o tick roda em background), e o claim
 * em PostgreSQL continua sendo a proteção DEFINITIVA contra duplicidade — este
 * laço só adiciona uma guarda LOCAL barata contra overlap no mesmo processo.
 *
 * Módulo puro/injetável de propósito: não importa Express, Graph nem o pool. A
 * aplicação injeta o `tick` (runSchedulerOnce + processar entregas). Assim o
 * comportamento do laço (dispara no start, periódico, sem overlap, encerra
 * limpo) é testável de forma determinística com timers/relógios fakes.
 */

export const INTERVALO_PADRAO_MS = 60 * 60 * 1000; // ~1 hora

export interface SchedulerLoopOptions {
  /** O trabalho de um tick (runSchedulerOnce + processar entregas pendentes). */
  tick: () => Promise<void>;
  /** Intervalo entre ticks (default ~1h). */
  intervalMs?: number;
  /** Disparar um tick logo após iniciar (recuperação pós-deploy/restart). Default true. */
  runOnStart?: boolean;
  /** Tratador de erro do tick — nunca deixa uma rejeição derrubar o processo. */
  onError?: (err: unknown) => void;
  /** Injeção para teste: setInterval/clearInterval. Default: globais. */
  setIntervalImpl?: (fn: () => void, ms: number) => any;
  clearIntervalImpl?: (handle: any) => void;
}

export interface SchedulerLoopHandle {
  /** Dispara um tick agora (respeitando a guarda de overlap). */
  runNow: () => Promise<void>;
  /** Para o laço (clearInterval). Um tick em andamento termina sozinho. */
  stop: () => void;
  /** true enquanto um tick está em execução (guarda de overlap). */
  emAndamento: () => boolean;
}

/**
 * Cria um executor que IGNORA disparos sobrepostos: se um tick ainda está
 * rodando, o próximo disparo é descartado (o claim no banco já garante que nada
 * duplica de verdade; localmente só evitamos trabalho redundante). Toda exceção
 * é capturada e roteada para onError — nunca vira unhandled rejection.
 */
function criarExecutorSemOverlap(tick: () => Promise<void>, onError?: (e: unknown) => void) {
  let rodando = false;
  const run = async (): Promise<void> => {
    if (rodando) return; // overlap local: descarta o disparo redundante
    rodando = true;
    try {
      await tick();
    } catch (err) {
      if (onError) onError(err);
      else console.error('[demurrage-scheduler] erro no tick:', err);
    } finally {
      rodando = false;
    }
  };
  return { run, emAndamento: () => rodando };
}

/**
 * Inicia o laço: (opcional) um tick imediato em background + um tick periódico.
 * Retorna um handle com `stop()` para o shutdown limpo.
 */
export function startSchedulerLoop(opts: SchedulerLoopOptions): SchedulerLoopHandle {
  const intervalMs = opts.intervalMs ?? INTERVALO_PADRAO_MS;
  const runOnStart = opts.runOnStart ?? true;
  const setIntervalFn = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalImpl ?? ((h) => clearInterval(h));

  const executor = criarExecutorSemOverlap(opts.tick, opts.onError);

  // Tick periódico. O `void` + catch garantem que nada derruba o processo.
  const handle = setIntervalFn(() => {
    void executor.run();
  }, intervalMs);

  // Disparo pós-boot: NÃO bloqueia o boot — roda em background. Se um deploy/
  // restart aconteceu durante uma janela prevista, a janela vencida é recuperada
  // agora, sem esperar mais uma hora inteira (o claim evita duplicar).
  if (runOnStart) void executor.run();

  return {
    runNow: () => executor.run(),
    stop: () => clearIntervalFn(handle),
    emAndamento: executor.emAndamento,
  };
}
