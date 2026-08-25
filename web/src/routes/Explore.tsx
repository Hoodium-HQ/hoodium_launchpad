import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { BackendOfflineBanner, WrongChainBanner } from '@/components/Banners'
import { Clipart } from '@/components/Clipart'
import { CommandSearch, SearchTrigger } from '@/components/CommandSearch'
import { Freshness } from '@/components/Freshness'
import { Pagination } from '@/components/Pagination'
import { SegmentedControl } from '@/components/SegmentedControl'
import { TokenCard } from '@/components/TokenCard'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
import { useTokenList } from '@/hooks/useLaunchpad'
import { useNow } from '@/hooks/useNow'
import type { TokenListItem, TokenListSort, VolumeWindow } from '@/lib/launchpad-api'
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
 *
 * ── The page's shape is hoodium.app's ────────────────────────────────────────
 * One-line heading with a sticker beside it, a control row, then the board,
 * with the claim the page makes moved to a footnote under it. On a surface
 * someone opens to read a ranking, the ranking is the argument.
 */
type TokenSort = Extract<TokenListSort, 'recent_buys' | 'newest' | 'oldest' | 'market_cap' | 'volume'>
type TokenWindow = VolumeWindow

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

/** The feed's own poll, restated to the reader by `Freshness`. */
const FEED_INTERVAL_MS = 4_000

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
  useDocumentMeta({ canonicalPath: '/' })

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

  // Whole-factory counts, identical on both responses, so whichever answers
  // first fills both badges. `live` is what is still on a curve; `launched`
  // would count the graduated ones a second time.
  const counts = live.data?.counts ?? graduated.data?.counts

  return (
    <div className="space-y-5">
      <div className="space-y-3 empty:hidden">
        <WrongChainBanner />
        <BackendOfflineBanner />
      </div>

      {/* One line, and a sticker for what the page is *of*. The claim under it
          has moved to the footnote below the board. */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
          Launch a token on {env.chainName}. Trade it before it graduates.
        </h1>
        <Clipart name="rocket" float className="hidden size-16 sm:block" />
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchTrigger onClick={() => setSearchOpen(true)} className="flex-1" />
        {/* Below `sm` the tab bar already carries Create; a full-width lime
            button above the board would be the same action twice. */}
        <Link
          to="/create"
          className={cn(buttonVariants({ variant: 'primary' }), 'hidden shrink-0 gap-2 sm:inline-flex')}
        >
          <Plus className="size-4" aria-hidden />
          Create
        </Link>
      </div>
      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      <Section
        title="Graduated"
        count={counts?.graduated}
        blurb="Cleared the threshold. Liquidity is locked and the curve is finished."
        tokens={graduated.data?.items}
        isLoading={graduated.isLoading}
        isError={graduated.isError}
        emptyTitle="Nothing has graduated yet"
        emptyBody="No token on this factory has reached the threshold. The first one will appear here."
        emptyClipart="ticket"
        now={now}
        pager={
          <Pagination
            page={gpage}
            pages={Math.max(1, Math.ceil((graduated.data?.total ?? 0) / GRADUATED_PAGE))}
            total={graduated.data?.total}
            pageSize={GRADUATED_PAGE}
            noun="token"
            onChange={(p) => update({ gpage: p === 1 ? null : String(p) })}
          />
        }
      />

      <Section
        title="On the curve"
        count={counts?.live}
        blurb={`Still climbing toward graduation. Every one of them can also go to zero.`}
        tokens={live.data?.items}
        isLoading={live.isLoading}
        isError={live.isError}
        emptyTitle="No launches yet"
        emptyBody="Nothing has launched on this factory. Yours would be the first."
        emptyClipart="telescope"
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
              tone="quiet"
            />
          </div>
        }
        freshness={
          live.dataUpdatedAt > 0 ? (
            <Freshness
              updatedAt={live.dataUpdatedAt}
              intervalMs={FEED_INTERVAL_MS}
              isFetching={live.isFetching}
              onRefresh={() => void live.refetch()}
            />
          ) : null
        }
        pager={
          <Pagination
            page={page}
            pages={Math.max(1, Math.ceil((live.data?.total ?? 0) / LIVE_PAGE))}
            total={live.data?.total}
            pageSize={LIVE_PAGE}
            noun="token"
            onChange={(p) => update({ page: p === 1 ? null : String(p) })}
          />
        }
      />

      <div className="space-y-1.5 px-1 text-xs text-muted-foreground">
        <p>
          Market cap is the curve's spot price times the fixed supply; FDV on a graduated token is the same
          figure read from its pool. Ordering above is a plain sort on measured on-chain activity.
        </p>
        <p>
          Hoodium does not review, endorse, or rank any token for payment, and issues no token of its own.{' '}
          <Link to="/learn" className="text-foreground hover:underline">
            How it works →
          </Link>
        </p>
      </div>
    </div>
  )
}

interface SectionProps {
  title: string
  /** Size of the whole set, not of this page. Undefined until the feed answers. */
  count: number | undefined
  blurb: string
  tokens: TokenListItem[] | undefined
  isLoading: boolean
  isError: boolean
  emptyTitle: string
  emptyBody: string
  emptyClipart: 'ticket' | 'telescope'
  now: number
  controls?: React.ReactNode
  freshness?: React.ReactNode
  pager?: React.ReactNode
}

/**
 * One board. The heading is the small tracked label hoodium.app puts over a
 * board ("WHERE THIS IS WORKING"), with the set's size beside it in the same
 * mono the figures use.
 */
function Section({
  title,
  count,
  blurb,
  tokens,
  isLoading,
  isError,
  emptyTitle,
  emptyBody,
  emptyClipart,
  now,
  controls,
  freshness,
  pager,
}: SectionProps) {
  const isEmpty = !isLoading && (tokens?.length ?? 0) === 0

  return (
    <section className="scroll-mt-20">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {title}
            {count === undefined ? null : (
              <span className="num rounded-full bg-muted px-2 py-0.5 text-[11px] normal-case tracking-normal text-foreground">
                {count.toLocaleString('en-US')}
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
        </div>
        {controls}
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-64 w-full rounded-2xl" />
            ))}
          </div>
        ) : isEmpty ? (
          <Card className="p-8 text-center">
            <Clipart name={emptyClipart} className="mx-auto mb-4 size-24" />
            <h3 className="text-section-title">{isError ? 'Feed unavailable' : emptyTitle}</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              {isError
                ? 'The feed is unavailable right now. Trading still works — it reads from the chain, not from us.'
                : emptyBody}
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {tokens!.map((token, i) => (
              <TokenCard key={token.address} token={token} now={now} index={i} />
            ))}
          </div>
        )}
      </div>

      {!isEmpty && (pager || freshness) ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">{pager}</div>
          {freshness}
        </div>
      ) : null}
    </section>
  )
}
