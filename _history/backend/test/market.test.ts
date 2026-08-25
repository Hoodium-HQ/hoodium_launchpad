/**
 * 003 R7 — the market read path.
 *
 * The thing worth defending here is the distinction between "zero" and "we could
 * not find out". The gateway fails `volume24h` routinely, and every cheap
 * shortcut — `?? 0`, a falsy check, a `Number()` coercion — turns a busy pool
 * into a dead one on screen. Most of these tests exist to keep that distinction
 * alive from the GraphQL body all the way to the sort order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapGqlPool, fetchPoolSnapshot, GatewayError } from '../src/market/gateway.js'
import { getMarketSnapshot, resetMarketCacheForTesting } from '../src/market/cache.js'
import { resetFeeCacheForTesting } from '../src/market/poolfees.js'
import { loadTokenImage, resetTokenImageCacheForTesting } from '../src/market/token-images.js'
import { matchesQuote } from '../src/api/market-routes.js'
import { loadEnv, type Env } from '../src/config/env.js'
import type { ChainClient } from '../src/chain/rpc.js'

function envFor(overrides: Partial<Record<string, string>> = {}): Env {
  return loadEnv({
    APP_ENV: 'local',
    CHAIN_ID: '31337',
    ROBINHOOD_MAINNET_CHAIN_ID: '4663',
    ROBINHOOD_TESTNET_CHAIN_ID: '421614',
    RPC_PRIMARY: 'https://rpc.example/1',
    RPC_FALLBACK: 'https://rpc.example/2',
    MONGO_URI: 'mongodb://127.0.0.1:27017',
    QUOTE_TOKEN_ADDRESS: '0x' + '1'.repeat(40),
    POSITION_MANAGER_ADDRESS: '0x' + '2'.repeat(40),
    UNISWAP_V3_FACTORY_ADDRESS: '0x' + '3'.repeat(40),
    APP_ORIGIN: 'http://localhost:5173',
    UNISWAP_CHAIN_SLUG: 'robinhood',
    ...overrides,
  })
}

/** A chain client that fails every call — enrichment must stay best-effort. */
const deadChain = {
  call: () => Promise.reject(new Error('no rpc in this test')),
  getBlockNumber: () => Promise.reject(new Error('no rpc in this test')),
} as unknown as ChainClient

const gqlPool = (over: Record<string, unknown> = {}) => ({
  protocolVersion: 'V3',
  address: '0x' + 'a'.repeat(40),
  feeTier: 3000,
  totalLiquidity: { value: 250_000 },
  token0: { symbol: 'brodie', address: '0x' + 'b'.repeat(40), decimals: 18 },
  token1: { symbol: 'usdg', address: '0x' + 'c'.repeat(40), decimals: 6 },
  volume24h: { value: 1_000_000 },
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetMarketCacheForTesting()
  resetFeeCacheForTesting()
  resetTokenImageCacheForTesting()
})

describe('mapGqlPool', () => {
  it('derives fee/day and APR from volume and fee tier', () => {
    const p = mapGqlPool(gqlPool(), false)
    // 1,000,000 × 0.3% = 3,000/day → 3,000 × 365 ÷ 250,000 = 438%
    expect(p.feeDayUsd).toBeCloseTo(3_000, 6)
    expect(p.aprPct).toBeCloseTo(438, 6)
    expect(p.feeDaySource).toBe('gateway')
  })

  it('keeps a missing volume as null rather than zero', () => {
    for (const missing of [undefined, null, 'not-a-number']) {
      const p = mapGqlPool(gqlPool({ volume24h: { value: missing } }), false)
      expect(p.volume24hUsd).toBeNull()
      expect(p.feeDayUsd).toBeNull()
      expect(p.aprPct).toBeNull()
      expect(p.feeDaySource).toBeNull()
    }
  })

  it('distinguishes a genuine zero volume from an absent one', () => {
    const p = mapGqlPool(gqlPool({ volume24h: { value: 0 } }), false)
    expect(p.volume24hUsd).toBe(0)
    expect(p.feeDayUsd).toBe(0)
    expect(p.aprPct).toBe(0)
  })

  it('masks the dynamic-fee bit out of the fee tier', () => {
    const p = mapGqlPool(gqlPool({ feeTier: 0x800000 | 500 }), true)
    expect(p.feeTier).toBe(500)
    expect(p.dynamicFee).toBe(true)
  })

  it('leaves a dynamic-fee pool unpriced, since its tier is not its rate', () => {
    const p = mapGqlPool(gqlPool({ isDynamicFee: true, feeTier: 3000 }), true)
    expect(p.dynamicFee).toBe(true)
    expect(p.feeDayUsd).toBeNull()
  })

  it('reports no APR when TVL is zero rather than dividing by it', () => {
    const p = mapGqlPool(gqlPool({ totalLiquidity: { value: 0 } }), false)
    expect(p.aprPct).toBeNull()
    expect(p.feeDayUsd).toBeCloseTo(3_000, 6)
  })

  it('normalises symbols and lowercases addresses', () => {
    const p = mapGqlPool(gqlPool(), false)
    expect(p.token0Symbol).toBe('BRODIE')
    expect(p.token1Address).toBe('0x' + 'c'.repeat(40))
  })

  it('reads the v4 identifier from poolId and the v3 one from address', () => {
    expect(mapGqlPool(gqlPool({ protocolVersion: 'V4', poolId: '0xfeed' }), true).id).toBe('0xfeed')
    expect(mapGqlPool(gqlPool(), false).id).toBe('0x' + 'a'.repeat(40))
  })
})

describe('fetchPoolSnapshot', () => {
  const stubFetch = (body: unknown, status = 200) => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('merges v4 and v3 pools into one snapshot', async () => {
    stubFetch({
      data: {
        topV4Pools: [gqlPool({ protocolVersion: 'V4', poolId: '0xaaa' })],
        topV3Pools: [gqlPool()],
      },
    })

    const snapshot = await fetchPoolSnapshot(envFor())
    expect(snapshot.pools).toHaveLength(2)
    expect(snapshot.pools.map((p) => p.version).sort()).toEqual(['v3', 'v4'])
  })

  it('records partial GraphQL errors as issues instead of discarding them', async () => {
    stubFetch({
      data: { topV4Pools: [gqlPool({ protocolVersion: 'V4', poolId: '0xaaa' })], topV3Pools: [] },
      errors: [{ errorType: 'ExternalAPIError', path: ['topV4Pools', 0, 'volume24h'] }],
    })

    const snapshot = await fetchPoolSnapshot(envFor())
    expect(snapshot.issues.some((i) => i.includes('volume24h'))).toBe(true)
  })

  it('survives one protocol version failing entirely', async () => {
    // `null` is what the gateway returns for a version this chain has no pools of.
    stubFetch({ data: { topV4Pools: null, topV3Pools: [gqlPool()] } })

    const snapshot = await fetchPoolSnapshot(envFor())
    expect(snapshot.pools).toHaveLength(1)
    expect(snapshot.pools[0]!.version).toBe('v3')
  })

  it('refuses to run without a chain slug', async () => {
    await expect(fetchPoolSnapshot(envFor({ UNISWAP_CHAIN_SLUG: undefined }))).rejects.toThrow(GatewayError)
  })

  it('throws rather than reporting an empty chain as success', async () => {
    stubFetch({ data: { topV4Pools: [], topV3Pools: [] } })
    await expect(fetchPoolSnapshot(envFor())).rejects.toThrow(GatewayError)
  })
})

describe('market cache', () => {
  const stubOnePool = () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: { topV4Pools: [], topV3Pools: [gqlPool()] } }),
      } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('serves a fresh snapshot without touching the gateway again', async () => {
    const fetchMock = stubOnePool()
    const env = envFor()

    await getMarketSnapshot(env, deadChain)
    await getMarketSnapshot(env, deadChain)

    // Two calls for the first build (v4 + v3), none for the second.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent cold builds onto one round trip', async () => {
    const fetchMock = stubOnePool()
    const env = envFor()

    await Promise.all([
      getMarketSnapshot(env, deadChain),
      getMarketSnapshot(env, deadChain),
      getMarketSnapshot(env, deadChain),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rebuilds once the entry is past the stale window', async () => {
    const fetchMock = stubOnePool()
    const env = envFor({ MARKET_CACHE_TTL_MS: '1', MARKET_CACHE_STALE_MS: '2' })

    await getMarketSnapshot(env, deadChain)
    await new Promise((r) => setTimeout(r, 12))
    await getMarketSnapshot(env, deadChain)

    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('keeps the gateway list when on-chain enrichment fails', async () => {
    stubOnePool()

    // `deadChain` rejects every call, standing in for an RPC outage.
    const snapshot = await getMarketSnapshot(envFor(), deadChain)

    expect(snapshot.pools).toHaveLength(1)
    expect(snapshot.pools[0]!.feeDayUsd).toBeCloseTo(3_000, 6)
    expect(snapshot.issues.length).toBeGreaterThan(0)
  })

  it('reports the on-chain reader as unconfigured rather than failing quietly', async () => {
    stubOnePool()

    const snapshot = await getMarketSnapshot(envFor({ UNISWAP_V4_POOL_MANAGER: undefined }), deadChain)
    expect(snapshot.issues.some((i) => i.includes('UNISWAP_V4_POOL_MANAGER'))).toBe(true)
  })
})

describe('token image proxy — T5.6', () => {
  const PNG = 'https://coin-images.coingecko.com/coins/1/large/x.png'

  const stubImage = (
    over: { status?: number; type?: string; bytes?: number; throws?: boolean } = {},
  ) => {
    const { status = 200, type = 'image/png', bytes = 1_024, throws = false } = over
    const fetchMock = vi.fn(() => {
      if (throws) return Promise.reject(new Error('network down'))
      return Promise.resolve({
        ok: status < 400,
        status,
        headers: new Headers({ 'content-type': type, 'content-length': String(bytes) }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)),
      } as unknown as Response)
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('serves an allowlisted png', async () => {
    stubImage()
    const image = await loadTokenImage('a', PNG)
    expect(image?.contentType).toBe('image/png')
    expect(image?.body.byteLength).toBe(1_024)
  })

  it('refuses a host that is not allowlisted', async () => {
    const fetchMock = stubImage()
    expect(await loadTokenImage('b', 'https://evil.example/logo.png')).toBeNull()
    // Rejected before any request left the process.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses plaintext http even on an allowlisted host', async () => {
    const fetchMock = stubImage()
    expect(await loadTokenImage('c', 'http://assets.coingecko.com/logo.png')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses internal addresses outright', async () => {
    const fetchMock = stubImage()
    for (const url of ['https://127.0.0.1/logo.png', 'https://169.254.169.254/latest/meta-data']) {
      expect(await loadTokenImage(`d:${url}`, url)).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses SVG, which is a document rather than an image when opened directly', async () => {
    stubImage({ type: 'image/svg+xml' })
    expect(await loadTokenImage('e', PNG)).toBeNull()
  })

  it('refuses a body larger than the cap', async () => {
    stubImage({ bytes: 2 * 1024 * 1024 })
    expect(await loadTokenImage('f', PNG)).toBeNull()
  })

  it('caches a success so a page view costs no outbound request', async () => {
    const fetchMock = stubImage()
    await loadTokenImage('g', PNG)
    await loadTokenImage('g', PNG)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caches a failure too, so a broken logo is not retried per view', async () => {
    const fetchMock = stubImage({ throws: true })
    await loadTokenImage('h', PNG)
    await loadTokenImage('h', PNG)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('sort direction — R7', () => {
  const p = (over: Partial<EnrichedPoolLike>): EnrichedPoolLike => ({ aprPct: 100, ...over })
  type EnrichedPoolLike = { aprPct: number | null }

  /**
   * Mirrors the route's comparator. The property under test is that unknowns
   * stay last in *both* directions: ascending order would otherwise float every
   * `null` to the top, reading as "this is the smallest" when it means "we could
   * not measure it".
   */
  const compare = (dir: 'asc' | 'desc') => (a: EnrichedPoolLike, b: EnrichedPoolLike) => {
    const x = a.aprPct
    const y = b.aprPct
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return dir === 'asc' ? x - y : y - x
  }

  it('puts unknowns last descending', () => {
    const sorted = [p({ aprPct: null }), p({ aprPct: 5 }), p({ aprPct: 500 })].sort(compare('desc'))
    expect(sorted.map((x) => x.aprPct)).toEqual([500, 5, null])
  })

  it('puts unknowns last ascending too, rather than treating them as smallest', () => {
    const sorted = [p({ aprPct: null }), p({ aprPct: 500 }), p({ aprPct: 5 })].sort(compare('asc'))
    expect(sorted.map((x) => x.aprPct)).toEqual([5, 500, null])
  })

  it('keeps a genuine zero ahead of an unknown in ascending order', () => {
    const sorted = [p({ aprPct: null }), p({ aprPct: 0 })].sort(compare('asc'))
    expect(sorted.map((x) => x.aprPct)).toEqual([0, null])
  })
})

describe('quote filter — R7', () => {
  const stables = new Set(['USDG', 'USDC', 'USDT', 'DAI'])
  const pair = (token0Symbol: string, token1Symbol: string) => ({ token0Symbol, token1Symbol })

  it('keeps everything when unfiltered', () => {
    expect(matchesQuote(pair('WETH', 'ARTCOIN'), 'all', stables)).toBe(true)
  })

  it('matches a ticker on either side of the pair', () => {
    // Uniswap orders a pair by token address, so which side the quote lands on is
    // arbitrary. Checking `token1` alone dropped every pool where it sorted first.
    expect(matchesQuote(pair('CASHCAT', 'USDG'), 'USDG', stables)).toBe(true)
    expect(matchesQuote(pair('USDG', 'CASHCAT'), 'USDG', stables)).toBe(true)
    expect(matchesQuote(pair('WETH', 'ARTCOIN'), 'USDG', stables)).toBe(false)
  })

  it('treats ETH and WETH as one asset', () => {
    // v4 holds native ETH, v3 holds WETH. Nobody asking for ETH pools means to
    // exclude half of them over a wrapping detail.
    expect(matchesQuote(pair('WETH', 'ARTCOIN'), 'ETH', stables)).toBe(true)
    expect(matchesQuote(pair('ETH', 'PONS'), 'ETH', stables)).toBe(true)
    expect(matchesQuote(pair('ETH', 'PONS'), 'WETH', stables)).toBe(true)
    expect(matchesQuote(pair('CASHCAT', 'USDG'), 'ETH', stables)).toBe(false)
  })

  it('does not alias any other symbol', () => {
    // The ETH/WETH pair is a wrapping of one asset. USDC and USDT are not, and
    // folding them together would be a claim about their peg we cannot make.
    expect(matchesQuote(pair('USDC', 'PONS'), 'USDT', stables)).toBe(false)
  })

  it('matches any configured stable when asked for stables', () => {
    expect(matchesQuote(pair('DAI', 'PONS'), 'stable', stables)).toBe(true)
    expect(matchesQuote(pair('WETH', 'ARTCOIN'), 'stable', stables)).toBe(false)
  })

  it('compares case-insensitively — symbols are token metadata, not a schema', () => {
    expect(matchesQuote(pair('WeTh', 'PONS'), 'eth', stables)).toBe(true)
    expect(matchesQuote(pair('usdg', 'PONS'), 'stable', stables)).toBe(true)
  })
})
