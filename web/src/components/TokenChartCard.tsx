import { useMemo, useState } from 'react'
import { AreaChart } from '@/components/AreaChart'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useTokenCandles } from '@/hooks/useLaunchpad'
import type { CandleInterval, TokenDetail } from '@/lib/launchpad-api'
import { formatPrice, fromBaseUnits, isZero, usdToMoney } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * The price, over time.
 *
 * The series is the candles' closes, drawn as an area. On a bonding curve
 * every trade *is* a price change, so the finest interval is the honest one;
 * the coarser buckets exist so a week reads as a shape rather than noise.
 * `ALL` is resolved by the API, which picks the widest bucket that fits the
 * token's whole life under its candle cap.
 *
 * Candle values are USD floats — chart coordinates, drawn and never settled
 * against. The price figure itself comes from `curveState.price`, the exact
 * spot price in quote base units; the last close is only the fallback for a
 * token whose curve state has not been read yet.
 *
 * The four figures that used to head this card live in the tile row above it
 * on the token page now, where hoodium.app puts a page's figures.
 */
const INTERVALS: Array<{ value: CandleInterval; label: string }> = [
  { value: '5m', label: '5M' },
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '1d', label: '1D' },
  { value: 'all', label: 'ALL' },
]

export function TokenChartCard({ token }: { token: TokenDetail }) {
  const [interval, setInterval] = useState<CandleInterval>('1h')
  const chart = useTokenCandles(token.address, interval)

  const points = useMemo(
    () =>
      (chart.data?.candles ?? []).map((c) => ({
        time: c.t,
        // Chart coordinate, not money: the series is drawn, never settled against.
        value: c.c,
      })),
    [chart.data],
  )

  const graduated = token.status === 'graduated' || token.graduated

  // Exact spot price in quote units (USDG is $1). A fresh token with no curve
  // read yet reports "0"; fall back to the last close, then to nothing.
  const spot = fromBaseUnits(token.curveState.price, env.quoteDecimals)
  const lastClose = chart.data?.candles.at(-1)?.c
  const latestPrice = !isZero(spot) ? spot : lastClose !== undefined && lastClose > 0 ? usdToMoney(lastClose) : null

  const first = points[0]?.value
  const last = points.at(-1)?.value
  const changePct = first !== undefined && last !== undefined && first > 0 ? ((last - first) / first) * 100 : null

  return (
    <Card featured className="min-w-0 overflow-hidden p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {graduated ? 'Price · Uniswap v3 pool' : 'Price · bonding curve'}
          </p>
          <p className="num mt-1 text-2xl font-medium leading-none tracking-tight">
            {latestPrice ? formatPrice(latestPrice, '$') : '—'}
          </p>
          {changePct !== null && (
            <p
              className={cn(
                'num mt-1.5 text-sm',
                changePct > 0 ? 'text-up' : changePct < 0 ? 'text-down' : 'text-muted-foreground',
              )}
            >
              {/* Sign is carried by a glyph as well as colour. */}
              {changePct > 0 ? '▲' : changePct < 0 ? '▼' : '·'} {Math.abs(changePct).toFixed(2)}%{' '}
              <span className="text-muted-foreground">{INTERVALS.find((w) => w.value === interval)?.label}</span>
            </p>
          )}
        </div>

        <SegmentedControl
          segments={INTERVALS}
          value={interval}
          onChange={setInterval}
          label="Chart interval"
          tone="quiet"
        />
      </div>

      {chart.isLoading && !chart.data ? (
        <Skeleton className="mt-4 h-[240px] w-full" />
      ) : (
        <AreaChart
          className="mt-3"
          height={240}
          points={points}
          format={(v) => (v >= 1 ? v.toFixed(2) : v.toPrecision(3))}
          ariaLabel={`Price of ${token.symbol} in ${env.quoteSymbol}, ${chart.data?.interval ?? interval} candles`}
          emptyLabel={chart.isError ? 'Chart unavailable.' : 'No trades yet. The chart starts with the first one.'}
        />
      )}
    </Card>
  )
}
