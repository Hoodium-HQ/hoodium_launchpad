/**
 * Tick math — AL-2.2, shared so both sides compute exposure identically.
 *
 * "Exposure SHALL be derived from `liquidity` + `tickCurrent` + `tickLower` +
 *  `tickUpper` using exact tick math (`price = 1.0001^tick`), never estimated
 *  from USD values."
 *
 * `getSqrtRatioAtTick` is a direct port of Uniswap v3 `TickMath`, and the amount
 * formulas are `LiquidityAmounts`. Ratios — genuinely fractional — use decimal.js
 * at 34 digits rather than IEEE doubles.
 *
 * No USD, no oracle, no price feed. The pool's own state is the only input.
 */
import Decimal from 'decimal.js'

Decimal.set({ precision: 34, toExpPos: 34, toExpNeg: -34 })
export { Decimal }

export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const Q96 = 1n << 96n
const MAX_UINT256 = (1n << 256n) - 1n
const DECIMAL_Q96 = new Decimal(Q96.toString())

/**
 * Uniswap v3 `TickMath.getSqrtRatioAtTick` — sqrt(1.0001^tick) * 2^96.
 *
 * Ported literally, magic constants and all. They are precomputed
 * sqrt(1.0001^(2^i)) values in Q128.128; deriving them at runtime would be
 * slower and less exact than the numbers the pool contract itself uses.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new RangeError(`tick must be an integer, got ${tick}`)
  const absTick = BigInt(Math.abs(tick))
  if (absTick > BigInt(MAX_TICK)) throw new RangeError(`tick ${tick} out of range`)

  let ratio =
    (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n

  const mul = (bit: bigint, constant: bigint) => {
    if ((absTick & bit) !== 0n) ratio = (ratio * constant) >> 128n
  }

  mul(0x2n, 0xfff97272373d413259a46990580e213an)
  mul(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn)
  mul(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n)
  mul(0x10n, 0xffcb9843d60f6159c9db58835c926644n)
  mul(0x20n, 0xff973b41fa98c081472e6896dfb254c0n)
  mul(0x40n, 0xff2ea16466c96a3843ec78b326b52861n)
  mul(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n)
  mul(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n)
  mul(0x200n, 0xf987a7253ac413176f2b074cf7815e54n)
  mul(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n)
  mul(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n)
  mul(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n)
  mul(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n)
  mul(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n)
  mul(0x8000n, 0x31be135f97d08fd981231505542fcfa6n)
  mul(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n)
  mul(0x20000n, 0x5d6af8dedb81196699c329225ee604n)
  mul(0x40000n, 0x2216e584f5fa1ea926041bedfe98n)
  mul(0x80000n, 0x48a170391f7dc42444e8fa2n)

  if (tick > 0) ratio = MAX_UINT256 / ratio

  // Q128.128 -> Q64.96, rounding up so the result never understates the price.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

/** Raw pool price (token1 per token0, undecimated) from a sqrt price. */
export function priceFromSqrtRatio(sqrtPriceX96: bigint): Decimal {
  const s = new Decimal(sqrtPriceX96.toString()).div(DECIMAL_Q96)
  return s.mul(s)
}

/** `price = 1.0001^tick`, computed via the exact sqrt ratio rather than `pow`. */
export function priceAtTick(tick: number): Decimal {
  return priceFromSqrtRatio(getSqrtRatioAtTick(tick))
}

/** Adjust a raw price for token decimals: whole token1 per whole token0. */
export function humanPrice(rawPrice: Decimal, decimals0: number, decimals1: number): Decimal {
  return rawPrice.mul(new Decimal(10).pow(decimals0 - decimals1))
}

// ── LiquidityAmounts ────────────────────────────────────────────────────────

export function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB]
  if (lo <= 0n) throw new RangeError('sqrt price must be positive')
  return ((liquidity << 96n) * (hi - lo)) / hi / lo
}

export function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB]
  return (liquidity * (hi - lo)) / Q96
}

/**
 * Token amounts a position currently holds. Below the range it is entirely
 * token0; above it, entirely token1 — which is exactly the "deeply converted"
 * condition 001 R4 exists to escape.
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const [lo, hi] = sqrtRatioAX96 > sqrtRatioBX96 ? [sqrtRatioBX96, sqrtRatioAX96] : [sqrtRatioAX96, sqrtRatioBX96]

  if (sqrtPriceX96 <= lo) {
    return { amount0: getAmount0ForLiquidity(lo, hi, liquidity), amount1: 0n }
  }
  if (sqrtPriceX96 < hi) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, hi, liquidity),
      amount1: getAmount1ForLiquidity(lo, sqrtPriceX96, liquidity),
    }
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(lo, hi, liquidity) }
}

// ── Exposure ────────────────────────────────────────────────────────────────

export interface ExposureInput {
  sqrtPriceX96: bigint
  tickCurrent: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** Which side of the pair is the quote asset (default USDG). */
  quoteIsToken0: boolean
  decimals0: number
  decimals1: number
  fees0?: bigint
  fees1?: bigint
}

export interface ExposureResult {
  amount0: bigint
  amount1: bigint
  /** Share of position value held in the non-quote token, 0–100. */
  exposurePct: Decimal
  valueQuote: Decimal
  price: Decimal
  inRange: boolean
  distanceToLowerPct: Decimal
  distanceToUpperPct: Decimal
  nearBoundary: boolean
  nearestBoundary: 'lower' | 'upper'
}

/**
 * The single function the Monitor calls, and the same one the web app uses to
 * render a range. Pure: same inputs, same outputs, no clock, no network.
 */
export function computeExposure(input: ExposureInput, proximityPct = 10): ExposureResult {
  const { sqrtPriceX96, tickCurrent, tickLower, tickUpper, liquidity, quoteIsToken0 } = input
  if (tickLower >= tickUpper) throw new RangeError(`tickLower (${tickLower}) must be < tickUpper (${tickUpper})`)

  const sqrtLower = getSqrtRatioAtTick(tickLower)
  const sqrtUpper = getSqrtRatioAtTick(tickUpper)

  const amounts = getAmountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity)
  const amount0 = amounts.amount0 + (input.fees0 ?? 0n)
  const amount1 = amounts.amount1 + (input.fees1 ?? 0n)

  const rawPrice = priceFromSqrtRatio(sqrtPriceX96)
  const price = humanPrice(rawPrice, input.decimals0, input.decimals1)

  // Raw amounts against the raw price is dimensionally consistent — the decimal
  // factors cancel in the ratio, so no adjustment can creep in and skew exposure.
  const d0 = new Decimal(amount0.toString())
  const d1 = new Decimal(amount1.toString())

  let baseValueRaw: Decimal
  let totalValueRaw: Decimal
  let quoteDecimals: number
  if (quoteIsToken0) {
    const t1InQuote = rawPrice.isZero() ? new Decimal(0) : d1.div(rawPrice)
    baseValueRaw = t1InQuote
    totalValueRaw = d0.plus(t1InQuote)
    quoteDecimals = input.decimals0
  } else {
    const t0InQuote = d0.mul(rawPrice)
    baseValueRaw = t0InQuote
    totalValueRaw = t0InQuote.plus(d1)
    quoteDecimals = input.decimals1
  }

  const exposurePct = totalValueRaw.isZero()
    ? new Decimal(0)
    : baseValueRaw.div(totalValueRaw).mul(100).toDecimalPlaces(10)

  const valueQuote = totalValueRaw.div(new Decimal(10).pow(quoteDecimals))
  const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper

  // Distance is measured in price terms, not ticks: a user reasons about "10%
  // from the edge" as a price move, and ticks are logarithmic.
  const priceLower = priceFromSqrtRatio(sqrtLower)
  const priceUpper = priceFromSqrtRatio(sqrtUpper)
  const clampPct = (d: Decimal) => (d.isNegative() ? new Decimal(0) : d.toDecimalPlaces(10))
  const distanceToLowerPct = rawPrice.isZero()
    ? new Decimal(0)
    : clampPct(rawPrice.minus(priceLower).div(rawPrice).mul(100))
  const distanceToUpperPct = rawPrice.isZero()
    ? new Decimal(0)
    : clampPct(priceUpper.minus(rawPrice).div(rawPrice).mul(100))

  const nearestBoundary = distanceToLowerPct.lte(distanceToUpperPct) ? 'lower' : 'upper'
  const nearest = Decimal.min(distanceToLowerPct, distanceToUpperPct)
  const nearBoundary = inRange && nearest.lte(proximityPct)

  return {
    amount0,
    amount1,
    exposurePct,
    valueQuote,
    price,
    inRange,
    distanceToLowerPct,
    distanceToUpperPct,
    nearBoundary,
    nearestBoundary,
  }
}

// ── Rebalance planning ──────────────────────────────────────────────────────

const ONE = new Decimal(1)
const ZERO = new Decimal(0)
const LN_1_0001 = new Decimal('1.0001').ln()

export interface RebalancePlanInput {
  sqrtPriceX96: bigint
  tickCurrent: number
  /** Range boundaries must be multiples of this or the pool rejects the mint. */
  tickSpacing: number
  /** How far below the upper bound the replacement range reaches, in percent. */
  depthPct: number
  /** Ceiling on the base-token share the replacement may open with, in percent. */
  maxBasePct: number
}

export interface RebalancePlan {
  tickLower: number
  tickUpper: number
  /** Width of the range in price terms: the lower bound is this far below the upper. */
  dropPct: Decimal
  /** How far the upper bound sits above the current price, in percent. */
  offsetPct: Decimal
  /** Base-token share the position opens with, 0–100 — the exposure it *starts* at. */
  baseSharePct: Decimal
  /** One `tickSpacing` step expressed as a percentage of price. */
  stepPct: Decimal
  /** > 0 when the offset was rejected: the share it would have opened with. */
  skippedSharePct: Decimal
  /** False when the range opens entirely below price — 100% quote, earning nothing. */
  inRangeAtOpen: boolean
}

/**
 * Where to put the replacement range after an exit.
 *
 * An upper bound exactly at the current price means the position is born 100%
 * quote and immediately out of range: it earns nothing until price falls into
 * it. Putting the bound slightly *above* price makes it earn from the first
 * block — but the slice between price and that bound has to be filled with the
 * base token, so the position opens already exposed.
 *
 * Because the bound must be a multiple of `tickSpacing`, the smallest exposure
 * that is still in range is always exactly one step above price. Anything
 * further is strictly more exposed, so there is no optimisation to run: compute
 * the share at that one step and accept it only if it is under the ceiling.
 *
 * How big that share is depends on the pool *and* on where price sits inside its
 * spacing cell — a pool with `tickSpacing` 889 moves 9.3% per step, so the same
 * rule yields anywhere from 0% to 16%. `maxBasePct` is what bounds it; when the
 * step is too coarse the plan falls back to opening out of range, which is the
 * conservative direction (`skippedSharePct` records what was refused).
 *
 * The exposure is a ceiling rather than a fixed cost: `amount0 = L(1/√P − 1/√Pb)`
 * goes to zero as price rises to the upper bound, so the base side sells itself
 * off along the way and the position returns to 100% quote on its own.
 *
 * Pure — no clock, no network, no chain reads.
 */
export function planRebalance(input: RebalancePlanInput): RebalancePlan {
  const { sqrtPriceX96, tickCurrent, tickSpacing, depthPct, maxBasePct } = input

  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new RangeError(`tickSpacing must be a positive integer, got ${tickSpacing}`)
  }
  if (!(depthPct > 0 && depthPct < 100)) {
    throw new RangeError(`depthPct must be inside (0, 100), got ${depthPct}`)
  }

  const priceNow = priceFromSqrtRatio(sqrtPriceX96)
  if (priceNow.lte(0)) throw new RangeError('sqrtPriceX96 must be positive')

  // Depth is stated in price, ranges are measured in ticks: width =
  // -ln(1 - depth) / ln(1.0001), rounded to a whole number of spacing steps.
  const depth = new Decimal(depthPct).div(100)
  const steps = Decimal.max(
    1,
    ONE.minus(depth).ln().neg().div(LN_1_0001).div(tickSpacing).toDecimalPlaces(0, Decimal.ROUND_HALF_UP),
  )
  const widthTicks = steps.toNumber() * tickSpacing

  const stepPct = priceAtTick(tickSpacing).minus(1).mul(100).toDecimalPlaces(10)
  // The multiple of tickSpacing at or below price — the highest bound that keeps
  // the position entirely out of the base token.
  const atPrice = Math.floor(tickCurrent / tickSpacing) * tickSpacing

  const pack = (tickUpper: number, baseSharePct: Decimal, skippedSharePct: Decimal): RebalancePlan => {
    let tickLower = tickUpper - widthTicks
    if (tickLower >= tickUpper) tickLower = tickUpper - tickSpacing
    if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
      throw new RangeError(`planned range [${tickLower}, ${tickUpper}] falls outside the tick domain`)
    }
    const priceUpper = priceAtTick(tickUpper)
    const priceLower = priceAtTick(tickLower)
    return {
      tickLower,
      tickUpper,
      dropPct: ONE.minus(priceLower.div(priceUpper)).mul(100).toDecimalPlaces(10),
      offsetPct: priceUpper.div(priceNow).minus(1).mul(100).toDecimalPlaces(10),
      baseSharePct,
      stepPct,
      skippedSharePct,
      inRangeAtOpen: tickUpper > tickCurrent,
    }
  }

  if (!(maxBasePct > 0)) return pack(atPrice, ZERO, ZERO)

  const tickUpper = atPrice + tickSpacing
  const tickLower = tickUpper - widthTicks
  if (tickLower < MIN_TICK || tickUpper > MAX_TICK) return pack(atPrice, ZERO, ZERO)

  // With liquidity constant and price P inside [Pa, Pb]:
  //   quote-side value ∝ 1 − √(Pa/P)      base-side value ∝ 1 − √(P/Pb)
  const vQuote = ONE.minus(priceAtTick(tickLower).div(priceNow).sqrt())
  const vBase = ONE.minus(priceNow.div(priceAtTick(tickUpper)).sqrt())
  const total = vBase.plus(vQuote)
  if (vBase.lte(0) || total.lte(0)) return pack(atPrice, ZERO, ZERO)

  const sharePct = vBase.div(total).mul(100).toDecimalPlaces(10)
  // Over the ceiling: better to open out of range than to hold more of the base
  // token than the user allowed.
  if (sharePct.gt(maxBasePct)) return pack(atPrice, ZERO, sharePct)
  return pack(tickUpper, sharePct, ZERO)
}
