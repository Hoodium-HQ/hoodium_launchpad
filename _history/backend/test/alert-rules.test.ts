/**
 * T3.5 · AL-3.1, AL-3.2 — the alert decision table, tested without a database.
 */
import { describe, expect, it } from 'vitest'
import { classify } from '../src/alerts/rules.js'
import { computeExposure, getSqrtRatioAtTick } from '../src/monitor/rangemath.js'

// ±10000 ticks ≈ -63%/+172% in price. Wide enough that the midpoint is not
// itself inside a 10% proximity band — see rangemath.test.ts for why that
// matters on narrow ranges.
const position = {
  tickLower: -10_000,
  tickUpper: 10_000,
  liquidity: 10n ** 18n,
  quoteIsToken0: false,
  decimals0: 18,
  decimals1: 6,
}

function at(tick: number, proximityPct = 10) {
  const exposure = computeExposure({ ...position, tickCurrent: tick, sqrtPriceX96: getSqrtRatioAtTick(tick) }, proximityPct)
  return classify({
    tickCurrent: tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    exposure,
  })
}

describe('classify', () => {
  it('stays silent mid-range', () => {
    expect(at(0)).toEqual({ kind: 'none' })
  })

  it('raises out_of_range below the lower boundary (AL-3.2)', () => {
    expect(at(-12_000)).toEqual({ kind: 'out_of_range', boundary: 'lower' })
  })

  it('raises out_of_range above the upper boundary (AL-3.2)', () => {
    expect(at(12_000)).toEqual({ kind: 'out_of_range', boundary: 'upper' })
  })

  it('treats the upper tick itself as out of range, matching Uniswap', () => {
    // A position is in range for tickLower <= tick < tickUpper.
    expect(at(10_000).kind).toBe('out_of_range')
    expect(at(-10_000).kind).toBe('range_proximity')
  })

  it('raises range_proximity with a stated percentage (AL-3.1)', () => {
    const verdict = at(9_500)
    expect(verdict.kind).toBe('range_proximity')
    if (verdict.kind !== 'range_proximity') return
    expect(verdict.boundary).toBe('upper')
    // AL-3.1 requires the distance stated as a percentage, not a tick count.
    expect(Number(verdict.distancePct)).toBeGreaterThan(0)
    expect(Number(verdict.distancePct)).toBeLessThan(10)
  })

  it('names the nearer boundary when the range is asymmetric around price', () => {
    const verdict = at(-9_500)
    expect(verdict.kind).toBe('range_proximity')
    if (verdict.kind !== 'range_proximity') return
    expect(verdict.boundary).toBe('lower')
  })

  it('honours a narrower proximity threshold', () => {
    // ~5% from the edge: inside a 10% band, outside a 0.1% one.
    expect(at(9_500, 10).kind).toBe('range_proximity')
    expect(at(9_500, 0.1).kind).toBe('none')
  })
})
