import type { ReactNode } from 'react'
import { MoneyValue } from '@/components/MoneyValue'
import { Card } from '@/components/ui/card'
import { MaybeHint } from '@/components/ui/tooltip'
import type { Money } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * One headline figure, with the rows that qualify it — hoodium.app's tile.
 *
 * Ported whole so a figure here reads the way the same figure does on a
 * position page there: the same 11px tracked label, the same mono figure under
 * it, the same rule before the qualifying rows. Two tile implementations would
 * drift, and the two products would stop looking like statements about the
 * same thing.
 *
 * What was left behind is the multi-denomination plumbing (`extra`, and the
 * `tileTotals` helpers around it): this product quotes in one stablecoin on
 * one chain, so there is never a second denomination to print.
 */
export interface StatRow {
  term: string
  value: Money | null
  dp: number
  suffix?: string
  prefix?: string
  compact?: boolean
  colorBySign?: boolean
  /** Shown in place of the figure when it is null. Never `0`. */
  fallback?: string
  hint?: string
  tone?: string
  /** A rule above this row, setting it apart from the ones before. */
  divider?: boolean
}

export function StatTile({
  label,
  value,
  dp,
  note,
  rows = [],
  badge,
  suffix,
  prefix,
  compact,
  action,
  colorBySign = false,
  featured = false,
  variant = 'card',
  size = 'xl',
  notice,
  className,
  children,
}: {
  label: string
  value: Money | null
  dp: number
  note: string
  rows?: StatRow[]
  /** Sits on the label line, so a caveat cannot be read apart from its figure. */
  badge?: ReactNode
  /** The unit of every figure in this tile, unless a row overrides it. */
  suffix: string
  /** A currency sign before the figure. */
  prefix?: string
  /** `1.2M` rather than `1,234,567`, for a figure whose magnitude is the point. */
  compact?: boolean
  /** One control, under the rows it acts on — for the rare figure that is also an offer. */
  action?: ReactNode
  colorBySign?: boolean
  featured?: boolean
  /**
   * `card` is the tile as its own rounded surface. `plain` drops the surface
   * and keeps everything else, for a caller that groups several figures inside
   * one container and separates them with rules instead.
   */
  variant?: 'card' | 'plain'
  /** `display` is the headline figure of a page. One per page. */
  size?: 'xl' | 'display'
  /** A caveat about the figure itself, and the one thing on a tile that is never hidden. */
  notice?: string
  className?: string
  /** Something that is not money, printed where the figure would go. */
  children?: ReactNode
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        {/* Instrument labels, not card titles: small, uppercase and widely
            tracked, in sans so the label never competes with the mono figure. */}
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          <MaybeHint
            content={variant === 'plain' ? note : undefined}
            className={cn(
              variant === 'plain' &&
                'cursor-help underline decoration-dotted decoration-from-font underline-offset-2',
            )}
          >
            {label}
          </MaybeHint>
        </p>
        {badge}
      </div>

      {children !== undefined ? (
        <p
          className={cn(
            'num mt-1 truncate font-medium',
            size === 'display' ? 'text-[2rem] leading-none tracking-tight sm:text-[2.5rem]' : 'text-xl',
          )}
        >
          {children}
        </p>
      ) : value === null ? (
        <p
          className={cn(
            'num mt-1 text-muted-foreground',
            size === 'display' ? 'text-[2rem] leading-none sm:text-[2.5rem]' : 'text-xl',
          )}
        >
          –
        </p>
      ) : (
        <MoneyValue
          value={value}
          size={size}
          dp={dp}
          prefix={prefix}
          compact={compact}
          colorBySign={colorBySign}
          suffix={suffix}
          className={cn('block truncate', size === 'display' ? 'mt-2' : 'mt-1')}
        />
      )}

      {rows.length > 0 && (
        <dl className="mt-3 space-y-1 border-t border-border pt-2.5">
          {rows.map((row) => (
            <div
              key={row.term}
              className={cn(
                'flex items-baseline justify-between gap-3',
                row.divider && 'mt-2 border-t border-border pt-2',
              )}
            >
              <Term hint={row.hint} className="text-[11px]">
                {row.term}
              </Term>
              <dd className="text-right">
                {row.value === null ? (
                  <span className="text-[11px] text-muted-foreground">{row.fallback ?? '–'}</span>
                ) : (
                  <MoneyValue
                    value={row.value}
                    size="sm"
                    dp={row.dp}
                    prefix={row.prefix ?? prefix}
                    compact={row.compact ?? compact}
                    colorBySign={row.colorBySign}
                    suffix={row.suffix ?? suffix}
                    className={row.tone}
                  />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {action && <div className="mt-3">{action}</div>}

      {notice && <p className="mt-1.5 text-[11px] leading-snug text-warning">{notice}</p>}

      {variant !== 'plain' && (
        <p className="mt-auto pt-2 text-[11px] leading-snug text-muted-foreground">{note}</p>
      )}
    </>
  )

  if (variant === 'plain') return <div className={cn('flex min-w-0 flex-col px-0 py-3.5', className)}>{body}</div>

  return (
    // `h-full` plus `mt-auto` on the note: the grid stretches every tile to the
    // tallest, and without this the notes land at different heights.
    <Card featured={featured} className={cn('flex h-full min-w-0 flex-col p-4', className)}>
      {body}
    </Card>
  )
}

/**
 * A term that says it has more to say. The dotted underline is the whole
 * affordance, and it costs one line of CSS rather than a popover component.
 */
export function Term({
  children,
  hint,
  className,
}: {
  children: ReactNode
  hint?: string
  className?: string
}) {
  return (
    <dt className={cn('text-muted-foreground', className)}>
      <MaybeHint
        content={hint}
        className={cn(
          hint && 'cursor-help underline decoration-dotted decoration-from-font underline-offset-2',
        )}
      >
        {children}
      </MaybeHint>
    </dt>
  )
}
