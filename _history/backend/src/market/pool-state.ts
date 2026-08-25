/**
 * Live pool state — 003 T5.12, WA-7.7.
 *
 * The indexer snapshot describes what a pool *earned*; it says nothing about
 * where the price is now or how the pool's ticks are spaced. Both are needed
 * before a range can be offered: a preset is meaningless without a price to
 * centre on, and a bound that is not a multiple of the tick spacing is rejected
 * by the contract *after* the user has signed.
 *
 * v4 tick spacing is the sharp edge. It is chosen independently of the fee tier,
 * so it cannot be derived — it has to be read from the `Initialize` log the pool
 * emitted when it was created, which is also where `hooks` comes from. Observed
 * on this chain: pools do carry non-zero hooks, and a fee of `0x800000` is the
 * dynamic-fee flag rather than a rate.
 *
 * This runs against `MARKET_RPC_URL`, which is the chain the market describes —
 * not necessarily the chain this process transacts on.
 */
import { createPublicClient, defineChain, http, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { componentLogger } from '../lib/logger.js'
import type { Env } from '../config/env.js'

const log = componentLogger('pool-state')

/** Full-history log queries are slow enough to need more headroom than a read. */
const RPC_TIMEOUT_MS = 30_000
const CACHE_TTL_MS = 30_000
/** Pool keys are immutable once initialised, so they never need re-reading. */
const poolKeyCache = new Map<string, PoolKey | null>()
const stateCache = new Map<string, { at: number; state: PoolState | null }>()

export function resetPoolStateCacheForTesting(): void {
  poolKeyCache.clear()
  stateCache.clear()
}

const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
])

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
])

const V4_INITIALIZE_ABI = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])

export interface PoolKey {
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number
  hooks: string
}

export interface PoolState {
  sqrtPriceX96: string
  tick: number
  tickSpacing: number
  liquidity: string
  /** v4 only. A non-zero hook can change what a mint even does. */
  hooks: string | null
}

let client: PublicClient | null = null
let clientUrl: string | null = null

function marketClient(env: Env): PublicClient {
  const url = env.MARKET_RPC_URL ?? env.RPC_PRIMARY
  if (client && clientUrl === url) return client

  // A bare numeric id is enough: nothing here signs, so the chain definition
  // only has to carry the transport.
  const chain = defineChain({
    id: env.CHAIN_ID,
    name: 'market',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  })

  client = createPublicClient({
    chain,
    transport: http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
  }) as PublicClient
  clientUrl = url
  return client
}

/**
 * Recover a v4 pool key from the `Initialize` log that created the pool.
 *
 * A poolId is the hash of the key, so it cannot be inverted — the log is the
 * only place the components survive.
 */
async function v4PoolKey(env: Env, poolId: string): Promise<PoolKey | null> {
  const cached = poolKeyCache.get(poolId)
  if (cached !== undefined) return cached

  const poolManager = env.UNISWAP_V4_POOL_MANAGER
  if (!poolManager) return null

  try {
    const rpc = marketClient(env)

    /*
     * The whole chain in one query, deliberately.
     *
     * A bounded lookback is the obvious design and it is wrong here: pools long
     * predate any window worth guessing — one live pool was initialised at block
     * 10.4M against a head of 22.2M — and a window that misses returns an empty
     * array, which reads exactly like "this pool does not exist".
     *
     * Scanning backwards in chunks fixes the correctness but costs dozens of
     * sequential round trips. Filtering on the indexed `id` makes the query
     * selective enough that the node answers the full range directly, so one
     * call beats forty.
     */
    const logs = await rpc.getLogs({
      address: poolManager as Address,
      event: V4_INITIALIZE_ABI[0],
      args: { id: poolId as Hex },
      fromBlock: 0n,
      toBlock: 'latest',
    })

    const found = logs[0]
    if (!found) {
      // Cached: a pool the indexer lists but whose key we cannot recover must
      // not re-scan the chain on every request.
      log.info({ poolId }, 'v4 Initialize log not found')
      poolKeyCache.set(poolId, null)
      return null
    }

    const args = found.args as {
      currency0?: string
      currency1?: string
      fee?: number
      tickSpacing?: number
      hooks?: string
    }
    const key: PoolKey = {
      currency0: String(args.currency0 ?? '').toLowerCase(),
      currency1: String(args.currency1 ?? '').toLowerCase(),
      fee: Number(args.fee ?? 0),
      tickSpacing: Number(args.tickSpacing ?? 0),
      hooks: String(args.hooks ?? '').toLowerCase(),
    }
    poolKeyCache.set(poolId, key)
    return key
  } catch (err) {
    log.warn({ err, poolId }, 'v4 pool key lookup failed')
    // Not cached: this is a transport failure, not a missing pool.
    return null
  }
}

async function readV4(env: Env, poolId: string): Promise<PoolState | null> {
  const stateView = env.UNISWAP_V4_STATE_VIEW
  if (!stateView) return null

  const key = await v4PoolKey(env, poolId)
  if (!key || key.tickSpacing === 0) return null

  const rpc = marketClient(env)
  const [slot0, liquidity] = await Promise.all([
    rpc.readContract({
      address: stateView as Address,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [poolId as Hex],
    }),
    rpc.readContract({
      address: stateView as Address,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [poolId as Hex],
    }),
  ])

  return {
    sqrtPriceX96: String(slot0[0]),
    tick: Number(slot0[1]),
    tickSpacing: key.tickSpacing,
    liquidity: String(liquidity),
    hooks: key.hooks,
  }
}

async function readV3(env: Env, poolAddress: string): Promise<PoolState | null> {
  const rpc = marketClient(env)
  const [slot0, tickSpacing, liquidity] = await Promise.all([
    rpc.readContract({ address: poolAddress as Address, abi: V3_POOL_ABI, functionName: 'slot0' }),
    rpc.readContract({ address: poolAddress as Address, abi: V3_POOL_ABI, functionName: 'tickSpacing' }),
    rpc.readContract({ address: poolAddress as Address, abi: V3_POOL_ABI, functionName: 'liquidity' }),
  ])

  return {
    sqrtPriceX96: String(slot0[0]),
    tick: Number(slot0[1]),
    tickSpacing: Number(tickSpacing),
    liquidity: String(liquidity),
    hooks: null,
  }
}

/**
 * Current state of one pool, or `null` when it cannot be read.
 *
 * `null` is a first-class answer here. Reading may fail because the configured
 * RPC serves a different chain than the market data describes, and inventing a
 * price in that case would be far worse than admitting we do not have one — the
 * caller renders the range picker only when this is present.
 */
export async function readPoolState(
  env: Env,
  version: 'v3' | 'v4',
  id: string,
): Promise<PoolState | null> {
  const cacheKey = `${version}:${id.toLowerCase()}`
  const hit = stateCache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state

  try {
    const state = version === 'v4' ? await readV4(env, id) : await readV3(env, id)
    stateCache.set(cacheKey, { at: Date.now(), state })
    return state
  } catch (err) {
    log.warn({ err, version, id }, 'pool state read failed')
    stateCache.set(cacheKey, { at: Date.now(), state: null })
    return null
  }
}
