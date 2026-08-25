/**
 * OHLC candles from curve trades.
 *
 * On a bonding curve every trade is a price change, so a candle's open is the
 * price *after* the previous trade (the curve's resting price), and its close is
 * the price after the last trade inside it. Empty buckets between two trades are
 * filled with flat candles at the previous close so a chart never shows a gap
 * where the price was simply unchanged.
 */
import { TradeModel } from '../db/models.js'
import type { Candle, CandleInterval } from '../types.js'

export const INTERVAL_SECONDS: Record<Exclude<CandleInterval, 'all'>, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '1d': 24 * 60 * 60,
}

/** Default lookback per interval so a request without `from` returns a sane chart. */
export const DEFAULT_LOOKBACK_SECONDS: Record<Exclude<CandleInterval, 'all'>, number> = {
  '1m': 6 * 60 * 60,
  '5m': 24 * 60 * 60,
  '15m': 3 * 24 * 60 * 60,
  '1h': 7 * 24 * 60 * 60,
  '6h': 30 * 24 * 60 * 60,
  '1d': 365 * 24 * 60 * 60,
}

export const MAX_CANDLES = 1500

/** Pick a bucket width for `all` that keeps the series under MAX_CANDLES. */
export function autoInterval(spanSeconds: number): Exclude<CandleInterval, 'all'> {
  const order: Exclude<CandleInterval, 'all'>[] = ['1m', '5m', '15m', '1h', '6h', '1d']
  for (const i of order) {
    if (spanSeconds / INTERVAL_SECONDS[i] <= MAX_CANDLES) return i
  }
  return '1d'
}

export interface TradePoint {
  /** Unix seconds. */
  t: number
  /** USD price per whole token, after the trade. */
  price: number
  /** USD value of the trade. */
  usd: number
  side: 'buy' | 'sell'
}

/**
 * Pure bucketing. `openingPrice` is the price in force before the first trade in
 * range (the previous close), or null when the token had never traded.
 */
export function bucketTrades(
  points: TradePoint[],
  bucketSeconds: number,
  opts: { from: number; to: number; openingPrice: number | null; fill?: boolean },
): Candle[] {
  const start = Math.floor(opts.from / bucketSeconds) * bucketSeconds
  const end = Math.floor(opts.to / bucketSeconds) * bucketSeconds
  const byBucket = new Map<number, Candle>()

  let last = opts.openingPrice
  for (const p of points) {
    const t = Math.floor(p.t / bucketSeconds) * bucketSeconds
    const c = byBucket.get(t)
    if (!c) {
      const open = last ?? p.price
      byBucket.set(t, {
        t,
        o: open,
        h: Math.max(open, p.price),
        l: Math.min(open, p.price),
        c: p.price,
        v: p.usd,
        buys: p.side === 'buy' ? 1 : 0,
        sells: p.side === 'sell' ? 1 : 0,
      })
    } else {
      c.h = Math.max(c.h, p.price)
      c.l = Math.min(c.l, p.price)
      c.c = p.price
      c.v += p.usd
      if (p.side === 'buy') c.buys++
      else c.sells++
    }
    last = p.price
  }

  if (!opts.fill) return [...byBucket.values()].sort((a, b) => a.t - b.t)

  const out: Candle[] = []
  let prevClose = opts.openingPrice
  const count = Math.floor((end - start) / bucketSeconds) + 1
  if (count > MAX_CANDLES * 4) {
    // Refuse to fabricate an absurd number of flat candles; return the real ones.
    return [...byBucket.values()].sort((a, b) => a.t - b.t)
  }
  for (let t = start; t <= end; t += bucketSeconds) {
    const c = byBucket.get(t)
    if (c) {
      out.push(c)
      prevClose = c.c
    } else if (prevClose !== null) {
      out.push({ t, o: prevClose, h: prevClose, l: prevClose, c: prevClose, v: 0, buys: 0, sells: 0 })
    }
  }
  return out
}

export async function loadCandles(input: {
  chainId: number
  tokenAddress: string
  interval: CandleInterval
  from?: number
  to?: number
  fill: boolean
}): Promise<{ interval: Exclude<CandleInterval, 'all'>; candles: Candle[]; from: number; to: number }> {
  const now = Math.floor(Date.now() / 1000)
  const scope = { chainId: input.chainId, tokenAddress: input.tokenAddress }

  let interval: Exclude<CandleInterval, 'all'>
  let from: number
  const to = input.to ?? now

  if (input.interval === 'all') {
    const first = await TradeModel.findOne(scope).sort({ blockNumber: 1, logIndex: 1 }).select('at').lean()
    from = first?.at ? Math.floor(new Date(first.at).getTime() / 1000) : now - 3600
    interval = autoInterval(Math.max(60, to - from))
  } else {
    interval = input.interval
    from = input.from ?? to - DEFAULT_LOOKBACK_SECONDS[interval]
  }

  const bucket = INTERVAL_SECONDS[interval]
  // Cap the range so a hostile `from` cannot turn into a million-row scan.
  from = Math.max(from, to - bucket * MAX_CANDLES)

  const [prior, rows] = await Promise.all([
    TradeModel.findOne({ ...scope, at: { $lt: new Date(from * 1000) } })
      .sort({ blockNumber: -1, logIndex: -1 })
      .select('priceUsd')
      .lean(),
    TradeModel.find({ ...scope, at: { $gte: new Date(from * 1000), $lte: new Date(to * 1000 + 999) } })
      .sort({ blockNumber: 1, logIndex: 1 })
      .select('priceUsd usdValue side at')
      .limit(50_000)
      .lean(),
  ])

  const points: TradePoint[] = rows.map((r) => ({
    t: Math.floor(new Date(r.at).getTime() / 1000),
    price: r.priceUsd ?? 0,
    usd: r.usdValue ?? 0,
    side: r.side as 'buy' | 'sell',
  }))

  const candles = bucketTrades(points, bucket, {
    from,
    to,
    openingPrice: prior ? (prior.priceUsd ?? null) : null,
    fill: input.fill,
  })

  return { interval, candles, from, to }
}
