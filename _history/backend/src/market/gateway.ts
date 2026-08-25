/**
 * Uniswap gateway client — 003 R7.
 *
 * Pool TVL, fee tier, and 24h volume come from Uniswap's hosted GraphQL gateway,
 * which already indexes this chain. The alternative — indexing every `Swap` on
 * every pool to rebuild those numbers ourselves — is weeks of work for data that
 * already exists, and it would double the indexer surface for a read-only
 * feature.
 *
 * The trade is that this is a **third-party dependency on an undocumented
 * endpoint**. Two consequences are load-bearing:
 *
 *   - It is optional. No slug configured means the market surface is off, and
 *     nothing else in the process may depend on this module.
 *   - It is proxied server-side, never called from the browser. That keeps the
 *     gateway origin out of the frontend CSP (WA-N2) and lets one cache serve
 *     every user instead of every tab hammering the endpoint.
 *
 * @see BE/src/market.ts in the reference bot, which proved the gateway serves
 * this chain under the slug `robinhood`.
 */
import { componentLogger } from '../lib/logger.js'
import type { Env } from '../config/env.js'

const log = componentLogger('market-gateway')

/** Backoff before retrying a rate-limited request: 1.5s → 4.5s → 13.5s. */
const RETRY_429_MS = 1_500
const MAX_429_RETRIES = 3
const FETCH_TIMEOUT_MS = 15_000
const FETCH_N = 100

export type PoolVersion = 'v3' | 'v4'

export interface TopPool {
  version: PoolVersion
  /** v4: poolId · v3: pool address. Identifies the pool for every downstream call. */
  id: string
  token0Symbol: string
  token1Symbol: string
  /** Lowercase addresses. Empty string means native ETH, which has no address. */
  token0Address: string
  token1Address: string
  token0Decimals: number
  token1Decimals: number
  /**
   * Upstream logo URLs, kept server-side and **never sent to the browser**. The
   * client asks for `/api/token-image/:address` and we resolve the URL from
   * here, so a request can never name the thing we fetch.
   */
  token0LogoUrl: string | null
  token1LogoUrl: string | null
  /** Masked free of the dynamic-fee bit. */
  feeTier: number
  dynamicFee: boolean
  tvlUsd: number
  /**
   * `null` is not zero. The gateway regularly fails this field with an
   * `ExternalAPIError`, and treating that as zero makes a busy pool render as
   * dead — the difference between "no trades" and "we could not find out".
   */
  volume24hUsd: number | null
  /** Fees the whole pool earns per day, USD. `null` when still unknown. */
  feeDayUsd: number | null
  feeDaySource: 'gateway' | 'onchain' | null
  /** Fee/day × 365 ÷ TVL, percent. `null` when fee/day is unknown. */
  aprPct: number | null
}

/** Raised when the gateway is configured but unreachable or malformed. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

interface GqlPool {
  protocolVersion?: string
  poolId?: string
  address?: string
  feeTier?: number
  isDynamicFee?: boolean
  totalLiquidity?: { value?: number }
  token0?: GqlToken
  token1?: GqlToken
  volume24h?: { value?: number }
}

interface GqlToken {
  symbol?: string
  address?: string
  decimals?: number
  project?: { logoUrl?: string | null } | null
}

interface GqlResponse {
  data?: Record<string, GqlPool[] | null>
  errors?: Array<{ message?: string; errorType?: string; path?: Array<string | number> }>
}

const POOL_FIELDS = (v4: boolean): string =>
  `{ protocolVersion ${v4 ? 'poolId isDynamicFee' : 'address'} feeTier totalLiquidity { value } ` +
  `token0 { symbol address decimals project { logoUrl } } ` +
  `token1 { symbol address decimals project { logoUrl } } ` +
  `volume24h: cumulativeVolume(duration: DAY) { value } }`

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms))

/**
 * The dynamic-fee flag lives in the top bit of `feeTier`, so the raw value is
 * not a fee rate until it is masked.
 */
const DYNAMIC_FEE_BIT = 0x800000
const FEE_TIER_MASK = 0x7fffff

/**
 * Accept a logo URL only if it is `https:` and well-formed.
 *
 * This runs at the point the value enters our data, not at the point it is
 * fetched. Anything that reaches the proxy has already passed here, so a
 * malformed or `file:`/`http:` URL never becomes something we could be talked
 * into requesting later.
 */
function logoUrlOf(token: GqlToken | undefined): string | null {
  const raw = token?.project?.logoUrl
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  try {
    return new URL(raw).protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

export function mapGqlPool(p: GqlPool, v4: boolean): TopPool {
  const rawFee = Number(p.feeTier) || 0
  const dynamicFee = Boolean(p.isDynamicFee) || (rawFee & DYNAMIC_FEE_BIT) !== 0
  const feeTier = rawFee & FEE_TIER_MASK
  const tvlUsd = Number(p.totalLiquidity?.value) || 0

  const rawVolume = p.volume24h?.value
  const volume24hUsd =
    rawVolume === null || rawVolume === undefined || !Number.isFinite(Number(rawVolume))
      ? null
      : Number(rawVolume)

  // A dynamic-fee pool has no fixed rate to multiply by, so volume alone cannot
  // give fee/day. Those fall through to the on-chain reader, which needs no fee
  // rate at all because it measures accrued growth directly.
  const feeDayUsd =
    volume24hUsd !== null && feeTier > 0 && !dynamicFee ? volume24hUsd * (feeTier / 1e6) : null
  const aprPct = feeDayUsd !== null && tvlUsd > 0 ? ((feeDayUsd * 365) / tvlUsd) * 100 : null

  return {
    version: (String(p.protocolVersion ?? (v4 ? 'V4' : 'V3')).toLowerCase() === 'v4' ? 'v4' : 'v3'),
    id: String((v4 ? p.poolId : p.address) ?? ''),
    token0Symbol: String(p.token0?.symbol ?? '?').toUpperCase(),
    token1Symbol: String(p.token1?.symbol ?? '?').toUpperCase(),
    token0Address: String(p.token0?.address ?? '').toLowerCase(),
    token1Address: String(p.token1?.address ?? '').toLowerCase(),
    token0Decimals: Number(p.token0?.decimals ?? 18),
    token1Decimals: Number(p.token1?.decimals ?? 18),
    token0LogoUrl: logoUrlOf(p.token0),
    token1LogoUrl: logoUrlOf(p.token1),
    feeTier,
    dynamicFee,
    tvlUsd,
    volume24hUsd,
    feeDayUsd,
    feeDaySource: feeDayUsd === null ? null : 'gateway',
    aprPct,
  }
}

/**
 * Partial failures the gateway reported while building the current snapshot.
 * Surfaced to the client so a `?` cell can say *why* it is a `?` rather than
 * leaving the user to guess whether the pool is dead or the data is missing.
 */
export type DataIssues = Set<string>

async function gqlFetch(env: Env, body: string, issues: DataIssues): Promise<GqlResponse> {
  const doFetch = (): Promise<Response> =>
    fetch(env.UNISWAP_GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.uniswap.org' },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

  let res: Response
  try {
    res = await doFetch()
  } catch (err) {
    throw new GatewayError(`gateway unreachable: ${(err as Error).message}`)
  }

  for (let retry = 0; res.status === 429 && retry < MAX_429_RETRIES; retry++) {
    await sleep(RETRY_429_MS * 3 ** retry)
    res = await doFetch()
  }
  if (!res.ok) throw new GatewayError(`gateway HTTP ${res.status}`)

  const body_ = (await res.json().catch(() => null)) as GqlResponse | null
  if (!body_) throw new GatewayError('gateway returned a body that is not JSON')

  // GraphQL reports per-field failures alongside partial data. Record which
  // field died — `["p0", 1, "volume24h"]` becomes `volume24h`.
  for (const e of body_.errors ?? []) {
    const field = [...(e.path ?? [])]
      .reverse()
      .find((x): x is string => typeof x === 'string' && !/^[pv][0-9_]/.test(x))
    issues.add(`${e.errorType ?? e.message ?? 'error'}${field ? ` on ${field}` : ''}`)
  }
  return body_
}

/**
 * Top pools of one protocol version, chain-wide.
 *
 * A version the chain has no pools for comes back as `null` rather than an empty
 * array, which is why the shape is checked before mapping.
 */
async function fetchTopPools(env: Env, v4: boolean, issues: DataIssues): Promise<TopPool[]> {
  const field = v4 ? 'topV4Pools' : 'topV3Pools'
  const query = `query Q($chain: Chain!, $first: Int!) { ${field}(first: $first, chain: $chain) ${POOL_FIELDS(v4)} }`
  const response = await gqlFetch(
    env,
    JSON.stringify({
      query,
      variables: { chain: env.UNISWAP_CHAIN_SLUG!.toUpperCase(), first: FETCH_N },
    }),
    issues,
  )

  const pools = response.data?.[field]
  if (!Array.isArray(pools)) return []
  return pools.map((p) => mapGqlPool(p, v4)).filter((p) => p.id !== '')
}

export interface PoolSnapshot {
  pools: TopPool[]
  /** Human-readable reasons some numbers are missing. Rendered as footnotes. */
  issues: string[]
}

/**
 * Every v3 and v4 pool the gateway will report for this chain, unfiltered and
 * unsorted — filtering and ranking are the route's job, so the cache holds one
 * snapshot that serves every query shape.
 *
 * A version that fails outright does not sink the whole snapshot: v3 pools are
 * still worth showing when v4 is down, and vice versa.
 */
export async function fetchPoolSnapshot(env: Env): Promise<PoolSnapshot> {
  if (!env.UNISWAP_CHAIN_SLUG) {
    throw new GatewayError('UNISWAP_CHAIN_SLUG is not configured — market data is off')
  }

  const issues: DataIssues = new Set()
  const [v4, v3] = await Promise.all([
    fetchTopPools(env, true, issues).catch((err: Error) => {
      log.warn({ err }, 'topV4Pools failed')
      issues.add(`v4 pools unavailable (${err.message})`)
      return [] as TopPool[]
    }),
    fetchTopPools(env, false, issues).catch((err: Error) => {
      log.warn({ err }, 'topV3Pools failed')
      issues.add(`v3 pools unavailable (${err.message})`)
      return [] as TopPool[]
    }),
  ])

  const pools = [...v4, ...v3]
  if (pools.length === 0) {
    throw new GatewayError(`gateway returned no pools for chain ${env.UNISWAP_CHAIN_SLUG}`)
  }

  log.debug({ v4: v4.length, v3: v3.length, issues: issues.size }, 'pool snapshot built')
  return { pools, issues: [...issues] }
}
