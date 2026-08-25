/**
 * Bounded-concurrency map. Robinhood Chain RPC rate limits are unbenchmarked
 * (T0.3 is still open), so every fan-out over chain reads goes through here
 * rather than `Promise.all` over an unbounded array.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  })

  await Promise.all(workers)
  return results
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
