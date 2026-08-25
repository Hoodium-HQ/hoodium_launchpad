/**
 * Position performance — what an LP position actually earned, and what it cost.
 *
 * `tickmath` answers "what does this position hold right now". This module
 * answers the two questions a provider actually asks, which are different:
 *
 *   1. **Was providing liquidity better than holding?** — fees against
 *      impermanent loss, both measured at one price.
 *   2. **Am I up or down on what I put in?** — current value against cost basis,
 *      which needs the price at each deposit.
 *
 * Those need different inputs and fail in different ways, so they are computed
 * separately and reported separately. Collapsing them into a single "PnL" is how
 * a dashboard ends up showing a positive number to someone who lost money.
 *
 * ── Why there is no price feed here ─────────────────────────────────────────
 * The HODL comparison values *both* sides at the same current price, so the
 * decimal factors and the price itself cancel out of the comparison's meaning:
 * it needs the deposited token amounts and nothing else. No oracle, no
 * historical series, no archive node. That is not a simplification — it is what
 * makes the figure exact rather than an estimate that drifts with whatever
 * source priced it.
 *
 * The cost basis genuinely does need the price at each deposit. Rather than ask
 * an oracle for it, `solveSqrtPriceFromDelta` recovers it from the deposit
 * itself: the token amounts a v3 mint pulls in are a function of the pool price,
 * and that function is invertible. The price is therefore read from the same
 * event that recorded the deposit, which is both exact and immune to a price
 * source disagreeing with the chain.
 *
 * Pure — no clock, no network, no chain reads. `Decimal` at 34 digits, never
 * IEEE doubles (AL-N4).
 */
import { Decimal, Q96, getSqrtRatioAtTick, priceFromSqrtRatio } from '../tickmath/index.js'

export { Decimal }

const ZERO = new Decimal(0)

// ── Recovering the price a deposit happened at ──────────────────────────────

/** One `IncreaseLiquidity` or `DecreaseLiquidity` event, reduced to its numbers. */
export interface LiquidityDelta {
  amount0: bigint
  amount1: bigint
  liquidity: bigint
}

export interface SolvedPrice {
  sqrtPriceX96: bigint
  /**
   * True when both legs were non-zero, which means price sat strictly inside
   * the range and the inversion has a unique solution.
   *
   * False means the event only *bounds* the price: a deposit entirely in one
   * token tells us price was on that side of the range, not where. The value
   * returned is then the boundary — the tightest honest statement available —
   * and `bound` says which direction the real price lies in.
   */
  exact: boolean
  bound: 'at_or_below_lower' | 'at_or_above_upper' | null
}

/**
 * The pool price implied by a liquidity change, inverted from `LiquidityAmounts`.
 *
 * Forward, for price inside `[Pa, Pb]`:
 *
 *     amount1 = L·(√P − √Pa) / Q96
 *     amount0 = L·Q96·(√Pb − √P) / (√Pb·√P)
 *
 * Either is invertible. The `amount1` leg is used whenever it is available
 * because it is linear in `√P`, so a one-wei rounding in the recorded amount
 * moves the result by one wei of `√P`. The `amount0` leg is a ratio, and near
 * the upper bound its inverse amplifies the same rounding — it is the fallback,
 * not the default.
 *
 * Returns `null` when the event carries no information about price: zero
 * liquidity, or both amounts zero. Callers must treat that as "unknown" rather
 * than substituting a price of their own, which is the whole reason this returns
 * a nullable rather than throwing or guessing.
 */
export function solveSqrtPriceFromDelta(
  delta: LiquidityDelta,
  tickLower: number,
  tickUpper: number,
): SolvedPrice | null {
  if (tickLower >= tickUpper) {
    throw new RangeError(`tickLower (${tickLower}) must be < tickUpper (${tickUpper})`)
  }

  const { amount0, amount1, liquidity } = delta
  if (liquidity <= 0n) return null
  if (amount0 <= 0n && amount1 <= 0n) return null

  const sqrtLower = getSqrtRatioAtTick(tickLower)
  const sqrtUpper = getSqrtRatioAtTick(tickUpper)

  // One-sided: the position was entirely token0 (price at or below the range) or
  // entirely token1 (at or above it). The boundary is a bound, not the price.
  if (amount1 <= 0n) {
    return { sqrtPriceX96: sqrtLower, exact: false, bound: 'at_or_below_lower' }
  }
  if (amount0 <= 0n) {
    return { sqrtPriceX96: sqrtUpper, exact: false, bound: 'at_or_above_upper' }
  }

  const solved = sqrtLower + (amount1 * Q96) / liquidity

  // The inversion can land a wei outside the range when the recorded amount was
  // rounded up at mint. Clamping is correct rather than merely tidy: price was
  // demonstrably inside the range (both legs are non-zero), so a result outside
  // it is rounding, not signal.
  const clamped = solved <= sqrtLower ? sqrtLower : solved >= sqrtUpper ? sqrtUpper : solved
  return { sqrtPriceX96: clamped, exact: true, bound: null }
}

// ── Valuation ───────────────────────────────────────────────────────────────

export interface QuoteValuationInput {
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  /** Which side of the pair is the quote asset (default USDG). */
  quoteIsToken0: boolean
  decimals0: number
  decimals1: number
}

/**
 * A token pair's worth in whole units of the quote asset.
 *
 * Deliberately the same conversion `computeExposure` performs: raw amounts
 * against the raw price, decimal-adjusted once at the end. Two valuation
 * routines that disagree by a decimal factor is exactly the class of bug WA-N6
 * exists to prevent, so this is the only other place the conversion is written
 * and it is written the same way.
 */
export function valueInQuote(input: QuoteValuationInput): Decimal {
  const { amount0, amount1, sqrtPriceX96, quoteIsToken0, decimals0, decimals1 } = input

  const rawPrice = priceFromSqrtRatio(sqrtPriceX96)
  const d0 = new Decimal(amount0.toString())
  const d1 = new Decimal(amount1.toString())

  if (quoteIsToken0) {
    const t1InQuote = rawPrice.isZero() ? ZERO : d1.div(rawPrice)
    return d0.plus(t1InQuote).div(new Decimal(10).pow(decimals0))
  }
  return d0.mul(rawPrice).plus(d1).div(new Decimal(10).pow(decimals1))
}

// ── Did providing liquidity beat holding? ───────────────────────────────────

export interface HodlComparisonInput {
  /** Everything ever deposited, raw units. */
  deposited0: bigint
  deposited1: bigint
  /** Principal already taken back out, raw units. Not fees. */
  withdrawn0: bigint
  withdrawn1: bigint
  /** What the position holds now, excluding fees. */
  current0: bigint
  current1: bigint
  /** Fees earned over the position's life, collected and not. */
  fees0: bigint
  fees1: bigint
  sqrtPriceX96: bigint
  quoteIsToken0: boolean
  decimals0: number
  decimals1: number
}

export interface HodlComparison {
  /** Value of what is in the pool right now, excluding fees. */
  positionValueQuote: Decimal
  /** Value of principal already withdrawn, at today's price. */
  withdrawnValueQuote: Decimal
  /** What the deposited tokens would be worth had they never been deposited. */
  hodlValueQuote: Decimal
  /**
   * `(position + withdrawn) − hodl`. Negative — the direction the name implies —
   * whenever the pool converted a rising token into a falling one.
   */
  impermanentLossQuote: Decimal
  feesValueQuote: Decimal
  /** `fees + impermanentLoss`. Positive means providing beat holding. */
  netVsHodlQuote: Decimal
}

/**
 * Fees against impermanent loss, every figure at the current price.
 *
 * **One price for both sides is the point.** Comparing a position valued today
 * against a deposit valued at its historical price measures the market's move,
 * not the pool's effect, and the market's move is not something an LP chose. The
 * counterfactual this answers is the one they can act on: *for the same tokens,
 * over the same period, would holding have been better?*
 *
 * Withdrawn principal is valued at today's price too, and that is a modelling
 * choice worth stating: it assumes tokens taken out were held, not sold. Any
 * other assumption requires knowing what the owner did with them afterwards,
 * which is not on this chain and certainly not in this pool.
 */
export function compareToHodl(input: HodlComparisonInput): HodlComparison {
  const { sqrtPriceX96, quoteIsToken0, decimals0, decimals1 } = input
  const at = (amount0: bigint, amount1: bigint) =>
    valueInQuote({ amount0, amount1, sqrtPriceX96, quoteIsToken0, decimals0, decimals1 })

  const positionValueQuote = at(input.current0, input.current1)
  const withdrawnValueQuote = at(input.withdrawn0, input.withdrawn1)
  const hodlValueQuote = at(input.deposited0, input.deposited1)
  const feesValueQuote = at(input.fees0, input.fees1)

  const impermanentLossQuote = positionValueQuote.plus(withdrawnValueQuote).minus(hodlValueQuote)

  return {
    positionValueQuote,
    withdrawnValueQuote,
    hodlValueQuote,
    impermanentLossQuote,
    feesValueQuote,
    netVsHodlQuote: feesValueQuote.plus(impermanentLossQuote),
  }
}

// ── Am I up on what I put in? ───────────────────────────────────────────────

/** A deposit or withdrawal, already priced at the moment it happened. */
export interface PricedFlow {
  valueQuote: Decimal
  /** False when the price behind it was bounded rather than solved. */
  exact: boolean
}

export interface CostBasisInput {
  deposits: PricedFlow[]
  withdrawals: PricedFlow[]
  /** Value in the pool now, excluding fees. */
  positionValueQuote: Decimal
  /** Fees earned, valued at the current price. */
  feesValueQuote: Decimal
  /**
   * Whether the event ledger accounts for the position's current liquidity —
   * `Σ increases − Σ decreases == liquidity`. False means events are missing,
   * so every figure below is a floor rather than a total.
   */
  ledgerComplete: boolean
}

export interface CostBasis {
  /** What was put in, each deposit at its own price. */
  costBasisQuote: Decimal
  /** What has already been taken back out, each at its own price. */
  realisedQuote: Decimal
  /** `position + realised + fees − basis`. */
  netPnlQuote: Decimal
  /** `netPnl / basis`, as a percent. Null when the basis is zero. */
  roiPct: Decimal | null
  /**
   * True only when every flow was priced exactly *and* the ledger reconciles.
   * Anything else and these are estimates — the UI must say so rather than
   * printing a number that looks as solid as the HODL comparison beside it.
   */
  complete: boolean
}

/**
 * Profit against cost basis.
 *
 * Unlike `compareToHodl`, this mixes prices from different moments by
 * construction: that is what a cost basis *is*. It is reported alongside the
 * HODL comparison rather than instead of it because the two answer different
 * questions, and because this one degrades — a deposit made while price sat
 * outside the range can only be bounded, and a position whose early events the
 * indexer never saw cannot be reconstructed at all.
 *
 * `complete` is the honest carrier for that. It is false rather than the figures
 * being withheld, because a floor on what someone earned is more useful than a
 * dash — provided it is labelled as one.
 */
export function computeCostBasis(input: CostBasisInput): CostBasis {
  const sum = (flows: PricedFlow[]) => flows.reduce((acc, f) => acc.plus(f.valueQuote), ZERO)

  const costBasisQuote = sum(input.deposits)
  const realisedQuote = sum(input.withdrawals)
  const netPnlQuote = input.positionValueQuote
    .plus(realisedQuote)
    .plus(input.feesValueQuote)
    .minus(costBasisQuote)

  const everyFlowExact = [...input.deposits, ...input.withdrawals].every((f) => f.exact)

  return {
    costBasisQuote,
    realisedQuote,
    netPnlQuote,
    roiPct: costBasisQuote.isZero() ? null : netPnlQuote.div(costBasisQuote).mul(100).toDecimalPlaces(6),
    complete: input.ledgerComplete && everyFlowExact,
  }
}

// ── Rates ───────────────────────────────────────────────────────────────────

const MS_PER_YEAR = new Decimal(365 * 24 * 60 * 60 * 1000)

/**
 * How long a position must have run before a fee rate may be quoted for it.
 *
 * Annualising is division by elapsed time, so the shorter the sample the more a
 * single busy hour is multiplied. A position fourteen hours old that happened to
 * catch one volatile afternoon annualises to four figures, and the number is not
 * wrong so much as meaningless — it describes an afternoon, presented as a year.
 *
 * Ranking by that metric does not surface good strategies. It surfaces new pools
 * on volatile pairs, every time, because they are the ones whose short samples
 * are extreme. The floor is what stops the leaderboard from being a list of
 * whatever launched yesterday.
 */
export const MIN_APR_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Fee income as an annual rate on cost basis.
 *
 * Null — never zero, and never a number — when the position is younger than
 * `minAgeMs` or has no basis to earn against. A caller that wants to display
 * something in that case should display "too new", which is what is true.
 */
export function annualisedFeeApr(
  feesQuote: Decimal,
  basisQuote: Decimal,
  ageMs: number,
  minAgeMs: number = MIN_APR_AGE_MS,
): Decimal | null {
  if (!Number.isFinite(ageMs) || ageMs < minAgeMs) return null
  if (basisQuote.lte(0)) return null

  return feesQuote.div(basisQuote).mul(MS_PER_YEAR.div(ageMs)).mul(100).toDecimalPlaces(6)
}

// ── Time in range ───────────────────────────────────────────────────────────

export interface TimeInRangeSample {
  at: Date
  inRange: boolean
}

export interface TimeInRange {
  pct: Decimal
  samples: number
  /** The window the figure actually covers — never the position's whole life. */
  from: Date
  to: Date
}

/**
 * Share of a sampled window the position spent earning.
 *
 * Weighted by the interval each sample represents rather than counting rows,
 * because the monitor's cadence is a target and not a guarantee: a gap during an
 * outage would otherwise count the same as a single minute, and outages are
 * exactly when a position is most likely to have drifted out of range unnoticed.
 *
 * The returned window is part of the answer. Snapshots expire, so this can only
 * ever describe the retained history — a caller that prints it as a lifetime
 * figure is claiming something this function did not measure.
 */
export function timeInRange(samples: TimeInRangeSample[]): TimeInRange | null {
  if (samples.length < 2) return null

  const ordered = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime())
  const first = ordered[0]!
  const last = ordered[ordered.length - 1]!

  let total = 0
  let inRange = 0
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!
    const span = ordered[i]!.at.getTime() - previous.at.getTime()
    if (span <= 0) continue
    total += span
    // The interval is attributed to the state at its start — that is the state
    // that held for it. Using the end would credit a range exit backwards.
    if (previous.inRange) inRange += span
  }

  if (total === 0) return null

  return {
    pct: new Decimal(inRange).div(total).mul(100).toDecimalPlaces(4),
    samples: ordered.length,
    from: first.at,
    to: last.at,
  }
}
