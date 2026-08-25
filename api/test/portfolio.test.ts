/**
 * Average-cost accounting. The property under test: after a partial sell, the
 * remaining `cost` must be the cost of the remaining `qty`.
 */
import { describe, expect, it } from 'vitest'
import { accumulate, type TradeRow } from '../src/services/portfolio.js'

const ONE = 10n ** 18n

function trade(side: 'buy' | 'sell', tokens: bigint, quote: string, at = new Date(0)): TradeRow {
  return { tokenAddress: '0xtoken', side, usdgAmount: quote, tokenAmount: tokens.toString(), at }
}

describe('accumulate', () => {
  it('sums quantity and cost across buys', () => {
    const r = accumulate([trade('buy', 100n * ONE, '1000'), trade('buy', 100n * ONE, '3000')])
    expect(r.qty).toBe(200n * ONE)
    expect(r.cost).toBe(4000n)
    expect(r.realized).toBe(0n)
  })

  it('removes basis at average cost on a partial sell, not at the sale price', () => {
    const r = accumulate([
      trade('buy', 100n * ONE, '1000'),
      trade('buy', 100n * ONE, '3000'),
      trade('sell', 100n * ONE, '5000'),
    ])
    expect(r.qty).toBe(100n * ONE)
    expect(r.cost).toBe(2000n)
    expect(r.realized).toBe(3000n)
  })

  it('leaves the entry price unchanged by a partial exit', () => {
    const before = accumulate([trade('buy', 200n * ONE, '4000')])
    const after = accumulate([trade('buy', 200n * ONE, '4000'), trade('sell', 50n * ONE, '9999')])
    const entry = (r: ReturnType<typeof accumulate>) => (r.cost * ONE) / r.qty
    expect(entry(after)).toBe(entry(before))
  })

  it('zeroes the position on a full exit', () => {
    const r = accumulate([trade('buy', 100n * ONE, '1000'), trade('sell', 100n * ONE, '1500')])
    expect(r.qty).toBe(0n)
    expect(r.cost).toBe(0n)
    expect(r.realized).toBe(500n)
  })

  it('records a loss as a negative realised figure', () => {
    const r = accumulate([trade('buy', 100n * ONE, '1000'), trade('sell', 100n * ONE, '400')])
    expect(r.realized).toBe(-600n)
  })

  it('never goes negative when a sell exceeds what the trades account for', () => {
    const r = accumulate([trade('buy', 100n * ONE, '1000'), trade('sell', 500n * ONE, '5000')])
    expect(r.qty).toBe(0n)
    expect(r.cost).toBe(0n)
    // Only the fifth of the proceeds attributable to known tokens counts.
    expect(r.realized).toBe(0n)
    expect(r.received).toBe(5000n)
  })

  it('ignores a sell with nothing held', () => {
    const r = accumulate([trade('sell', 10n * ONE, '100')])
    expect(r.qty).toBe(0n)
    expect(r.realized).toBe(0n)
  })
})
