/**
 * T4.1 · design section 6 — where the replacement range goes.
 *
 * The plan makes one promise that matters: a position opened at these ticks, at
 * this price, starts at `baseSharePct` exposure. So the strongest test here is
 * not against hand-computed constants — it feeds the planned range straight back
 * into `computeExposure` (the same function AL-2.2 makes the Monitor use) and
 * checks the two agree. If the planner and the exposure math ever disagree, the
 * cost guard is guarding against a number nobody will actually see.
 */
import { describe, expect, it } from 'vitest'
import { computeExposure, getSqrtRatioAtTick, planRebalance } from '../src/monitor/rangemath.js'

const plan = (tick: number, tickSpacing: number, depthPct = 15, maxBasePct = 16) =>
  planRebalance({
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tickCurrent: tick,
    tickSpacing,
    depthPct,
    maxBasePct,
  })

/** Exposure a position with this range would actually open at, at this price. */
function openingExposurePct(tick: number, tickLower: number, tickUpper: number): number {
  return computeExposure({
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tickCurrent: tick,
    tickLower,
    tickUpper,
    liquidity: 10n ** 18n,
    // token1 is the quote side, so the base token is token0 — the upper leg of
    // the range, which is exactly the share the plan is bounding.
    quoteIsToken0: false,
    decimals0: 18,
    decimals1: 18,
  }).exposurePct.toNumber()
}

describe('planRebalance', () => {
  it('aligns both boundaries to tickSpacing', () => {
    // Not a multiple of 60, so alignment has something to do.
    const p = plan(12_345, 60)
    expect(p.tickLower % 60).toBe(0)
    expect(p.tickUpper % 60).toBe(0)
    expect(p.tickLower).toBeLessThan(p.tickUpper)
  })

  it('translates depthPct into a range that deep in price terms', () => {
    const p = plan(12_345, 60, 15)
    // Rounding to whole spacing steps costs a little precision; 60 ticks is 0.6%.
    expect(p.dropPct.toNumber()).toBeGreaterThan(14)
    expect(p.dropPct.toNumber()).toBeLessThan(16)
  })

  it('opens out of range and fully in quote when the offset is disabled', () => {
    const p = plan(12_345, 60, 15, 0)
    expect(p.baseSharePct.toNumber()).toBe(0)
    expect(p.inRangeAtOpen).toBe(false)
    // The bound sits at or below price, so the position holds no base token.
    expect(p.tickUpper).toBeLessThanOrEqual(12_345)
    expect(openingExposurePct(12_345, p.tickLower, p.tickUpper)).toBe(0)
  })

  it('places the bound one step above price so the position earns immediately', () => {
    const p = plan(12_345, 60)
    expect(p.inRangeAtOpen).toBe(true)
    expect(p.tickUpper).toBe(12_360) // floor(12345/60)*60 + 60
    expect(p.baseSharePct.toNumber()).toBeGreaterThan(0)
    expect(p.skippedSharePct.toNumber()).toBe(0)
  })

  it('predicts the opening exposure the exposure math will report', () => {
    for (const tick of [12_345, -4_321, 0, 887, 60_000]) {
      const p = plan(tick, 60)
      const actual = openingExposurePct(tick, p.tickLower, p.tickUpper)
      expect(Math.abs(actual - p.baseSharePct.toNumber())).toBeLessThan(0.05)
    }
  })

  it('never opens above the ceiling — a coarse pool falls back to one-sided', () => {
    // tickSpacing 889 is one step ≈ +9.3% in price. Depending on where price
    // sits in that cell the smallest reachable exposure can be well past 16%,
    // and then opening out of range is the conservative answer.
    const maxBasePct = 16
    let sawFallback = false
    for (let tick = 0; tick < 889 * 4; tick += 37) {
      const p = plan(tick, 889, 30, maxBasePct)
      expect(p.baseSharePct.toNumber()).toBeLessThanOrEqual(maxBasePct)
      if (p.skippedSharePct.toNumber() > 0) {
        sawFallback = true
        // The refusal records what it refused, and the plan degrades to
        // one-sided rather than to a revert.
        expect(p.skippedSharePct.toNumber()).toBeGreaterThan(maxBasePct)
        expect(p.baseSharePct.toNumber()).toBe(0)
        expect(p.inRangeAtOpen).toBe(false)
      }
    }
    expect(sawFallback).toBe(true)
  })

  it('reports one spacing step as a percentage of price', () => {
    expect(plan(0, 60).stepPct.toNumber()).toBeCloseTo(0.6018, 3) // 1.0001^60 - 1
    expect(plan(0, 889).stepPct.toNumber()).toBeCloseTo(9.3, 1)
  })

  it('keeps the range at least one spacing step wide', () => {
    // A depth so shallow it rounds to zero steps would otherwise invert the range.
    const p = plan(12_345, 889, 0.5)
    expect(p.tickUpper - p.tickLower).toBe(889)
  })

  it('rejects inputs it cannot align or interpret', () => {
    expect(() => plan(0, 0)).toThrow(RangeError)
    expect(() => plan(0, 1.5)).toThrow(RangeError)
    expect(() => plan(0, 60, 0)).toThrow(RangeError)
    expect(() => plan(0, 60, 100)).toThrow(RangeError)
  })
})
