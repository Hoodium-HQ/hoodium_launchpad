import { toBigInt, toUnits, valueOf } from '../lib/amounts.js'
import type { Token, Trade, Holder, Message } from '../db/models.js'
import type {
  CurveState,
  HolderItem,
  LaunchTerms,
  MessageItem,
  TokenDetail,
  TokenListItem,
  TradeItem,
  VolumeWindow,
} from '../types.js'

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null)

export function imageUrl(t: Pick<Token, 'tokenAddress' | 'metadata'>): string | null {
  return t.metadata?.image ? `/api/tokens/${t.tokenAddress}/image` : null
}

export function serializeTokenItem(t: Token, window: VolumeWindow): TokenListItem {
  const volumeUsd = window === '24h' ? (t.volumeUsd24h ?? 0) : window === '7d' ? (t.volumeUsd7d ?? 0) : (t.volumeUsdAll ?? 0)
  const tradeCount = window === '24h' ? (t.trades24h ?? 0) : window === '7d' ? (t.trades7d ?? 0) : (t.tradeCount ?? 0)
  return {
    address: t.tokenAddress,
    curve: t.curveAddress,
    name: t.name,
    symbol: t.symbol,
    image: imageUrl(t),
    description: t.metadata?.description ?? null,
    creator: t.creator,
    createdAt: new Date(t.createdAtChain).toISOString(),
    createdBlock: t.createdBlock,
    status: t.status as 'curve' | 'graduated',
    graduated: t.status === 'graduated',
    pool: t.poolAddress ?? null,
    graduatedAt: iso(t.graduatedAt),
    progressBps: t.progressBps ?? 0,
    priceUsd: t.priceUsd ?? 0,
    marketCapUsd: t.marketCapUsd ?? 0,
    fdvUsd: t.fdvUsd ?? 0,
    volumeUsd,
    volumeUsd24h: t.volumeUsd24h ?? 0,
    volumeUsdAll: t.volumeUsdAll ?? 0,
    tradeCount,
    tradeCountAll: t.tradeCount ?? 0,
    holderCount: t.holderCount ?? 0,
    lastTradeAt: iso(t.lastTradeAt),
    lastBuyAt: iso(t.lastBuyAt),
    risk: {
      creatorSharePct: t.risk?.creatorSharePct ?? '0',
      priorLaunches: t.risk?.creatorPriorLaunches ?? 0,
      priorGraduations: t.risk?.creatorPriorGraduations ?? 0,
      hasConfusableSymbol: t.risk?.hasConfusableSymbol ?? false,
      flags: (t.risk?.flags ?? []) as TokenListItem['risk']['flags'],
      computedAt: iso(t.risk?.computedAt),
    },
  }
}

export function buildCurveState(t: Token, terms: LaunchTerms | null, usdgDecimals: number): CurveState {
  const raised = toBigInt(t.reserveUsdg ?? '0')
  const target = toBigInt(t.graduationTarget ?? '0') || (terms ? toBigInt(terms.graduationTarget) : 0n)
  const remaining = target > raised ? target - raised : 0n
  const price = toBigInt(t.lastPrice ?? '0')
  const usd = (v: bigint) => toUnits(v, usdgDecimals)
  return {
    raised: raised.toString(),
    raisedUsd: usd(raised),
    target: target.toString(),
    targetUsd: usd(target),
    remaining: remaining.toString(),
    remainingUsd: usd(remaining),
    progressBps: t.progressBps ?? 0,
    price: price.toString(),
    priceUsd: usd(price),
    tokensSold: t.tokensSold ?? '0',
    curveAllocation: terms?.curveAllocation ?? null,
    totalSupply: terms?.totalSupply ?? null,
    virtualUsdg: terms?.virtualUsdg ?? null,
    virtualTokens: terms?.virtualTokens ?? null,
    tradeFeeBps: terms?.tradeFeeBps ?? null,
    creatorFeeShareBps: terms?.creatorFeeShareBps ?? null,
    platformFeeShareBps: terms ? 10_000 - terms.creatorFeeShareBps : null,
    lpProtocolFeeShareBps: terms?.protocolFeeShareBps ?? null,
    complete: t.status === 'graduated' || (target > 0n && raised >= target),
  }
}

export function serializeTokenDetail(
  t: Token,
  terms: LaunchTerms | null,
  usdgDecimals: number,
  ath: { priceUsd: number | null },
): TokenDetail {
  const base = serializeTokenItem(t, 'all')
  const supply = terms ? toBigInt(terms.totalSupply) : null
  const athPriceUsd = ath.priceUsd
  let athMarketCapUsd: number | null = null
  if (athPriceUsd !== null && supply && terms) {
    // ATH is a float already; scale by whole-token supply.
    athMarketCapUsd = athPriceUsd * toUnits(supply, terms.tokenDecimals)
  }
  void valueOf
  return {
    ...base,
    metadataURI: t.metadataURI ?? null,
    x: t.links?.x ?? t.metadata?.x ?? null,
    telegram: t.links?.telegram ?? t.metadata?.telegram ?? null,
    website: t.links?.website ?? t.metadata?.website ?? null,
    curveState: buildCurveState(t, terms, usdgDecimals),
    devBuyUsdg: t.devBuyUsdg ?? '0',
    devBuyTokens: t.devBuyTokens ?? '0',
    buyCount: t.buyCount ?? 0,
    sellCount: t.sellCount ?? 0,
    volumeUsdg: t.volumeUsdg ?? '0',
    feesUsdg: t.feesUsdg ?? '0',
    creatorFeesClaimedUsdg: t.creatorFeesClaimedUsdg ?? '0',
    volumeUsd7d: t.volumeUsd7d ?? 0,
    lpTokenId: t.lpTokenId ?? null,
    graduationTxHash: t.graduationTxHash ?? null,
    graduationUsdgIn: t.graduationUsdgIn ?? '0',
    graduationTokensIn: t.graduationTokensIn ?? '0',
    athPriceUsd,
    athMarketCapUsd,
    createdTxHash: t.createdTxHash ?? null,
  }
}

export function serializeTrade(t: Trade): TradeItem {
  return {
    side: t.side as 'buy' | 'sell',
    trader: t.trader,
    usdgAmount: t.usdgAmount,
    usdValue: t.usdValue ?? 0,
    tokenAmount: t.tokenAmount,
    feeUsdg: t.feeUsdg ?? '0',
    priceUsdg: t.priceUsdg ?? '0',
    priceUsd: t.priceUsd ?? 0,
    blockNumber: t.blockNumber,
    txHash: t.txHash,
    logIndex: t.logIndex,
    at: new Date(t.at).toISOString(),
    finalized: Boolean(t.finalized),
  }
}

export function serializeHolder(h: Holder, ctx: { creator: string | null; curve: string | null; tokensSold: bigint }): HolderItem {
  const balance = toBigInt(h.balance)
  const sharePct = ctx.tokensSold > 0n ? Number((balance * 10_000n) / ctx.tokensSold) / 100 : null
  return {
    holder: h.holder,
    balance: h.balance,
    balanceUnits: h.balanceUnits ?? 0,
    sharePct,
    isCreator: ctx.creator === h.holder,
    isCurve: ctx.curve === h.holder,
    firstSeenAt: iso(h.firstSeenAt),
    lastTradeAt: iso(h.lastTradeAt),
  }
}

export function serializeMessage(m: Message & { _id: unknown }): MessageItem {
  return {
    id: String(m._id),
    author: m.author,
    body: m.body,
    authorBalance: m.authorBalance ?? '0',
    isCreator: Boolean(m.isCreator),
    at: new Date(m.at).toISOString(),
  }
}
