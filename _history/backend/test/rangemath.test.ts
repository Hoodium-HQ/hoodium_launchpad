/**
 * T3.1 · AL-2.2 — exposure math against known tick/liquidity fixtures.
 *
 * The reference values come from Uniswap v3's own TickMath/LiquidityAmounts, so
 * these tests fail if the port drifts from the contracts the pool actually runs.
 */
import { describe, expect, it } from 'vitest'
import Decimal from 'decimal.js'
import {
  computeExposure,
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  MAX_TICK,
  MIN_TICK,
  priceAtTick,
  Q96,
} from '../src/monitor/rangemath.js'

describe('getSqrtRatioAtTick', () => {
  it('returns 2^96 at tick 0 — price 1.0', () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96)
  })

  // Values taken from Uniswap v3-core TickMath.
  it.each([
    [MIN_TICK, 4295128739n],
    [MAX_TICK, 1461446703485210103287273052203988822378723970342n],
    [-887271, 4295343490n],
    [887271, 1461373636630004318706518188784493106690254656249n],
  ])('matches the contract at tick %i', (tick, expected) => {
    expect(getSqrtRatioAtTick(tick)).toBe(expected)
  })

  it('is monotonically increasing', () => {
    let previous = 0n
    for (let tick = -600; tick <= 600; tick += 60) {
      const value = getSqrtRatioAtTick(tick)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })

  it('rejects ticks outside the representable range', () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError)
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(RangeError)
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(RangeError)
  })
})

describe('priceAtTick', () => {
  it('is 1.0 at tick 0', () => {
    expect(priceAtTick(0).toFixed(8)).toBe('1.00000000')
  })

  // price = 1.0001^tick; 1.0001^10000 ≈ 2.71814593
  it('matches 1.0001^tick', () => {
    expect(priceAtTick(10_000).toDecimalPlaces(6).toString()).toBe(
      new Decimal(1.0001).pow(10_000).toDecimalPlaces(6).toString(),
    )
    expect(priceAtTick(-10_000).toDecimalPlaces(6).toString()).toBe(
      new Decimal(1.0001).pow(-10_000).toDecimalPlaces(6).toString(),
    )
  })
})

describe('getAmountsForLiquidity', () => {
  const liquidity = 1_000_000_000_000_000_000n // 1e18
  const lower = -60
  const upper = 60
  const sqrtLower = getSqrtRatioAtTick(lower)
  const sqrtUpper = getSqrtRatioAtTick(upper)

  it('holds only token0 below the range', () => {
    const { amount0, amount1 } = getAmountsForLiquidity(getSqrtRatioAtTick(-120), sqrtLower, sqrtUpper, liquidity)
    expect(amount1).toBe(0n)
    expect(amount0).toBe(getAmount0ForLiquidity(sqrtLower, sqrtUpper, liquidity))
  })

  it('holds only token1 above the range', () => {
    const { amount0, amount1 } = getAmountsForLiquidity(getSqrtRatioAtTick(120), sqrtLower, sqrtUpper, liquidity)
    expect(amount0).toBe(0n)
    expect(amount1).toBe(getAmount1ForLiquidity(sqrtLower, sqrtUpper, liquidity))
  })

  it('holds a balanced mix at the midpoint of a symmetric range', () => {
    const { amount0, amount1 } = getAmountsForLiquidity(getSqrtRatioAtTick(0), sqrtLower, sqrtUpper, liquidity)
    expect(amount0).toBeGreaterThan(0n)
    expect(amount1).toBeGreaterThan(0n)
    // Same decimals on both sides, price 1.0 → the two legs match to rounding.
    const diff = amount0 > amount1 ? amount0 - amount1 : amount1 - amount0
    expect(Number(diff)).toBeLessThan(Number(amount0) * 1e-6)
  })

  it('accepts sqrt bounds in either order', () => {
    const a = getAmountsForLiquidity(getSqrtRatioAtTick(0), sqrtLower, sqrtUpper, liquidity)
    const b = getAmountsForLiquidity(getSqrtRatioAtTick(0), sqrtUpper, sqrtLower, liquidity)
    expect(a).toEqual(b)
  })
})

describe('computeExposure — AL-2.2', () => {
  /** MEME/USDG pool: token0 = MEME (18dp), token1 = USDG (6dp). Quote is token1. */
  const base = {
    tickLower: -1000,
    tickUpper: 1000,
    liquidity: 10n ** 18n,
    quoteIsToken0: false,
    decimals0: 18,
    decimals1: 6,
  }

  it('is 0% when the position is entirely quote — price above the range', () => {
    const result = computeExposure({
      ...base,
      tickCurrent: 1200,
      sqrtPriceX96: getSqrtRatioAtTick(1200),
    })
    expect(result.exposurePct.toFixed(4)).toBe('0.0000')
    expect(result.inRange).toBe(false)
    expect(result.amount0).toBe(0n)
  })

  it('is 100% when the position is entirely the volatile token — price below the range', () => {
    const result = computeExposure({
      ...base,
      tickCurrent: -1200,
      sqrtPriceX96: getSqrtRatioAtTick(-1200),
    })
    expect(result.exposurePct.toFixed(4)).toBe('100.0000')
    expect(result.inRange).toBe(false)
    expect(result.amount1).toBe(0n)
  })

  it('is ~50% at the midpoint of a symmetric range', () => {
    const result = computeExposure({ ...base, tickCurrent: 0, sqrtPriceX96: getSqrtRatioAtTick(0) })
    expect(result.inRange).toBe(true)
    expect(Number(result.exposurePct)).toBeGreaterThan(49.9)
    expect(Number(result.exposurePct)).toBeLessThan(50.1)
  })

  it('rises as price falls — the condition R4 exists to escape', () => {
    const at = (tick: number) =>
      Number(computeExposure({ ...base, tickCurrent: tick, sqrtPriceX96: getSqrtRatioAtTick(tick) }).exposurePct)

    expect(at(-800)).toBeGreaterThan(at(-400))
    expect(at(-400)).toBeGreaterThan(at(0))
    expect(at(0)).toBeGreaterThan(at(400))
  })

  it('mirrors correctly when the quote is token0', () => {
    const asToken1Quote = computeExposure({ ...base, tickCurrent: 300, sqrtPriceX96: getSqrtRatioAtTick(300) })
    // Same pool, but declare token0 the quote: the volatile side flips, so the
    // exposure figure must be the complement.
    const asToken0Quote = computeExposure({
      ...base,
      quoteIsToken0: true,
      tickCurrent: 300,
      sqrtPriceX96: getSqrtRatioAtTick(300),
    })
    const sum = Number(asToken1Quote.exposurePct) + Number(asToken0Quote.exposurePct)
    expect(sum).toBeCloseTo(100, 6)
  })

  it('is unaffected by token decimals — exposure is a ratio, not a USD estimate', () => {
    const sixDp = computeExposure({ ...base, tickCurrent: 0, sqrtPriceX96: getSqrtRatioAtTick(0) })
    const eighteenDp = computeExposure({
      ...base,
      decimals1: 18,
      tickCurrent: 0,
      sqrtPriceX96: getSqrtRatioAtTick(0),
    })
    expect(sixDp.exposurePct.toFixed(8)).toBe(eighteenDp.exposurePct.toFixed(8))
  })

  it('reports 0% exposure and no NaN for an empty position', () => {
    const result = computeExposure({ ...base, liquidity: 0n, tickCurrent: 0, sqrtPriceX96: getSqrtRatioAtTick(0) })
    expect(result.exposurePct.toFixed(2)).toBe('0.00')
    expect(result.valueQuote.toFixed(2)).toBe('0.00')
  })

  it('rejects an inverted range rather than returning a plausible wrong number', () => {
    expect(() =>
      computeExposure({ ...base, tickLower: 1000, tickUpper: -1000, tickCurrent: 0, sqrtPriceX96: Q96 }),
    ).toThrow(RangeError)
  })
})

describe('boundary proximity — AL-3.1', () => {
  // A ±10000-tick range spans roughly -63% to +172% in price. A ±1000-tick range
  // would be only ~±9.5% wide, so its own midpoint sits inside a 10% proximity
  // band — a fixture worth stating explicitly, because it is a real property of
  // narrow ranges and not a bug in the alert rule.
  const base = {
    tickLower: -10_000,
    tickUpper: 10_000,
    liquidity: 10n ** 18n,
    quoteIsToken0: false,
    decimals0: 18,
    decimals1: 6,
  }

  it('flags proximity within the configured percentage', () => {
    const result = computeExposure({ ...base, tickCurrent: 9_500, sqrtPriceX96: getSqrtRatioAtTick(9_500) }, 10)
    expect(result.nearBoundary).toBe(true)
    expect(result.nearestBoundary).toBe('upper')
    expect(Number(result.distanceToUpperPct)).toBeLessThan(10)
  })

  it('does not flag a position sitting mid-range', () => {
    const result = computeExposure({ ...base, tickCurrent: 0, sqrtPriceX96: getSqrtRatioAtTick(0) }, 10)
    expect(result.nearBoundary).toBe(false)
  })

  it('flags a narrow range at its own midpoint, because it genuinely is close', () => {
    const narrow = { ...base, tickLower: -1000, tickUpper: 1000 }
    const result = computeExposure({ ...narrow, tickCurrent: 0, sqrtPriceX96: getSqrtRatioAtTick(0) }, 10)
    expect(result.nearBoundary).toBe(true)
    expect(Number(result.distanceToLowerPct)).toBeLessThan(10)
  })

  it('never reports a negative distance once out of range', () => {
    const result = computeExposure({ ...base, tickCurrent: 12_000, sqrtPriceX96: getSqrtRatioAtTick(12_000) }, 10)
    expect(result.distanceToUpperPct.isNegative()).toBe(false)
    expect(result.nearBoundary).toBe(false) // out of range is its own alert (AL-3.2)
  })

  it('shrinks monotonically as price approaches the upper boundary', () => {
    const distance = (tick: number) =>
      Number(
        computeExposure({ ...base, tickCurrent: tick, sqrtPriceX96: getSqrtRatioAtTick(tick) }, 10)
          .distanceToUpperPct,
      )

    expect(distance(0)).toBeGreaterThan(distance(5_000))
    expect(distance(5_000)).toBeGreaterThan(distance(9_000))
    expect(distance(9_000)).toBeGreaterThan(distance(9_900))
    expect(distance(9_900)).toBeGreaterThan(0)
  })

  it('states distance relative to the current price, so it reads as "how far price must move"', () => {
    // At tick 9500 the upper bound is 1.0001^500 ≈ 1.0513x away — about 5.13%.
    const result = computeExposure({ ...base, tickCurrent: 9_500, sqrtPriceX96: getSqrtRatioAtTick(9_500) }, 10)
    expect(Number(result.distanceToUpperPct)).toBeCloseTo(5.13, 1)
  })
})
