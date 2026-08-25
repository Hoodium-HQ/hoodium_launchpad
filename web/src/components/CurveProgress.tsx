import { cn } from '@/lib/utils'

/**
 * `CurveProgress` — design-system.md section 7, LP-2.1 / WA-2.3.
 *
 * design-system.md section 8.1 gives one rule that is not negotiable:
 *
 *   "**Percentage is always shown as a number next to the bar.** A bar alone
 *    cannot be read precisely, and the difference between 77% and 83% is exactly
 *    what a buyer is deciding on."
 *
 * `progressBps` is basis points — an integer from the contract, not a float, so
 * nothing drifts on the way to the screen.
 */
export function CurveProgress({
  progressBps,
  className,
  showLabel = true,
}: {
  progressBps: number
  className?: string
  showLabel?: boolean
}) {
  const clamped = Math.min(10_000, Math.max(0, progressBps))
  const pct = (clamped / 100).toFixed(clamped >= 10_000 || clamped === 0 ? 0 : 1)
  const complete = clamped >= 10_000

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={clamped / 100}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Bonding curve ${pct}% complete`}
      >
        <div
          // Accent fill on a muted track (design-system.md section 8.1). This is
          // brand, not price direction, so the accent is the correct colour here.
          className={cn('h-full rounded-full transition-[width] duration-[120ms]', complete ? 'bg-up' : 'bg-primary')}
          style={{ width: `${clamped / 100}%` }}
        />
      </div>
      {showLabel && (
        <span className={cn('num shrink-0 text-xs', complete ? 'text-up' : 'text-muted-foreground')}>{pct}%</span>
      )}
    </div>
  )
}
