import { describe, expect, it } from 'vitest'
import {
  Decimal,
  MIN_APR_AGE_MS,
  annualisedFeeApr,
  compareToHodl,
  computeCostBasis,
  solveSqrtPriceFromDelta,
  timeInRange,
  valueInQuote,
} from '../src/performance/index.js'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '../src/tickmath/index.js'

const TICK_LOWER = -6000
const TICK_UPPER = 6000
const LIQUIDITY = 10n ** 18n

/** USDG-style pair: 18-decimal base as token0, 18-decimal quote as token1. */
const PAIR = { quoteIsToken0: false, decimals0: 18, decimals1: 18 } as const

describe('solveSqrtPriceFromDelta', () => {
  /*
   * The property that matters: the inversion undoes `LiquidityAmounts`. If a
   * price is recoverable from the amounts a mint pulled in, every cost basis
   * downstream is exact without an oracle — and if it is not, none of them are.
   */
  it.each([-5000, -1234, 0, 777, 5000])('recovers the price at tick %i', (tick) => {
    const sqrtPrice = getSqrtRatioAtTick(tick)
    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPrice,
      getSqrtRatioAtTick(TICK_LOWER),
      getSqrtRatioAtTick(TICK_UPPER),
      LIQUIDITY,
    )

    const solved = solveSqrtPriceFromDelta({ amount0, amount1, liquidity: LIQUIDITY }, TICK_LOWER, TICK_UPPER)

    expect(solved).not.toBeNull()
    expect(solved!.exact).toBe(true)
    expect(solved!.bound).toBeNull()

    // Rounding in the forward amount calculation costs a few wei of sqrt price;
    // as a share of a Q64.96 value that is far below any figure we display.
    const drift = new Decimal(solved!.sqrtPriceX96.toString())
      .minus(sqrtPrice.toString())
      .abs()
      .div(sqrtPrice.toString())
    expect(drift.lt(1e-15)).toBe(true)
  })

  it('bounds rather than guesses when the deposit was one-sided below the range', () => {
    const sqrtPrice = getSqrtRatioAtTick(TICK_LOWER - 500)
    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPrice,
      getSqrtRatioAtTick(TICK_LOWER),
      getSqrtRatioAtTick(TICK_UPPER),
      LIQUIDITY,
    )
    expect(amount1).toBe(0n)

    const solved = solveSqrtPriceFromDelta({ amount0, amount1, liquidity: LIQUIDITY }, TICK_LOWER, TICK_UPPER)

    expect(solved).toEqual({
      sqrtPriceX96: getSqrtRatioAtTick(TICK_LOWER),
      exact: false,
      bound: 'at_or_below_lower',
    })
  })

  it('bounds the other way above the range', () => {
    const sqrtPrice = getSqrtRatioAtTick(TICK_UPPER + 500)
    const { amount0, amount1 } = getAmountsForLiquidity(
      sqrtPrice,
      getSqrtRatioAtTick(TICK_LOWER),
      getSqrtRatioAtTick(TICK_UPPER),
      LIQUIDITY,
    )
    expect(amount0).toBe(0n)

    const solved = solveSqrtPriceFromDelta({ amount0, amount1, liquidity: LIQUIDITY }, TICK_LOWER, TICK_UPPER)
    expect(solved?.bound).toBe('at_or_above_upper')
    expect(solved?.exact).toBe(false)
  })

  it('returns null when the event says nothing about price', () => {
    expect(solveSqrtPriceFromDelta({ amount0: 1n, amount1: 1n, liquidity: 0n }, TICK_LOWER, TICK_UPPER)).toBeNull()
    expect(solveSqrtPriceFromDelta({ amount0: 0n, amount1: 0n, liquidity: LIQUIDITY }, TICK_LOWER, TICK_UPPER)).toBeNull()
  })

  it('rejects an inverted range rather than returning a plausible number', () => {
    expect(() => solveSqrtPriceFromDelta({ amount0: 1n, amount1: 1n, liquidity: LIQUIDITY }, 10, 10)).toThrow(RangeError)
  })
})

describe('compareToHodl', () => {
  const sqrtPrice = getSqrtRatioAtTick(0)

  it('reports no impermanent loss when the position still holds what went in', () => {
    const result = compareToHodl({
      deposited0: 1_000n * 10n ** 18n,
      deposited1: 1_000n * 10n ** 18n,
      withdrawn0: 0n,
      withdrawn1: 0n,
      current0: 1_000n * 10n ** 18n,
      current1: 1_000n * 10n ** 18n,
      fees0: 0n,
      fees1: 0n,
      sqrtPriceX96: sqrtPrice,
      ...PAIR,
    })

    expect(result.impermanentLossQuote.isZero()).toBe(true)
    expect(result.netVsHodlQuote.isZero()).toBe(true)
  })

  /*
   * The case the whole comparison exists for: price moved, the pool sold the
   * riser for the faller, and the fees have to cover the difference.
   */
  it('is negative once the pool has converted one side into the other', () => {
    const result = compareToHodl({
      deposited0: 1_000n * 10n ** 18n,
      deposited1: 1_000n * 10n ** 18n,
      withdrawn0: 0n,
      withdrawn1: 0n,
      // Price rose, so the pool sold token0 down and holds more token1.
      current0: 500n * 10n ** 18n,
      current1: 1_400n * 10n ** 18n,
      fees0: 0n,
      fees1: 0n,
      sqrtPriceX96: getSqrtRatioAtTick(4000),
      ...PAIR,
    })

    expect(result.impermanentLossQuote.isNegative()).toBe(true)
    expect(result.netVsHodlQuote.equals(result.impermanentLossQuote)).toBe(true)
  })

  it('counts withdrawn principal as still the owner’s', () => {
    const withdrawn = compareToHodl({
      deposited0: 1_000n * 10n ** 18n,
      deposited1: 0n,
      withdrawn0: 400n * 10n ** 18n,
      withdrawn1: 0n,
      current0: 600n * 10n ** 18n,
      current1: 0n,
      fees0: 0n,
      fees1: 0n,
      sqrtPriceX96: sqrtPrice,
      ...PAIR,
    })

    // Half the principal sitting in the owner's wallet is not a loss, and a
    // comparison that ignored it would report one every time anyone trimmed.
    expect(withdrawn.impermanentLossQuote.isZero()).toBe(true)
    expect(withdrawn.withdrawnValueQuote.toFixed(0)).toBe('400')
  })

  it('lets fee income offset the loss', () => {
    const base = {
      deposited0: 1_000n * 10n ** 18n,
      deposited1: 1_000n * 10n ** 18n,
      withdrawn0: 0n,
      withdrawn1: 0n,
      current0: 500n * 10n ** 18n,
      current1: 1_400n * 10n ** 18n,
      sqrtPriceX96: getSqrtRatioAtTick(4000),
      ...PAIR,
    }

    const without = compareToHodl({ ...base, fees0: 0n, fees1: 0n })
    const with_ = compareToHodl({ ...base, fees0: 0n, fees1: 500n * 10n ** 18n })

    expect(with_.impermanentLossQuote.equals(without.impermanentLossQuote)).toBe(true)
    expect(with_.netVsHodlQuote.gt(without.netVsHodlQuote)).toBe(true)
  })
})

describe('valueInQuote', () => {
  it('agrees with itself whichever side of the pair is the quote', () => {
    const sqrtPrice = getSqrtRatioAtTick(0) // price = 1, so the sides are worth the same
    const asToken1 = valueInQuote({
      amount0: 5n * 10n ** 18n,
      amount1: 3n * 10n ** 18n,
      sqrtPriceX96: sqrtPrice,
      quoteIsToken0: false,
      decimals0: 18,
      decimals1: 18,
    })
    const asToken0 = valueInQuote({
      amount0: 5n * 10n ** 18n,
      amount1: 3n * 10n ** 18n,
      sqrtPriceX96: sqrtPrice,
      quoteIsToken0: true,
      decimals0: 18,
      decimals1: 18,
    })

    expect(asToken1.toFixed(0)).toBe('8')
    expect(asToken0.toFixed(0)).toBe('8')
  })
})

describe('computeCostBasis', () => {
  const flow = (value: string, exact = true) => ({ valueQuote: new Decimal(value), exact })

  it('nets position, withdrawals and fees against what went in', () => {
    const basis = computeCostBasis({
      deposits: [flow('1000')],
      withdrawals: [flow('200')],
      positionValueQuote: new Decimal('850'),
      feesValueQuote: new Decimal('30'),
      ledgerComplete: true,
    })

    expect(basis.costBasisQuote.toFixed(0)).toBe('1000')
    expect(basis.netPnlQuote.toFixed(0)).toBe('80')
    expect(basis.roiPct!.toFixed(1)).toBe('8.0')
    expect(basis.complete).toBe(true)
  })

  it('is incomplete when any deposit could only be bounded', () => {
    const basis = computeCostBasis({
      deposits: [flow('1000'), flow('500', false)],
      withdrawals: [],
      positionValueQuote: new Decimal('1600'),
      feesValueQuote: new Decimal('0'),
      ledgerComplete: true,
    })
    expect(basis.complete).toBe(false)
  })

  it('is incomplete when the record cannot reach the mint', () => {
    const basis = computeCostBasis({
      deposits: [flow('1000')],
      withdrawals: [],
      positionValueQuote: new Decimal('1100'),
      feesValueQuote: new Decimal('0'),
      ledgerComplete: false,
    })
    expect(basis.complete).toBe(false)
  })

  it('returns a null ROI rather than dividing by a zero basis', () => {
    const basis = computeCostBasis({
      deposits: [],
      withdrawals: [],
      positionValueQuote: new Decimal('0'),
      feesValueQuote: new Decimal('0'),
      ledgerComplete: true,
    })
    expect(basis.roiPct).toBeNull()
  })
})

describe('annualisedFeeApr', () => {
  const fees = new Decimal('10')
  const basis = new Decimal('1000')

  it('refuses to annualise a sample shorter than the floor', () => {
    expect(annualisedFeeApr(fees, basis, MIN_APR_AGE_MS - 1)).toBeNull()
  })

  it('annualises once the position is old enough', () => {
    // 1% earned over 365 days is 1% a year.
    const apr = annualisedFeeApr(fees, basis, 365 * 24 * 60 * 60 * 1000)
    expect(apr!.toFixed(2)).toBe('1.00')
  })

  it('scales a short window up, which is why the floor exists', () => {
    const apr = annualisedFeeApr(fees, basis, 24 * 60 * 60 * 1000)
    expect(apr!.toFixed(0)).toBe('365')
  })

  it('returns null rather than infinity when there is no basis', () => {
    expect(annualisedFeeApr(fees, new Decimal(0), 10 * MIN_APR_AGE_MS)).toBeNull()
  })
})

describe('timeInRange', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes))

  it('weights by elapsed time rather than counting samples', () => {
    /*
     * Three in-range readings a minute apart, then one out-of-range reading an
     * hour later. By row count that is 75% in range; by time it is 3 minutes of
     * 63, which is what actually happened.
     */
    const result = timeInRange([
      { at: at(0), inRange: true },
      { at: at(1), inRange: true },
      { at: at(2), inRange: true },
      { at: at(3), inRange: false },
      { at: at(63), inRange: false },
    ])

    expect(result!.pct.toFixed(2)).toBe('4.76')
    expect(result!.samples).toBe(5)
    expect(result!.from).toEqual(at(0))
    expect(result!.to).toEqual(at(63))
  })

  it('orders samples it was handed out of order', () => {
    const result = timeInRange([
      { at: at(10), inRange: false },
      { at: at(0), inRange: true },
    ])
    expect(result!.pct.toFixed(0)).toBe('100')
    expect(result!.from).toEqual(at(0))
  })

  it('returns null rather than 0% when there is nothing to measure', () => {
    expect(timeInRange([])).toBeNull()
    expect(timeInRange([{ at: at(0), inRange: true }])).toBeNull()
    expect(timeInRange([{ at: at(0), inRange: true }, { at: at(0), inRange: false }])).toBeNull()
  })
})
