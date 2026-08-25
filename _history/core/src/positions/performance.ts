/**
 * Deriving a position's performance from the event log — 003 `WA-3.3`, `AL-7.2`.
 *
 * "Reported figures SHALL be recomputed from the `events` collection." This is
 * the file that does it for the reporting view, and it holds no state of its
 * own: hand it a position, it reads events and the latest snapshot and returns
 * a complete record. Running it twice produces the same answer, and running it
 * after a reorg rewind produces the *corrected* answer, which is the property
 * that makes a materialised copy safe to keep (`PositionPerformanceModel`).
 *
 * ── Where the prices come from ───────────────────────────────────────────────
 * Nowhere external. The HODL comparison values both sides at the price in the
 * latest snapshot, so it needs no history. The cost basis prices each deposit by
 * inverting the amounts that deposit pulled in (`solveSqrtPriceFromDelta`) — the
 * event carries its own price, once you know the range it was minted into.
 *
 * There is deliberately no oracle call, no archive `slot0`, and no price series
 * lookup here. A cost basis that disagrees with the chain because a third-party
 * feed disagreed with the chain is worse than no cost basis.
 *
 * ── Finality ─────────────────────────────────────────────────────────────────
 * The same asymmetry `accounting.ts` documents, for the same reason, plus one
 * more: deposits must be final before they count toward a basis. A deposit that
 * reorgs away would otherwise inflate what someone appears to have put in. The
 * cost of requiring it is that a position with fresh activity fails the ledger
 * reconciliation for 32 blocks and drops off the board until it settles — which
 * is the honest state to be in while we do not yet know what happened.
 */
import {
  compareToHodl,
  computeCostBasis,
  annualisedFeeApr,
  solveSqrtPriceFromDelta,
  timeInRange,
  valueInQuote,
  Decimal,
  type PricedFlow,
  type TimeInRangeSample,
} from '@hoodium/shared/performance'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '@hoodium/shared/tickmath'
import { EventModel } from '../db/models/event.js'
import { PositionSnapshotModel } from '../db/models/position-snapshot.js'
import { lifetimeFeesEarned } from './accounting.js'
import { componentLogger } from '../lib/logger.js'

const log = componentLogger('performance')

/**
 * How far back in-range history is sampled by default.
 *
 * Snapshots are kept for 90 days, so nothing longer would find more rows — but
 * 30 is what the figure is *worth* quoting over. A range set two months ago
 * describes a market that no longer exists, and averaging it with this week
 * hides the thing someone opened the page to see.
 */
export const TIME_IN_RANGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Just enough of a position to value it. Accepts a lean doc or a hydrated one. */
export interface PerformancePosition {
  chainId: number
  positionManager: string
  tokenId: string
  ownerAddress: string
  poolAddress: string
  token0: { address: string; symbol: string; decimals: number }
  token1: { address: string; symbol: string; decimals: number }
  tickLower: number
  tickUpper: number
  quoteIsToken0: boolean
  quoteSupported: boolean
  status: 'open' | 'closed'
}

export interface DerivedPerformance {
  chainId: number
  positionKey: string
  ownerAddress: string
  poolAddress: string
  status: 'open' | 'closed'

  deposited0: string
  deposited1: string
  withdrawn0: string
  withdrawn1: string
  fees0: string
  fees1: string

  positionValueQuote: string | null
  withdrawnValueQuote: string | null
  hodlValueQuote: string | null
  impermanentLossQuote: string | null
  feesValueQuote: string | null
  netVsHodlQuote: string | null

  costBasisQuote: string | null
  realisedQuote: string | null
  netPnlQuote: string | null
  roiPct: string | null
  basisComplete: boolean

  feeAprPct: string | null

  timeInRangePct: string | null
  timeInRangeFrom: Date | null
  timeInRangeTo: Date | null
  timeInRangeSamples: number

  firstEventAt: Date | null
  firstEventBlock: number | null
  ledgerComplete: boolean

  rankable: boolean
  computedAt: Date
  computedBlock: number | null
}

/** A liquidity change, with the price it happened at recovered from its amounts. */
interface Flow {
  amount0: bigint
  amount1: bigint
  liquidity: bigint
  blockNumber: number
  at: Date | null
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return 0n
}

function readFlows(rows: Array<Record<string, unknown>>): Flow[] {
  return rows.map((row) => {
    const args = (row.args ?? {}) as Record<string, unknown>
    return {
      amount0: toBigInt(args.amount0),
      amount1: toBigInt(args.amount1),
      liquidity: toBigInt(args.liquidity),
      blockNumber: Number(row.blockNumber ?? 0),
      at: (row.blockTimestamp as Date | null) ?? null,
    }
  })
}

/**
 * Everything the derivation needs from the event log, in one pass per family.
 *
 * Three queries rather than one aggregate because the finality filter differs
 * per family and cannot be expressed as a single `$match` — see the header.
 */
async function loadEvents(chainId: number, positionKey: string) {
  const [increases, decreases, collects] = await Promise.all([
    EventModel.find({ chainId, positionKey, eventName: 'IncreaseLiquidity', finalized: true })
      .select({ args: 1, blockNumber: 1, blockTimestamp: 1 })
      .sort({ blockNumber: 1, logIndex: 1 })
      .lean(),
    EventModel.find({ chainId, positionKey, eventName: 'DecreaseLiquidity' })
      .select({ args: 1, blockNumber: 1, blockTimestamp: 1 })
      .sort({ blockNumber: 1, logIndex: 1 })
      .lean(),
    EventModel.find({ chainId, positionKey, eventName: 'Collect', finalized: true })
      .select({ args: 1 })
      .lean(),
  ])

  return {
    increases: readFlows(increases as Array<Record<string, unknown>>),
    decreases: readFlows(decreases as Array<Record<string, unknown>>),
    collects: readFlows(collects as Array<Record<string, unknown>>),
  }
}

function sumAmounts(flows: Flow[]): { amount0: bigint; amount1: bigint } {
  return flows.reduce(
    (acc, f) => ({ amount0: acc.amount0 + f.amount0, amount1: acc.amount1 + f.amount1 }),
    { amount0: 0n, amount1: 0n },
  )
}

/**
 * Value one liquidity change at the price it happened, not today's.
 *
 * A flow whose price could only be bounded still produces a number — the bound
 * is the best available estimate and dropping it would understate the basis by
 * a whole deposit. It is marked inexact, and one inexact flow is enough to make
 * the whole basis inexact, which is where that fact surfaces.
 */
function priceFlow(
  flow: Flow,
  position: PerformancePosition,
): PricedFlow | null {
  const solved = solveSqrtPriceFromDelta(flow, position.tickLower, position.tickUpper)
  if (!solved) return null

  return {
    valueQuote: valueInQuote({
      amount0: flow.amount0,
      amount1: flow.amount1,
      sqrtPriceX96: solved.sqrtPriceX96,
      quoteIsToken0: position.quoteIsToken0,
      decimals0: position.token0.decimals,
      decimals1: position.token1.decimals,
    }),
    exact: solved.exact,
  }
}

async function loadTimeInRange(positionKey: string, windowMs: number, now: Date) {
  const samples = await PositionSnapshotModel.find({
    'meta.positionKey': positionKey,
    at: { $gte: new Date(now.getTime() - windowMs) },
  })
    .select({ at: 1, inRange: 1 })
    .sort({ at: 1 })
    .lean()

  return timeInRange(
    (samples as Array<{ at: Date; inRange: boolean }>).map(
      (s): TimeInRangeSample => ({ at: s.at, inRange: s.inRange }),
    ),
  )
}

const d = (value: Decimal | null | undefined) => (value == null ? null : value.toFixed())

/**
 * Recompute one position's performance from scratch.
 *
 * Never throws for missing data — a position with no snapshot yet, or one whose
 * pair has no quote side (`quoteSupported: false`, `AL-2.2`), returns a record
 * with the raw token ledger filled in and every valuation null. That is a real
 * state and the UI renders it as one; a thrown error would turn "we cannot price
 * this pair" into "the page is broken".
 */
export async function derivePositionPerformance(params: {
  position: PerformancePosition
  now?: Date
  timeInRangeWindowMs?: number
}): Promise<DerivedPerformance> {
  const { position } = params
  const now = params.now ?? new Date()
  const windowMs = params.timeInRangeWindowMs ?? TIME_IN_RANGE_WINDOW_MS

  const positionKey = `${position.chainId}:${position.positionManager}:${position.tokenId}`

  const [{ increases, decreases, collects }, snapshotRow, inRange] = await Promise.all([
    loadEvents(position.chainId, positionKey),
    PositionSnapshotModel.findOne({ 'meta.positionKey': positionKey })
      .sort({ at: -1 })
      .select({ at: 1, blockNumber: 1, sqrtPriceX96: 1, liquidity: 1, fees0: 1, fees1: 1 })
      .lean(),
    loadTimeInRange(positionKey, windowMs, now),
  ])

  const deposited = sumAmounts(increases)
  const withdrawn = sumAmounts(decreases)
  const collected = sumAmounts(collects)
  const first = increases[0] ?? decreases[0] ?? null

  const snapshot = snapshotRow as {
    at: Date
    blockNumber: number
    sqrtPriceX96: string
    liquidity: string
    fees0: string | null
    fees1: string | null
  } | null

  /*
   * `Σ increases − Σ decreases` against live liquidity. Equality means the event
   * log accounts for every unit of liquidity the position holds, which is a
   * stronger statement than "we found the mint": it also fails when an event in
   * the middle went missing, and that is the failure no start-block check sees.
   */
  const liquidityFromEvents =
    increases.reduce((acc, f) => acc + f.liquidity, 0n) -
    decreases.reduce((acc, f) => acc + f.liquidity, 0n)
  const liveLiquidity = snapshot ? toBigInt(snapshot.liquidity) : null
  const ledgerComplete =
    increases.length > 0 && liveLiquidity != null && liquidityFromEvents === liveLiquidity

  // Fees over the whole life: baseline zero, because nothing here is billing —
  // this is what the *owner* earned, not what the platform may charge for.
  const fees = lifetimeFeesEarned({
    collected0: collected.amount0,
    collected1: collected.amount1,
    decreased0: withdrawn.amount0,
    decreased1: withdrawn.amount1,
    uncollected0: toBigInt(snapshot?.fees0),
    uncollected1: toBigInt(snapshot?.fees1),
    baseline0: 0n,
    baseline1: 0n,
  })

  const base: DerivedPerformance = {
    chainId: position.chainId,
    positionKey,
    ownerAddress: position.ownerAddress,
    poolAddress: position.poolAddress,
    status: position.status,

    deposited0: deposited.amount0.toString(),
    deposited1: deposited.amount1.toString(),
    withdrawn0: withdrawn.amount0.toString(),
    withdrawn1: withdrawn.amount1.toString(),
    fees0: fees.fees0.toString(),
    fees1: fees.fees1.toString(),

    positionValueQuote: null,
    withdrawnValueQuote: null,
    hodlValueQuote: null,
    impermanentLossQuote: null,
    feesValueQuote: null,
    netVsHodlQuote: null,

    costBasisQuote: null,
    realisedQuote: null,
    netPnlQuote: null,
    roiPct: null,
    basisComplete: false,

    feeAprPct: null,

    timeInRangePct: d(inRange?.pct),
    timeInRangeFrom: inRange?.from ?? null,
    timeInRangeTo: inRange?.to ?? null,
    timeInRangeSamples: inRange?.samples ?? 0,

    firstEventAt: first?.at ?? null,
    firstEventBlock: first?.blockNumber ?? null,
    ledgerComplete,

    rankable: false,
    computedAt: now,
    computedBlock: snapshot?.blockNumber ?? null,
  }

  // Nothing below can be expressed in the quote asset. The ledger above still
  // stands, and it is the half that does not depend on a price.
  if (!position.quoteSupported || !snapshot) return base

  const sqrtPriceX96 = toBigInt(snapshot.sqrtPriceX96)
  if (sqrtPriceX96 <= 0n) {
    log.warn({ positionKey }, 'snapshot carries no usable price — valuations skipped')
    return base
  }

  /*
   * Current holdings are recomputed from `sqrtPriceX96` and `liquidity` rather
   * than read from the snapshot's `amount0`/`amount1`. Those fields come from
   * `computeExposure`, which folds uncollected fees into them — adding
   * `feesValueQuote` on top of that would count the same fees twice. Deriving
   * the amounts here makes the exclusion structural instead of a comment
   * somewhere hoping to stay true.
   */
  const current = getAmountsForLiquidity(
    sqrtPriceX96,
    getSqrtRatioAtTick(position.tickLower),
    getSqrtRatioAtTick(position.tickUpper),
    toBigInt(snapshot.liquidity),
  )

  const hodl = compareToHodl({
    deposited0: deposited.amount0,
    deposited1: deposited.amount1,
    withdrawn0: withdrawn.amount0,
    withdrawn1: withdrawn.amount1,
    current0: current.amount0,
    current1: current.amount1,
    fees0: fees.fees0,
    fees1: fees.fees1,
    sqrtPriceX96,
    quoteIsToken0: position.quoteIsToken0,
    decimals0: position.token0.decimals,
    decimals1: position.token1.decimals,
  })

  const priced = (flows: Flow[]) =>
    flows.map((f) => priceFlow(f, position)).filter((f): f is PricedFlow => f !== null)

  const basis = computeCostBasis({
    deposits: priced(increases),
    withdrawals: priced(decreases),
    positionValueQuote: hodl.positionValueQuote,
    feesValueQuote: hodl.feesValueQuote,
    ledgerComplete,
  })

  const ageMs = first?.at ? now.getTime() - first.at.getTime() : Number.NaN
  const feeApr = annualisedFeeApr(hodl.feesValueQuote, basis.costBasisQuote, ageMs)

  return {
    ...base,
    positionValueQuote: d(hodl.positionValueQuote),
    withdrawnValueQuote: d(hodl.withdrawnValueQuote),
    hodlValueQuote: d(hodl.hodlValueQuote),
    impermanentLossQuote: d(hodl.impermanentLossQuote),
    feesValueQuote: d(hodl.feesValueQuote),
    netVsHodlQuote: d(hodl.netVsHodlQuote),

    costBasisQuote: d(basis.costBasisQuote),
    realisedQuote: d(basis.realisedQuote),
    netPnlQuote: d(basis.netPnlQuote),
    roiPct: d(basis.roiPct),
    basisComplete: basis.complete,

    feeAprPct: d(feeApr),

    /*
     * A row earns its place on the public board only if every figure it would be
     * ranked by is a total. Incomplete rows are still computed and still shown
     * to their owner, labelled — but ranking them would rank the gaps in our
     * index against each other, which is not a comparison anyone asked for.
     */
    rankable: basis.complete && position.status === 'open',
  }
}

/** Age in hours, or null — used for the board's minimum-age filter and the UI. */
export function ageHours(firstEventAt: Date | null | undefined, now: Date): number | null {
  if (!firstEventAt) return null
  const ms = now.getTime() - firstEventAt.getTime()
  return ms >= 0 ? ms / (60 * 60 * 1000) : null
}
