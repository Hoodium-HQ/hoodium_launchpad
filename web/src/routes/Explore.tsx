import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { BackendOfflineBanner, WrongChainBanner } from '@/components/Banners'
import { CommandSearch, SearchTrigger } from '@/components/CommandSearch'
import { Pagination } from '@/components/Pagination'
import { SegmentedControl } from '@/components/SegmentedControl'
import { TokenCard } from '@/components/TokenCard'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useTokenList } from '@/hooks/useLaunchpad'
import { useNow } from '@/hooks/useNow'
import type { TokenSort, TokenSummary, TokenWindow } from '@/lib/launchpad-api'
import { cn } from '@/lib/utils'

/**
 * Explore — two sections, not one feed with a status filter.
 *
 * A graduated token and a curve token are different objects: one has a real
 * pool with locked liquidity, the other may never finish. One feed with a
 * toggle made them look interchangeable.
 *
 * Nothing is promoted. Splitting by status is a filter on a measured column,
 * and every sort is a plain sort. There is no code path that can place a token
 * higher than the sort puts it, paid or otherwise.
 *
 * Sort, window and page live in the URL so a view someone wants to show a
 * friend survives the paste.
 */
const SORTS: Array<{ value: TokenSort; label: string }> = [
  { value: 'recent_buys', label: 'Recent buys' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'market_cap', label: 'Market cap' },
  { value: 'volume', label: 'Volume' },
]

const WINDOWS: Array<{ value: TokenWindow; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
]

const GRADUATED_PAGE = 10
const LIVE_PAGE = 20

function isSort(v: string | null): v is TokenSort {
  return SORTS.some((s) => s.value === v)
}
function isWindow(v: string | null): v is TokenWindow {
  return WINDOWS.some((w) => w.value === v)
}
function pageOf(v: string | null): number {
  const n = Number.parseInt(v ?? '1', 10)
  return Number.isInteger(n) && n > 0 ? n : 1
}

export function Explore() {
  const [params, setParams] = useSearchParams()
  const [searchOpen, setSearchOpen] = useState(false)
  const now = useNow()

  const sort = isSort(params.get('sort')) ? (params.get('sort') as TokenSort) : 'recent_buys'
  const window = isWindow(params.get('window')) ? (params.get('window') as TokenWindow) : 'all'
  const page = pageOf(params.get('page'))
  const gpage = pageOf(params.get('gpage'))

  const update = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === '') prev.delete(key)
          else prev.set(key, value)
        }
        return prev
      },
      { replace: true },
    )

  const graduated = useTokenList({ status: 'graduated', sort: 'newest', page: gpage, limit: GRADUATED_PAGE })
  const live = useTokenList({ status: 'live', sort, window, page, limit: LIVE_PAGE })

  const counts = live.data?.counts ?? graduated.data?.counts

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchTrigger onClick={() => setSearchOpen(true)} className="flex-1" />
        <Link to="/create" className={cn(buttonVariants({ variant: 'primary' }), 'shrink-0 gap-2')}>
          <Plus className="size-4" aria-hidden />
          Create
        </Link>
      </div>
      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      <div className="space-y-3">
        <WrongChainBanner />
        <BackendOfflineBanner />
      </div>

      <Section
        title="Graduated"
        count={counts?.graduated}
        blurb="Tokens that cleared the graduation threshold. Liquidity is locked and the curve is finished."
        tokens={graduated.data?.items}
        isLoading={graduated.isLoading}
        isError={graduated.isError}
        emptyTitle="Nothing has graduated yet"
        emptyBody="No token on this factory has reached the threshold. The first one will appear here."
        now={now}
        tinted
        pager={
          <Pagination
            page={gpage}
            pages={Math.max(1, Math.ceil((graduated.data?.total ?? 0) / GRADUATED_PAGE))}
            onChange={(p) => update({ gpage: p === 1 ? null : String(p) })}
          />
        }
      />

      <Section
        title="Explore"
        count={counts?.launched}
        countLabel="launched"
        blurb={`Tokens still climbing toward graduation on ${env.chainName}. Every one of them can also go to zero.`}
        tokens={live.data?.items}
        isLoading={live.isLoading}
        isError={live.isError}
        emptyTitle="No launches yet"
        emptyBody="Nothing has launched on this factory. Yours would be the first."
        now={now}
        controls={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              segments={SORTS}
              value={sort}
              onChange={(v) => update({ sort: v === 'recent_buys' ? null : v, page: null })}
              label="Sort tokens"
            />
            <SegmentedControl
              segments={WINDOWS}
              value={window}
              onChange={(v) => update({ window: v === 'all' ? null : v, page: null })}
              label="Time window"
            />
          </div>
        }
        pager={
          <Pagination
            page={page}
            pages={Math.max(1, Math.ceil((live.data?.total ?? 0) / LIVE_PAGE))}
            onChange={(p) => update({ page: p === 1 ? null : String(p) })}
          />
        }
      />

      <p className="px-1 text-xs text-muted-foreground">
        Hoodium does not review, endorse, or rank any token for payment, and issues no token of its own.
        Ordering above is a plain sort on measured on-chain activity.
      </p>
    </div>
  )
}

interface SectionProps {
  title: string
  /** Size of the whole set, not of this page. Undefined until the feed answers. */
  count: number | undefined
  countLabel?: string
  blurb: string
  tokens: TokenSummary[] | undefined
  isLoading: boolean
  isError: boolean
  emptyTitle: string
  emptyBody: string
  now: number
  controls?: React.ReactNode
  pager?: React.ReactNode
  tinted?: boolean
}

function Section({
  title,
  count,
  countLabel,
  blurb,
  tokens,
  isLoading,
  isError,
  emptyTitle,
  emptyBody,
  now,
  controls,
  pager,
  tinted,
}: SectionProps) {
  const isEmpty = !isLoading && (tokens?.length ?? 0) === 0

  return (
    <section className={cn('rounded-2xl', tinted && 'border border-border bg-muted/20 p-4 sm:p-5')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-section-title">{title}</h2>
            {count === undefined ? null : (
              <span className="num rounded-full bg-muted px-2 py-0.5 text-[12px] text-muted-foreground">
                {count.toLocaleString('en-US')}
                {countLabel ? ` ${countLabel}` : ''}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
        </div>
        {controls}
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-64 w-full" />
            ))}
          </div>
        ) : isEmpty ? (
          <Card className="p-8 text-center">
            <h3 className="text-section-title">{isError ? 'Feed unavailable' : emptyTitle}</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              {isError
                ? 'The feed is unavailable right now. Trading still works — it reads from the chain, not from us.'
                : emptyBody}
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {tokens!.map((token) => (
              <TokenCard key={token.address} token={token} now={now} />
            ))}
          </div>
        )}
      </div>

      {!isEmpty && pager ? <div className="mt-4">{pager}</div> : null}
    </section>
  )
}
