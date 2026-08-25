/**
 * Curve math — the same invariants the Solidity fuzz tests assert (LP-N4, T2.1,
 * T2.2), re-asserted against the TypeScript mirror.
 *
 * This is what makes the mirror trustworthy. If the TS implementation drifts
 * from `BondingCurve.sol`, one of these properties breaks, because they are the
 * properties the contract was written to satisfy.
 */
import { describe, expect, it } from 'vitest'
import {
  applyBuy,
  applySell,
  currentK,
  curveComplete,
  deriveVirtualTokens,
  progressBps,
  quoteBuy,
  quoteSell,
  remainingToTarget,
  type CurveState,
} from '../src/curve/index.js'

const USDG = 10n ** 6n
const TOKEN = 10n ** 18n

const CURVE_ALLOCATION = 800_000_000n * TOKEN
const VIRTUAL_USDG = 23_000n * USDG // the factory derives this; 23,000 with the deploy defaults
const TARGET = 69_000n * USDG

function freshState(): CurveState {
  return {
    virtualUsdg: VIRTUAL_USDG,
    virtualTokens: deriveVirtualTokens(CURVE_ALLOCATION, VIRTUAL_USDG, TARGET),
    curveAllocation: CURVE_ALLOCATION,
    reserveUsdg: 0n,
    tokensSold: 0n,
    graduationTarget: TARGET,
    tradeFeeBps: 100n,
  }
}

describe('deriveVirtualTokens', () => {
  it('matches the factory formula vT = C x vU / target', () => {
    expect(deriveVirtualTokens(CURVE_ALLOCATION, VIRTUAL_USDG, TARGET)).toBe(
      (CURVE_ALLOCATION * VIRTUAL_USDG) / TARGET,
    )
  })
})

describe('k never decreases — LP-N4, mirrors T2.1', () => {
  it('holds across a buy', () => {
    let state = freshState()
    const before = currentK(state)
    state = applyBuy(state, 5_000n * USDG).state
    expect(currentK(state)).toBeGreaterThanOrEqual(before)
  })

  it('holds across an arbitrary buy/sell sequence', () => {
    let state = freshState()
    let k = currentK(state)

    const script: Array<['buy' | 'sell', bigint]> = [
      ['buy', 1_000n * USDG],
      ['buy', 250n * USDG],
      ['sell', 1_000_000n * TOKEN],
      ['buy', 12_345n * USDG],
      ['sell', 5_000_000n * TOKEN],
      ['buy', 1n * USDG],
      ['sell', 1n * TOKEN],
    ]

    for (const [side, amount] of script) {
      state = side === 'buy' ? applyBuy(state, amount).state : applySell(state, amount).state
      const next = currentK(state)
      expect(next).toBeGreaterThanOrEqual(k)
      k = next
    }
  })

  it('holds across 200 dust round trips — the drain attack', () => {
    let state = applyBuy(freshState(), 5_000n * USDG).state
    const reserveBefore = state.reserveUsdg
    const kBefore = currentK(state)

    for (let i = 0; i < 200; i++) {
      const buy = applyBuy(state, 1n)
      state = buy.state
      if (buy.quote.tokensOut > 0n) state = applySell(state, buy.quote.tokensOut).state
    }

    expect(state.reserveUsdg).toBeGreaterThanOrEqual(reserveBefore)
    expect(currentK(state)).toBeGreaterThanOrEqual(kBefore)
  })
})

describe('a round trip never profits the caller — LP-N8, mirrors T2.2', () => {
  const amounts = [1n * USDG, 37n * USDG, 500n * USDG, 4_321n * USDG, 20_000n * USDG]

  it.each(amounts)('holds for %s', (usdgIn) => {
    const start = freshState()
    const buy = quoteBuy(start, usdgIn)
    if (buy.tokensOut === 0n) return

    const spent = buy.netIn + buy.fee
    const after = applyBuy(start, usdgIn).state
    const sell = quoteSell(after, buy.tokensOut)

    expect(sell.usdgOut).toBeLessThanOrEqual(spent)
  })

  it('holds after somebody else moved the price', () => {
    const moved = applyBuy(freshState(), 15_000n * USDG).state
    const buy = quoteBuy(moved, 3_000n * USDG)
    const spent = buy.netIn + buy.fee

    const after = applyBuy(moved, 3_000n * USDG).state
    const sell = quoteSell(after, buy.tokensOut)

    expect(sell.usdgOut).toBeLessThanOrEqual(spent)
  })
})

describe('overshoot handling — LP-2.6', () => {
  it('clamps at the target and refunds the excess', () => {
    const state = freshState()
    const quote = quoteBuy(state, 500_000n * USDG)

    expect(quote.netIn).toBe(TARGET)
    expect(quote.refund).toBeGreaterThan(0n)
    expect(quote.netIn + quote.fee + quote.refund).toBe(500_000n * USDG)

    const after = applyBuy(state, 500_000n * USDG).state
    expect(after.reserveUsdg).toBe(TARGET)
    expect(curveComplete(after)).toBe(true)
    expect(remainingToTarget(after)).toBe(0n)
  })

  it('refuses further buys once complete', () => {
    const complete = applyBuy(freshState(), 500_000n * USDG).state
    expect(quoteBuy(complete, 1_000n * USDG).tokensOut).toBe(0n)
  })

  it('sells the whole allocation by the time the target is hit', () => {
    const complete = applyBuy(freshState(), 500_000n * USDG).state
    // Rounding favours the contract, so a sliver may remain — it rolls into the
    // pool at graduation rather than being lost.
    expect(complete.tokensSold).toBeLessThanOrEqual(CURVE_ALLOCATION)
    expect(complete.tokensSold).toBeGreaterThan(CURVE_ALLOCATION - CURVE_ALLOCATION / 1_000_000n)
  })
})

describe('rounding always favours the contract — LP-N8', () => {
  it('rounds the fee up, not down', () => {
    // 101 units at 1% is 1.01 → the contract takes 2, never 1.
    const quote = quoteBuy(freshState(), 101n)
    expect(quote.fee).toBe(2n)
  })

  it('never mints tokens for an input entirely consumed by the fee', () => {
    expect(quoteBuy(freshState(), 1n).tokensOut).toBe(0n)
  })
})

describe('sell bounds', () => {
  it('refuses to sell more than the curve has sold', () => {
    const state = applyBuy(freshState(), 1_000n * USDG).state
    expect(quoteSell(state, state.tokensSold + 1n).usdgOut).toBe(0n)
  })

  it('never pays out the virtual reserve', () => {
    const state = applyBuy(freshState(), 1_000n * USDG).state
    const sell = quoteSell(state, state.tokensSold)
    expect(sell.grossOut).toBeLessThanOrEqual(state.reserveUsdg)
  })
})

describe('progressBps', () => {
  it('is an integer basis-point value, never a float', () => {
    const state = applyBuy(freshState(), 34_500n * USDG).state
    const bps = progressBps(state)
    expect(Number.isInteger(bps)).toBe(true)
    expect(bps).toBeGreaterThan(4_000)
    expect(bps).toBeLessThan(6_000)
  })

  it('caps at 10000', () => {
    expect(progressBps(applyBuy(freshState(), 500_000n * USDG).state)).toBe(10_000)
  })
})
