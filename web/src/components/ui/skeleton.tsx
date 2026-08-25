import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Loading placeholders — WA-4.x.
 *
 * `Skeleton` is the primitive. The composites below exist because a single
 * `<Skeleton className="h-96 w-full" />` is a grey rectangle the size of a
 * viewport: it tells the user something is coming but nothing about what, and
 * when the real content lands the page reflows from one block into twelve rows.
 * A placeholder that already carries the shape of its content is the difference
 * between "loading" and "loading *this*".
 *
 * All of them are `aria-hidden`. The live region announcing a load belongs to
 * the surface that owns the query, not to twelve individual grey bars.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-lg bg-muted', className)} aria-hidden {...props} />
}

/**
 * Rows of a table or feed.
 *
 * Widths vary per row so the block does not read as a solid rectangle. Real rows
 * are ragged, and a perfectly uniform placeholder looks like a rendering fault
 * rather than a pending one. The sequence is fixed rather than random so the
 * placeholder does not reshuffle on every re-render.
 */
export function SkeletonRows({
  rows = 6,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { rows?: number }) {
  const widths = ['w-2/5', 'w-1/3', 'w-1/2', 'w-2/5', 'w-1/4', 'w-1/2', 'w-1/3', 'w-2/5']

  return (
    <div className={cn('divide-y divide-border rounded-2xl border border-border', className)} {...props}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <Skeleton className={cn('h-4', widths[i % widths.length])} />
          <Skeleton className="ml-auto h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** A label over a value, matching the `Stat` rhythm on the landing page. */
export function SkeletonStat({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={className} {...props}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-2 h-7 w-20" />
    </div>
  )
}

/** A card with a title line and a few body lines. */
export function SkeletonCard({
  lines = 3,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { lines?: number }) {
  return (
    <div className={cn('rounded-2xl border border-border bg-card p-5', className)} {...props}>
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/5' : 'w-full')} />
        ))}
      </div>
    </div>
  )
}

/**
 * A chart placeholder.
 *
 * Reserves the plot's exact height so the axis and whatever sits below it do not
 * jump when the series arrives, which is the layout shift this exists to
 * prevent. A ragged bar silhouette reads as "a chart"; a flat block does not.
 */
export function SkeletonChart({
  height = 220,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { height?: number }) {
  const bars = [38, 62, 45, 78, 55, 88, 70, 94, 66, 82, 58, 74]

  return (
    <div className={cn('rounded-xl border border-border p-4', className)} {...props}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {bars.map((pct, i) => (
          <Skeleton key={i} className="flex-1 rounded-sm" style={{ height: `${pct}%` }} />
        ))}
      </div>
    </div>
  )
}
