import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Which page numbers to show for `1 2 … 41 42 43 … 99 100`.
 *
 * Always the first, the last, and a window around the current page; `null`
 * marks a gap. Pure so it can be tested without rendering.
 */
export function pageWindow(page: number, pages: number, around = 1): Array<number | null> {
  if (pages <= 1) return [1]
  const keep = new Set<number>([1, pages])
  for (let p = page - around; p <= page + around; p++) if (p >= 1 && p <= pages) keep.add(p)
  // Fill small gaps so "1 … 3" becomes "1 2 3".
  if (keep.has(3) && !keep.has(2)) keep.add(2)
  if (keep.has(pages - 2) && !keep.has(pages - 1)) keep.add(pages - 1)

  const sorted = [...keep].sort((a, b) => a - b)
  const out: Array<number | null> = []
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!
    const previous = sorted[i - 1]
    if (previous !== undefined && current - previous > 1) out.push(null)
    out.push(current)
  }
  return out
}

export function Pagination({
  page,
  pages,
  onChange,
  className,
}: {
  page: number
  pages: number
  onChange: (page: number) => void
  className?: string
}) {
  if (pages <= 1) return null

  const item =
    'num inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs transition-colors duration-[120ms] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

  return (
    <nav className={cn('flex flex-wrap items-center justify-center gap-1', className)} aria-label="Pagination">
      <button
        type="button"
        className={cn(item, 'border-border text-muted-foreground hover:text-foreground')}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>

      {pageWindow(page, pages).map((p, i) =>
        p === null ? (
          <span key={`gap-${i}`} className="num px-1 text-xs text-muted-foreground" aria-hidden>
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onChange(p)}
            className={cn(
              item,
              p === page
                ? 'border-border bg-muted text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {p}
          </button>
        ),
      )}

      <button
        type="button"
        className={cn(item, 'border-border text-muted-foreground hover:text-foreground')}
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </nav>
  )
}
