/**
 * Trader profile — holdings, PnL, launches and claimable creator fees.
 *
 * Built from indexed curve trades and nothing else: a token's price is what it
 * last traded at on its own curve. Cost basis is average-cost. Because a plain
 * ERC-20 `transfer` emits no curve event, every open position is reconciled
 * against the live `balanceOf` and a mismatch withholds PnL for that position
 * rather than publishing a figure we cannot stand behind.
 */
import type { Address } from 'viem'
import { bondingCurveAbi, erc20Abi } from '../chain/abi.js'
import type { ChainClient } from '../chain/client.js'
import { TokenModel, TradeModel } from '../db/models.js'
import { minBigInt, pricePerToken, toBigInt, toUnits, valueOf } from '../lib/amounts.js'
import { mapLimit } from '../lib/concurrency.js'
import { componentLogger } from '../lib/logger.js'
import type { LaunchTerms, ProfileActivityEntry, ProfileHolding, ProfileLaunch, ProfileResponse } from '../types.js'

const log = componentLogger('portfolio')

const READ_CONCURRENCY = 8
const MAX_TOKENS = 100

export interface TradeRow {
  tokenAddress: string
  side: 'buy' | 'sell'
  usdgAmount: string
  tokenAmount: string
  priceUsdg?: string
  txHash?: string
  at: Date | null
  finalized?: boolean
}

export interface Accumulated {
  qty: bigint
  cost: bigint
  realized: bigint
  spent: bigint
  received: bigint
  first: Date | null
  last: Date | null
}

/**
 * Walk one token's trades in order, average-cost.
 *
 * On a sell, the basis removed is `avgCost × tokensSold` — not the proceeds —
 * so the remaining `cost` stays the cost of the remaining `qty` and the entry
 * price survives a partial exit intact.
 */
export function accumulate(trades: TradeRow[]): Accumulated {
  let qty = 0n
  let cost = 0n
  let realized = 0n
  let spent = 0n
  let received = 0n
  let first: Date | null = null
  let last: Date | null = null

  for (const trade of trades) {
    const tokens = toBigInt(trade.tokenAmount)
    const quote = toBigInt(trade.usdgAmount)
    if (trade.at) {
      first ??= trade.at
      last = trade.at
    }

    if (trade.side === 'buy') {
      qty += tokens
      cost += quote
      spent += quote
      continue
    }

    received += quote
    if (qty <= 0n || tokens <= 0n) continue
    // A sell larger than we know about means tokens arrived by transfer. Cap the
    // basis removed at what we have; reconciliation reports the discrepancy.
    const sold = minBigInt(tokens, qty)
    const basisRemoved = (cost * sold) / qty
    realized += (quote * sold) / tokens - basisRemoved
    qty -= sold
    cost -= basisRemoved
  }

  return { qty, cost, realized, spent, received, first, last }
}

async function liveBalances(chain: ChainClient, owner: string, tokens: string[]): Promise<Map<string, bigint>> {
  if (tokens.length === 0) return new Map()
  const settled = await mapLimit(tokens, READ_CONCURRENCY, async (token) => {
    try {
      const balance = await chain.call('read:balanceOf', (client) =>
        client.readContract({ address: token as Address, abi: erc20Abi, functionName: 'balanceOf', args: [owner as Address] }),
      )
      return { token, balance }
    } catch {
      return null
    }
  })
  const out = new Map<string, bigint>()
  for (const entry of settled) if (entry) out.set(entry.token, entry.balance)
  if (out.size === 0) log.warn({ owner, tokens: tokens.length }, 'balance reconciliation unavailable — PnL withheld')
  return out
}

async function claimableCreatorFees(
  chain: ChainClient,
  curves: string[],
): Promise<Map<string, { accrued: bigint; claimed: bigint }>> {
  const out = new Map<string, { accrued: bigint; claimed: bigint }>()
  if (curves.length === 0) return out
  await mapLimit(curves, READ_CONCURRENCY, async (curve) => {
    try {
      const contract = { address: curve as Address, abi: bondingCurveAbi } as const
      const [accrued, claimed] = await chain.call('read:creatorFees', (client) =>
        Promise.all([
          client.readContract({ ...contract, functionName: 'creatorFeesAccrued' }),
          client.readContract({ ...contract, functionName: 'creatorFeesClaimed' }),
        ]),
      )
      out.set(curve, { accrued, claimed })
    } catch {
      /* left absent — reported as null */
    }
  })
  return out
}

export interface ProfileInput {
  chainId: number
  address: string
  chain: ChainClient
  terms: LaunchTerms | null
  usdgDecimals: number
  tokenDecimals: number
}

export async function buildProfile(input: ProfileInput): Promise<ProfileResponse> {
  const { chainId, address, chain, terms, usdgDecimals, tokenDecimals } = input
  const usd = (v: bigint) => toUnits(v, usdgDecimals)

  const [trades, launches] = await Promise.all([
    TradeModel.find({ chainId, trader: address })
      .select('tokenAddress side usdgAmount tokenAmount priceUsdg txHash at finalized')
      .sort({ blockNumber: 1, logIndex: 1 })
      .limit(10_000)
      .lean(),
    TokenModel.find({ chainId, creator: address }).sort({ createdAtChain: -1 }).limit(200).lean(),
  ])

  const byToken = new Map<string, TradeRow[]>()
  for (const t of trades as unknown as TradeRow[]) {
    const list = byToken.get(t.tokenAddress)
    if (list) list.push(t)
    else byToken.set(t.tokenAddress, [t])
  }

  const tokenAddresses = [...byToken.keys()].slice(0, MAX_TOKENS)
  const [tokenDocs, live, fees] = await Promise.all([
    TokenModel.find({ chainId, tokenAddress: { $in: tokenAddresses } })
      .select('tokenAddress name symbol status lastPrice metadata.image poolAddress')
      .lean(),
    liveBalances(chain, address, tokenAddresses),
    claimableCreatorFees(
      chain,
      launches.map((l) => l.curveAddress),
    ),
  ])
  const meta = new Map(tokenDocs.map((t) => [t.tokenAddress, t]))
  const supply = terms ? toBigInt(terms.totalSupply) : null

  const holdings: ProfileHolding[] = []
  const closed: ProfileHolding[] = []
  let totalValue = 0n
  let totalUnrealized = 0n
  let totalRealized = 0n
  let anyWithheld = false

  for (const tokenAddress of tokenAddresses) {
    const rows = byToken.get(tokenAddress)!
    const acc = accumulate(rows)
    const doc = meta.get(tokenAddress)
    const price = toBigInt(doc?.lastPrice ?? '0')
    const value = valueOf(price, acc.qty, tokenDecimals)
    const entryPrice = acc.qty > 0n ? pricePerToken(acc.cost, acc.qty, tokenDecimals) : 0n

    const onChain = live.get(tokenAddress)
    let withheld: ProfileHolding['pnlWithheldReason'] = null
    if (acc.qty > 0n) {
      if (onChain === undefined) withheld = 'chain_unreadable'
      else if (onChain !== acc.qty) withheld = 'balance_mismatch'
      else if (acc.cost <= 0n) withheld = 'no_cost_basis'
    }

    const unrealized = withheld ? null : value - acc.cost
    const pnlPct = withheld || acc.cost <= 0n ? null : Number(((value - acc.cost) * 10_000n) / acc.cost) / 100

    const holding: ProfileHolding = {
      address: tokenAddress,
      name: doc?.name ?? '',
      symbol: doc?.symbol ?? '',
      image: doc?.metadata?.image ? `/api/tokens/${tokenAddress}/image` : null,
      status: (doc?.status as 'curve' | 'graduated') ?? 'curve',
      graduated: doc?.status === 'graduated',
      balance: acc.qty.toString(),
      balanceUnits: toUnits(acc.qty, tokenDecimals),
      onChainBalance: onChain === undefined ? null : onChain.toString(),
      costBasis: acc.cost.toString(),
      costBasisUsd: usd(acc.cost),
      value: value.toString(),
      valueUsd: usd(value),
      entryPrice: entryPrice.toString(),
      currentPrice: price.toString(),
      currentPriceUsd: toUnits(price, usdgDecimals),
      entryMarketCapUsd: supply && acc.qty > 0n ? usd(valueOf(entryPrice, supply, tokenDecimals)) : null,
      currentMarketCapUsd: supply ? usd(valueOf(price, supply, tokenDecimals)) : null,
      unrealizedPnl: unrealized === null ? null : unrealized.toString(),
      unrealizedPnlUsd: unrealized === null ? null : usd(unrealized),
      realizedPnl: acc.realized.toString(),
      realizedPnlUsd: usd(acc.realized),
      pnlPct,
      pnlWithheldReason: withheld,
      tradeCount: rows.length,
      firstTradeAt: acc.first ? acc.first.toISOString() : null,
      lastTradeAt: acc.last ? acc.last.toISOString() : null,
    }

    totalRealized += acc.realized
    if (acc.qty > 0n) {
      holdings.push(holding)
      totalValue += value
      if (unrealized !== null) totalUnrealized += unrealized
      else anyWithheld = true
    } else {
      closed.push(holding)
    }
  }

  holdings.sort((a, b) => b.valueUsd - a.valueUsd)
  closed.sort((a, b) => (b.lastTradeAt ?? '').localeCompare(a.lastTradeAt ?? ''))

  let totalClaimable = 0n
  let claimableKnown = true
  const launchRows: ProfileLaunch[] = launches.map((l) => {
    const f = fees.get(l.curveAddress)
    const claimable = f ? f.accrued - f.claimed : null
    if (claimable === null) claimableKnown = false
    else totalClaimable += claimable
    return {
      address: l.tokenAddress,
      curve: l.curveAddress,
      name: l.name,
      symbol: l.symbol,
      image: l.metadata?.image ? `/api/tokens/${l.tokenAddress}/image` : null,
      status: l.status as 'curve' | 'graduated',
      graduated: l.status === 'graduated',
      pool: l.poolAddress ?? null,
      lpTokenId: l.lpTokenId ?? null,
      createdAt: new Date(l.createdAtChain).toISOString(),
      marketCapUsd: l.marketCapUsd ?? 0,
      progressBps: l.progressBps ?? 0,
      volumeUsd: l.volumeUsdAll ?? 0,
      holderCount: l.holderCount ?? 0,
      creatorFeesAccrued: f ? f.accrued.toString() : null,
      creatorFeesClaimed: f ? f.claimed.toString() : null,
      creatorFeesClaimable: claimable === null ? null : claimable.toString(),
      creatorFeesClaimableUsd: claimable === null ? null : usd(claimable),
    }
  })

  return {
    address,
    holdings,
    closed,
    launches: launchRows,
    totals: {
      valueUsd: usd(totalValue),
      unrealizedPnlUsd: anyWithheld ? null : usd(totalUnrealized),
      realizedPnlUsd: usd(totalRealized),
      claimableCreatorFeesUsd: claimableKnown ? usd(totalClaimable) : null,
      tokensHeld: holdings.length,
      tokensLaunched: launchRows.length,
      tokensGraduated: launchRows.filter((l) => l.graduated).length,
      tradeCount: trades.length,
    },
  }
}

/** Trades and launches as one newest-first stream. */
export async function buildActivity(input: {
  chainId: number
  address: string
  limit: number
  usdgDecimals: number
}): Promise<ProfileActivityEntry[]> {
  const { chainId, address, limit, usdgDecimals } = input

  const [trades, launches] = await Promise.all([
    TradeModel.find({ chainId, trader: address })
      .select('tokenAddress side usdgAmount tokenAmount txHash at finalized')
      .sort({ blockNumber: -1, logIndex: -1 })
      .limit(limit)
      .lean(),
    TokenModel.find({ chainId, creator: address })
      .select('tokenAddress name symbol createdAtChain createdTxHash devBuyUsdg devBuyTokens')
      .sort({ createdAtChain: -1 })
      .limit(limit)
      .lean(),
  ])

  const tokenAddresses = [...new Set(trades.map((t) => t.tokenAddress))]
  const docs = await TokenModel.find({ chainId, tokenAddress: { $in: tokenAddresses } })
    .select('tokenAddress name symbol')
    .lean()
  const meta = new Map(docs.map((d) => [d.tokenAddress, d]))

  const entries: ProfileActivityEntry[] = [
    ...trades.map((t) => ({
      kind: t.side as 'buy' | 'sell',
      address: t.tokenAddress,
      name: meta.get(t.tokenAddress)?.name ?? '',
      symbol: meta.get(t.tokenAddress)?.symbol ?? '',
      usdgAmount: t.usdgAmount,
      usdValue: toUnits(t.usdgAmount, usdgDecimals),
      tokenAmount: t.tokenAmount,
      txHash: t.txHash,
      at: new Date(t.at).toISOString(),
      finalized: Boolean(t.finalized),
    })),
    ...launches.map((l) => ({
      kind: 'launch' as const,
      address: l.tokenAddress,
      name: l.name,
      symbol: l.symbol,
      usdgAmount: l.devBuyUsdg ?? '0',
      usdValue: toUnits(l.devBuyUsdg ?? '0', usdgDecimals),
      tokenAmount: l.devBuyTokens ?? '0',
      txHash: l.createdTxHash ?? null,
      at: new Date(l.createdAtChain).toISOString(),
      finalized: true,
    })),
  ]

  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}
