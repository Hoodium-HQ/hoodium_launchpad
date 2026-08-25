import { ArrowLeft, ExternalLink, Percent } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { Address } from '@/components/Address'
import { WrongChainBanner } from '@/components/Banners'
import { CreatorFeesCard } from '@/components/CreatorFeesCard'
import { CurveProgress } from '@/components/CurveProgress'
import { PoolFeesCard } from '@/components/PoolFeesCard'
import { RiskFlags } from '@/components/RiskFlag'
import { TokenActivity } from '@/components/TokenActivity'
import { TokenAvatar } from '@/components/TokenAvatar'
import { TokenChartCard } from '@/components/TokenChartCard'
import { TokenLinks } from '@/components/TokenLinks'
import { TradePanel } from '@/components/TradePanel'
import { Card } from '@/components/ui/card'
import { Skeleton, SkeletonCard } from '@/components/ui/skeleton'
import { env } from '@/config/env'
import { useToken } from '@/hooks/useLaunchpad'
import { ApiError, tokenImageUrl } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { cn, relativeTime, sanitizeText } from '@/lib/utils'

/**
 * Token page.
 *
 * ── Layout order is an argument, not a preference ────────────────────────────
 * About first, because a stranger arriving from a shared link needs to know
 * what this is before any number means anything. Then two columns: the curve
 * and the trade panel on the left, with the risk flags **above** the panel
 * where a buyer cannot transact without passing them; price, chart and history
 * on the right. Fee cards last — the creator's is only rendered for the
 * creator, the pool's is the disclosure everyone gets.
 */
export function TokenPage() {
  const { address = '' } = useParams()
  const token = useToken(address)

  if (token.isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-5 w-32" />
        <SkeletonCard lines={3} />
        <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
          <SkeletonCard lines={6} className="h-96" />
          <SkeletonCard lines={8} className="h-96" />
        </div>
      </div>
    )
  }

  if (!token.data) {
    const missing = token.error instanceof ApiError && token.error.status === 404
    return (
      <Card className="p-8 text-center">
        <h1 className="text-section-title">{missing ? 'Token not found' : 'Could not load this token'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {missing
            ? 'It may not have been indexed yet, or the address is wrong.'
            : 'The API did not answer. Try again in a moment.'}
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-primary hover:underline">
          Back to explore
        </Link>
      </Card>
    )
  }

  const t = token.data
  // Creator-supplied and attacker-controlled, every one of them.
  const name = sanitizeText(t.name, 60) || 'Unnamed'
  const symbol = sanitizeText(t.symbol, 16) || '???'
  const description = sanitizeText(t.description, 512)
  const graduated = t.status === 'graduated' || t.graduated
  const pct = Math.min(100, Math.max(0, t.progressBps / 100))

  /*
   * The fee terms ride on `curveState` and are null when the API could not read
   * the factory. Null is "unknown", which the page says outright — a zero here
   * would read as a free trade, and that is a claim nobody verified.
   */
  const { tradeFeeBps, creatorFeeShareBps, lpProtocolFeeShareBps } = t.curveState
  const creatorTaxPct =
    tradeFeeBps !== null && creatorFeeShareBps !== null ? (tradeFeeBps * creatorFeeShareBps) / 1_000_000 : null

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Back to explore
      </Link>

      <WrongChainBanner />

      {/* ── About ──────────────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <TokenAvatar
                tokenAddress={t.address}
                name={name}
                src={tokenImageUrl(t)}
                className="size-14 shrink-0 text-lg"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-page-title">{name}</h1>
                  {graduated ? (
                    <Chip tone="up">Graduated</Chip>
                  ) : (
                    <Chip tone="muted">Bonding curve</Chip>
                  )}
                  <Chip tone="muted">Paired {env.quoteSymbol}</Chip>
                </div>
                <p className="num text-sm text-muted-foreground">${symbol}</p>
              </div>
            </div>
            <TokenLinks token={t} />
          </div>

          {description ? (
            <p className="mt-4 max-w-2xl whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {description}
            </p>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              {t.metadataURI
                ? 'No description in this token’s metadata, or it has not been read yet.'
                : 'This token launched without metadata.'}
            </p>
          )}

          <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border pt-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Creator">
              <Address value={t.creator} to={`/profile/${t.creator}`} label="creator address" />
            </Fact>
            <Fact label="Creator tax">
              <span className="num">
                {creatorTaxPct !== null
                  ? `${creatorTaxPct.toFixed(creatorTaxPct % 1 === 0 ? 0 : 2)}% of every curve trade`
                  : 'Terms unavailable'}
              </span>
            </Fact>
            <Fact label="Supply">
              <span className="num">
                {t.curveState.totalSupply
                  ? formatAmount(fromBaseUnits(t.curveState.totalSupply, 18), { compact: true })
                  : '—'}{' '}
                {symbol}
              </span>
            </Fact>
            <Fact label="Contract">
              <span className="inline-flex flex-wrap items-center gap-2">
                <Address value={t.address} label="token address" />
                {env.explorerUrl && (
                  <a
                    href={`${env.explorerUrl}/address/${t.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    Explorer <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </span>
            </Fact>
          </dl>
        </Card>

        {/* Holder fee sharing — the terms, stated where everyone reads them. */}
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
              <Percent className="size-4 text-muted-foreground" aria-hidden />
            </span>
            <div>
              <h2 className="text-card-title">Fee sharing</h2>
              <p className="mt-1 text-label text-muted-foreground">
                {tradeFeeBps !== null && creatorFeeShareBps !== null ? (
                  <>
                    Every curve trade pays a {tradeFeeBps / 100}% fee, split{' '}
                    <span className="text-foreground">{creatorFeeShareBps / 100}% to the creator</span> and{' '}
                    {(10_000 - creatorFeeShareBps) / 100}% to Hoodium.
                  </>
                ) : (
                  <>Every curve trade pays a fee split between the creator and Hoodium; the factory could not be read just now, so the exact split is unavailable.</>
                )}{' '}
                After graduation the locked pool keeps earning; those fees are split{' '}
                {/* The API reports the locker's cut; the creator keeps the rest. */}
                {lpProtocolFeeShareBps !== null
                  ? `${(10_000 - lpProtocolFeeShareBps) / 100}% creator / ${lpProtocolFeeShareBps / 100}% protocol`
                  : 'per the locker contract'}
                . Holders earn nothing from fees — the token has no tax and no rebase.
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* ── Trade + market ─────────────────────────────────────────────── */}
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-label text-muted-foreground">{graduated ? 'Graduated' : 'Bonding curve'}</span>
              <span className="num text-sm font-medium">{graduated ? '100%' : `${pct.toFixed(pct >= 10 ? 0 : 1)}% to graduation`}</span>
            </div>
            <CurveProgress progressBps={t.progressBps} className="mt-3" showLabel={false} />
            <p className="mt-3 text-xs text-muted-foreground">
              {graduated ? (
                <>
                  The curve closed{t.graduatedAt ? ` ${relativeTime(t.graduatedAt)}` : ''} and its reserve
                  became a Uniswap v3 position that cannot be withdrawn.
                  {t.pool && (
                    <>
                      {' '}
                      Pool <Address value={t.pool} link label="pool address" />
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="num text-foreground">
                    {formatAmount(fromBaseUnits(t.curveState.raised, env.quoteDecimals), { compact: true })}
                  </span>{' '}
                  of{' '}
                  <span className="num text-foreground">
                    {formatAmount(fromBaseUnits(t.curveState.target, env.quoteDecimals), { compact: true })}{' '}
                    {env.quoteSymbol}
                  </span>{' '}
                  raised. At the threshold the curve closes and liquidity moves to a Uniswap v3 pool and is
                  locked.
                </>
              )}
            </p>
          </Card>

          {/* Above the trade panel, not behind a tab. */}
          <RiskFlags token={t} />
          <TradePanel token={t} />
        </div>

        <div className="space-y-4">
          <TokenChartCard token={t} />
          <TokenActivity token={t} />
        </div>
      </div>

      {/* Renders for the creator only; returns null for everyone else. */}
      <CreatorFeesCard token={t} />
      <PoolFeesCard token={t} />
    </div>
  )
}

function Chip({ tone, children }: { tone: 'up' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none',
        tone === 'up' ? 'border-up/25 bg-up/10 text-up' : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-label text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-foreground">{children}</dd>
    </div>
  )
}
