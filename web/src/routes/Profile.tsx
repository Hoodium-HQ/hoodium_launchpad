import { Check, Coins, Share2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useAccount, useDisconnect } from 'wagmi'
import { Address } from '@/components/Address'
import { Clipart } from '@/components/Clipart'
import { ConnectButton } from '@/components/ConnectButton'
import { SegmentedControl } from '@/components/SegmentedControl'
import { StatTile } from '@/components/StatTile'
import { TokenAvatar } from '@/components/TokenAvatar'
import { TokenCard } from '@/components/TokenCard'
import { TxStatus } from '@/components/TxStatus'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useCreatorFees } from '@/hooks/useCreatorFees'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
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
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * hoodium.app's provider page: the address as the heading, three plain tiles
 * in one card separated by rules, then a segmented board. Same tile, same
 * label treatment, so a reader who has learned one page can read the other.
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

  useDocumentMeta({
    title: valid ? `Profile ${truncateMiddle(valid)}` : 'Profile',
    description: valid ? `Launchpad holdings, launches and trades of ${valid} on ${env.chainName}.` : undefined,
    canonicalPath: valid ? `/profile/${valid}` : '/profile',
    // Your own profile, before a wallet is connected, is an invitation to
    // connect and nothing else.
    noindex: !valid,
  })

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
        <Clipart name="wallet" className="mx-auto mb-4 size-28" />
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

  const holdingsCount = holdings.length
  const launchCount = launches.length
  const tradeCount = profile.data?.totals.tradeCount ?? 0

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="min-w-0">
            <Address value={address} size="lg" lead={10} tail={8} muted={false} />
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isSelf ? 'Your profile' : 'Trader profile'} · {env.chainName}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void share()}>
            {copied ? <Check aria-hidden /> : <Share2 aria-hidden />}
            {copied ? 'Link copied' : 'Share'}
          </Button>
          {isSelf && (
            <Button variant="ghost" size="sm" className="text-down hover:text-down" onClick={() => disconnect()}>
              Disconnect
            </Button>
          )}
        </div>
      </header>

      {/* Three figures inside one container, separated by rules rather than
          three equal cards — they are counts, not the headline of the page. */}
      <Card className="grid grid-cols-3 divide-x divide-border px-4">
        <StatTile
          variant="plain"
          label="Holdings"
          value={null}
          dp={0}
          suffix=""
          note="Launchpad tokens this address holds a balance of, reconciled against the chain."
          className="pr-4"
        >
          {profile.isLoading ? <Skeleton className="h-6 w-10" /> : holdingsCount.toLocaleString('en-US')}
        </StatTile>
        <StatTile
          variant="plain"
          label="Launches"
          value={null}
          dp={0}
          suffix=""
          note="Tokens this address created on the factory."
          className="px-4"
        >
          {profile.isLoading ? <Skeleton className="h-6 w-10" /> : launchCount.toLocaleString('en-US')}
        </StatTile>
        <StatTile
          variant="plain"
          label="Trades"
          value={null}
          dp={0}
          suffix=""
          note="Indexed curve trades, buys and sells, across every token."
          className="pl-4"
        >
          {profile.isLoading ? <Skeleton className="h-6 w-10" /> : tradeCount.toLocaleString('en-US')}
        </StatTile>
      </Card>

      {profile.isError && (
        <p className="px-1 text-xs text-muted-foreground">
          The API did not answer, so this profile is empty for now. Trading still works from any token page.
        </p>
      )}

      {/* Creator fees, for the wallet's own profile only — the claim needs its signature. */}
      {isSelf && fees.count > 0 && (
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
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

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            segments={TABS.map((t) => ({
              ...t,
              count: profile.data
                ? t.value === 'holdings'
                  ? holdingsCount
                  : t.value === 'launches'
                    ? launchCount
                    : undefined
                : undefined,
            }))}
            value={tab}
            onChange={setTab}
            label="Profile section"
            countLabel="token"
          />
          <p className="text-label text-muted-foreground">
            {tab === 'holdings' && 'PnL is value now against the average cost of what was bought.'}
            {tab === 'launches' && 'Every token this address created, newest first.'}
            {tab === 'activity' && 'Buys, sells and launches, newest first.'}
          </p>
        </div>

        <div className="mt-4">
          {tab === 'activity' ? (
            activity.isLoading ? (
              <SkeletonRows rows={5} />
            ) : (
              <ActivityList entries={entries} now={now} />
            )
          ) : profile.isLoading ? (
            <SkeletonRows rows={4} />
          ) : tab === 'holdings' ? (
            <HoldingList holdings={holdings} now={now} />
          ) : (
            <LaunchList launches={launches} now={now} />
          )}
        </div>
      </section>
    </div>
  )
}

function HoldingList({ holdings, now }: { holdings: ProfileHolding[]; now: number }) {
  if (holdings.length === 0) {
    return <EmptyBoard>No launchpad tokens held by this address.</EmptyBoard>
  }

  return (
    <>
      <Card className="divide-y divide-border">
        {holdings.map((h, i) => {
          const name = sanitizeText(h.name, 40) || 'Unnamed'
          return (
            <Link
              key={h.address}
              to={`/t/${h.address}`}
              style={{ '--i': i } as React.CSSProperties}
              className={cn(
                'stagger-in flex flex-wrap items-center gap-4 px-4 py-3',
                'transition-colors duration-[120ms] hover:bg-muted/40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
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
          )
        })}
      </Card>
      <p className="mt-3 px-1 text-label text-muted-foreground">
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
        {negative ? '−' : '+'}
        {formatAmount(magnitude, { dp: 2, prefix: '$' })}
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
    return <EmptyBoard>This address has launched nothing.</EmptyBoard>
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {launches.map((token, i) => (
        <TokenCard key={token.address} token={token} now={now} index={i} />
      ))}
    </div>
  )
}

function ActivityList({ entries, now }: { entries: ProfileActivityEntry[]; now: number }) {
  if (entries.length === 0) {
    return <EmptyBoard>No launchpad activity yet.</EmptyBoard>
  }

  return (
    <Card className="scroll-x">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-3 py-2.5 text-left font-medium">
              Side
            </th>
            <th scope="col" className="px-3 py-2.5 text-left font-medium">
              Token
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">
              {env.quoteSymbol}
            </th>
            <th scope="col" className="px-3 py-2.5 text-right font-medium">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr
              key={`${entry.txHash ?? entry.address}-${index}`}
              style={{ '--i': index } as React.CSSProperties}
              className={cn('stagger-in border-b border-border last:border-0', !entry.finalized && 'opacity-60')}
            >
              <td
                className={cn(
                  'num whitespace-nowrap px-3 py-2.5 text-xs',
                  entry.kind === 'buy' ? 'text-up' : entry.kind === 'sell' ? 'text-down' : 'text-primary',
                )}
              >
                {entry.kind === 'buy' ? '↑ Buy' : entry.kind === 'sell' ? '↓ Sell' : '★ Launch'}
              </td>
              <td className="max-w-0 px-3 py-2.5">
                <Link to={`/t/${entry.address}`} className="block truncate hover:underline">
                  {sanitizeText(entry.name, 40) || truncateMiddle(entry.address)}
                  <span className="num ml-1.5 text-xs text-muted-foreground">${sanitizeText(entry.symbol, 12)}</span>
                </Link>
              </td>
              <td className="num whitespace-nowrap px-3 py-2.5 text-right text-xs">
                {entry.kind === 'launch'
                  ? '—'
                  : formatAmount(fromBaseUnits(entry.usdgAmount, env.quoteDecimals), { dp: 4, prefix: '$' })}
              </td>
              <td className="num whitespace-nowrap px-3 py-2.5 text-right text-xs text-muted-foreground">
                {entry.at ? relativeTime(entry.at, now) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function EmptyBoard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="p-8 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </Card>
  )
}
