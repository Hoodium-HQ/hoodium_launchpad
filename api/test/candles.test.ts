import { describe, expect, it } from 'vitest'
import { autoInterval, bucketTrades, INTERVAL_SECONDS, MAX_CANDLES, type TradePoint } from '../src/services/candles.js'

const p = (t: number, price: number, usd = 10, side: 'buy' | 'sell' = 'buy'): TradePoint => ({ t, price, usd, side })

describe('bucketTrades', () => {
  it('opens a bucket at the previous close, not at its own first trade', () => {
    const candles = bucketTrades([p(300, 2), p(320, 3)], 300, { from: 300, to: 599, openingPrice: 1 })
    expect(candles).toHaveLength(1)
    expect(candles[0]).toMatchObject({ t: 300, o: 1, h: 3, l: 1, c: 3, v: 20, buys: 2, sells: 0 })
  })

  it('uses the first trade as the open when the token never traded before', () => {
    const [c] = bucketTrades([p(10, 5)], 60, { from: 0, to: 59, openingPrice: null })
    expect(c).toMatchObject({ o: 5, h: 5, l: 5, c: 5 })
  })

  it('fills empty buckets flat at the previous close', () => {
    const candles = bucketTrades([p(0, 1), p(700, 2, 5, 'sell')], 300, { from: 0, to: 899, openingPrice: null, fill: true })
    expect(candles.map((c) => c.t)).toEqual([0, 300, 600])
    expect(candles[1]).toMatchObject({ o: 1, h: 1, l: 1, c: 1, v: 0 })
    expect(candles[2]).toMatchObject({ o: 1, h: 2, l: 1, c: 2, sells: 1 })
  })

  it('does not fabricate leading candles before the first known price', () => {
    const candles = bucketTrades([p(650, 1)], 300, { from: 0, to: 899, openingPrice: null, fill: true })
    expect(candles.map((c) => c.t)).toEqual([600])
  })

  it('returns buckets sorted by time', () => {
    const candles = bucketTrades([p(0, 1), p(1000, 2), p(500, 3)], 100, { from: 0, to: 1000, openingPrice: null })
    // Input order is the caller's responsibility for open/close, but output is sorted.
    expect(candles.map((c) => c.t)).toEqual([0, 500, 1000])
  })
})

describe('autoInterval', () => {
  it('keeps the series under MAX_CANDLES', () => {
    for (const span of [60, 3600, 86_400, 30 * 86_400, 400 * 86_400]) {
      const i = autoInterval(span)
      expect(span / INTERVAL_SECONDS[i]).toBeLessThanOrEqual(MAX_CANDLES)
    }
  })
})
