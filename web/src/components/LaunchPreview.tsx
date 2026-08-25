import { ImageIcon, Lock } from 'lucide-react'
import { env } from '@/config/env'
import type { LaunchTerms } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { sanitizeText } from '@/lib/utils'
import { Card } from './ui/card'

/**
 * What the creator is about to create, and on what terms — WA-2.1.
 *
 * Two jobs, and the second is the one that matters. The top half is a preview of
 * the card their token will appear as. The bottom half is the **terms**: the
 * launch fee, the fee split, the graduation target, and the fact that liquidity
 * locks. Every one of those is read from the factory, which is immutable
 * (LP-N1) — none of it is a constant in this file, because a constant here could
 * disagree with the contract and the creator would never know.
 *
 * When the read fails the panel says so instead of showing zeroes. A zero is a
 * number, and a creator would reasonably read "Launch fee 0" as free.
 */
export function LaunchPreview({
  name,
  symbol,
  imageUrl,
  devBuy,
  terms,
  termsUnavailable,
}: {
  name: string
  symbol: string
  /** Object URL of the picked file, before anything is pinned. */
  imageUrl: string | null
  devBuy: bigint
  terms: LaunchTerms | null
  termsUnavailable: boolean
}) {
  // The creator is typing this, but it is the same untrusted string it will be
  // when a stranger loads the token page — treat it identically (WA-N3).
  const displayName = sanitizeText(name, 40) || 'Your token'
  const displaySymbol = sanitizeText(symbol, 12) || 'ticker'

  return (
    <Card featured className="p-5">
      <div className="grid size-14 place-items-center overflow-hidden rounded-xl bg-muted">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" aria-hidden />
        )}
      </div>

      <p className="mt-4 truncate text-section-title">{displayName}</p>
      <p className="num truncate text-sm text-muted-foreground">{displaySymbol}</p>

      <dl className="mt-4 space-y-0 border-t border-border">
        {termsUnavailable ? (
          <p className="pt-3 text-xs text-warning">
            The factory could not be read, so these terms are unknown. The form will not submit until it
            can state what you would be agreeing to.
          </p>
        ) : !terms ? (
          <p className="pt-3 text-xs text-muted-foreground">Reading terms from the factory…</p>
        ) : (
          <>
            <Row label="Launch fee">
              {terms.creationFee === '0'
                ? 'None'
                : `${formatAmount(fromBaseUnits(terms.creationFee, env.quoteDecimals), { dp: 4 })} ${env.quoteSymbol}`}
            </Row>
            <Row label="Trading fees">
              {terms.creatorFeeShareBps / 100}% creator / {(10_000 - terms.creatorFeeShareBps) / 100}% protocol
            </Row>
            {devBuy > 0n && (
              <Row label="Developer buy">
                {formatAmount(fromBaseUnits(devBuy, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
              </Row>
            )}
            <Row label="Graduation">
              {formatAmount(fromBaseUnits(terms.graduationTarget, env.quoteDecimals), {
                compact: true,
              })}{' '}
              {env.quoteSymbol}
            </Row>
            <Row label="Liquidity">
              <span className="inline-flex items-center gap-1">
                <Lock className="size-3" aria-hidden />
                Locked
              </span>
            </Row>
            <Row label="Trade fee">{terms.tradeFeeBps / 100}%</Row>
          </>
        )}
      </dl>

      {terms && (
        <p className="mt-3 text-label text-muted-foreground">
          {/*
            LP-4.4's promise, stated where the decision is made rather than in a
            doc nobody opens. The LP position is sent to a locker with no
            withdrawal path — not "we promise not to", which is a different and
            much weaker claim.
          */}
          At {formatAmount(fromBaseUnits(terms.graduationTarget, env.quoteDecimals), { compact: true })}{' '}
          {env.quoteSymbol} raised, the curve closes and its reserve becomes a Uniswap position that cannot be
          withdrawn — not by you, and not by Hoodium.
        </p>
      )}
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="num text-right text-sm font-medium">{children}</dd>
    </div>
  )
}
