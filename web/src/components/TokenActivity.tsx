import { ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { Address } from '@/components/Address'
import { Pagination } from '@/components/Pagination'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useTokenHolders, useTokenTrades } from '@/hooks/useLaunchpad'
import { useNow } from '@/hooks/useNow'
import type { Holder, TokenDetail, Trade } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { cn, relativeTime, sanitizeText } from '@/lib/utils'

/**
 * Trades and holders, paged.
 *
 * Holder balances are reconstructed from indexed trades, so a plain ERC-20
 * `transfer` is invisible to them. Said in the footnote rather than a tooltip,
 * because a holder list that quietly omits transfers reads as authoritative.
 */
const TABS = [
  { value: 'trades' as const, label: 'Recent trades' },
  { value: 'holders' as const, label: 'Holders' },
]

const PAGE_SIZE = 25

export function TokenActivity({ token }: { token: TokenDetail }) {
  const [tab, setTab] = useState<'trades' | 'holders'>('trades')
  const [page, setPage] = useState(1)
  const now = useNow(5_000)

  const symbol = sanitizeText(token.symbol, 16) || '???'

  const trades = useTokenTrades(tab === 'trades' ? token.address : undefined, page, PAGE_SIZE)
  const holders = useTokenHolders(tab === 'holders' ? token.address : undefined, page, PAGE_SIZE)

  const active = tab === 'trades' ? trades : holders
  // Named `rowCount`, not `total`: it is a row count, and `total*` is on the
  // money lint rule's list for good reason.
  const rowCount = active.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(rowCount / PAGE_SIZE))

  const switchTab = (next: 'trades' | 'holders') => {
    setTab(next)
    // Page 3 of trades is not page 3 of holders.
    setPage(1)
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <SegmentedControl segments={TABS} value={tab} onChange={switchTab} label="Token activity" />
        <span className="num text-label text-muted-foreground">{rowCount.toLocaleString()}</span>
      </CardHeader>

      <CardContent>
        {active.isLoading && !active.data ? (
          <Skeleton className="h-52 w-full" />
        ) : active.isError && !active.data ? (
          <Empty>Could not load {tab}. The API did not answer.</Empty>
        ) : tab === 'trades' ? (
          <TradeRows trades={trades.data?.items ?? []} symbol={symbol} now={now} />
        ) : (
          <HolderRows holders={holders.data?.items ?? []} symbol={symbol} />
        )}

        <Pagination page={page} pages={pages} onChange={setPage} className="mt-3" />

        {tab === 'holders' && (holders.data?.items.length ?? 0) > 0 && (
          <p className="mt-3 text-label text-muted-foreground">
            Balances are reconstructed from indexed trades. Direct transfers between wallets are not indexed, so
            a holder's real balance can differ.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function TradeRows({ trades, symbol, now }: { trades: Trade[]; symbol: string; now: number }) {
  if (trades.length === 0) return <Empty>No trades yet.</Empty>

  return (
    <div className="scroll-x">
      <table className="w-full text-xs [&_td]:px-2 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th]:px-2 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="pb-2 font-normal">Side</th>
            <th className="pb-2 text-right font-normal">{symbol}</th>
            <th className="pb-2 font-normal">Trader</th>
            <th className="pb-2 text-right font-normal">{env.quoteSymbol}</th>
            <th className="pb-2 font-normal">Venue</th>
            <th className="pb-2 text-right font-normal">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {trades.map((trade) => (
            <tr
              key={`${trade.txHash}-${trade.blockNumber}`}
              // Unconfirmed rows render at reduced opacity. A row that silently
              // vanished after a reorg would read as a bug.
              className={cn('animate-fade-in', !trade.finalized && 'opacity-60')}
            >
              <td className="py-1.5">
                <span
                  className={cn('inline-flex items-center gap-1', trade.side === 'buy' ? 'text-up' : 'text-down')}
                >
                  {trade.side === 'buy' ? (
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  ) : (
                    <ArrowDownLeft className="size-3.5" aria-hidden />
                  )}
                  {trade.side === 'buy' ? 'Buy' : 'Sell'}
                </span>
              </td>
              <td className="num py-1.5 text-right">
                {formatAmount(fromBaseUnits(trade.tokenAmount, 18), { compact: true })}
              </td>
              <td className="py-1.5">
                <Address value={trade.trader} to={`/profile/${trade.trader}`} label="trader address" />
              </td>
              <td className="num py-1.5 text-right">
                {formatAmount(fromBaseUnits(trade.quoteAmount, env.quoteDecimals), { dp: 4 })}
              </td>
              <td className="py-1.5 text-muted-foreground">{trade.venue === 'pool' ? 'Uniswap v3' : 'Curve'}</td>
              <td className="num py-1.5 text-right text-muted-foreground">
                {trade.finalized ? relativeTime(trade.at, now) : 'pending'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HolderRows({ holders, symbol }: { holders: Holder[]; symbol: string }) {
  if (holders.length === 0) return <Empty>No holders yet.</Empty>

  return (
    <div className="scroll-x">
      <table className="w-full text-xs [&_td]:px-2 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th]:px-2 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="pb-2 font-normal">Holder</th>
            <th className="pb-2 text-right font-normal">{symbol}</th>
            <th className="pb-2 text-right font-normal">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {holders.map((holder) => (
            <tr key={holder.address} className="animate-fade-in">
              <td className="py-1.5">
                <span className="inline-flex items-center gap-1.5">
                  <Address value={holder.address} to={`/profile/${holder.address}`} label="holder address" />
                  {holder.isCreator && (
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">creator</span>
                  )}
                </span>
              </td>
              <td className="num py-1.5 text-right">
                {formatAmount(fromBaseUnits(holder.balance, 18), { compact: true })}
              </td>
              <td className="num py-1.5 text-right">{holder.sharePct ? `${holder.sharePct}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
}
