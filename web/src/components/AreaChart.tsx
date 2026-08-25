import {
  createChart,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { themeColor } from '@/lib/theme-color'
import { cn } from '@/lib/utils'

export interface AreaPoint {
  /** Unix seconds. */
  time: number
  value: number
}

/**
 * A read-only value-over-time series.
 *
 * Deliberately non-interactive: a token's price is read, not interrogated, and
 * leaving zoom and pan enabled would mean a chart that can be dragged into a
 * state that says nothing, with no way back.
 *
 * `minMove` is derived from the data rather than fixed. A curve trading at 1e-9
 * against a hardcoded 1e-7 renders with no axis labels at all — the library
 * clamps tick spacing to at least one `minMove`, so it is a ceiling on
 * resolution, not a floor.
 */
export function AreaChart({
  points,
  height = 220,
  format,
  className,
  ariaLabel,
  emptyLabel = 'No activity in this window.',
}: {
  points: AreaPoint[]
  height?: number
  /** Axis and crosshair label formatter. */
  format: (value: number) => string
  className?: string
  ariaLabel: string
  emptyLabel?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)
  // The formatter is captured by the series at creation; keeping it in a ref lets
  // it change without tearing the chart down.
  const formatRef = useRef(format)
  formatRef.current = format

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Theme tokens resolved to rgba — this library cannot parse hsl, and it
    // throws during construction rather than degrading.
    const hsl = themeColor

    const chart = createChart(container, {
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: hsl('--muted-foreground'),
        fontFamily: '"Geist Mono Variable", "JetBrains Mono", ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: hsl('--border', 0.5), style: LineStyle.Dotted },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true },
      crosshair: {
        horzLine: { labelBackgroundColor: hsl('--card') },
        vertLine: { labelBackgroundColor: hsl('--card') },
      },
      handleScale: false,
      handleScroll: false,
    })

    const series = chart.addAreaSeries({
      lineColor: hsl('--primary'),
      topColor: hsl('--primary', 0.28),
      bottomColor: hsl('--primary', 0.02),
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: 'custom', minMove: 1e-7, formatter: (v: number) => formatRef.current(v) },
    })

    chartRef.current = chart
    seriesRef.current = series

    const observer = new ResizeObserver(([entry]) => {
      if (entry) chart.applyOptions({ width: entry.contentRect.width })
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return

    const data = points
      .filter((p) => Number.isFinite(p.value) && p.time > 0)
      // lightweight-charts requires strictly ascending, de-duplicated timestamps.
      .filter((p, i, all) => i === 0 || p.time > all[i - 1]!.time)
      .map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))

    // Applied before `setData`, which triggers the first tick-mark pass — a stale
    // `minMove` there renders one labelless frame.
    series.applyOptions({
      priceFormat: {
        type: 'custom',
        minMove: minMoveFor(data.map((p) => p.value)),
        formatter: (v: number) => formatRef.current(v),
      },
    })

    series.setData(data)
    if (data.length > 0) chart.timeScale().fitContent()
  }, [points])

  return (
    <div className={cn('relative', className)} role="img" aria-label={ariaLabel}>
      <div ref={containerRef} className="w-full" />
      {points.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {emptyLabel}
        </div>
      )}
    </div>
  )
}

/** Below this the library's `Math.round(1 / minMove)` stops being a power of ten. */
const EXPONENT_FLOOR = -17
/** Above `1` it collapses to `0` — a base with no minimum at all. */
const EXPONENT_CEILING = 0

export function minMoveFor(values: number[]): number {
  let smallest = Infinity
  for (const v of values) {
    if (Number.isFinite(v) && v > 0 && v < smallest) smallest = v
  }
  if (!Number.isFinite(smallest)) return 1e-7

  const wanted = Math.floor(Math.log10(smallest)) - 4
  const exponent = Math.min(EXPONENT_CEILING, Math.max(EXPONENT_FLOOR, wanted))
  // `10 ** -17` is one ulp below `1e-17`, and the library derives its tick base
  // from `Math.round(1 / minMove)`, which then fails its power-of-ten check and
  // throws on every frame. The literal form is exact.
  return Number(`1e${exponent}`)
}
