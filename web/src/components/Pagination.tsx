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

/**
 * Page numbers for a paged board — hoodium.app's pager, on this product's
 * page maths.
 *
 * Numbers rather than "load more", because the page lives in the URL and a
 * position in a ranking has to survive a paste. The count on the left is the
 * honest part: it says what is on screen and what it is a slice of. It is
 * rendered only when the caller can state the total — a page count alone does
 * not know how many rows the last page holds.
 */
export function Pagination({
  page,
  pages,
  onChange,
  total,
  pageSize,
  noun = 'row',
  className,
}: {
  page: number
  pages: number
  onChange: (page: number) => void
  /** Every row the board holds, not the page — this is what "of 500" means. */
  total?: number
  pageSize?: number
  /** Singular. Pluralised here, so callers do not each invent a rule. */
  noun?: string
  className?: string
}) {
  // One page is not a pager. A control whose every state shows the same rows
  // is furniture.
  if (pages <= 1) return null

  const showing = total !== undefined && pageSize !== undefined
  const first = showing ? (page - 1) * pageSize + 1 : 0
  const last = showing ? Math.min(page * pageSize, total) : 0

  return (
    <nav
      className={cn(
        'flex flex-wrap items-center gap-3 px-1',
        showing ? 'justify-between' : 'justify-center',
        className,
      )}
      aria-label="Pagination"
    >
      {showing && (
        <p className="text-xs text-muted-foreground">
          Showing <span className="num text-foreground">{first}</span>–
          <span className="num text-foreground">{last}</span> of <span className="num">{total}</span>{' '}
          {noun}
          {total === 1 ? '' : 's'}
        </p>
      )}

      <div className="flex items-center gap-1">
        <Step
          label="Previous page"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          icon={<ChevronLeft className="size-4" aria-hidden />}
        />

        {pageWindow(page, pages).map((p, i) =>
          p === null ? (
            // Inert: a gap that says it is a gap.
            <span key={`gap-${i}`} className="px-1 text-xs text-muted-foreground" aria-hidden>
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              aria-current={p === page ? 'page' : undefined}
              className={cn(
                'num min-w-8 rounded-lg px-2 py-1 text-xs outline-none transition-colors duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring',
                p === page
                  ? 'bg-primary/15 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {p}
            </button>
          ),
        )}

        <Step
          label="Next page"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
          icon={<ChevronRight className="size-4" aria-hidden />}
        />
      </div>
    </nav>
  )
}

function Step({
  label,
  disabled,
  onClick,
  icon,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      /* Disabled rather than hidden at the ends: a control that disappears makes
         the row reflow and the neighbouring page numbers move under the cursor
         mid-click. */
      disabled={disabled}
      aria-label={label}
      className="rounded-lg p-1 text-muted-foreground outline-none transition-colors duration-[120ms] hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
    </button>
  )
}
