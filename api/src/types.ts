/**
 * Public API response shapes.
 *
 * This file is dependency-free on purpose so the web app can copy it verbatim.
 *
 * Conventions:
 *  - Every exact on-chain amount is a decimal string in base units.
 *  - Every `…Usd` field is a JS number for display and sorting only. USDG is
 *    treated as $1 (it is the quote asset of every curve).
 *  - Addresses and hashes are lowercase hex.
 *  - Dates are ISO-8601 strings; `t` fields on chart points are unix seconds.
 */

export type TokenStatus = 'curve' | 'graduated'
export type TradeSide = 'buy' | 'sell'
export type RiskFlag = 'creator_concentration' | 'creator_no_prior_graduations' | 'confusable_symbol'

export type TokenListStatus = 'live' | 'graduated' | 'all'
export type TokenListSort = 'recent_buys' | 'newest' | 'oldest' | 'market_cap' | 'volume' | 'progress' | 'recent'
export type VolumeWindow = 'all' | '24h' | '7d'
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '6h' | '1d' | 'all'

export interface TokenRisk {
  /** Percent of circulating (sold) supply the creator holds, e.g. "12.5". */
  creatorSharePct: string
  priorLaunches: number
  priorGraduations: number
  hasConfusableSymbol: boolean
  flags: RiskFlag[]
  computedAt: string | null
}

/** One card on the explore page. */
export interface TokenListItem {
  address: string
  curve: string
  name: string
  symbol: string
  /** API-relative URL that serves the artwork, or null when there is none. */
  image: string | null
  description: string | null
  creator: string
  createdAt: string
  createdBlock: number
  status: TokenStatus
  graduated: boolean
  /** Uniswap v3 pool once graduated. */
  pool: string | null
  graduatedAt: string | null
  /** 0–10000, curve progress toward the graduation target. */
  progressBps: number
  priceUsd: number
  marketCapUsd: number
  fdvUsd: number
  /** Volume over the requested `window`. */
  volumeUsd: number
  volumeUsd24h: number
  volumeUsdAll: number
  /** Trades over the requested `window`. */
  tradeCount: number
  tradeCountAll: number
  holderCount: number
  lastTradeAt: string | null
  lastBuyAt: string | null
  risk: TokenRisk
}

export interface TokenListCounts {
  /** Every token ever launched on this chain. */
  launched: number
  graduated: number
  live: number
  /** Size of the filtered set the page was cut from. */
  matched: number
}

export interface TokenListResponse {
  items: TokenListItem[]
  page: number
  limit: number
  total: number
  hasMore: boolean
  sort: TokenListSort
  window: VolumeWindow
  status: TokenListStatus
  counts: TokenListCounts
}

export interface CurveState {
  /** Quote base units raised so far (real reserve). */
  raised: string
  raisedUsd: number
  target: string
  targetUsd: number
  remaining: string
  remainingUsd: number
  progressBps: number
  /** Quote base units per whole token — the spot price after the last trade. */
  price: string
  priceUsd: number
  /** Token base units sold along the curve so far. */
  tokensSold: string
  curveAllocation: string | null
  totalSupply: string | null
  virtualUsdg: string | null
  virtualTokens: string | null
  tradeFeeBps: number | null
  /** Split of the trade fee, in bps of the fee. */
  creatorFeeShareBps: number | null
  platformFeeShareBps: number | null
  /** The locker's cut of post-graduation pool fees, in bps. */
  lpProtocolFeeShareBps: number | null
  complete: boolean
}

export interface TokenDetail extends TokenListItem {
  metadataURI: string | null
  x: string | null
  telegram: string | null
  website: string | null
  curveState: CurveState
  devBuyUsdg: string
  devBuyTokens: string
  buyCount: number
  sellCount: number
  volumeUsdg: string
  feesUsdg: string
  creatorFeesClaimedUsdg: string
  volumeUsd7d: number
  lpTokenId: string | null
  graduationTxHash: string | null
  graduationUsdgIn: string
  graduationTokensIn: string
  athPriceUsd: number | null
  athMarketCapUsd: number | null
  createdTxHash: string | null
}

export interface TokenDetailResponse {
  token: TokenDetail
}

export interface TradeItem {
  side: TradeSide
  trader: string
  usdgAmount: string
  usdValue: number
  tokenAmount: string
  feeUsdg: string
  /** Quote base units per whole token after the trade. */
  priceUsdg: string
  priceUsd: number
  blockNumber: number
  txHash: string
  logIndex: number
  at: string
  finalized: boolean
}

export interface Paged<T> {
  items: T[]
  page: number
  limit: number
  total: number
  hasMore: boolean
}

export type TradesResponse = Paged<TradeItem>

export interface HolderItem {
  holder: string
  balance: string
  balanceUnits: number
  /** Percent of tokens sold, two decimals, or null when nothing is sold yet. */
  sharePct: number | null
  isCreator: boolean
  isCurve: boolean
  firstSeenAt: string | null
  lastTradeAt: string | null
}

export interface HoldersResponse extends Paged<HolderItem> {
  /** Balances are reconstructed from curve trades only; transfers are invisible. */
  basis: 'curve_trades'
  tokensSold: string
}

export interface Candle {
  /** Bucket open, unix seconds. */
  t: number
  o: number
  h: number
  l: number
  c: number
  /** USD traded inside the bucket. */
  v: number
  buys: number
  sells: number
}

export interface CandlesResponse {
  interval: Exclude<CandleInterval, 'all'>
  from: number
  to: number
  candles: Candle[]
}

export interface PricePoint {
  t: number
  priceUsd: number
}

export interface PriceSeriesResponse {
  window: '1h' | '6h' | '1d' | '7d' | '30d' | 'all'
  points: PricePoint[]
}

export interface MessageItem {
  id: string
  author: string
  body: string
  authorBalance: string
  isCreator: boolean
  at: string
}

export interface MessagesResponse {
  items: MessageItem[]
  hasMore: boolean
}

export interface ProfileHolding {
  address: string
  name: string
  symbol: string
  image: string | null
  status: TokenStatus
  graduated: boolean
  balance: string
  balanceUnits: number
  onChainBalance: string | null
  costBasis: string
  costBasisUsd: number
  value: string
  valueUsd: number
  entryPrice: string
  currentPrice: string
  currentPriceUsd: number
  entryMarketCapUsd: number | null
  currentMarketCapUsd: number | null
  unrealizedPnl: string | null
  unrealizedPnlUsd: number | null
  realizedPnl: string
  realizedPnlUsd: number
  pnlPct: number | null
  pnlWithheldReason: 'balance_mismatch' | 'chain_unreadable' | 'no_cost_basis' | null
  tradeCount: number
  firstTradeAt: string | null
  lastTradeAt: string | null
}

export interface ProfileLaunch {
  address: string
  curve: string
  name: string
  symbol: string
  image: string | null
  status: TokenStatus
  graduated: boolean
  pool: string | null
  lpTokenId: string | null
  createdAt: string
  marketCapUsd: number
  progressBps: number
  volumeUsd: number
  holderCount: number
  /** Null when the curve could not be read. */
  creatorFeesAccrued: string | null
  creatorFeesClaimed: string | null
  creatorFeesClaimable: string | null
  creatorFeesClaimableUsd: number | null
}

export interface ProfileResponse {
  address: string
  holdings: ProfileHolding[]
  closed: ProfileHolding[]
  launches: ProfileLaunch[]
  totals: {
    valueUsd: number
    /** Null when any open position withheld its PnL — a partial total is a wrong total. */
    unrealizedPnlUsd: number | null
    realizedPnlUsd: number
    claimableCreatorFeesUsd: number | null
    tokensHeld: number
    tokensLaunched: number
    tokensGraduated: number
    tradeCount: number
  }
}

export interface ProfileActivityEntry {
  kind: 'buy' | 'sell' | 'launch'
  address: string
  name: string
  symbol: string
  usdgAmount: string
  usdValue: number
  tokenAmount: string
  txHash: string | null
  at: string
  finalized: boolean
}

export interface ProfileActivityResponse {
  entries: ProfileActivityEntry[]
}

export interface LaunchTerms {
  factoryAddress: string
  usdgAddress: string
  feeVault: string
  graduationManager: string
  locker: string | null
  positionManager: string | null
  totalSupply: string
  curveAllocation: string
  lpAllocation: string
  tokenDecimals: number
  virtualUsdg: string
  virtualTokens: string
  creationFee: string
  graduationTarget: string
  graduationFee: string
  devBuyCapTokens: string
  devBuyMaxBps: number
  tradeFeeBps: number
  creatorFeeShareBps: number
  protocolFeeShareBps: number | null
  snipeBlocks: number
  snipeMaxBps: number
}

export interface ConfigResponse {
  chainId: number
  factoryAddress: string | null
  usdgAddress: string | null
  usdgDecimals: number
  tokenDecimals: number
  appOrigin: string
  pinningEnabled: boolean
  /** Null when the factory is not configured or could not be read. */
  terms: LaunchTerms | null
}

export interface HealthResponse {
  ok: boolean
  service: 'hoodium-launchpad-api'
  chainId: number
  factoryConfigured: boolean
  db: 'up' | 'down'
  indexer: {
    enabled: boolean
    running: boolean
    lastProcessedBlock: number | null
    chainHeadBlock: number | null
    lag: number | null
    lastRunAt: string | null
    lastError: string | null
  }
  uptimeSec: number
}

export interface PinMetadataRequest {
  name: string
  symbol: string
  description?: string
  x?: string | null
  telegram?: string | null
  website?: string | null
  image?: { contentType: string; data: string }
}

export interface PinMetadataResponse {
  uri: string
  imageUri: string | null
}

/**
 * Signed write envelope. `signature` is an EIP-191 `personal_sign` over the
 * string returned by `buildAuthMessage` (src/auth.ts, copy it too).
 */
export interface SignedRequest {
  address: string
  /** Unix milliseconds; refused when older than 5 minutes or in the future. */
  issuedAt: number
  signature: string
}

export interface PostMessageRequest extends SignedRequest {
  body: string
}

export interface UpdateLinksRequest extends SignedRequest {
  x?: string | null
  telegram?: string | null
  website?: string | null
}

export interface ApiError {
  error: string
  code?: string
}
