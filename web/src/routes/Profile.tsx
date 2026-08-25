import { Check, Coins, Share2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAccount, useDisconnect } from 'wagmi'
import { Address } from '@/components/Address'
import { ConnectButton } from '@/components/ConnectButton'
import { SegmentedControl } from '@/components/SegmentedControl'
import { TokenAvatar } from '@/components/TokenAvatar'
import { TokenCard } from '@/components/TokenCard'
import { TxStatus } from '@/components/TxStatus'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useCreatorFees } from '@/hooks/useCreatorFees'
import { useProfile, useProfileActivity } from '@/hooks/useLaunchpad'
import { useNow } from '@/hooks/useNow'
import {
  tokenImageUrl,
  type ProfileActivityEntry,
  type ProfileHolding,
  type ProfileLaunch,
} from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits, isNegative, usdToMoney } from '@/lib/money'
import { cn, isAddress, relativeTime, sanitizeText, truncateMiddle } from '@/lib/utils'

/**
 * Trader profile — holdings, launches, activity.
 *
 * Public: everything here is derived from indexed on-chain trades, which the
 * token page already serves per-token to anyone. Gating the same facts behind
 * a session because they are grouped by address would be theatre, and it would
 * break the share link the header offers.
 *
 * PnL is sometimes missing on purpose. Cost basis is reconstructed from
 * trades; a plain ERC-20 `transfer` moves balance without one, so the API
 * withholds the figure when the two disagree. A withheld number is the answer.
 *
 * The profile and its activity are two calls: the profile reconciles every
 * open position against the chain and is the slower of the two, so the
 * activity tab does not wait on it.
 */
const TABS = [
  { value: 'holdings' as const, label: 'Holdings' },
  { value: 'launches' as const, label: 'Launches' },
  { value: 'activity' as const, label: 'Activity' },
]

export function Profile() {
  const { address: routeAddress } = useParams()
  const { address: connected } = useAccount()
  const { disconnect } = useDisconnect()
  const now = useNow(5_000)

  const address = (routeAddress ?? connected ?? '').toLowerCase()
  const isSelf = Boolean(connected && address === connected.toLowerCase())

  const [tab, setTab] = useState<'holdings' | 'launches' | 'activity'>('holdings')
  const [copied, setCopied] = useState(false)

  const valid = isAddress(address) ? address : undefined
  const profile = useProfile(valid)
  const activity = useProfileActivity(valid)
  const fees = useCreatorFees()

  const share = async () => {
    const url = `${env.siteUrl}/profile/${address}`
    if (navigator.share) {
      await navigator.share({ title: 'Hoodium Launchpad profile', url }).catch(() => {})
      return
    }
    await navigator.clipboard.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  if (!address) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-section-title">Connect a wallet to see your profile</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Or open anyone's profile directly — every figure on this page comes from public on-chain activity,
          so no signature is needed to read one.
        </p>
        <div className="mt-5 flex justify-center">
          <ConnectButton variant="primary" size="md" label="Connect wallet" />
        </div>
      </Card>
    )
  }

  if (!isAddress(address)) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-section-title">That is not an address</h1>
        <p className="mt-2 text-sm text-muted-foreground">A profile lives at /profile/0x… — forty hex characters.</p>
      </Card>
    )
  }

  const holdings = profile.data?.holdings ?? []
  const launches = profile.data?.launches ?? []
  const entries = activity.data?.entries ?? []

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="min-w-0">
              <Address value={address} size="lg" lead={10} tail={8} muted={false} />
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{isSelf ? 'Your profile' : 'Trader profile'}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void share()}>
              {copied ? <Check aria-hidden /> : <Share2 aria-hidden />}
              {copied ? 'Link copied' : 'Share'}
            </Button>
            {isSelf && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => disconnect()}>
                Disconnect
              </Button>
            )}
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-3 gap-3">
          <Stat label="Holdings" loading={profile.isLoading}>
            {holdings.length}
          </Stat>
          <Stat label="Launches" loading={profile.isLoading}>
            {launches.length}
          </Stat>
          <Stat label="Trades" loading={profile.isLoading}>
            {profile.data?.totals.tradeCount ?? 0}
          </Stat>
        </dl>

        {profile.isError && (
          <p className="mt-3 text-xs text-muted-foreground">
            The API did not answer, so this profile is empty for now. Trading still works from any token page.
          </p>
        )}
      </Card>

      {/* Creator fees, for the wallet's own profile only — the claim needs its signature. */}
      {isSelf && fees.count > 0 && (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
              <Coins className="size-4 text-muted-foreground" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-card-title">Creator fees ready</h2>
              <p className="mt-0.5 text-label text-muted-foreground">
                Your share of curve trades on tokens you launched, claimable now in {env.quoteSymbol}.
              </p>
            </div>
          </div>
          <ul className="mt-3 divide-y divide-border">
            {fees.claimable.map((fee) => (
              <li key={fee.token.address} className="flex items-center gap-3 py-2">
                <TokenAvatar
                  tokenAddress={fee.token.address}
                  name={sanitizeText(fee.token.name, 40)}
                  src={tokenImageUrl(fee.token)}
                  className="size-8 text-xs"
                  rounded="rounded-lg"
                />
                <Link to={`/t/${fee.token.address}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                  {sanitizeText(fee.token.name, 40) || 'Unnamed'}
                </Link>
                <span className="num text-sm">
                  {formatAmount(fromBaseUnits(fee.amount, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
                </span>
                <Button variant="primary" size="sm" disabled={fees.tx.isBusy} onClick={() => void fees.claim(fee)}>
                  Claim
                </Button>
              </li>
            ))}
          </ul>
          <TxStatus tx={fees.tx} className="mt-3" />
        </Card>
      )}

      <Card className="p-5">
        <SegmentedControl segments={TABS} value={tab} onChange={setTab} label="Profile section" />

        <div className="mt-4">
          {tab === 'activity' ? (
            activity.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <ActivityList entries={entries} now={now} />
            )
          ) : profile.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : tab === 'holdings' ? (
            <HoldingList holdings={holdings} now={now} />
          ) : (
            <LaunchList launches={launches} now={now} />
          )}
        </div>
      </Card>
    </div>
  )
}

function Stat({ label, loading, children }: { label: string; loading: boolean; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <dt className="text-label text-muted-foreground">{label}</dt>
      <dd className="num mt-1 text-[17px] font-medium">{loading ? <Skeleton className="h-5 w-10" /> : children}</dd>
    </div>
  )
}

function HoldingList({ holdings, now }: { holdings: ProfileHolding[]; now: number }) {
  if (holdings.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No launchpad tokens held by this address.</p>
  }

  return (
    <>
      <ul className="space-y-2">
        {holdings.map((h) => {
          const name = sanitizeText(h.name, 40) || 'Unnamed'
          return (
            <li key={h.address}>
              <Link
                to={`/t/${h.address}`}
                className={cn(
                  'flex flex-wrap items-center gap-4 rounded-xl border border-border p-3',
                  'transition-colors duration-[120ms] hover:border-primary/30',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                <div className="flex min-w-[10rem] flex-1 items-center gap-2.5">
                  <TokenAvatar
                    tokenAddress={h.address}
                    name={name}
                    src={tokenImageUrl(h)}
                    className="size-9 shrink-0 text-xs"
                    rounded="rounded-lg"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{name}</p>
                    <p className="num truncate text-label text-muted-foreground">
                      ${sanitizeText(h.symbol, 12) || '???'}
                      {h.lastTradeAt ? ` · ${relativeTime(h.lastTradeAt, now)}` : ''}
                    </p>
                  </div>
                </div>

                <Column label="Balance">{formatAmount(fromBaseUnits(h.balance, 18), { compact: true })}</Column>
                <Column label="Value">{formatAmount(usdToMoney(h.valueUsd), { dp: 2, prefix: '$' })}</Column>
                <PnlColumn value={h.unrealizedPnlUsd} />
              </Link>
            </li>
          )
        })}
      </ul>
      <p className="mt-4 text-label text-muted-foreground">
        PnL uses indexed trades and average-cost accounting. It is withheld when transfers or incomplete history
        do not reconcile with the live wallet balance.
      </p>
    </>
  )
}

/** Unrealised PnL in USD (USDG at $1); null is withheld, not zero. */
function PnlColumn({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <div className="min-w-[6rem] text-right">
        <p className="text-label text-muted-foreground">PnL</p>
        <p className="text-sm text-muted-foreground">Unavailable</p>
      </div>
    )
  }
  const pnl = usdToMoney(value)
  const negative = isNegative(pnl)
  const magnitude = pnl.replace('-', '')
  return (
    <div className="min-w-[6rem] text-right">
      <p className="text-label text-muted-foreground">PnL</p>
      <p className={cn('num text-sm font-medium', negative ? 'text-down' : 'text-up')}>
        {negative ? '▼' : '▲'} {formatAmount(magnitude, { dp: 2, prefix: '$' })}
      </p>
    </div>
  )
}

function Column({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[6rem]">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="num text-sm">{children}</p>
    </div>
  )
}

function LaunchList({ launches, now }: { launches: ProfileLaunch[]; now: number }) {
  if (launches.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">This address has launched nothing.</p>
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {launches.map((token) => (
        <TokenCard key={token.address} token={token} now={now} />
      ))}
    </div>
  )
}

function ActivityList({ entries, now }: { entries: ProfileActivityEntry[]; now: number }) {
  if (entries.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No launchpad activity yet.</p>
  }

  return (
    <ul className="divide-y divide-border">
      {entries.map((entry, index) => (
        <li
          key={`${entry.txHash ?? entry.address}-${index}`}
          className={cn('flex items-center gap-3 py-2.5 text-sm', !entry.finalized && 'opacity-60')}
        >
          <span
            className={cn(
              'num w-16 shrink-0 text-xs',
              entry.kind === 'buy' ? 'text-up' : entry.kind === 'sell' ? 'text-down' : 'text-primary',
            )}
          >
            {entry.kind === 'buy' ? '↑ Buy' : entry.kind === 'sell' ? '↓ Sell' : '★ Launch'}
          </span>

          <Link to={`/t/${entry.address}`} className="min-w-0 flex-1 truncate hover:underline">
            {sanitizeText(entry.name, 40) || truncateMiddle(entry.address)}
            <span className="num ml-1.5 text-xs text-muted-foreground">${sanitizeText(entry.symbol, 12)}</span>
          </Link>

          <span className="num shrink-0 text-xs">
            {entry.kind === 'launch'
              ? '—'
              : formatAmount(fromBaseUnits(entry.usdgAmount, env.quoteDecimals), { dp: 4, prefix: '$' })}
          </span>

          <span className="num w-16 shrink-0 text-right text-xs text-muted-foreground">
            {entry.at ? relativeTime(entry.at, now) : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
