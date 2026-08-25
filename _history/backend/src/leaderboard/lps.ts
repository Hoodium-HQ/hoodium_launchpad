/**
 * LP leaderboard — the ranking behind the landing page.
 *
 * ── What this can and cannot see ─────────────────────────────────────────────
 * Positions are only indexed for addresses that have been registered with us
 * (AL-1.1), so this ranks *Hoodium's* liquidity providers, not the chain's. That
 * is a real limit, not a rounding error, and the route says so in `scope` rather
 * than letting the page imply it surveyed every LP on the network.
 *
 * ── Why snapshots and not positions ──────────────────────────────────────────
 * `positions` knows liquidity but not what it is worth; `position_snapshots`
 * carries `valueQuote`, priced by the monitor once a minute. So the ranking is
 * built from the most recent snapshot of each position, and a position whose
 * snapshots stopped arriving simply falls out of the window — which is exactly
 * what should happen to one that was closed or to a wallet we stopped watching.
 */
import { Types } from 'mongoose'
import { PositionSnapshotModel } from '../db/models/position-snapshot.js'
import { WalletModel } from '../db/models/wallet.js'
import { moneyToJson, toDecimal } from '../lib/money.js'
import { componentLogger } from '../lib/logger.js'

const log = componentLogger('leaderboard')

/**
 * How far back a snapshot may be and still count as "now".
 *
 * The monitor writes every 60 seconds, so anything inside this window is
 * current. It is not tighter than that because a single missed cycle would
 * otherwise erase a live position from the board.
 */
const FRESH_WINDOW_MS = 15 * 60_000

/** Width of the lookback used for the 24h comparison, same reasoning. */
const PAST_WINDOW_MS = 15 * 60_000
const DAY_MS = 24 * 60 * 60_000

/** Nobody scrolls past this, and an unbounded ranking is an unbounded query. */
export const MAX_LIMIT = 100

export interface LpRow {
  rank: number
  address: string
  /** Sum of the latest `valueQuote` across this address's open positions. */
  valueQuote: string
  positions: number
  /** How many of those positions are currently in range (AL-2.1). */
  inRange: number
  /**
   * Change in total value over 24h, as a percent. `null` when we have no
   * snapshot from a day ago — a new LP has no history, and `0%` would claim
   * they were flat rather than admit we were not watching yet.
   */
  changePct: string | null
}

export interface LeaderboardResult {
  lps: LpRow[]
  /** Distinct addresses considered, before the limit. */
  total: number
  builtAt: number
}

interface OwnerTotals {
  value: Types.Decimal128
  positions: number
  inRange: number
}

/**
 * Latest snapshot per position inside `[since, until]`, folded up by owner.
 *
 * The two-stage `$group` is load-bearing: grouping straight to owner would sum
 * every snapshot in the window, so a position sampled fifteen times would count
 * fifteen times over.
 */
async function totalsByOwner(
  chainId: number,
  since: Date,
  until: Date | null,
  excluded: string[],
): Promise<Map<string, OwnerTotals>> {
  const at: Record<string, Date> = { $gte: since }
  if (until) at.$lte = until

  const rows = await PositionSnapshotModel.aggregate<{
    _id: string
    value: Types.Decimal128
    positions: number
    inRange: number
  }>([
    { $match: { at, 'meta.chainId': chainId } },
    { $sort: { at: -1 } },
    {
      $group: {
        _id: '$meta.positionKey',
        owner: { $first: '$meta.ownerAddress' },
        value: { $first: '$valueQuote' },
        inRange: { $first: '$inRange' },
      },
    },
    ...(excluded.length > 0 ? [{ $match: { owner: { $nin: excluded } } }] : []),
    {
      $group: {
        _id: '$owner',
        value: { $sum: '$value' },
        positions: { $sum: 1 },
        inRange: { $sum: { $cond: ['$inRange', 1, 0] } },
      },
    },
  ])

  return new Map(
    rows.map((r) => [r._id, { value: r.value, positions: r.positions, inRange: r.inRange }]),
  )
}

/**
 * Percent change between two totals, computed in decimal — a leaderboard is not
 * a reason to start doing money in floats (AL-N4).
 *
 * `null` when there is nothing to compare against: no history, or a past value
 * of zero, where the change is not 0% or ∞ but undefined.
 */
function changePct(now: Types.Decimal128, past: Types.Decimal128 | undefined): string | null {
  if (!past) return null
  const before = toDecimal(past)
  if (before.isZero()) return null
  return toDecimal(now).minus(before).div(before).times(100).toFixed(2)
}

async function build(chainId: number): Promise<LeaderboardResult> {
  const now = Date.now()

  const optedOut = await WalletModel.find({ chainId, leaderboardOptOut: true })
    .select('address')
    .lean()
  const excluded = optedOut.map((w) => w.address)

  const [current, past] = await Promise.all([
    totalsByOwner(chainId, new Date(now - FRESH_WINDOW_MS), null, excluded),
    totalsByOwner(
      chainId,
      new Date(now - DAY_MS - PAST_WINDOW_MS),
      new Date(now - DAY_MS),
      excluded,
    ),
  ])

  const lps = [...current.entries()]
    .map(([address, totals]) => ({
      address,
      valueQuote: moneyToJson(totals.value) ?? '0',
      positions: totals.positions,
      inRange: totals.inRange,
      changePct: changePct(totals.value, past.get(address)?.value),
    }))
    // Sorted here rather than in the pipeline so the comparison stays decimal
    // all the way through; `$sort` on Decimal128 is correct too, but this keeps
    // one ordering rule in one place.
    .sort((a, b) => toDecimal(b.valueQuote).comparedTo(toDecimal(a.valueQuote)))
    .map((row, index) => ({ rank: index + 1, ...row }))

  log.debug({ lps: lps.length, excluded: excluded.length }, 'leaderboard built')
  return { lps, total: lps.length, builtAt: now }
}

let cached: LeaderboardResult | null = null
let refreshing: Promise<LeaderboardResult> | null = null

/** Exported for tests — module state would otherwise leak between cases. */
export function resetLeaderboardCacheForTesting(): void {
  cached = null
  refreshing = null
}

/**
 * The board changes at most once a minute, because that is how often the monitor
 * writes. Caching for that long costs the viewer nothing and keeps a public
 * landing page from turning every visitor into two aggregations over a
 * time-series collection.
 */
const CACHE_TTL_MS = 60_000

export async function getLeaderboard(chainId: number): Promise<LeaderboardResult> {
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return cached

  // Collapse concurrent callers onto one build, or a cold cache under any
  // concurrency fans out into one aggregation per request.
  refreshing ??= build(chainId)
    .then((result) => {
      cached = result
      return result
    })
    .finally(() => {
      refreshing = null
    })

  try {
    return await refreshing
  } catch (err) {
    // Stale is better than an error page for a ranking, so long as the age
    // travels with it — the route stamps `builtAt` for exactly this case.
    if (cached) {
      log.warn({ err }, 'leaderboard rebuild failed, serving cached')
      return cached
    }
    throw err
  }
}
