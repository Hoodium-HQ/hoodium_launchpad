/**
 * API contract types — WA-N6.
 *
 * The backend serialises these and the web app consumes them. Declaring them
 * twice is how a field gets renamed on one side and silently read as `undefined`
 * on the other, which TypeScript cannot catch across a `fetch` boundary.
 *
 * Every monetary field is `Money` (string | bigint), never `number`.
 */
import type { Money } from '../money/index.js'

// ── Shared vocabulary ───────────────────────────────────────────────────────

export const WALLET_MODES = ['watch_only', 'automated'] as const
export type WalletMode = (typeof WALLET_MODES)[number]

export const POSITION_STATUSES = ['open', 'closed'] as const
export type PositionStatus = (typeof POSITION_STATUSES)[number]

export const ALERT_TYPES = ['range_proximity', 'out_of_range', 'monitoring_degraded'] as const
export type AlertType = (typeof ALERT_TYPES)[number]

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const TOKEN_STATUSES = ['curve', 'graduated'] as const
export type TokenStatus = (typeof TOKEN_STATUSES)[number]

export const TRADE_SIDES = ['buy', 'sell'] as const
export type TradeSide = (typeof TRADE_SIDES)[number]

/** LP-5.4 — machine-readable facts, never prose verdicts (LP-5.5). */
export const RISK_FLAGS = ['creator_concentration', 'creator_no_prior_graduations', 'confusable_symbol'] as const
export type RiskFlag = (typeof RISK_FLAGS)[number]

// ── Auto LP (spec 001) ──────────────────────────────────────────────────────

export interface TokenMeta {
  address: string
  symbol: string
  decimals: number
}

export interface Position {
  positionKey: string
  chainId: number
  tokenId: string
  owner: string
  pool: string
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickLower: number
  tickUpper: number
  liquidity: string
  quoteIsToken0: boolean
  /** False when neither side is the quote asset — exposure is undefined (AL-2.2). */
  quoteSupported: boolean
  status: PositionStatus
  lastSnapshotAt: string | null
}

export interface Snapshot {
  at: string
  positionKey: string | null
  blockNumber: number
  tickCurrent: number
  liquidity: string
  amount0: string
  amount1: string
  exposurePct: Money | null
  valueQuote: Money | null
  price: Money | null
  inRange: boolean
  distanceToLowerPct: Money | null
  distanceToUpperPct: Money | null
}

/**
 * What a position earned — the reporting view WA-3.3 asks for, recomputed from
 * the `events` collection rather than accumulated (AL-7.2).
 *
 * Two frames, kept apart on purpose. `hodl*` and `impermanentLoss*` value every
 * side at the current price and are exact. `costBasis*`, `netPnl*` and `roiPct`
 * price each deposit at the moment it happened and degrade — `basisComplete`
 * says whether they are totals or floors, and the UI may not print them as
 * totals when it is false.
 */
export interface PositionPerformance {
  positionKey: string
  chainId: number
  owner: string
  status: PositionStatus

  /** Value in the pool now, excluding fees. */
  positionValueQuote: Money | null
  /** Principal already withdrawn, at today's price. */
  withdrawnValueQuote: Money | null
  /** What the deposited tokens would be worth unpooled. */
  hodlValueQuote: Money | null
  /** `(position + withdrawn) − hodl`. Negative is the loss. */
  impermanentLossQuote: Money | null
  /** Fees earned over the position's life, collected and not, priced now. */
  feesValueQuote: Money | null
  /** `fees + impermanentLoss`. Positive means providing beat holding. */
  netVsHodlQuote: Money | null

  costBasisQuote: Money | null
  realisedQuote: Money | null
  netPnlQuote: Money | null
  roiPct: Money | null
  /** False when a deposit could only be bounded, or the record misses the mint. */
  basisComplete: boolean

  /** Fee income annualised on cost basis. Null below `minAprAgeHours` (AL-N7). */
  feeAprPct: Money | null
  /** Share of the sampled window spent earning. Never a lifetime figure. */
  timeInRangePct: Money | null
  /** The window `timeInRangePct` covers — snapshots expire, so it is bounded. */
  timeInRangeFrom: string | null
  timeInRangeTo: string | null

  /** First indexed event for this position, which is its mint when we saw it. */
  firstEventAt: string | null
  ageHours: number | null
  /**
   * Whether `Σ increases − Σ decreases` equals the position's live liquidity.
   * False means events are missing, so every total above is a floor.
   */
  ledgerComplete: boolean

  computedAt: string
}

/** How the strategy board may be ordered. Each is a different question. */
export const STRATEGY_SORTS = ['net_vs_hodl', 'fee_apr', 'roi', 'value'] as const
export type StrategySort = (typeof STRATEGY_SORTS)[number]

/**
 * One row of the public strategy board — a *position*, not a wallet.
 *
 * Ranking wallets by total value ranks whoever deposited the most. Ranking
 * positions by what they returned is the only version of this board that says
 * anything about the decision behind it, which is the thing a visitor came to
 * compare.
 */
export interface StrategyRow {
  rank: number
  positionKey: string
  owner: string
  pool: string
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickLower: number
  tickUpper: number
  status: PositionStatus
  ageHours: number | null
  performance: PositionPerformance
}

export interface WalletStatus {
  address: string
  mode: WalletMode
  label: string | null
  backfill: {
    state: 'pending' | 'running' | 'complete' | 'failed'
    startedAt: string | null
    completedAt: string | null
    error: string | null
  }
  monitoring: {
    lastSuccessAt: string | null
    consecutiveFailures: number
    /** AL-2.5 — drives the degraded-mode banner (WA-3.7). */
    executionSuspended: boolean
    suspendedReason: string | null
  }
}

export interface Notification {
  id: string
  type: string
  severity: AlertSeverity
  title: string
  body: string
  data: Record<string, unknown>
  positionKey: string | null
  readAt: string | null
  createdAt: string
  /** Outcome of the external (Telegram) leg. In-app delivery is unconditional. */
  deliveryState: string
}

export interface Health {
  status: string
  appEnv: string
  chainId: number
  rpcEndpoint: string
  killSwitch: { engaged: boolean; reason: string | null }
}

// ── Sign-in (WA-1.6 … WA-1.9) ───────────────────────────────────────────────

export interface AuthChallenge {
  nonce: string
  /** Signed verbatim. The client never composes an EIP-4361 message (WA-1.7). */
  message: string
  expiresAt: string
}

export interface AuthIdentity {
  authenticated: boolean
  address: string | null
  expiresAt?: string
}

// ── Launchpad (spec 002) ────────────────────────────────────────────────────

export interface LaunchpadToken {
  tokenAddress: string
  curveAddress: string
  creator: string
  /** Creator-supplied and attacker-controlled. Sanitise at render (WA-N3). */
  name: string
  symbol: string
  metadataURI: string | null
  status: TokenStatus
  progressBps: number
  reserveUsdg: Money | null
  tokensSold: string
  graduationTarget: Money | null
  volumeUsdg: Money | null
  tradeCount: number
  holderCount: number
  poolAddress: string | null
  graduatedAt: string | null
  lastTradeAt: string | null
  createdAt: string
  risk: {
    creatorSharePct: Money | null
    priorLaunches: number
    priorGraduations: number
    hasConfusableSymbol: boolean
    flags: RiskFlag[]
  }
}

export interface LaunchpadTrade {
  side: TradeSide
  trader: string
  usdgAmount: Money | null
  tokenAmount: string
  feeUsdg: Money | null
  priceUsdg: Money | null
  blockNumber: number
  txHash: string
  at: string
  /** Unconfirmed rows render at reduced opacity (002/design section 5). */
  finalized: boolean
}

export interface LaunchpadHolder {
  holder: string
  balance: string
  lastTradeAt: string | null
}

export interface LaunchpadConfig {
  factoryAddress: string | null
  quoteSymbol: string
  quoteAddress: string
  quoteDecimals: number
  chainId: number
}
