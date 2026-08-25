/**
 * Trader portfolio — positions, PnL, activity and a value series.
 *
 * ── What the numbers are built from ──────────────────────────────────────────
 * Indexed curve trades, and nothing else. There is no oracle here and no price
 * feed: a token's price is what it last traded at on its own curve, which is the
 * only price that exists for it.
 *
 * ── Why PnL can be withheld ──────────────────────────────────────────────────
 * Cost basis is reconstructed from `Bought`/`Sold` events. The token is a plain
 * ERC-20, so a wallet-to-wallet `transfer` moves balance without emitting either
 * — an airdrop recipient's "cost" would read as zero and their PnL as infinite
 * profit. So every position is reconciled against the live `balanceOf` before any
 * figure is reported, and a mismatch withholds PnL for that position rather than
 * publishing a number we cannot stand behind. AL-2.2's spirit, applied to a
 * different surface: do not present a derived figure as if it were measured.
 */
import type { Address } from 'viem'
import { erc20Abi } from '@hoodium/shared/abi'
import { LaunchpadTokenModel, LaunchpadTradeModel } from '../db/models/launchpad.js'
import { Decimal } from '../lib/money.js'
import { mapLimit } from '../lib/concurrency.js'
import { componentLogger } from '../lib/logger.js'
import type { ChainClient } from '../chain/rpc.js'

const log = componentLogger('launchpad-portfolio')

/**
 * Concurrent `balanceOf` reads per portfolio request. One user opening their
 * portfolio becomes one request per token they hold, so this is the ceiling on
 * how much of the RPC budget a single page load may take.
 */
const BALANCE_READ_CONCURRENCY = 8

/** Beyond this a trader is not browsing a portfolio, and the reads stop being cheap. */
const MAX_TOKENS = 100
const MAX_SERIES_POINTS = 60

const ONE_TOKEN = new Decimal(10).pow(18)

export interface TokenPosition {
  tokenAddress: string
  name: string
  symbol: string
  status: 'curve' | 'graduated'
  /** Token base units still held, per our reconstruction. */
  balance: string
  /** Quote base units: what the held balance cost, average-cost basis. */
  costBasis: string
  /** Quote base units at the last traded price. */
  value: string
  /** Quote base units per whole token, averaged over the buys that remain. */
  entryPrice: string
  currentPrice: string
  /** Quote base units. Null when supply is unknown. */
  entryMarketCap: string | null
  currentMarketCap: string | null
  /** Null when the position does not reconcile — see the module note. */
  unrealizedPnl: string | null
  realizedPnl: string | null
  /** Percent, two decimal places, as a string. Null alongside a null PnL. */
  pnlPct: string | null
  /** Why PnL is missing, when it is. */
  pnlWithheldReason: 'balance_mismatch' | 'chain_unreadable' | 'no_cost_basis' | null
  tradeCount: number
  firstTradeAt: string | null
  lastTradeAt: string | null
}

export interface ActivityEntry {
  kind: 'buy' | 'sell' | 'launch'
  tokenAddress: string
  name: string
  symbol: string
  /** Quote base units. Zero for a launch with no dev buy. */
  quoteAmount: string
  tokenAmount: string
  txHash: string | null
  at: string | null
  finalized: boolean
}

export interface PortfolioSeriesPoint {
  /** Unix seconds. */
  t: number
  /** Quote base units. */
  value: string
}

export interface TradeRow {
  tokenAddress: string
  side: 'buy' | 'sell'
  usdgAmount: unknown
  tokenAmount: string
  priceUsdg: unknown
  txHash: string
  at: Date | null
  finalized: boolean
}

function dec(value: unknown): Decimal {
  if (value === null || value === undefined) return new Decimal(0)
  return new Decimal(value.toString())
}

/**
 * Walk one token's trades in order, average-cost.
 *
 * On a sell, the basis removed is `avgCost x tokensSold` — not the proceeds. That
 * is what makes the remaining `cost` the cost of the remaining `qty`, which is
 * the only way an entry price survives a partial exit intact.
 */
export function accumulate(trades: TradeRow[]): {
  qty: Decimal
  cost: Decimal
  realized: Decimal
  spent: Decimal
  first: Date | null
  last: Date | null
} {
  let qty = new Decimal(0)
  let cost = new Decimal(0)
  let realized = new Decimal(0)
  let spent = new Decimal(0)
  let first: Date | null = null
  let last: Date | null = null

  for (const trade of trades) {
    const tokens = dec(trade.tokenAmount)
    const quote = dec(trade.usdgAmount)
    if (trade.at) {
      first ??= trade.at
      last = trade.at
    }

    if (trade.side === 'buy') {
      qty = qty.plus(tokens)
      cost = cost.plus(quote)
      spent = spent.plus(quote)
      continue
    }

    if (qty.lte(0) || tokens.lte(0)) continue
    // A sell larger than our reconstruction knows about means tokens arrived by
    // transfer. Cap the basis removed at what we have rather than going negative;
    // the reconciliation below is what actually reports the problem.
    const sold = Decimal.min(tokens, qty)
    const basisRemoved = cost.mul(sold).div(qty)
    realized = realized.plus(quote.mul(sold).div(tokens)).minus(basisRemoved)
    qty = qty.minus(sold)
    cost = cost.minus(basisRemoved)
  }

  return { qty, cost, realized, spent, first, last }
}

/** Latest traded price per token, in quote base units per whole token. */
async function latestPrices(chainId: number, tokens: string[]): Promise<Map<string, Decimal>> {
  if (tokens.length === 0) return new Map()

  const rows = await LaunchpadTradeModel.aggregate<{ _id: string; priceUsdg: unknown }>([
    { $match: { chainId, tokenAddress: { $in: tokens } } },
    { $sort: { blockNumber: -1, logIndex: -1 } },
    { $group: { _id: '$tokenAddress', priceUsdg: { $first: '$priceUsdg' } } },
  ])

  return new Map(rows.map((r) => [r._id, dec(r.priceUsdg)]))
}

/**
 * Live balances for the reconciliation.
 *
 * `allowFailure` is on so one unverifiable token withholds its own PnL instead of
 * every position's. A total RPC failure returns an empty map, which withholds all
 * of them — the correct outcome, and a visible one.
 */
async function liveBalances(
  chain: ChainClient,
  owner: string,
  tokens: string[],
): Promise<Map<string, Decimal>> {
  if (tokens.length === 0) return new Map()

  /*
   * One read per token, bounded, rather than one `multicall`.
   *
   * viem takes the Multicall3 address from `chain.contracts.multicall3`, and the
   * chain built in chain/rpc.ts declares no contracts — so `client.multicall()`
   * threw `ChainDoesNotSupportContract` on every chain, was caught below, and
   * withheld PnL for every position while looking like an RPC problem. Same
   * cause as launchpad/terms.ts.
   *
   * `mapLimit` keeps the fan-out bounded: Robinhood Chain's rate limits are
   * unbenchmarked (T0.3), and a portfolio read is one request from a user turning
   * into one request per token they hold.
   *
   * The per-token `catch` preserves what `allowFailure: true` bought — one
   * unverifiable token withholds its own PnL rather than every position's.
   */
  const settled = await mapLimit(tokens, BALANCE_READ_CONCURRENCY, async (token) => {
    try {
      const balance = await chain.call('read:balanceOf', (client) =>
        client.readContract({
          address: token as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [owner as Address],
        }),
      )
      return { token, balance: balance as bigint }
    } catch {
      return null
    }
  })

  const out = new Map<string, Decimal>()
  for (const entry of settled) {
    if (entry) out.set(entry.token, new Decimal(entry.balance.toString()))
  }

  // Every single read failing is an outage, not an unverifiable token. Say so —
  // the caller withholds all PnL either way, but only one of the two is a bug.
  if (out.size === 0) {
    log.warn({ owner, tokens: tokens.length }, 'balance reconciliation unavailable — PnL will be withheld')
  }

  return out
}

export interface PortfolioInput {
  chainId: number
  address: string
  chain: ChainClient
  /** Token base units. Null when the factory could not be read; market caps go null. */
  totalSupply: string | null
}

export interface PortfolioResult {
  open: TokenPosition[]
  closed: TokenPosition[]
  /** Quote base units, summed over open positions. */
  totalValue: string
  /** Null when any open position withheld its PnL — a partial total is a wrong total. */
  totalUnrealizedPnl: string | null
  totalRealizedPnl: string
}

export async function buildPortfolio(input: PortfolioInput): Promise<PortfolioResult> {
  const { chainId, address, chain, totalSupply } = input

  const trades = (await LaunchpadTradeModel.find({ chainId, trader: address })
    .select('tokenAddress side usdgAmount tokenAmount priceUsdg txHash at finalized')
    .sort({ blockNumber: 1, logIndex: 1 })
    .limit(10_000)
    .lean()) as unknown as TradeRow[]

  const byToken = new Map<string, TradeRow[]>()
  for (const trade of trades) {
    const list = byToken.get(trade.tokenAddress)
    if (list) list.push(trade)
    else byToken.set(trade.tokenAddress, [trade])
  }

  const tokenAddresses = [...byToken.keys()].slice(0, MAX_TOKENS)
  const [tokenDocs, prices, live] = await Promise.all([
    LaunchpadTokenModel.find({ chainId, tokenAddress: { $in: tokenAddresses } })
      .select('tokenAddress name symbol status')
      .lean(),
    latestPrices(chainId, tokenAddresses),
    liveBalances(chain, address, tokenAddresses),
  ])

  const meta = new Map(tokenDocs.map((t) => [t.tokenAddress, t]))
  const supply = totalSupply ? new Decimal(totalSupply) : null

  const open: TokenPosition[] = []
  const closed: TokenPosition[] = []
  let totalValue = new Decimal(0)
  let totalRealized = new Decimal(0)
  let anyWithheld = false
  let totalUnrealized = new Decimal(0)

  for (const tokenAddress of tokenAddresses) {
    const rows = byToken.get(tokenAddress)!
    const { qty, cost, realized, first, last } = accumulate(rows)
    const doc = meta.get(tokenAddress)
    const price = prices.get(tokenAddress) ?? new Decimal(0)

    const value = qty.mul(price).div(ONE_TOKEN)
    const entryPrice = qty.gt(0) ? cost.mul(ONE_TOKEN).div(qty) : new Decimal(0)

    // See the module note. The reconciliation is against the chain, not against
    // our own holder table — that would compare a reconstruction with itself.
    const onChain = live.get(tokenAddress)
    let withheld: TokenPosition['pnlWithheldReason'] = null
    if (onChain === undefined) withheld = 'chain_unreadable'
    else if (!onChain.equals(qty)) withheld = 'balance_mismatch'
    else if (qty.gt(0) && cost.lte(0)) withheld = 'no_cost_basis'

    const unrealized = withheld ? null : value.minus(cost)
    const pnlPct =
      withheld || cost.lte(0) ? null : value.minus(cost).mul(100).div(cost).toFixed(2)

    const position: TokenPosition = {
      tokenAddress,
      name: doc?.name ?? '',
      symbol: doc?.symbol ?? '',
      status: (doc?.status as 'curve' | 'graduated') ?? 'curve',
      balance: qty.toFixed(0),
      costBasis: cost.toFixed(0),
      value: value.toFixed(0),
      entryPrice: entryPrice.toFixed(0),
      currentPrice: price.toFixed(0),
      entryMarketCap: supply && qty.gt(0) ? cost.div(qty).mul(supply).toFixed(0) : null,
      currentMarketCap: supply ? price.div(ONE_TOKEN).mul(supply).toFixed(0) : null,
      unrealizedPnl: unrealized ? unrealized.toFixed(0) : null,
      realizedPnl: withheld ? null : realized.toFixed(0),
      pnlPct,
      pnlWithheldReason: withheld,
      tradeCount: rows.length,
      firstTradeAt: first ? first.toISOString() : null,
      lastTradeAt: last ? last.toISOString() : null,
    }

    if (qty.gt(0)) {
      open.push(position)
      totalValue = totalValue.plus(value)
      if (unrealized) totalUnrealized = totalUnrealized.plus(unrealized)
      else anyWithheld = true
    } else {
      closed.push(position)
    }
    if (!withheld) totalRealized = totalRealized.plus(realized)
  }

  open.sort((a, b) => new Decimal(b.value).comparedTo(new Decimal(a.value)))
  closed.sort((a, b) => (b.lastTradeAt ?? '').localeCompare(a.lastTradeAt ?? ''))

  return {
    open,
    closed,
    totalValue: totalValue.toFixed(0),
    totalUnrealizedPnl: anyWithheld ? null : totalUnrealized.toFixed(0),
    totalRealizedPnl: totalRealized.toFixed(0),
  }
}

/**
 * Portfolio value over a window.
 *
 * Reconstructed rather than snapshotted: holdings come from the trader's own
 * trades and prices from every trade on the tokens they hold, so the series is
 * exact at every point where something happened and flat in between. That flat
 * segment is the truth — a curve with no trades has no new price.
 */
export async function buildPortfolioSeries(input: {
  chainId: number
  address: string
  hours: number
}): Promise<PortfolioSeriesPoint[]> {
  const { chainId, address, hours } = input

  const now = Date.now()
  const start = now - hours * 60 * 60 * 1000

  const trades = (await LaunchpadTradeModel.find({ chainId, trader: address })
    .select('tokenAddress side tokenAmount at')
    .sort({ blockNumber: 1, logIndex: 1 })
    .limit(10_000)
    .lean()) as unknown as Array<{ tokenAddress: string; side: 'buy' | 'sell'; tokenAmount: string; at: Date | null }>

  if (trades.length === 0) return []

  const tokens = [...new Set(trades.map((t) => t.tokenAddress))].slice(0, MAX_TOKENS)

  // Two queries, not one per token: the price in force at the window's start, and
  // every price change inside it.
  const [priorRows, windowRows] = await Promise.all([
    LaunchpadTradeModel.aggregate<{ _id: string; priceUsdg: unknown }>([
      { $match: { chainId, tokenAddress: { $in: tokens }, at: { $lt: new Date(start) } } },
      { $sort: { blockNumber: -1, logIndex: -1 } },
      { $group: { _id: '$tokenAddress', priceUsdg: { $first: '$priceUsdg' } } },
    ]),
    LaunchpadTradeModel.find({ chainId, tokenAddress: { $in: tokens }, at: { $gte: new Date(start) } })
      .select('tokenAddress priceUsdg at')
      .sort({ blockNumber: 1, logIndex: 1 })
      .limit(20_000)
      .lean() as unknown as Promise<Array<{ tokenAddress: string; priceUsdg: unknown; at: Date | null }>>,
  ])

  const price = new Map<string, Decimal>(priorRows.map((r) => [r._id, dec(r.priceUsdg)]))
  const qty = new Map<string, Decimal>()

  // Holdings as they stood at the window's start.
  for (const trade of trades) {
    if (trade.at && trade.at.getTime() >= start) break
    const current = qty.get(trade.tokenAddress) ?? new Decimal(0)
    const delta = dec(trade.tokenAmount)
    qty.set(trade.tokenAddress, trade.side === 'buy' ? current.plus(delta) : Decimal.max(0, current.minus(delta)))
  }

  const step = (now - start) / MAX_SERIES_POINTS
  const points: PortfolioSeriesPoint[] = []

  let tradeIndex = trades.findIndex((t) => t.at != null && t.at.getTime() >= start)
  if (tradeIndex < 0) tradeIndex = trades.length
  let priceIndex = 0

  for (let i = 0; i <= MAX_SERIES_POINTS; i++) {
    const at = start + step * i

    while (tradeIndex < trades.length && (trades[tradeIndex]!.at?.getTime() ?? Infinity) <= at) {
      const trade = trades[tradeIndex]!
      const current = qty.get(trade.tokenAddress) ?? new Decimal(0)
      const delta = dec(trade.tokenAmount)
      qty.set(trade.tokenAddress, trade.side === 'buy' ? current.plus(delta) : Decimal.max(0, current.minus(delta)))
      tradeIndex++
    }

    while (priceIndex < windowRows.length && (windowRows[priceIndex]!.at?.getTime() ?? Infinity) <= at) {
      const row = windowRows[priceIndex]!
      price.set(row.tokenAddress, dec(row.priceUsdg))
      priceIndex++
    }

    let value = new Decimal(0)
    for (const [token, held] of qty) {
      if (held.lte(0)) continue
      const p = price.get(token)
      if (!p || p.lte(0)) continue
      value = value.plus(held.mul(p).div(ONE_TOKEN))
    }

    points.push({ t: Math.floor(at / 1000), value: value.toFixed(0) })
  }

  return points
}

/** Trades and launches, newest first, as one stream. */
export async function buildActivity(input: {
  chainId: number
  address: string
  limit: number
}): Promise<ActivityEntry[]> {
  const { chainId, address, limit } = input

  const [trades, launches] = await Promise.all([
    LaunchpadTradeModel.find({ chainId, trader: address })
      .select('tokenAddress side usdgAmount tokenAmount txHash at finalized')
      .sort({ blockNumber: -1, logIndex: -1 })
      .limit(limit)
      .lean(),
    LaunchpadTokenModel.find({ chainId, creator: address })
      .select('tokenAddress name symbol createdAtChain')
      .sort({ createdAtChain: -1 })
      .limit(limit)
      .lean(),
  ])

  const tokenAddresses = [...new Set(trades.map((t) => t.tokenAddress))]
  const docs = await LaunchpadTokenModel.find({ chainId, tokenAddress: { $in: tokenAddresses } })
    .select('tokenAddress name symbol')
    .lean()
  const meta = new Map(docs.map((d) => [d.tokenAddress, d]))

  const entries: ActivityEntry[] = [
    ...trades.map((t) => ({
      kind: t.side as 'buy' | 'sell',
      tokenAddress: t.tokenAddress,
      name: meta.get(t.tokenAddress)?.name ?? '',
      symbol: meta.get(t.tokenAddress)?.symbol ?? '',
      quoteAmount: dec(t.usdgAmount).toFixed(0),
      tokenAmount: t.tokenAmount?.toString() ?? '0',
      txHash: t.txHash ?? null,
      at: t.at ? new Date(t.at).toISOString() : null,
      finalized: Boolean(t.finalized),
    })),
    ...launches.map((l) => ({
      kind: 'launch' as const,
      tokenAddress: l.tokenAddress,
      name: l.name,
      symbol: l.symbol,
      quoteAmount: '0',
      tokenAmount: '0',
      txHash: null,
      at: l.createdAtChain ? new Date(l.createdAtChain).toISOString() : null,
      // A launch is only in this table because it was indexed, which happens
      // after the fact — there is no unconfirmed state to represent.
      finalized: true,
    })),
  ]

  return entries.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, limit)
}
