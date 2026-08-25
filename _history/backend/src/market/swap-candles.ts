/**
 * Candles from `Swap` events — 003 R7.
 *
 * The indexer's price series samples hourly and offers nothing finer: `HOUR` is
 * not even a valid duration, and there is no five- or fifteen-minute value.
 * Candles built from it are aggregations of samples, so their wicks understate
 * the real range.
 *
 * Swap logs carry the pool's `tick` at the moment of every trade, which is the
 * price. Bucketing those gives **true** open/high/low/close — the extremes are
 * trades that happened, not the highest sample we happened to take.
 *
 * Measured on this chain: blocks land every 0.1s, so an hour is ~36k blocks and
 * a busy pool sees ~65 swaps in that time. A 6-hour window returned 885 logs in
 * under a second. That is what makes this practical, and also why the window is
 * capped — a week would be 6M blocks.
 */
import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem'
import { componentLogger } from '../lib/logger.js'
import type { Env } from '../config/env.js'

const log = componentLogger('swap-candles')

const RPC_TIMEOUT_MS = 30_000
/** Beyond this the log query gets slow enough to be worse than coarser candles. */
const MAX_WINDOW_HOURS = 24
const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 100
/** Falls back to this if block timing cannot be measured. */
const FALLBACK_BLOCKS_PER_HOUR = 36_000
/** Widest span this RPC answers reliably; 12h times out, 24h rate-limits. */
const CHUNK_HOURS = 3
const CHUNK_RETRIES = 2
const RETRY_BASE_MS = 700

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

/** Retry with backoff — the failures here are timeouts and 429s, both transient. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === CHUNK_RETRIES) {
        log.warn({ err: (err as Error).message.split('\n')[0] }, 'swap log chunk failed, skipping')
        return null
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt)
    }
  }
  return null
}

export const INTERVALS = { '15m': 900, '1h': 3600, '4h': 14_400 } as const
export type CandleInterval = keyof typeof INTERVALS

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Trades in the bucket. Zero is impossible; a bucket with none is absent. */
  trades: number
  /**
   * Traded volume in whole token1 units.
   *
   * A float, like the prices beside it, because a charting library takes
   * `number` — the same concession `ExposureChart` documents. It is a bar
   * height, never quoted back as an exact figure.
   */
  volume: number
}

const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)
const V4_SWAP = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
)

const cache = new Map<string, { at: number; candles: Candle[] }>()

export function resetSwapCandleCacheForTesting(): void {
  cache.clear()
}

let client: PublicClient | null = null
let clientUrl: string | null = null

function marketClient(env: Env): PublicClient {
  const url = env.MARKET_RPC_URL ?? env.RPC_PRIMARY
  if (client && clientUrl === url) return client

  const chain = defineChain({
    id: env.CHAIN_ID,
    name: 'market',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  })
  client = createPublicClient({ chain, transport: http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }) }) as PublicClient
  clientUrl = url
  return client
}

let blocksPerHourCache: { at: number; value: number } | null = null

/** Measured, not assumed — block time is a chain parameter that can change. */
async function blocksPerHour(rpc: PublicClient, head: bigint): Promise<number> {
  if (blocksPerHourCache && Date.now() - blocksPerHourCache.at < 60 * 60_000) {
    return blocksPerHourCache.value
  }

  try {
    const back = head > 100_000n ? 100_000n : head / 2n
    const [older, newer] = await Promise.all([
      rpc.getBlock({ blockNumber: head - back }),
      rpc.getBlock({ blockNumber: head }),
    ])
    const seconds = Number(newer.timestamp - older.timestamp)
    if (seconds <= 0) throw new Error('block timestamps are not monotonic')

    const value = Math.round((Number(back) * 3600) / seconds)
    blocksPerHourCache = { at: Date.now(), value }
    return value
  } catch (err) {
    log.warn({ err }, 'could not measure block rate, using fallback')
    return FALLBACK_BLOCKS_PER_HOUR
  }
}

/**
 * Real OHLC for one pool.
 *
 * @param windowHours how far back to read, clamped to {@link MAX_WINDOW_HOURS}.
 * @returns candles oldest-first, or `[]` when the pool saw no trades in the window.
 */
export async function fetchSwapCandles(
  env: Env,
  version: 'v3' | 'v4',
  id: string,
  interval: CandleInterval,
  windowHours: number,
  /** token1 decimals, so volume comes back in whole units rather than wei. */
  token1Decimals: number,
): Promise<Candle[]> {
  const hours = Math.min(Math.max(1, windowHours), MAX_WINDOW_HOURS)
  const cacheKey = `${version}:${id.toLowerCase()}:${interval}:${hours}`

  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candles

  const rpc = marketClient(env)
  const head = await rpc.getBlockNumber()
  const perHour = await blocksPerHour(rpc, head)
  const span = BigInt(Math.round(perHour * hours))
  const fromBlock = head > span ? head - span : 0n

  if (version === 'v4' && !env.UNISWAP_V4_POOL_MANAGER) return []

  /*
   * Chunked, because the node refuses the whole span.
   *
   * Measured against this RPC: a 6-hour range answers in under a second, 12
   * hours returns `log query timed out`, and 24 hours comes back `Too Many
   * Requests`. One query for the window is the obvious shape and simply does not
   * work, so the range is split and walked sequentially — concurrency here just
   * converts the timeout into a rate limit.
   */
  const chunkBlocks = BigInt(Math.max(1, Math.round(perHour * CHUNK_HOURS)))
  const logs: Array<{ args: unknown; blockNumber: bigint | null }> = []

  for (let start = fromBlock; start <= head; start += chunkBlocks + 1n) {
    const stop = start + chunkBlocks > head ? head : start + chunkBlocks

    const chunk = await withRetry(() =>
      version === 'v3'
        ? rpc.getLogs({ address: id as Address, event: V3_SWAP, fromBlock: start, toBlock: stop })
        : rpc.getLogs({
            address: env.UNISWAP_V4_POOL_MANAGER as Address,
            event: V4_SWAP,
            args: { id: id as Hex },
            fromBlock: start,
            toBlock: stop,
          }),
    )

    // A chunk that keeps failing is skipped rather than sinking the request:
    // a candle chart with a gap beats no chart at all.
    if (chunk) logs.push(...(chunk as Array<{ args: unknown; blockNumber: bigint | null }>))
  }

  if (logs.length === 0) {
    remember(cacheKey, [])
    return []
  }

  /*
   * Timestamps by interpolation between a few anchors, not one header per block.
   *
   * A 12-hour window on a busy pool is ~5,600 swaps across thousands of distinct
   * blocks. Reading a header for each took 92 seconds — correct and unusable.
   * Blocks land every 0.1s here, so time is very nearly linear in block number:
   * anchoring each chunk at both ends and interpolating between them costs a
   * handful of reads and lands well inside a 15-minute bucket.
   */
  const anchors = await fetchAnchors(rpc, fromBlock, head, chunkBlocks)
  const timeAt = (block: bigint): number | undefined => interpolate(anchors, block)

  const seconds = INTERVALS[interval]
  const buckets = new Map<number, Candle>()

  const unit = 10 ** token1Decimals

  for (const entry of logs) {
    const args = entry.args as { tick?: number; amount1?: bigint }
    const tick = Number(args.tick ?? Number.NaN)
    const at = entry.blockNumber === null ? undefined : timeAt(entry.blockNumber)
    if (!Number.isFinite(tick) || at === undefined) continue

    // Same convention as the range band: raw `1.0001^tick`, so the chart and the
    // band it carries are in one price space.
    const price = 1.0001 ** tick
    if (!Number.isFinite(price) || price <= 0) continue

    // Signed by direction, so magnitude is what counts as volume.
    const raw = args.amount1 ?? 0n
    const volume = Number(raw < 0n ? -raw : raw) / unit

    const bucket = Math.floor(at / seconds) * seconds
    const existing = buckets.get(bucket)

    if (!existing) {
      buckets.set(bucket, {
        time: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        trades: 1,
        volume: Number.isFinite(volume) ? volume : 0,
      })
      continue
    }

    existing.high = Math.max(existing.high, price)
    existing.low = Math.min(existing.low, price)
    existing.close = price
    existing.trades += 1
    if (Number.isFinite(volume)) existing.volume += volume
  }

  const candles = [...buckets.values()].sort((a, b) => a.time - b.time)
  log.debug({ version, id, interval, hours, swaps: logs.length, candles: candles.length }, 'built swap candles')

  remember(cacheKey, candles)
  return candles
}

interface Anchor {
  block: bigint
  time: number
}

/** Block/timestamp pairs at each chunk boundary, oldest first. */
async function fetchAnchors(
  rpc: PublicClient,
  fromBlock: bigint,
  head: bigint,
  chunkBlocks: bigint,
): Promise<Anchor[]> {
  const wanted: bigint[] = []
  for (let block = fromBlock; block < head; block += chunkBlocks) wanted.push(block)
  wanted.push(head)

  const blocks = await Promise.all(
    wanted.map((block) => withRetry(() => rpc.getBlock({ blockNumber: block, includeTransactions: false }))),
  )

  return blocks
    .map((b) => (b?.number == null ? null : { block: b.number, time: Number(b.timestamp) }))
    .filter((a): a is Anchor => a !== null)
    .sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
}

/**
 * Time of a block, linear between the surrounding anchors.
 *
 * Outside the anchor range the nearest segment's slope is extended, which only
 * happens for a block at the very edge of the window.
 */
function interpolate(anchors: Anchor[], block: bigint): number | undefined {
  if (anchors.length === 0) return undefined
  if (anchors.length === 1) return anchors[0]!.time

  let lower = anchors[0]!
  let upper = anchors[anchors.length - 1]!
  for (let i = 0; i < anchors.length - 1; i++) {
    if (block >= anchors[i]!.block && block <= anchors[i + 1]!.block) {
      lower = anchors[i]!
      upper = anchors[i + 1]!
      break
    }
  }

  const spanBlocks = Number(upper.block - lower.block)
  if (spanBlocks === 0) return lower.time

  const offset = Number(block - lower.block)
  return lower.time + ((upper.time - lower.time) * offset) / spanBlocks
}

function remember(key: string, candles: Candle[]): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), candles })
}
