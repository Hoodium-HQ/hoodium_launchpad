/**
 * Pool price history — 003 R7.
 *
 * The indexer serves a per-pool price series, which is what a range picker needs
 * behind it: a band drawn over the price it is meant to cover reads very
 * differently from the same band drawn over nothing.
 *
 * Cached per pool and duration. The series only gains a point per interval, so
 * re-fetching it on every page view would spend a third-party request to learn
 * nothing.
 */
import { componentLogger } from '../lib/logger.js'
import { GatewayError } from './gateway.js'
import type { Env } from '../config/env.js'

const log = componentLogger('price-history')

const FETCH_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 200

/**
 * Every value the indexer actually accepts. `HOUR` is **not** among them — it
 * fails schema validation rather than returning an empty series, so accepting it
 * here would send a query guaranteed to error.
 *
 * Sampling by duration, measured: DAY and WEEK give a point per hour, MONTH one
 * per four hours, YEAR and MAX one per day. One hour is the floor — anything
 * finer has to come from `Swap` logs (see `swap-candles.ts`).
 */
export const DURATIONS = ['DAY', 'WEEK', 'MONTH', 'YEAR', 'MAX'] as const
export type Duration = (typeof DURATIONS)[number]

export interface PricePoint {
  /** Unix seconds. */
  timestamp: number
  /** token1 per token0 — the same direction the tick encodes. */
  price: number
}

interface GqlPricePoint {
  timestamp?: number
  token0Price?: number
  token1Price?: number
}

const cache = new Map<string, { at: number; points: PricePoint[] }>()

export function resetPriceHistoryCacheForTesting(): void {
  cache.clear()
}

function remember(key: string, points: PricePoint[]): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), points })
}

/**
 * `token1Price` is token1 per token0, matching `1.0001^tick`.
 *
 * Getting this backwards would draw a chart that is the mirror image of the
 * range band over it — visually plausible and completely wrong — so the two are
 * cross-checked against the live tick where they meet.
 */
function mapPoints(raw: GqlPricePoint[]): PricePoint[] {
  return raw
    .map((p) => ({ timestamp: Number(p.timestamp ?? 0), price: Number(p.token1Price ?? Number.NaN) }))
    .filter((p) => p.timestamp > 0 && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
}

export async function fetchPriceHistory(
  env: Env,
  version: 'v3' | 'v4',
  id: string,
  duration: Duration,
): Promise<PricePoint[]> {
  if (!env.UNISWAP_CHAIN_SLUG) throw new GatewayError('market data is not configured for this chain')

  const cacheKey = `${version}:${id.toLowerCase()}:${duration}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.points

  // Separate root fields per version: a v3 pool is addressed by contract, a v4
  // pool by the hash of its key. They are not interchangeable.
  const query =
    version === 'v3'
      ? `query Q($chain: Chain!, $id: String!, $duration: HistoryDuration!) {
           v3Pool(chain: $chain, address: $id) {
             priceHistory(duration: $duration) { timestamp token0Price token1Price }
           }
         }`
      : `query Q($chain: Chain!, $id: String!, $duration: HistoryDuration!) {
           v4Pool(chain: $chain, poolId: $id) {
             priceHistory(duration: $duration) { timestamp token0Price token1Price }
           }
         }`

  let response: Response
  try {
    response = await fetch(env.UNISWAP_GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body: JSON.stringify({
        query,
        variables: { chain: env.UNISWAP_CHAIN_SLUG.toUpperCase(), id, duration },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    throw new GatewayError(`price history unreachable: ${(err as Error).message}`)
  }

  if (!response.ok) throw new GatewayError(`price history HTTP ${response.status}`)

  const body = (await response.json().catch(() => null)) as {
    data?: { v3Pool?: { priceHistory?: GqlPricePoint[] }; v4Pool?: { priceHistory?: GqlPricePoint[] } }
    errors?: Array<{ message?: string }>
  } | null

  if (!body) throw new GatewayError('price history returned a body that is not JSON')
  if (body.errors?.length) {
    log.warn({ version, id, error: body.errors[0]?.message }, 'price history reported an error')
  }

  const raw = (version === 'v3' ? body.data?.v3Pool : body.data?.v4Pool)?.priceHistory
  const points = Array.isArray(raw) ? mapPoints(raw) : []

  // An empty series is cached too: an illiquid pool genuinely has none, and
  // re-asking on every view would spend requests to rediscover that.
  remember(cacheKey, points)
  return points
}
