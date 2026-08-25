import { Rocket } from 'lucide-react'
import { Address } from '@/components/Address'
import { env } from '@/config/env'
import type { LaunchTerms } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { sanitizeText } from '@/lib/utils'
import { Modal } from './Modal'
import { Button } from './ui/button'

/**
 * The last screen before a signature — WA-1.4, WA-1.5.
 *
 * "This product explains before it asks."
 *
 * Everything here is the argument that is about to be encoded, or a term the
 * transaction will lock in permanently. Nothing is summarised loosely: the
 * network and factory are shown because a wallet prompt shows neither in a form
 * anyone reads, and picking the wrong network is how a creator ends up with a
 * token on a chain nobody trades.
 *
 * The metadata URI is here too, and it is the reason this dialog exists at all.
 * By the time it opens the artwork is already pinned and immutable — this is the
 * creator's one chance to see the hash that is about to be written on-chain
 * forever.
 */
export function LaunchConfirmDialog({
  open,
  onClose,
  onConfirm,
  busy,
  name,
  symbol,
  metadataURI,
  devBuy,
  creator,
  terms,
  factoryAddress,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  busy: boolean
  name: string
  symbol: string
  metadataURI: string
  devBuy: bigint
  creator: string
  terms: LaunchTerms | null
  factoryAddress: string
}) {
  const displayName = sanitizeText(name, 40)
  const displaySymbol = sanitizeText(symbol, 12)

  return (
    <Modal open={open} onClose={onClose} title={`Launch ${displaySymbol || 'token'}`}>
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-primary/15">
        <Rocket className="size-5 text-primary" aria-hidden />
      </div>

      <dl className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
        <Row label="Token">
          {displayName} ({displaySymbol})
        </Row>
        {terms && (
          <>
            <Row label="Launch fee">
              {terms.creationFee === '0'
                ? 'None'
                : `${env.quoteSymbol} ${formatAmount(fromBaseUnits(terms.creationFee, env.quoteDecimals), { dp: 4 })}`}
            </Row>
            <Row label="Trading fee split">
              {terms.creatorFeeShareBps / 100}% creator / {(10_000 - terms.creatorFeeShareBps) / 100}% protocol
            </Row>
          </>
        )}
        <Row label="Developer buy">
          {devBuy === 0n
            ? 'None'
            : `${env.quoteSymbol} ${formatAmount(fromBaseUnits(devBuy, env.quoteDecimals), { dp: 6 })}`}
        </Row>
        {/* This dialog is the last screen before an irreversible signature, so
            it is the one place a reader is most likely to want to check a value
            against something else. Truncated and uncopyable is the worst shape
            for that. */}
        <Row label="Creator">
          <Address value={creator} label="creator address" />
        </Row>
        <Row label="Network">
          {env.chainName} ({env.chainId})
        </Row>
        <Row label="Factory">
          <Address value={factoryAddress} label="factory address" />
        </Row>
        <Row label="Metadata">
          {metadataURI ? (
            <Address value={metadataURI} label="metadata URI" lead={12} tail={6} />
          ) : (
            'None'
          )}
        </Row>
      </dl>

      <p className="mt-3 text-xs text-muted-foreground">
        One transaction deploys the token, opens its curve, and executes the developer buy. None of it can be
        undone or edited afterwards.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Working…' : 'Confirm'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="num truncate text-right font-medium">{children}</dd>
    </div>
  )
}
