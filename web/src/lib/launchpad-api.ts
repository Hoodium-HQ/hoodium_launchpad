/**
 * Launchpad read API. Rankings, history and aggregates only — anything that
 * moves money goes browser → chain, never through here.
 *
 * The three writes (pinning metadata, editing a token's links, token chat —
 * unused here) touch no balance, and a launch still fails closed if the
 * browser cannot reach us — the creator pastes an IPFS URI instead.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 * `./api-types.ts` is a verbatim copy of `../api/src/types.ts` and is the only
 * description of the wire shapes in this app. Nothing below re-declares a
 * response type; it re-exports them so a consumer never imports a copy that
 * could drift. Two conventions from that file matter at every call site:
 *
 *   - exact on-chain amounts are decimal strings of base units (`Money`);
 *   - every `…Usd` field is a JS *number*, for display and sorting only —
 *     `usdToMoney` in `./money` is where it becomes `Money` again.
 *
 * Writes that need a signature carry the envelope from `./auth`; the API has
 * no cookies or sessions, so requests are sent without credentials.
 */
import { env } from '@/config/env'
import type {
  CandleInterval,
  CandlesResponse,
  ConfigResponse,
  HealthResponse,
  HoldersResponse,
  PinMetadataRequest,
  PinMetadataResponse,
  PriceSeriesResponse,
  ProfileActivityResponse,
  ProfileResponse,
  TokenDetail,
  TokenDetailResponse,
  TokenListItem,
  TokenListResponse,
  TokenListSort,
  TokenListStatus,
  TradesResponse,
  UpdateLinksRequest,
  VolumeWindow,
} from './api-types'

export type * from './api-types'

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

/**
 * Error bodies are `{ error, code? }`. A handful of codes deserve a sentence
 * the creator can act on rather than the server's terse one.
 */
const MESSAGES: Record<string, string> = {
  pinning_unavailable:
    'Metadata pinning is not configured on this deployment. Paste an IPFS URI you pinned yourself instead.',
  expired: 'That signature has expired — sign again.',
  bad_signature: 'The signature did not match the connected wallet.',
  forbidden: 'Only the creator wallet can edit these links.',
  not_a_holder: 'Only token holders can post here.',
}

async function throwFor(path: string, response: Response, payload: { error?: unknown; code?: unknown } | null): Promise<never> {
  const code = typeof payload?.code === 'string' ? payload.code : null
  const message =
    (code && MESSAGES[code]) ??
    (typeof payload?.error === 'string' ? payload.error : `${path} failed with ${response.status}`)
  throw new ApiError(response.status, code, message)
}

async function get<T>(path: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`)
  } catch (cause) {
    throw new ApiUnreachableError(cause)
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null
    return throwFor(path, response, payload)
  }
  return (await response.json()) as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    throw new ApiUnreachableError(cause)
  }

  const payload = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; code?: unknown })
    | null

  if (!response.ok) return throwFor(path, response, payload)
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
export function tokenImageUrl(token: Pick<TokenListItem, 'address' | 'image'>): string | null {
  if (!token.image) return null
  if (token.image.startsWith('/')) return `${env.apiUrl}${token.image}`
  if (token.image.startsWith(env.apiUrl)) return token.image
  return `${env.apiUrl}/api/tokens/${token.address}/image`
}

export interface TokenListParams {
  status?: TokenListStatus
  sort?: TokenListSort
  window?: VolumeWindow
  page?: number
  limit?: number
  q?: string
  creator?: string
}

/** What `POST /api/tokens/:address/links` answers with — the overlay as stored. */
export interface LinksResponse {
  x: string | null
  telegram: string | null
  website: string | null
}

export const launchpadApi = {
  health: () => get<HealthResponse>('/health'),
  config: () => get<ConfigResponse>('/api/config'),

  tokens: (params: TokenListParams) => get<TokenListResponse>(`/api/tokens${query({ ...params })}`),

  token: async (address: string): Promise<TokenDetail> =>
    (await get<TokenDetailResponse>(`/api/tokens/${address}`)).token,

  trades: (address: string, page = 1, limit = 25) =>
    get<TradesResponse>(`/api/tokens/${address}/trades${query({ page, limit })}`),

  holders: (address: string, page = 1, limit = 25) =>
    get<HoldersResponse>(`/api/tokens/${address}/holders${query({ page, limit })}`),

  /**
   * `interval=all` is resolved server-side: the API picks the widest bucket that
   * keeps the whole life of the token under its candle cap and reports the
   * interval it chose in the response.
   */
  candles: (address: string, interval: CandleInterval) =>
    get<CandlesResponse>(`/api/tokens/${address}/candles${query({ interval })}`),

  priceSeries: (address: string, window: PriceSeriesResponse['window']) =>
    get<PriceSeriesResponse>(`/api/tokens/${address}/price-series${query({ window })}`),

  profile: (address: string) => get<ProfileResponse>(`/api/profile/${address}`),

  profileActivity: (address: string, limit = 100) =>
    get<ProfileActivityResponse>(`/api/profile/${address}/activity${query({ limit })}`),

  /** The caller signs; see `useSaveLinks`. */
  saveLinks: (address: string, body: UpdateLinksRequest) =>
    post<LinksResponse>(`/api/tokens/${address}/links`, body),

  pinMetadata: (input: PinMetadataRequest) => post<PinMetadataResponse>('/api/metadata', input),
}
