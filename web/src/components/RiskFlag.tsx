import { TriangleAlert } from 'lucide-react'
import type { TokenListItem } from '@/lib/launchpad-api'
import { formatPercent } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * `RiskFlag`.
 *
 * "The app SHALL display creator risk flags **prominently, not hidden behind a
 *  tab**."
 *
 * The wording is deliberately factual. The product forbids editorial promotion, and
 * the same restraint applies in the other direction: the backend supplies a
 * measurement, this supplies plain English for it, and neither calls a token a
 * scam. Users draw the conclusion.
 */
const COPY: Record<string, { label: string; explain: string }> = {
  creator_concentration: {
    label: 'Creator holds a large share',
    explain: 'The creator holds an outsized portion of the tokens sold so far. They can sell at any time.',
  },
  creator_no_prior_graduations: {
    label: 'Creator has no graduated launches',
    explain: 'Every previous token from this creator stopped short of graduating.',
  },
  confusable_symbol: {
    label: 'Symbol imitates another token',
    explain:
      'This symbol contains characters that look like Latin letters but are not. Check it against the token you meant to buy.',
  },
}

/** Every list item carries `risk`, so both forms accept the narrower shape. */
type Flagged = Pick<TokenListItem, 'risk'>

export function RiskFlags({ token, className }: { token: Flagged; className?: string }) {
  const flags = token.risk?.flags ?? []
  if (flags.length === 0) return null

  return (
    <div className={cn('space-y-2 rounded-xl border border-warning/25 bg-warning/10 p-3', className)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <TriangleAlert className="size-3.5" aria-hidden />
        {flags.length === 1 ? 'One thing to check' : `${flags.length} things to check`}
      </p>
      <ul className="space-y-1.5">
        {flags.map((flag) => {
          const copy = COPY[flag]
          if (!copy) return null
          return (
            <li key={flag} className="text-xs">
              <span className="font-medium text-foreground">{copy.label}</span>
              {/* `creatorSharePct` is a percent as a decimal string ("12.5"), which
                  `formatPercent` takes as-is. Guard the empty string, not null —
                  the API always sends one. */}
              {flag === 'creator_concentration' && token.risk.creatorSharePct ? (
                <span className="num text-warning"> — {formatPercent(token.risk.creatorSharePct, 1)}</span>
              ) : null}
              <span className="block text-muted-foreground">{copy.explain}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Compact form for the discovery grid, where space is tight. */
export function RiskBadge({ token }: { token: Flagged }) {
  const count = token.risk?.flags?.length ?? 0
  if (count === 0) return null

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-warning"
      title={(token.risk.flags ?? []).map((f) => COPY[f]?.label ?? f).join(' · ')}
    >
      <TriangleAlert className="size-2.5" aria-hidden />
      {count}
    </span>
  )
}
