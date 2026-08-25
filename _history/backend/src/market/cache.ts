/**
 * Market snapshot cache — 003 R7.
 *
 * One snapshot serves every query shape: the route filters and sorts what it
 * gets, so a user changing sort order costs nothing upstream. Rebuilding it is
 * expensive — a GraphQL round trip plus up to 25 batched `extsload` calls — and
 * a page that polls would otherwise turn every viewer into load on a
 * third-party endpoint.
 *
 * Three ages, deliberately:
 *
 *   fresh   (< TTL)    → serve as-is
 *   stale   (< STALE)  → serve immediately, refresh in the background
 *   expired            → block on a rebuild
 *
 * The middle band is the one that matters. Without it, every rebuild makes some
 * unlucky user wait the full round trip; with it, only a genuinely cold cache
 * ever blocks, which in practice is the first request after boot.
 */
import { componentLogger } from '../lib/logger.js'
import { fetchPoolSnapshot, GatewayError } from './gateway.js'
import { enrichFeeDayOnchain, type EnrichedPool, type OnchainIssues } from './poolfees.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'

const log = componentLogger('market-cache')

export interface MarketSnapshot {
  pools: EnrichedPool[]
  /** Footnotes explaining any `?` cells. Never silently dropped. */
  issues: string[]
  builtAt: number
}

let cached: MarketSnapshot | null = null
let refreshing: Promise<MarketSnapshot> | null = null

/** Exported for tests — module state would otherwise leak between cases. */
export function resetMarketCacheForTesting(): void {
  cached = null
  refreshing = null
}

async function build(env: Env, chain: ChainClient): Promise<MarketSnapshot> {
  const snapshot = await fetchPoolSnapshot(env)
  const pools: EnrichedPool[] = snapshot.pools.map((p) => ({ ...p, liquidityTrendPct: null }))

  // Enrichment is best-effort by design: a chain read that fails must not cost
  // the user the pool list the gateway already returned.
  const issues: OnchainIssues = new Set(snapshot.issues)
  await enrichFeeDayOnchain(env, chain, pools, issues).catch((err: Error) => {
    log.warn({ err }, 'on-chain fee enrichment failed')
    issues.add(`on-chain fees unavailable (${err.message})`)
  })

  const built: MarketSnapshot = { pools, issues: [...issues], builtAt: Date.now() }
  cached = built
  log.debug({ pools: pools.length, issues: built.issues.length }, 'market snapshot built')
  return built
}

/**
 * Rebuild, collapsing concurrent callers onto one in-flight build.
 *
 * Without the collapse, a cold cache under any concurrency fans out into one
 * gateway round trip per request — the exact stampede the cache exists to stop.
 */
function rebuild(env: Env, chain: ChainClient): Promise<MarketSnapshot> {
  refreshing ??= build(env, chain).finally(() => {
    refreshing = null
  })
  return refreshing
}

export interface MarketOptions {
  /** Skip the cache entirely. Used by an explicit user-triggered refresh. */
  force?: boolean
}

const MINUTE_MS = 60_000

/** Age-stamped copy, so a served-stale snapshot admits how old it is. */
function withStaleNote(snapshot: MarketSnapshot, reason: string): MarketSnapshot {
  const minutes = Math.round((Date.now() - snapshot.builtAt) / MINUTE_MS)
  return {
    ...snapshot,
    issues: [...snapshot.issues, `showing data from ${minutes} minute(s) ago — ${reason}`],
  }
}

export async function getMarketSnapshot(
  env: Env,
  chain: ChainClient,
  options: MarketOptions = {},
): Promise<MarketSnapshot> {
  if (options.force) return rebuild(env, chain)

  const age = cached ? Date.now() - cached.builtAt : Infinity
  if (age < env.MARKET_CACHE_TTL_MS) return cached!

  if (cached && age < env.MARKET_CACHE_STALE_MS) {
    // Serve what we have, refresh behind the response. A rejection here is
    // already logged inside `build`; swallowing it keeps a background failure
    // from surfacing as an unhandled rejection.
    void rebuild(env, chain).catch(() => undefined)
    return cached
  }

  try {
    return await rebuild(env, chain)
  } catch (err) {
    /*
     * Observed behaviour, not a hypothetical: under rate limiting the gateway
     * answers 200 with an empty array and no `errors` field. That is
     * indistinguishable from "this chain has no pools", so `fetchPoolSnapshot`
     * treats an all-empty result as a failure.
     *
     * Which leaves this case: we cannot refresh, but we do have numbers from
     * before. Half-hour-old TVL is far more use than an error page, so long as
     * the age is stated — hence the note rather than a silent substitution.
     */
    if (cached) {
      log.warn({ err, ageMs: Date.now() - cached.builtAt }, 'serving expired snapshot, upstream refused')
      return withStaleNote(cached, 'the pool indexer is not responding')
    }
    throw err
  }
}

/** True when the market surface is configured at all. */
export function isMarketEnabled(env: Env): boolean {
  return Boolean(env.UNISWAP_CHAIN_SLUG)
}

export { GatewayError }
