/**
 * Average-cost accounting — the arithmetic behind every PnL figure on a profile.
 *
 * The property under test throughout: after a partial sell, the remaining `cost`
 * must be the cost of the remaining `qty`. Get that wrong and the entry price
 * moves every time somebody takes profit, which is exactly the number a trader
 * would notice and never trust again.
 */
import { describe, expect, it } from 'vitest'
import { accumulate, type TradeRow } from '../src/launchpad/portfolio.js'

/** One whole token, in 18-decimal base units. */
const ONE = 10n ** 18n

function trade(side: 'buy' | 'sell', tokens: bigint, quote: string, at = new Date(0)): TradeRow {
  return {
    tokenAddress: '0xtoken',
    side,
    usdgAmount: quote,
    tokenAmount: tokens.toString(),
    priceUsdg: '0',
    txHash: '0x',
    at,
    finalized: true,
  }
}

describe('accumulate', () => {
  it('sums quantity and cost across buys', () => {
    const result = accumulate([trade('buy', 100n * ONE, '1000'), trade('buy', 100n * ONE, '3000')])

    expect(result.qty.toFixed(0)).toBe((200n * ONE).toString())
    expect(result.cost.toFixed(0)).toBe('4000')
    expect(result.realized.toFixed(0)).toBe('0')
  })

  it('removes basis at average cost on a partial sell, not at the sale price', () => {
    // 200 tokens for 4000 → average 20 each. Selling half removes 2000 of basis
    // regardless of what the half actually fetched.
    const result = accumulate([
      trade('buy', 100n * ONE, '1000'),
      trade('buy', 100n * ONE, '3000'),
      trade('sell', 100n * ONE, '5000'),
    ])

    expect(result.qty.toFixed(0)).toBe((100n * ONE).toString())
    expect(result.cost.toFixed(0)).toBe('2000')
    expect(result.realized.toFixed(0)).toBe('3000')
  })

  it('leaves the entry price unchanged by a partial exit', () => {
    const before = accumulate([trade('buy', 200n * ONE, '4000')])
    const after = accumulate([trade('buy', 200n * ONE, '4000'), trade('sell', 50n * ONE, '9999')])

    const entry = (r: ReturnType<typeof accumulate>) => r.cost.mul(ONE.toString()).div(r.qty).toFixed(0)
    expect(entry(after)).toBe(entry(before))
  })

  it('zeroes the position on a full exit', () => {
    const result = accumulate([trade('buy', 100n * ONE, '1000'), trade('sell', 100n * ONE, '1500')])

    expect(result.qty.toFixed(0)).toBe('0')
    expect(result.cost.toFixed(0)).toBe('0')
    expect(result.realized.toFixed(0)).toBe('500')
  })

  it('records a loss as a negative realised figure', () => {
    const result = accumulate([trade('buy', 100n * ONE, '1000'), trade('sell', 100n * ONE, '400')])
    expect(result.realized.toFixed(0)).toBe('-600')
  })

  it('never goes negative when a sell exceeds what the trades account for', () => {
    /*
     * Tokens can arrive by plain ERC-20 transfer, which emits no curve event. The
     * seller then disposes of more than we ever saw them buy. Clamping keeps the
     * arithmetic sane; the reconciliation against `balanceOf` in `buildPortfolio`
     * is what actually reports the discrepancy, by withholding PnL.
     */
    const result = accumulate([trade('buy', 100n * ONE, '1000'), trade('sell', 500n * ONE, '5000')])

    expect(result.qty.toFixed(0)).toBe('0')
    expect(result.cost.toFixed(0)).toBe('0')
    expect(result.realized.isPositive()).toBe(true)
  })

  it('ignores a sell with no position behind it', () => {
    const result = accumulate([trade('sell', 100n * ONE, '1000')])

    expect(result.qty.toFixed(0)).toBe('0')
    expect(result.cost.toFixed(0)).toBe('0')
    expect(result.realized.toFixed(0)).toBe('0')
  })

  it('tracks the first and last timestamps it saw', () => {
    const first = new Date('2026-01-01T00:00:00Z')
    const last = new Date('2026-02-01T00:00:00Z')
    const result = accumulate([
      trade('buy', ONE, '10', first),
      trade('buy', ONE, '10', new Date('2026-01-15T00:00:00Z')),
      trade('sell', ONE, '20', last),
    ])

    expect(result.first).toEqual(first)
    expect(result.last).toEqual(last)
  })

  it('keeps full precision on 18-decimal quantities', () => {
    // A figure well past 2^53 — the point at which a Number would start lying.
    const odd = 123_456_789_012_345_678_901n
    const result = accumulate([trade('buy', odd, '1')])
    expect(result.qty.toFixed(0)).toBe(odd.toString())
  })
})
