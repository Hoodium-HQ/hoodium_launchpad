import { CircleCheck, CircleX, Loader2 } from 'lucide-react'
import { env } from '@/config/env'
import type { TransactionResult } from '@/hooks/useTransaction'
import { cn, truncateMiddle } from '@/lib/utils'

/**
 * `TxStatus` — design-system.md section 7, WA-4.2 / WA-4.3.
 *
 * Renders the state machine from design.md section 6. Two rules it exists to
 * honour: the app stays usable while a transaction is pending (this is a strip,
 * never a blocking modal), and a failure shows a decoded reason rather than a
 * raw hex string.
 */
const COPY: Record<string, string> = {
  simulating: 'Checking the transaction will succeed…',
  awaiting_signature: 'Confirm in your wallet',
  pending: 'Submitted — waiting for confirmation',
  confirmed: 'Confirmed',
  rejected: 'You declined the signature. Nothing was sent.',
  failed: 'Transaction failed',
}

/** Contract custom errors, translated into something a trader can act on. */
const REVERT_COPY: Record<string, string> = {
  SlippageExceeded: 'Price moved past your slippage limit. Nothing was spent — try again or raise the limit.',
  AntiSnipeCapExceeded:
    'Too large for the opening blocks. Each address may buy at most a small share of supply in total during the launch window; try a smaller amount or wait a few blocks.',
  AlreadyGraduated: 'This curve has closed — the token has graduated to a Uniswap pool.',
  CurveComplete: 'Curve complete — trading has moved to the pool. Nothing was spent.',
  Expired: 'This trade’s deadline passed before it was mined. Nothing was spent — submit it again.',
  PoolPriceManipulated:
    'This buy would complete the curve, but someone has primed the pool with liquidity at a hostile price. Graduation is blocked until the pool price is arbitraged back; try again later.',
  UnexpectedSwapPayment:
    'This buy would complete the curve, but the pool has liquidity in the way of its fair price. Graduation is blocked until the pool price is arbitraged back; try again later.',
  ExcessiveDust: 'The pool would not take enough of the raise. Graduation is blocked until the pool price is arbitraged back; try again later.',
  NothingToPull: 'Nothing is left over to pull.',
  NotBeneficiary: 'Only the creator can collect these fees.',
  NotGraduated: 'This token has not graduated yet.',
  ZeroAmount: 'That amount is too small to trade.',
  ExceedsSold: 'You cannot sell more than the curve has sold.',
  UnsupportedTokenBehaviour: 'This token behaves in a way the curve rejects. Nothing was spent.',
  DevBuyTooLarge: 'That dev buy exceeds the cap on the creator’s own share.',
  TargetNotReached: 'The curve has not reached its graduation target yet.',
  NotCreator: 'Only the creator can claim these fees.',
}

function humanise(error: string): string {
  const name = error.split('(')[0]?.trim() ?? error
  return REVERT_COPY[name] ?? error
}

export function TxStatus({ tx, className }: { tx: TransactionResult; className?: string }) {
  if (tx.state === 'idle') return null

  const failed = tx.state === 'failed' || tx.state === 'rejected'
  const done = tx.state === 'confirmed'

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-2 rounded-xl border p-3 text-xs',
        done && 'border-up/25 bg-up/10 text-up',
        failed && 'border-down/25 bg-down/10 text-down',
        !done && !failed && 'border-border bg-muted/40 text-muted-foreground',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {done ? (
          <CircleCheck className="size-3.5" />
        ) : failed ? (
          <CircleX className="size-3.5" />
        ) : (
          <Loader2 className="size-3.5 animate-spin" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="font-medium">{COPY[tx.state] ?? tx.state}</p>
        {/* WA-4.3 — the decoded reason, not the hex. */}
        {tx.error && tx.state !== 'rejected' && <p className="mt-0.5 opacity-90">{humanise(tx.error)}</p>}
        {tx.hash && (
          <p className="num mt-1 opacity-70">
            {env.explorerUrl ? (
              <a
                href={`${env.explorerUrl}/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {truncateMiddle(tx.hash, 10, 8)}
              </a>
            ) : (
              truncateMiddle(tx.hash, 10, 8)
            )}
          </p>
        )}
      </div>
    </div>
  )
}
