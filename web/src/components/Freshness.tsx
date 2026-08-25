import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Hint } from '@/components/ui/tooltip'

/**
 * How old the figures on a page are, when they will be replaced, and a way to
 * stop waiting.
 *
 * Every read on this product polls — the monitor writes on a 60-second cycle,
 * the reporting rebuild on five minutes — and a page that polls silently is
 * asking to be misread. A figure with no age on it is taken for live, so the
 * one state worth catching (a poll that stopped, a backend that went quiet)
 * looks exactly like the healthy one. The countdown is the other half of the
 * same answer: "45s ago" is only alarming until you know the cadence is a
 * minute.
 *
 * ── Why it counts in seconds ─────────────────────────────────────────────────
 * `relativeTime` rounds anything under 45 seconds to "now", which is right for
 * a fill or a deposit and wrong here: for the whole first half of a 60-second
 * cycle it would report the same word, and the number would only ever move once
 * before resetting. This ticks.
 *
 * ── Why it is not a live region ──────────────────────────────────────────────
 * A per-second `aria-live` would read the whole label aloud every second, which
 * is unusable. The text is left silent between renders and the button carries
 * the affordance instead — a screen-reader user who wants the current figures
 * presses "Refresh now" rather than listening to a clock.
 */
export function Freshness({
  updatedAt,
  intervalMs,
  isFetching,
  onRefresh,
  className,
}: {
  /** Epoch ms of the last successful read. `dataUpdatedAt` from react-query. */
  updatedAt: number
  /** The query's own `refetchInterval`, so the countdown is not a guess. */
  intervalMs: number
  isFetching: boolean
  onRefresh: () => void
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  // A page opened from cache can be older than one whole cycle, and a clock that
  // drifted can make `updatedAt` sit in the future. Both floor at zero rather
  // than rendering a negative age or a countdown that runs backwards forever.
  const age = Math.max(0, Math.round((now - updatedAt) / 1000))
  const next = Math.max(0, Math.round(intervalMs / 1000) - age)

  return (
    <p className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      {isFetching ? (
        <span className="text-foreground">updating…</span>
      ) : (
        <>
          {/* Each clause holds together or breaks entirely. Squeezed into a
              phone-width column this wrapped mid-phrase — "next / in / 5m" down
              three lines — which is three lines of nothing legible where one
              line of "next in 5m" was always going to fit somewhere. */}
          <span className="whitespace-nowrap">
            updated <span className="num text-foreground">{ago(age)}</span>
          </span>
          {/* The dot separates two clauses about the same clock. Hidden from the
              reader, which would otherwise say "middle dot". */}
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">
            next in <span className="num">{ago(next, false)}</span>
          </span>
        </>
      )}

      <Hint
        content="Refresh now"
        render={
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className="rounded p-0.5 outline-none transition-colors duration-[120ms] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          />
        }
      >
        <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} aria-hidden />
        <span className="sr-only">Refresh now</span>
      </Hint>
    </p>
  )
}

/**
 * Seconds as a duration, in the shortest form that stays exact.
 *
 * Minutes appear only past 90s, where the second is no longer the interesting
 * digit — a five-minute cadence would otherwise render as "287s ago", which is
 * a number nobody converts.
 */
function ago(seconds: number, suffix = true): string {
  const body =
    seconds < 90 ? `${seconds}s` : seconds < 5_400 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3_600)}h`
  return suffix ? `${body} ago` : body
}
