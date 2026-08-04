/**
 * Priora — utilitário de concorrência limitada.
 * Roda `fn` sobre `items` com no máximo `limit` execuções em paralelo,
 * preservando a ordem do resultado. Usado para raspar vários BLs sem derrubar
 * o Render nem tomar bloqueio dos portais.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
