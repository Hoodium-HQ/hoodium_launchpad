import { Link } from 'react-router'
import { tokenImageUrl, type TokenListItem } from '@/lib/launchpad-api'
import { formatAmount, usdToMoney } from '@/lib/money'
import { cn, relativeTime, sanitizeText, truncateMiddle } from '@/lib/utils'
import { CurveProgress } from './CurveProgress'
import { TokenAvatar } from './TokenAvatar'

/**
 * What a card needs. Structural rather than `TokenListItem` because a profile's
 * launches carry the same facts under a narrower shape (no FDV), and the card
 * should not demand fields it never reads.
 */
export type CardToken = Pick<
  TokenListItem,
  'address' | 'name' | 'symbol' | 'image' | 'graduated' | 'marketCapUsd' | 'progressBps' | 'createdAt'
> & { fdvUsd?: number }

/**
 * The densest repeated element, and the one the whole explore surface is built
 * from.
 *
 *   image (square, "Graduated" chip top-left once it has)
 *   Token Name          15px/500, truncate
 *   $SYMBOL             13px mono muted
 *   $35.14M MC          17px mono 500 — the scan target, largest element
 *   [curve progress]    pre-graduation only; graduated cards show FDV instead
 *   0xB9F5…24b0  15d    12px mono muted, space-between
 *
 * `now` comes from the parent's ticking clock so forty cards share one
 * interval and the "5s ago" on every one of them moves together.
 */
export function TokenCard({ token, now }: { token: CardToken; now: number }) {
  // Creator-supplied and attacker-controlled.
  const name = sanitizeText(token.name, 40) || 'Unnamed'
  const symbol = sanitizeText(token.symbol, 12) || '???'

  // Age in the accent only under 60 seconds, then muted: if every row is
  // highlighted, none of them are.
  const isFresh = now - new Date(token.createdAt).getTime() < 60_000

  return (
    <Link
      to={`/t/${token.address}`}
      className={cn(
        'group block animate-fade-in rounded-2xl border border-border bg-card p-3',
        'transition-colors duration-[120ms] hover:border-primary/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="relative mb-3">
        <TokenAvatar
          tokenAddress={token.address}
          name={name}
          src={tokenImageUrl(token)}
          className="aspect-square w-full text-2xl"
        />
        {token.graduated && (
          <span className="absolute left-2 top-2 inline-flex items-center rounded-full border border-up/25 bg-up/15 px-2 py-0.5 text-[11px] font-medium leading-none text-up backdrop-blur">
            Graduated
          </span>
        )}
      </div>

      <p className="truncate text-card-title">{name}</p>
      <p className="num truncate text-[13px] text-muted-foreground">${symbol}</p>

      {/* The scan target. */}
      <p className="num mt-1 truncate text-[17px] font-medium">
        {formatAmount(usdToMoney(token.marketCapUsd), { compact: true, prefix: '$' })}{' '}
        <span className="text-xs font-normal text-muted-foreground">MC</span>
        {token.graduated && token.fdvUsd !== undefined && (
          <span className="block text-xs font-normal text-muted-foreground sm:inline">
            <span className="hidden sm:inline">{' / '}</span>
            {formatAmount(usdToMoney(token.fdvUsd), { compact: true, prefix: '$' })} FDV
          </span>
        )}
      </p>

      {!token.graduated && <CurveProgress progressBps={token.progressBps} className="mt-2" />}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="num whitespace-nowrap text-[12px] text-muted-foreground">{truncateMiddle(token.address, 5, 4)}</span>
        <span className={cn('num whitespace-nowrap text-[12px]', isFresh ? 'text-primary' : 'text-muted-foreground')}>
          {relativeTime(token.createdAt, now)}
        </span>
      </div>
    </Link>
  )
}
