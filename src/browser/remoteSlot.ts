/**
 * Priora — Vagas de navegador REMOTO (Scrapfly/CDP) no processo inteiro.
 *
 * Numa instância de 512 MB, duas sessões remotas ao mesmo tempo (cada uma
 * coletando páginas de 1–2 MB em vários frames) derrubam o processo — e processo
 * morto é job perdido: foi o que aconteceu com três raspagens disparadas juntas.
 * Agora que há QUATRO origens de raspagem concorrentes (botão, disparo
 * automático, diagnóstico avulso e diagnóstico em lote), cada uma sequencial por
 * dentro mas não entre si, a garantia precisa ser GLOBAL: no máximo N sessões
 * remotas por vez (padrão 1), o resto espera na fila, em ordem de chegada.
 *
 * REMOTE_BROWSER_MAX ajusta N (subir só com instância/plano maiores).
 */

const MAX = Math.max(1, parseInt(process.env.REMOTE_BROWSER_MAX || '1', 10));
let active = 0;
const queue: Array<() => void> = [];

/** Executa `fn` ocupando uma vaga de navegador remoto (espera na fila se lotado). */
export async function withRemoteSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX) {
    // Quem libera a vaga a TRANSFERE direto para cá (ver finally), sem passar
    // por um estado livre — senão um recém-chegado poderia furar a fila.
    await new Promise<void>((resolve) => queue.push(resolve));
  } else {
    active++;
  }
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

/** Ocupação atual (diagnóstico): vagas, em uso e na fila. */
export function remoteSlotStatus() {
  return { max: MAX, active, queued: queue.length };
}
