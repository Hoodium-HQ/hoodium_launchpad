/**
 * Uncollected fee math — T7.1 / 001 design section 6a.
 *
 * A Uniswap v3 position does not store what it has earned. `positions()` returns
 * `tokensOwed`, which is only what was owed at the last time the position was
 * *touched* — minted, increased, decreased, or collected. Everything earned since
 * then exists solely as a difference between two accumulators, and computing that
 * difference is the whole of this file.
 *
 *   feeGrowthInside = feeGrowthGlobal − growthBelowRange − growthAboveRange
 *   pending         = liquidity × (feeGrowthInside − feeGrowthInsideLast) / 2^128
 *
 * **Every subtraction here wraps.** Uniswap accumulates fee growth in `unchecked`
 * blocks and relies on two's-complement wrap-around: `feeGrowthOutside` for a tick
 * initialized after the pool started collecting fees is routinely *larger* than
 * `feeGrowthGlobal`, and the difference is only meaningful modulo 2^256. Doing
 * this in checked arithmetic throws on a perfectly healthy pool, so the wrapping
 * is not a defensive measure — it is the algorithm.
 *
 * Pure. No I/O, no chain client; the caller supplies the reads.
 */

/** 2^256 − 1. Every intermediate is masked to this, matching Solidity's uint256. */
const MASK256 = (1n << 256n) - 1n

/** Fee growth is a Q128.128 fixed-point number. */
const Q128_SHIFT = 128n

/**
 * `a − b` as Solidity computes it inside `unchecked`.
 *
 * The mask is what makes an underflow produce the large positive number the
 * accumulator arithmetic depends on, rather than a negative BigInt that would
 * make `pending` come out negative and, downstream, refund the platform's fee.
 */
function wrapSub(a: bigint, b: bigint): bigint {
  return (a - b) & MASK256
}

/** One tick's fee-growth-outside pair, as returned by `pool.ticks(tick)`. */
export interface TickFeeGrowth {
  feeGrowthOutside0X128: bigint
  feeGrowthOutside1X128: bigint
}

export interface FeeGrowthInsideParams {
  tickLower: number
  tickUpper: number
  /** `slot0().tick` — the pool's current tick. */
  tickCurrent: number
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
  lower: TickFeeGrowth
  upper: TickFeeGrowth
}

export interface FeeGrowthInside {
  feeGrowthInside0X128: bigint
  feeGrowthInside1X128: bigint
}

/**
 * Fee growth per unit of liquidity accrued *inside* a range, all time.
 *
 * Mirrors `Tick.getFeeGrowthInside` in v3-core. The two branch conditions are
 * asymmetric on purpose — `>=` on the lower bound, `<` on the upper — because a
 * position is active on `[tickLower, tickUpper)`. Making them symmetric
 * misattributes one tick of growth at each boundary, which is invisible in
 * testing and wrong in production.
 */
export function feeGrowthInside(params: FeeGrowthInsideParams): FeeGrowthInside {
  const { tickLower, tickUpper, tickCurrent, feeGrowthGlobal0X128, feeGrowthGlobal1X128, lower, upper } = params

  const below0 =
    tickCurrent >= tickLower ? lower.feeGrowthOutside0X128 : wrapSub(feeGrowthGlobal0X128, lower.feeGrowthOutside0X128)
  const below1 =
    tickCurrent >= tickLower ? lower.feeGrowthOutside1X128 : wrapSub(feeGrowthGlobal1X128, lower.feeGrowthOutside1X128)

  const above0 =
    tickCurrent < tickUpper ? upper.feeGrowthOutside0X128 : wrapSub(feeGrowthGlobal0X128, upper.feeGrowthOutside0X128)
  const above1 =
    tickCurrent < tickUpper ? upper.feeGrowthOutside1X128 : wrapSub(feeGrowthGlobal1X128, upper.feeGrowthOutside1X128)

  return {
    feeGrowthInside0X128: wrapSub(wrapSub(feeGrowthGlobal0X128, below0), above0),
    feeGrowthInside1X128: wrapSub(wrapSub(feeGrowthGlobal1X128, below1), above1),
  }
}

export interface UncollectedFeesParams extends FeeGrowthInsideParams {
  /** Position liquidity, `positions().liquidity`. */
  liquidity: bigint
  /** `positions().feeGrowthInside0LastX128`. */
  feeGrowthInside0LastX128: bigint
  feeGrowthInside1LastX128: bigint
  /** `positions().tokensOwed0` — settled at the last touch, not necessarily fees. */
  tokensOwed0: bigint
  tokensOwed1: bigint
}

export interface UncollectedFees {
  /** Everything `collect()` would return right now, in smallest units. */
  fees0: bigint
  fees1: bigint
  /** Earned since the last touch and not yet moved into `tokensOwed`. */
  pending0: bigint
  pending1: bigint
}

/**
 * What `collect()` would return if called at this block.
 *
 * Note what this is **not**: it is not "fees earned". `tokensOwed` also holds
 * principal that a prior `decreaseLiquidity` released and nobody has collected
 * yet, and this function cannot tell the two apart — the position has no memory
 * of which is which. Separating them needs the event history, and that is
 * `lifetimeFeesEarned` in `accounting.ts`. Billing against this number directly
 * would charge a user a share of their own withdrawn capital.
 */
export function uncollectedFees(params: UncollectedFeesParams): UncollectedFees {
  const inside = feeGrowthInside(params)

  const delta0 = wrapSub(inside.feeGrowthInside0X128, params.feeGrowthInside0LastX128)
  const delta1 = wrapSub(inside.feeGrowthInside1X128, params.feeGrowthInside1LastX128)

  const pending0 = (params.liquidity * delta0) >> Q128_SHIFT
  const pending1 = (params.liquidity * delta1) >> Q128_SHIFT

  return {
    fees0: params.tokensOwed0 + pending0,
    fees1: params.tokensOwed1 + pending1,
    pending0,
    pending1,
  }
}
