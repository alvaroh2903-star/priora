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

/**
 * PISTAS paralelas: cada item vai para uma pista (`laneOf`), cada pista anda com
 * o SEU limite e todas andam ao mesmo tempo; o resultado sai na ordem original.
 * Ex.: CMA/ZIM pela API da Scrapfly (não usam o navegador remoto) numa pista com
 * 3 em paralelo, e os portais de navegador na outra, um por vez — antes um ZIM
 * esperava atrás de cada OOCL do lote, e vice-versa.
 */
export async function mapLanes<T, R>(
  items: T[],
  laneOf: (item: T) => string,
  limits: Record<string, number>,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  const lanes = new Map<string, number[]>();
  items.forEach((item, i) => {
    const lane = laneOf(item);
    lanes.set(lane, [...(lanes.get(lane) || []), i]);
  });
  await Promise.all(
    [...lanes.entries()].map(([lane, idxs]) =>
      mapLimit(idxs, limits[lane] ?? 1, async (i) => {
        out[i] = await fn(items[i], i);
      }),
    ),
  );
  return out;
}
