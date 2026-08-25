/**
 * On-chain fee accrual for v4 pools — 003 R7.
 *
 * The gateway never serves `cumulativeVolume(duration: DAY)` for v4 pools on
 * this chain. Not intermittently: every v4 pool, every time. Left alone that
 * makes every v4 pool rank last on a `null` APR — and v4 is what the positions
 * on this chain actually use, so the ranking would be exactly backwards.
 *
 * The replacement is read out of PoolManager storage. `feeGrowthGlobal{0,1}X128`
 * accumulates fees per unit of liquidity, so fees earned over a window are
 *
 *   Σ_i (feeGrowthGlobal(t_i+1) − feeGrowthGlobal(t_i)) × L̄_i / 2^128
 *
 * with L̄ the average active liquidity across each slice. Sampling matters:
 * liquidity moves all day, so a single 24-hour difference multiplied by today's
 * L is wrong by however much L drifted. This also beats `volume × feeTier` for
 * dynamic-fee pools, because it never needs to know the fee rate at all.
 *
 * **Why storage rather than summing `Swap` events**, which would be exact: a
 * 24-hour `eth_getLogs` range routinely times out for a busy pool, and splitting
 * it into dozens of calls per pool walks straight into RPC rate limits.
 * `extsload` takes many slots at once, so one call reads 40 pools.
 *
 * @see BE/src/poolfees.ts, where this method was cross-checked against exact
 * `Swap` summation and agreed within 3%.
 */
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem'
import { componentLogger } from '../lib/logger.js'
import { mapLimit } from '../lib/concurrency.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'
import type { TopPool } from './gateway.js'

const log = componentLogger('market-poolfees')

/** `StateLibrary.POOLS_SLOT` — the `_pools` mapping inside PoolManager. */
const POOLS_SLOT = 6n
/** Field offsets in `Pool.State`: slot0 · feeGrowthGlobal0 · feeGrowthGlobal1 · liquidity. */
const SLOT_OFFSETS = [0n, 1n, 2n, 3n] as const
const U256 = (1n << 256n) - 1n
const Q128 = 1n << 128n
const MAX_U128 = (1n << 128n) - 1n

/** Hourly slices — fine enough for a pool whose liquidity wobbles. */
const BUCKETS = 24
/** 40 pools × 4 slots = 160 slots per `extsload`. */
const POOLS_PER_CALL = 40
const MAX_POOLS = 40
const SAMPLE_CONCURRENCY = 4
/**
 * RPC sits behind a load balancer: one node can lag the head another just
 * reported, and archive depth varies between them. Backing off the head absorbs
 * both.
 */
const HEAD_LAG = 50n
const FEE_TTL_MS = 10 * 60 * 1000
const BLOCKS_PER_DAY_TTL_MS = 60 * 60 * 1000

const EXTSLOAD_ABI = [
  {
    name: 'extsload',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'slots', type: 'bytes32[]' }],
    outputs: [{ type: 'bytes32[]' }],
  },
] as const

/** Why some pools stay `?` even after the on-chain attempt. */
export type OnchainIssues = Set<string>

interface Snap {
  tick: number
  feeGrowth0: bigint
  feeGrowth1: bigint
  liquidity: bigint
}

/** `slot0` packs the current tick as a signed 24-bit value above bit 160. */
function signExtend24(v: bigint): number {
  const x = Number(v & 0xffffffn)
  return x & 0x800000 ? x - 0x1000000 : x
}

function stateSlotOf(poolId: Hex): bigint {
  return BigInt(
    keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT])),
  )
}

/**
 * One `extsload` per chunk → the state of every pool in `slots` at that block.
 * A `null` entry means `slot0` was empty, i.e. the pool did not exist yet.
 */
async function sampleAt(
  chain: ChainClient,
  poolManager: Hex,
  stateSlots: bigint[],
  blockNumber: bigint,
): Promise<Array<Snap | null>> {
  const out: Array<Snap | null> = []

  for (let i = 0; i < stateSlots.length; i += POOLS_PER_CALL) {
    const chunk = stateSlots.slice(i, i + POOLS_PER_CALL)
    const slots = chunk.flatMap((st) => SLOT_OFFSETS.map((n) => toHex((st + n) & U256, { size: 32 })))

    const raw = (await chain.call('extsload', (client) =>
      client.readContract({
        address: poolManager,
        abi: EXTSLOAD_ABI,
        functionName: 'extsload',
        args: [slots],
        blockNumber,
      }),
    )) as readonly Hex[]

    for (let k = 0; k < chunk.length; k++) {
      const [slot0, g0, g1, liq] = raw.slice(k * 4, k * 4 + 4).map((h) => BigInt(h))
      out.push(
        slot0 === undefined || slot0 === 0n
          ? null
          : {
              tick: signExtend24(slot0 >> 160n),
              feeGrowth0: g0!,
              feeGrowth1: g1!,
              liquidity: liq! & MAX_U128,
            },
      )
    }
  }

  return out
}

let blocksPerDayCache: { at: number; blocks: bigint } | null = null

/** Block count spanning 24 hours, measured rather than assumed. */
async function blocksIn24h(chain: ChainClient, head: bigint): Promise<bigint> {
  if (blocksPerDayCache && Date.now() - blocksPerDayCache.at < BLOCKS_PER_DAY_TTL_MS) {
    return blocksPerDayCache.blocks
  }

  const back = head > 100_000n ? 100_000n : head / 2n
  const [older, newer] = await Promise.all([
    chain.call('getBlock:span', (c) => c.getBlock({ blockNumber: head - back })),
    chain.call('getBlock:head', (c) => c.getBlock({ blockNumber: head })),
  ])

  const seconds = Number(newer.timestamp - older.timestamp)
  if (seconds <= 0) throw new Error('block timestamps are not monotonic')

  const blocks = BigInt(Math.round((86_400 * Number(back)) / seconds))
  const clamped = blocks > head ? head : blocks
  blocksPerDayCache = { at: Date.now(), blocks: clamped }
  return clamped
}

/**
 * Fees accrued across a pool's snapshot series, in whole units of each token.
 *
 * A pool created partway through the window is absent from the early blocks, so
 * only the slices with data on both ends are summed and the total is scaled up
 * to the full window rather than under-reporting.
 */
function feeFromSnaps(
  pool: TopPool,
  snaps: Array<Snap | null>,
): { fee0: number; fee1: number; tick: number } | null {
  const last = snaps[snaps.length - 1]
  if (!last) return null

  let fee0 = 0
  let fee1 = 0
  let covered = 0

  for (let i = 0; i + 1 < snaps.length; i++) {
    const a = snaps[i]
    const b = snaps[i + 1]
    if (!a || !b) continue

    const avgLiquidity = (a.liquidity + b.liquidity) / 2n
    // Growth counters wrap by design, so the difference is taken modulo 2^256.
    fee0 += Number((((b.feeGrowth0 - a.feeGrowth0) & U256) * avgLiquidity) / Q128) / 10 ** pool.token0Decimals
    fee1 += Number((((b.feeGrowth1 - a.feeGrowth1) & U256) * avgLiquidity) / Q128) / 10 ** pool.token1Decimals
    covered++
  }

  if (!covered || !Number.isFinite(fee0) || !Number.isFinite(fee1)) return null

  const scale = (snaps.length - 1) / covered
  return { fee0: fee0 * scale, fee1: fee1 * scale, tick: last.tick }
}

/**
 * Direction of *active liquidity* over the window, percent.
 *
 * Your share of fees is your L ÷ pool L, not your share of dollar TVL, so this
 * samples `liquidity` rather than USD value. A pool other LPs are leaving while
 * its fees hold steady is one where your share rises without adding capital.
 *
 * Compared as median-of-first-quarter against median-of-last-quarter rather than
 * first point against last: active liquidity jumps every time price crosses a
 * tick boundary, so two lone samples mislead easily. The median also survives a
 * single failed read.
 */
function liquidityTrendPct(snaps: Array<Snap | null>): number | null {
  const values = snaps.filter((s): s is Snap => s !== null).map((s) => Number(s.liquidity))
  if (values.length < 8) return null

  const quarter = Math.max(2, Math.floor(values.length / 4))
  const median = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  }

  const first = median(values.slice(0, quarter))
  const last = median(values.slice(-quarter))
  if (!(first > 0)) return null

  const pct = (last / first - 1) * 100
  return Number.isFinite(pct) ? pct : null
}

const feeCache = new Map<string, { at: number; feeDayUsd: number | null; liquidityTrendPct: number | null }>()

/** Exported for tests — the cache is process-wide and would leak between cases. */
export function resetFeeCacheForTesting(): void {
  feeCache.clear()
  blocksPerDayCache = null
}

export interface EnrichedPool extends TopPool {
  /** Active-liquidity direction over 24h, percent. `null` when not measured. */
  liquidityTrendPct: number | null
}

/**
 * Fill in fee/day for pools the gateway could not price, reading accrual from
 * the chain. Mutates in place: the same objects live in the market cache, so the
 * next build inherits the work.
 *
 * Quote pricing is deliberately narrow. Fees are earned in the pool's own two
 * tokens, and turning that into USD needs the quote token's price. Rather than
 * build a price oracle, only pools quoted in a configured stable are converted —
 * that is the USDG-denominated case this product is about. Anything else is left
 * `null` with a stated reason, which is honest where a guessed price would not be.
 */
export async function enrichFeeDayOnchain(
  env: Env,
  chain: ChainClient,
  pools: EnrichedPool[],
  issues: OnchainIssues,
): Promise<void> {
  const poolManager = env.UNISWAP_V4_POOL_MANAGER
  if (!poolManager) {
    issues.add('UNISWAP_V4_POOL_MANAGER is not configured — v4 fees cannot be read')
    return
  }

  const stableQuotes = new Set(env.MARKET_QUOTE_SYMBOLS)

  const apply = (p: EnrichedPool, feeDayUsd: number | null, trend: number | null): void => {
    // Liquidity direction stands on its own: a pool whose fee/day the gateway
    // already served still wants it, and a pool whose fees failed may still report it.
    if (trend !== null) p.liquidityTrendPct = trend
    if (p.feeDayUsd !== null) return // the gateway already answered — do not overwrite
    if (feeDayUsd === null || !(feeDayUsd >= 0)) return

    p.feeDayUsd = feeDayUsd
    p.feeDaySource = 'onchain'
    p.aprPct = p.tvlUsd > 0 ? ((feeDayUsd * 365) / p.tvlUsd) * 100 : null
  }

  // Pools whose fee/day is already known still ride along, purely for the
  // liquidity trend. That costs nothing: one `extsload` carries 40 pools, so
  // adding more to an existing batch is free.
  const todo: EnrichedPool[] = []
  for (const p of pools) {
    if (!p.id) continue
    if (p.feeDayUsd !== null && p.liquidityTrendPct !== null) continue

    const hit = feeCache.get(p.id)
    if (hit && Date.now() - hit.at < FEE_TTL_MS) apply(p, hit.feeDayUsd, hit.liquidityTrendPct)
    else if (p.version === 'v4') todo.push(p)
  }
  if (todo.length === 0) return

  const unique = new Map<string, EnrichedPool>()
  for (const p of [...todo].sort((a, b) => b.tvlUsd - a.tvlUsd)) if (!unique.has(p.id)) unique.set(p.id, p)
  const targets = [...unique.values()].slice(0, MAX_POOLS)
  if (unique.size > targets.length) {
    // A silent cap reads as "we covered everything" when we did not.
    const skipped = unique.size - targets.length
    issues.add(`${skipped} pool(s) beyond the ${MAX_POOLS}-pool on-chain budget were not priced`)
    log.info({ skipped, budget: MAX_POOLS }, 'on-chain fee budget exhausted')
  }

  let head: bigint
  let span: bigint
  try {
    const tip = await chain.getBlockNumber()
    head = tip > HEAD_LAG ? tip - HEAD_LAG : tip
    span = await blocksIn24h(chain, head)
  } catch (err) {
    issues.add(`RPC unreachable (${(err as Error).message.split('\n')[0]})`)
    return
  }

  const stateSlots = targets.map((p) => stateSlotOf(p.id as Hex))
  const blocks = Array.from(
    { length: BUCKETS + 1 },
    (_, i) => head - span + (span * BigInt(i)) / BigInt(BUCKETS),
  )

  // One missing time point is survivable — that slice alone is skipped.
  const samples = await mapLimit(blocks, SAMPLE_CONCURRENCY, async (block) => {
    try {
      return await sampleAt(chain, poolManager as Hex, stateSlots, block)
    } catch (err) {
      log.warn({ err, block: block.toString() }, 'pool state sample failed')
      return null
    }
  })

  if (!samples[samples.length - 1]) {
    issues.add('the latest pool state could not be read from RPC')
    return
  }

  targets.forEach((p, index) => {
    const series = samples.map((s) => (s ? (s[index] ?? null) : null))
    const trend = liquidityTrendPct(series)
    const accrued = feeFromSnaps(p, series)

    if (!accrued) {
      issues.add(`24h history for ${p.token0Symbol}/${p.token1Symbol} could not be read`)
      feeCache.set(p.id, { at: Date.now(), feeDayUsd: null, liquidityTrendPct: trend })
      return
    }

    if (!stableQuotes.has(p.token1Symbol)) {
      issues.add(`${p.token1Symbol} has no USD price — fees for ${p.token0Symbol}/${p.token1Symbol} left unpriced`)
      feeCache.set(p.id, { at: Date.now(), feeDayUsd: null, liquidityTrendPct: trend })
      return
    }

    // token0 fees are valued through the pool's own current price, expressed as
    // token0 in terms of token1, which the tick already encodes.
    const price0In1 = 1.0001 ** accrued.tick * 10 ** (p.token0Decimals - p.token1Decimals)
    const feeDayUsd = accrued.fee0 * price0In1 + accrued.fee1

    feeCache.set(p.id, {
      at: Date.now(),
      feeDayUsd: Number.isFinite(feeDayUsd) ? feeDayUsd : null,
      liquidityTrendPct: trend,
    })
  })

  // Apply to every pool, since one pool id can appear more than once.
  for (const p of pools) {
    const hit = feeCache.get(p.id)
    if (hit) apply(p, hit.feeDayUsd, hit.liquidityTrendPct)
  }
}
