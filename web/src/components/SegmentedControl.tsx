import { useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * `SegmentedControl` — design-system.md section 8.2.
 *
 * | Property | Value |
 * |---|---|
 * | Track | `bg-muted` pill, rounded-full, 4px padding |
 * | Active | `bg-card` raised pill |
 * | Accent | **None.** The accent is reserved; active state is carried by elevation |
 * | Semantics | Real `<button>` elements with `aria-pressed`, arrow-key traversal |
 */
export interface Segment<T extends string> {
  value: T
  label: string
  /**
   * Optional leading mark. Decorative only — the label always carries the
   * meaning, because an icon alone communicates nothing to a screen reader and
   * nothing to anyone who cannot distinguish it (WA-5.5).
   */
  icon?: ReactNode
  /**
   * How many things sit behind this segment. Rendered as a trailing numeral so
   * a filter says what it will cost to follow it — "Closed 14" answers the
   * question that clicking Closed would otherwise have to.
   *
   * Omit it while the count is still loading. A `0` is a statement, and
   * flashing one before the data lands states the opposite of the truth.
   */
  count?: number
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  countLabel,
  className,
  tone = 'raised',
}: {
  segments: ReadonlyArray<Segment<T>>
  value: T
  onChange: (value: T) => void
  label: string
  /**
   * What the counts are counting, singular ("position"). A bare numeral in the
   * accessible name reads as "Open 3", which is not a sentence; with this it is
   * "Open, 3 positions". Only used by segments that carry a `count`.
   */
  countLabel?: string
  className?: string
  /**
   * How much of the page's ink this group is allowed.
   *
   * `raised` is design-system.md 8.2 as written: a `bg-muted` track with the
   * active segment lifted out of it in `bg-card`. It is the treatment for a
   * control that is the point of its row, and it stays the default.
   *
   * `quiet` is for a row that carries several groups at once. Four raised
   * tracks side by side out-weigh the table they filter, because on this canvas
   * `muted` is *lighter* than `card` — the track reads as the lit object and
   * the active pill as a hole punched in it. Quiet inverts that: the track is a
   * hairline and the active segment is the only filled thing in the group. Same
   * contract, less ink, and a *stronger* active state rather than a weaker one,
   * since `muted` against `background` separates further than `card` does.
   */
  tone?: 'raised' | 'quiet'
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()

    const next = (index + delta + segments.length) % segments.length
    const segment = segments[next]
    if (!segment) return
    onChange(segment.value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full p-1',
        tone === 'raised' ? 'bg-muted' : 'border border-border/70',
        className,
      )}
    >
      {segments.map((segment, index) => {
        const active = segment.value === value
        return (
          <button
            key={segment.value}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(segment.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full py-1 text-xs font-medium transition-colors duration-[120ms] ease-out',
              // Tighter on the icon side so the mark, not the padding, is what
              // sits against the pill edge.
              segment.icon ? 'pl-1.5 pr-3' : 'px-3',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? tone === 'raised'
                  ? 'bg-card text-foreground'
                  : 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {segment.icon}
            {segment.label}
            {segment.count !== undefined && (
              <>
                {/* The numeral is decoration for the sentence below it: read
                    aloud on its own it would just trail the label. */}
                <span
                  aria-hidden
                  className={cn(
                    'tabular-nums',
                    active ? 'text-muted-foreground' : 'text-muted-foreground/60',
                  )}
                >
                  {segment.count}
                </span>
                <span className="sr-only">
                  , {segment.count} {countLabel ?? 'item'}
                  {segment.count === 1 ? '' : 's'}
                </span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
