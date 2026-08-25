/**
 * Market read API — 003 R7.
 *
 * Read-only and unauthenticated, for the same reason the launchpad routes are:
 * looking at what pools exist is not private data, and gating it behind sign-in
 * would break discovery.
 *
 * `LP-5.5` applies here unchanged — "SHALL NOT editorially promote, endorse, or
 * rank-boost any token for payment." Every ordering below is a plain sort over a
 * measured column. There is no boost field and nowhere to put one.
 *
 * When the market surface is unconfigured this returns an empty list **with a
 * stated reason** rather than a 404 or a silent empty array. A client cannot
 * otherwise tell "this chain has no pools" from "we never looked".
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { componentLogger } from '../lib/logger.js'
import { getMarketSnapshot, isMarketEnabled, GatewayError } from '../market/cache.js'
import { loadTokenImage } from '../market/token-images.js'
import { readPoolState } from '../market/pool-state.js'
import { DURATIONS, fetchPriceHistory } from '../market/price-history.js'
import { fetchSwapCandles } from '../market/swap-candles.js'
import type { EnrichedPool } from '../market/poolfees.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'

const SORTS = ['apr', 'tvl', 'fees', 'volume', 'liquidity'] as const
type Sort = (typeof SORTS)[number]

const VERSIONS = ['all', 'v3', 'v4'] as const

/**
 * Ticker symbols are token metadata and therefore attacker-controlled (WA-N3).
 * This one is only ever compared against symbols already in the snapshot — it
 * indexes nothing and is never interpolated anywhere — but it is still bounded,
 * because an unbounded string in a query parameter has no business being one.
 */
const SYMBOL = /^[A-Za-z0-9.+_-]{1,16}$/

const querySchema = z.object({
  sort: z.enum(SORTS).default('apr'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  version: z.enum(VERSIONS).default('all'),
  /**
   * `all` keeps everything, `stable` keeps pools paired with a configured
   * stable, and any other value is a ticker: `USDG`, `ETH`, whatever the client
   * offers. Symbols rather than an enum because which assets are worth filtering
   * by is a property of the chain, not of this route.
   */
  quote: z
    .string()
    .default('all')
    .refine((v) => v === 'all' || v === 'stable' || SYMBOL.test(v), 'not a ticker symbol'),
  limit: z.coerce.number().int().positive().max(100).default(50),
  minTvl: z.coerce.number().nonnegative().optional(),
})

/**
 * v4 pools hold native ETH, v3 pools hold WETH, and a user asking for "ETH only"
 * means both. Treating them as different assets would hide half the answer
 * behind a wrapping detail they did not ask about.
 */
const ETH_ALIASES = ['ETH', 'WETH'] as const

/**
 * Both sides are checked, not just `token1`.
 *
 * Uniswap orders a pair by token address, so which side the quote asset lands on
 * is arbitrary — `USDG/CASHCAT` and `WETH/USDG` are both USDG pools. Filtering on
 * `token1` alone silently dropped every pool where the quote sorted first.
 */
export function matchesQuote(
  p: Pick<EnrichedPool, 'token0Symbol' | 'token1Symbol'>,
  quote: string,
  stables: ReadonlySet<string>,
): boolean {
  if (quote === 'all') return true

  const sides = [p.token0Symbol.toUpperCase(), p.token1Symbol.toUpperCase()]
  if (quote === 'stable') return sides.some((s) => stables.has(s))

  const wanted = quote.toUpperCase()
  const accepted: readonly string[] = (ETH_ALIASES as readonly string[]).includes(wanted)
    ? ETH_ALIASES
    : [wanted]
  return sides.some((s) => accepted.includes(s))
}

const METRICS: Record<Sort, (p: EnrichedPool) => number | null> = {
  apr: (p) => p.aprPct,
  tvl: (p) => p.tvlUsd,
  fees: (p) => p.feeDayUsd,
  volume: (p) => p.volume24hUsd,
  liquidity: (p) => p.liquidityTrendPct,
}

/**
 * Rank by one metric, with unknowns last in **both** directions.
 *
 * That asymmetry is deliberate. Ascending order would otherwise put every `null`
 * at the top, presenting "we could not measure this" as "this is the smallest" —
 * the same conflation between unknown and zero that the rest of this module
 * exists to prevent, just relocated into the sort.
 */
function comparatorFor(sort: Sort, dir: 'asc' | 'desc') {
  const pick = METRICS[sort]
  return (a: EnrichedPool, b: EnrichedPool): number => {
    const x = pick(a)
    const y = pick(b)
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return dir === 'asc' ? x - y : y - x
  }
}

function serializePool(p: EnrichedPool) {
  return {
    version: p.version,
    id: p.id,
    token0: {
      symbol: p.token0Symbol,
      address: p.token0Address,
      decimals: p.token0Decimals,
      // The URL itself stays server-side. `hasLogo` exists so the client can
      // skip requesting an image we already know does not exist, rather than
      // firing a 404 per token per page.
      //
      // It requires an address as well as a URL: the proxy is keyed by address,
      // so native ETH — which has none — is not fetchable however good its logo.
      hasLogo: p.token0LogoUrl !== null && p.token0Address !== '',
    },
    token1: {
      symbol: p.token1Symbol,
      address: p.token1Address,
      decimals: p.token1Decimals,
      hasLogo: p.token1LogoUrl !== null && p.token1Address !== '',
    },
    feeTier: p.feeTier,
    dynamicFee: p.dynamicFee,
    tvlUsd: p.tvlUsd,
    // `null` travels to the client intact. The table renders it as `?`, which is
    // a different statement from `$0`.
    volume24hUsd: p.volume24hUsd,
    feeDayUsd: p.feeDayUsd,
    feeDaySource: p.feeDaySource,
    aprPct: p.aprPct,
    liquidityTrendPct: p.liquidityTrendPct,
  }
}

export async function registerMarketRoutes(
  app: FastifyInstance,
  deps: { env: Env; chain: ChainClient },
): Promise<void> {
  const { env, chain } = deps
  const log = componentLogger('market-api')

  app.get('/api/pools', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid query parameters' })
    }
    const { sort, dir, version, quote, limit, minTvl } = parsed.data

    if (!isMarketEnabled(env)) {
      return {
        pools: [],
        issues: ['market data is not configured for this chain (UNISWAP_CHAIN_SLUG is unset)'],
        enabled: false,
        builtAt: null,
      }
    }

    let snapshot
    try {
      snapshot = await getMarketSnapshot(env, chain)
    } catch (err) {
      if (err instanceof GatewayError) {
        // An upstream outage is not our failure to report as a 500 — the client
        // can still render the page and say why it is empty.
        log.warn({ err }, 'market snapshot unavailable')
        return reply.status(503).send({
          pools: [],
          issues: [`pool data is temporarily unavailable (${err.message})`],
          enabled: true,
          builtAt: null,
        })
      }
      throw err
    }

    const floor = minTvl ?? env.MARKET_MIN_TVL_USD
    const stableQuotes = new Set(env.MARKET_QUOTE_SYMBOLS)

    const pools = snapshot.pools
      .filter((p) => (version === 'all' ? true : p.version === version))
      .filter((p) => matchesQuote(p, quote, stableQuotes))
      .filter((p) => p.tvlUsd >= floor)
      .sort(comparatorFor(sort, dir))
      .slice(0, limit)

    return {
      pools: pools.map(serializePool),
      issues: snapshot.issues,
      enabled: true,
      builtAt: new Date(snapshot.builtAt).toISOString(),
      quoteSymbols: env.MARKET_QUOTE_SYMBOLS,
    }
  })

  /**
   * One pool, served from the same cached snapshot the list uses.
   *
   * The version is part of the path rather than a query flag because a v3
   * address and a v4 poolId are different identifier spaces. Matching on id
   * alone would let one answer a lookup meant for the other, and the caller
   * needs the right answer to know which contract to talk to.
   */
  app.get('/api/pools/:version/:id', async (request, reply) => {
    const params = z
      .object({ version: z.enum(['v3', 'v4']), id: z.string().min(3).max(80) })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid pool identifier' })

    if (!isMarketEnabled(env)) {
      return reply.status(404).send({ error: 'market data is not configured for this chain' })
    }

    let snapshot
    try {
      snapshot = await getMarketSnapshot(env, chain)
    } catch (err) {
      if (err instanceof GatewayError) {
        log.warn({ err }, 'pool lookup unavailable')
        return reply.status(503).send({ error: 'pool data is temporarily unavailable' })
      }
      throw err
    }

    const wanted = params.data.id.toLowerCase()
    const pool = snapshot.pools.find(
      (p) => p.version === params.data.version && p.id.toLowerCase() === wanted,
    )
    // Absent from the snapshot is not the same as absent from the chain: the
    // snapshot holds the indexer's top pools, not every pool in existence.
    if (!pool) {
      return reply.status(404).send({
        error: 'this pool is not in the current top-pool snapshot',
        code: 'not_in_snapshot',
      })
    }

    // Read live: a range picker needs the current price and the pool's tick
    // spacing, neither of which the indexer snapshot carries. `null` when it
    // cannot be read — the client then hides the picker rather than centring a
    // range on a price we invented.
    const state = await readPoolState(env, params.data.version, pool.id)

    return {
      pool: serializePool(pool),
      state,
      issues: snapshot.issues,
      builtAt: new Date(snapshot.builtAt).toISOString(),
      quoteSymbols: env.MARKET_QUOTE_SYMBOLS,
    }
  })

  /**
   * True OHLC from `Swap` logs, for the short windows where the indexer has
   * nothing fine enough — its samples stop at one an hour.
   */
  app.get('/api/pools/:version/:id/candles', async (request, reply) => {
    const params = z
      .object({ version: z.enum(['v3', 'v4']), id: z.string().min(3).max(80) })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid pool identifier' })

    const query = z
      .object({
        interval: z.enum(['15m', '1h', '4h']).default('15m'),
        windowHours: z.coerce.number().int().min(1).max(24).default(12),
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid interval or window' })

    if (!isMarketEnabled(env)) {
      return reply.status(404).send({ error: 'no candles for this chain' })
    }

    try {
      // token1 decimals come from the snapshot, so volume is reported in whole
      // units rather than the token's smallest denomination.
      const snapshot = await getMarketSnapshot(env, chain)
      const wanted = params.data.id.toLowerCase()
      const pool = snapshot.pools.find(
        (p) => p.version === params.data.version && p.id.toLowerCase() === wanted,
      )

      const candles = await fetchSwapCandles(
        env,
        params.data.version,
        params.data.id,
        query.data.interval,
        query.data.windowHours,
        pool?.token1Decimals ?? 18,
      )
      return { candles, interval: query.data.interval, windowHours: query.data.windowHours, source: 'swaps' }
    } catch (err) {
      log.warn({ err }, 'swap candles unavailable')
      return reply.status(503).send({
        candles: [],
        interval: query.data.interval,
        windowHours: query.data.windowHours,
        source: 'swaps',
        error: (err as Error).message,
      })
    }
  })

  /** Price series behind the range picker. Separate so the pool page paints first. */
  app.get('/api/pools/:version/:id/prices', async (request, reply) => {
    const params = z
      .object({ version: z.enum(['v3', 'v4']), id: z.string().min(3).max(80) })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid pool identifier' })

    const query = z.object({ duration: z.enum(DURATIONS).default('DAY') }).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid duration' })

    if (!isMarketEnabled(env)) {
      return reply.status(404).send({ error: 'no price history for this chain' })
    }

    try {
      const points = await fetchPriceHistory(env, params.data.version, params.data.id, query.data.duration)
      return { points, duration: query.data.duration }
    } catch (err) {
      if (err instanceof GatewayError) {
        log.warn({ err }, 'price history unavailable')
        // An empty series with a reason beats a 500: the page still renders and
        // says why the chart is blank.
        return reply.status(503).send({ points: [], duration: query.data.duration, error: err.message })
      }
      throw err
    }
  })

  /**
   * Token logo, re-served from our own origin (T5.6).
   *
   * The address in the path selects a URL from our snapshot; it never *is* the
   * URL. That is what keeps this from being an SSRF endpoint — see
   * `market/token-images.ts`.
   */
  app.get('/api/token-image/:address', async (request, reply) => {
    const params = z
      .object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'a valid token address is required' })

    if (!isMarketEnabled(env)) return reply.status(404).send({ error: 'no token images for this chain' })

    let snapshot
    try {
      snapshot = await getMarketSnapshot(env, chain)
    } catch {
      return reply.status(503).send({ error: 'token images are temporarily unavailable' })
    }

    const address = params.data.address.toLowerCase()
    let logoUrl: string | null = null
    for (const pool of snapshot.pools) {
      if (pool.token0Address === address && pool.token0LogoUrl) {
        logoUrl = pool.token0LogoUrl
        break
      }
      if (pool.token1Address === address && pool.token1LogoUrl) {
        logoUrl = pool.token1LogoUrl
        break
      }
    }
    if (!logoUrl) return reply.status(404).send({ error: 'no logo for this token' })

    const image = await loadTokenImage(address, logoUrl)
    if (!image) return reply.status(404).send({ error: 'logo could not be served' })

    return reply
      .header('content-type', image.contentType)
      // `nosniff` stops a browser from re-interpreting these bytes as anything
      // other than the image type we validated, and the lockdown CSP applies to
      // the case where someone opens this URL directly rather than in an `<img>`.
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(image.body)
  })
}
