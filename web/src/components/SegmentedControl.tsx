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
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  className,
}: {
  segments: ReadonlyArray<Segment<T>>
  value: T
  onChange: (value: T) => void
  label: string
  className?: string
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
      className={cn('inline-flex items-center gap-0.5 rounded-full bg-muted p-1', className)}
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
              active ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {segment.icon}
            {segment.label}
          </button>
        )
      })}
    </div>
  )
}
