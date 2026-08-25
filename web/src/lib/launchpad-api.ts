/**
 * Launchpad read API. Rankings, history and aggregates only — anything that
 * moves money goes browser → chain, never through here.
 *
 * The two writes (pinning metadata, editing a token's links) touch no balance,
 * and a launch still fails closed if the browser cannot reach us — the creator
 * pastes an IPFS URI instead.
 *
 * Every monetary field is a `Money` (decimal string of base units), never a
 * `number`. `*Usd` fields are already in whole USD and may carry decimals.
 *
 * The shapes below are the contract with `../api`; `API_NEEDS.md` lists what
 * this client consumes beyond the endpoints that were specified up front.
 */
import { env } from '@/config/env'
import type { Money } from './money'

// ── Tokens ──────────────────────────────────────────────────────────────────

export type TokenStatus = 'live' | 'graduated'
export type TokenSort = 'recent_buys' | 'newest' | 'oldest' | 'market_cap' | 'volume'
export type TokenWindow = 'all' | '24h' | '7d'

/** One card in the explore grid — `GET /api/tokens`. */
export interface TokenSummary {
  address: string
  /** Creator-supplied and attacker-controlled. Sanitise at render. */
  name: string
  symbol: string
  /** Absolute or API-relative image URL, or null when the token has no artwork. */
  image: string | null
  creator: string
  createdAt: string
  marketCapUsd: Money | null
  fdvUsd: Money | null
  /** Basis points, 0–10 000. */
  progressBps: number
  /** Quote base units, over the requested window. */
  volume: Money | null
  lastTradeAt: string | null
  graduated: boolean
  /** Uniswap v3 pool once graduated, else null. */
  pool: string | null
}

export interface TokenList {
  items: TokenSummary[]
  total: number
  page: number
  limit: number
  counts: { graduated: number; launched: number }
}

/** The token page — `GET /api/tokens/:address`. */
export interface TokenDetail extends TokenSummary {
  curve: string
  description: string | null
  /** Handles only — the `x.com/` and `t.me/` prefixes are added at render. */
  x: string | null
  telegram: string | null
  metadataURI: string | null
  status: TokenStatus
  /** Quote base units raised on the curve so far. */
  raised: Money
  /** Quote base units at which the curve closes. */
  target: Money
  /** Quote base units per whole token, current. */
  price: Money | null
  /** Whole token supply in base units (18 decimals). */
  totalSupply: Money | null
  /** Curve trades, all-time, in quote base units. */
  volumeAll: Money | null
  volume24h: Money | null
  tradeCount: number
  holderCount: number
  fees: {
    /** Per-trade fee on the curve. */
    tradeFeeBps: number
    /** Creator's share of that fee; the rest goes to the platform vault. */
    creatorShareBps: number
    /** Creator's share of the locked pool's fees after graduation. */
    lpCreatorShareBps: number | null
  }
  /** The locked LP position backing the pool. A uint256 as a string. */
  lpTokenId: string | null
  graduatedAt: string | null
  risk: TokenRisk
}

export interface TokenRisk {
  creatorSharePct: Money | null
  priorLaunches: number
  priorGraduations: number
  hasConfusableSymbol: boolean
  flags: RiskFlag[]
}

export type RiskFlag = 'creator_concentration' | 'creator_no_prior_graduations' | 'confusable_symbol'

// ── Trades, holders, candles ────────────────────────────────────────────────

export interface Trade {
  side: 'buy' | 'sell'
  trader: string
  /** Quote base units. */
  quoteAmount: Money
  /** Token base units. */
  tokenAmount: Money
  /** Quote base units per whole token at this trade. */
  price: Money | null
  venue: 'curve' | 'pool'
  txHash: string
  blockNumber: number
  at: string
  /** Unconfirmed rows render at reduced opacity. */
  finalized: boolean
}

export interface Holder {
  address: string
  balance: Money
  /** Percent of circulating supply, two decimals. */
  sharePct: string | null
  isCreator: boolean
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

export type CandleInterval = '5m' | '1h' | '6h' | '1d' | 'all'

export interface Candle {
  /** Unix seconds, bucket start. */
  t: number
  /** Quote base units per whole token. */
  o: Money
  h: Money
  l: Money
  c: Money
  /** Quote base units traded in the bucket. */
  v: Money
}

export interface CandleSeries {
  interval: CandleInterval
  candles: Candle[]
}

// ── Profile ─────────────────────────────────────────────────────────────────

export interface Holding {
  token: TokenSummary
  balance: Money
  /** Quote base units. */
  valueQuote: Money | null
  costBasisQuote: Money | null
  /** Null when the position does not reconcile with the live wallet balance. */
  pnlQuote: Money | null
}

export interface ClaimableFee {
  token: TokenSummary
  curve: string
  /** Quote base units the creator can claim right now. */
  amount: Money
}

export interface ActivityEntry {
  kind: 'buy' | 'sell' | 'launch'
  token: TokenSummary
  quoteAmount: Money
  tokenAmount: Money
  txHash: string | null
  at: string | null
}

export interface Profile {
  address: string
  holdings: Holding[]
  launches: TokenSummary[]
  claimable: ClaimableFee[]
  activity: ActivityEntry[]
}

// ── Launch terms ────────────────────────────────────────────────────────────

/**
 * Launch terms, read from the factory itself.
 *
 * Null on the config object means the factory could not be read. The launch
 * form renders that as a refusal rather than filling in plausible numbers.
 */
export interface LaunchTerms {
  factoryAddress: string
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
  snipeBlocks: number
  snipeMaxBps: number
}

export interface LaunchpadConfig {
  factoryAddress: string | null
  quoteSymbol: string
  quoteAddress: string
  quoteDecimals: number
  chainId: number
  /** False means the upload path is off and the form asks for a URI instead. */
  pinningEnabled: boolean
  terms: LaunchTerms | null
}

export interface Health {
  status: string
  chainId: number
  /** Last block the indexer has processed, for the "indexing behind" note. */
  indexedBlock?: number
}

// ── Transport ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Thrown when the API cannot be reached at all, as opposed to answering badly. */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super('Hoodium API is unreachable')
    this.name = 'ApiUnreachableError'
    this.cause = cause
  }
}

async function get<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, { credentials: 'include' })
  } catch (cause) {
    throw new ApiUnreachableError(cause)
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown; code?: string } | null
    const message = typeof payload?.error === 'string' ? payload.error : `${path} failed with ${response.status}`
    throw new ApiError(response.status, payload?.code ?? null, message)
  }
  return (await response.json()) as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    throw new ApiUnreachableError(cause)
  }

  const payload = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; code?: string })
    | null

  if (!response.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `request failed with ${response.status}`
    throw new ApiError(response.status, payload?.code ?? null, message)
  }

  return payload as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

/**
 * Artwork, re-served from our own origin — the CSP admits no other image host.
 * An API-relative `image` field is resolved against the API origin; an absolute
 * one is trusted only if it is already on that origin.
 */
export function tokenImageUrl(token: Pick<TokenSummary, 'address' | 'image'>): string | null {
  if (!token.image) return null
  if (token.image.startsWith('/')) return `${env.apiUrl}${token.image}`
  if (token.image.startsWith(env.apiUrl)) return token.image
  return `${env.apiUrl}/api/tokens/${token.address}/image`
}

export interface TokenListParams {
  status?: TokenStatus
  sort?: TokenSort
  window?: TokenWindow
  page?: number
  limit?: number
  q?: string
}

export const launchpadApi = {
  health: () => get<Health>('/health'),
  config: () => get<LaunchpadConfig>('/api/config'),

  tokens: (params: TokenListParams) => get<TokenList>(`/api/tokens${query({ ...params })}`),

  token: (address: string) => get<TokenDetail>(`/api/tokens/${address}`),

  trades: (address: string, page = 1, limit = 25) =>
    get<Paged<Trade>>(`/api/tokens/${address}/trades${query({ page, limit })}`),

  holders: (address: string, page = 1, limit = 25) =>
    get<Paged<Holder>>(`/api/tokens/${address}/holders${query({ page, limit })}`),

  candles: (address: string, interval: CandleInterval) =>
    get<CandleSeries>(`/api/tokens/${address}/candles${query({ interval })}`),

  profile: (address: string) => get<Profile>(`/api/profile/${address}`),

  saveLinks: (address: string, links: { x: string | null; telegram: string | null }) =>
    post<{ x: string | null; telegram: string | null }>(`/api/tokens/${address}/links`, links),

  pinMetadata: (input: {
    name: string
    symbol: string
    description?: string
    x?: string | null
    telegram?: string | null
    image?: { contentType: string; data: string }
  }) => post<{ uri: string; imageUri: string | null }>('/api/metadata', input),
}
