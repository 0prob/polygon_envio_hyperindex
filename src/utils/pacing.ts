/**
 * Run an array of async tasks with limited concurrency.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[] | T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (limit <= 1) {
    const results: R[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      results[i] = await fn(items[i], i);
    }
    return results;
  }

  const concurrency = Math.min(limit, items.length);
  const results: R[] = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}
