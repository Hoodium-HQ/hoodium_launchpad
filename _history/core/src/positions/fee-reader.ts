/**
 * Chain reads behind the fee math — T7.2 / 001 design section 6a.
 *
 * `feemath.ts` is pure and takes seven values it cannot fetch. This is the thin
 * layer that fetches them, and it is separate for the reason every read/compute
 * split in this codebase is separate: the arithmetic is the part that has to be
 * tested against fixtures, and it cannot be if a chain client is threaded
 * through it.
 *
 * Cost, because this runs on the monitor's 60-second cycle: four reads per
 * position (`positions`, two `ticks`, one `feeGrowthGlobal` pair). The two
 * pool-level reads are shared by every position in that pool and the tick reads
 * by every position sharing a boundary, so `FeeReadCache` collapses them for the
 * duration of a cycle. Without it a wallet with twenty positions in one pool
 * costs eighty round trips a minute to learn the same four numbers.
 */
import type { Address, PublicClient } from 'viem'
import { poolAbi, positionManagerAbi } from '../chain/abi.js'
import { uncollectedFees, type TickFeeGrowth, type UncollectedFees } from './feemath.js'

/** Per-cycle memo of pool- and tick-level reads. Construct one, discard it after. */
export class FeeReadCache {
  readonly global = new Map<string, { feeGrowthGlobal0X128: bigint; feeGrowthGlobal1X128: bigint }>()
  readonly ticks = new Map<string, TickFeeGrowth>()
}

type Caller = <T>(label: string, fn: (client: PublicClient) => Promise<T>) => Promise<T>

async function readFeeGrowthGlobal(
  call: Caller,
  pool: Address,
  cache: FeeReadCache,
): Promise<{ feeGrowthGlobal0X128: bigint; feeGrowthGlobal1X128: bigint }> {
  const key = pool.toLowerCase()
  const hit = cache.global.get(key)
  if (hit) return hit

  const [g0, g1] = await call('feeGrowthGlobal', (client) =>
    Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: 'feeGrowthGlobal0X128' }),
      client.readContract({ address: pool, abi: poolAbi, functionName: 'feeGrowthGlobal1X128' }),
    ]),
  )

  const value = { feeGrowthGlobal0X128: g0, feeGrowthGlobal1X128: g1 }
  cache.global.set(key, value)
  return value
}

async function readTick(call: Caller, pool: Address, tick: number, cache: FeeReadCache): Promise<TickFeeGrowth> {
  const key = `${pool.toLowerCase()}:${tick}`
  const hit = cache.ticks.get(key)
  if (hit) return hit

  const result = await call('poolTicks', (client) =>
    client.readContract({ address: pool, abi: poolAbi, functionName: 'ticks', args: [tick] }),
  )

  /*
   * An uninitialized tick returns zeros, which is the correct input rather than
   * an error: `getFeeGrowthInside` treats zero growth-outside as "nothing has
   * accrued past this boundary", and a position whose boundary was never crossed
   * is exactly that case.
   */
  const value: TickFeeGrowth = { feeGrowthOutside0X128: result[2], feeGrowthOutside1X128: result[3] }
  cache.ticks.set(key, value)
  return value
}

export interface PositionFeeState extends UncollectedFees {
  /** Position liquidity as the chain reports it now. */
  liquidity: bigint
}

/**
 * Read everything needed and return what `collect()` would yield at this block.
 *
 * Read from `positions()` rather than from our stored copy: `liquidity` and
 * `feeGrowthInside*Last` must come from the same snapshot of state as
 * `tokensOwed`, or the delta is computed against a checkpoint the position has
 * already moved past. Our database copy is refreshed by a different loop on a
 * different cadence, and pairing the two would produce a figure that is not
 * wrong on any single read but drifts under exactly the conditions — an active
 * position in a busy pool — where the fee matters most.
 */
export async function readPositionFeeState(params: {
  call: Caller
  positionManager: Address
  poolAddress: Address
  tokenId: bigint
  tickLower: number
  tickUpper: number
  tickCurrent: number
  cache: FeeReadCache
}): Promise<PositionFeeState> {
  const { call, positionManager, poolAddress, tokenId, tickLower, tickUpper, tickCurrent, cache } = params

  const [position, global, lower, upper] = await Promise.all([
    call('positions', (client) =>
      client.readContract({ address: positionManager, abi: positionManagerAbi, functionName: 'positions', args: [tokenId] }),
    ),
    readFeeGrowthGlobal(call, poolAddress, cache),
    readTick(call, poolAddress, tickLower, cache),
    readTick(call, poolAddress, tickUpper, cache),
  ])

  const liquidity = position[7]
  const feeGrowthInside0LastX128 = position[8]
  const feeGrowthInside1LastX128 = position[9]
  const tokensOwed0 = position[10]
  const tokensOwed1 = position[11]

  const fees = uncollectedFees({
    tickLower,
    tickUpper,
    tickCurrent,
    feeGrowthGlobal0X128: global.feeGrowthGlobal0X128,
    feeGrowthGlobal1X128: global.feeGrowthGlobal1X128,
    lower,
    upper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    tokensOwed0,
    tokensOwed1,
  })

  return { ...fees, liquidity }
}
