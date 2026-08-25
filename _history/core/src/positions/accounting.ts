/**
 * Fees earned — T7.3 / 001 `AL-8.2`, `AL-8.3`, design section 6a.
 *
 * `uncollectedFees` answers "what would `collect()` return". This file answers
 * the different and harder question the fee model actually bills against: **how
 * much has this position earned while we were managing it.**
 *
 * The two differ in two ways that both matter financially:
 *
 *   1. `tokensOwed` holds principal released by `decreaseLiquidity` alongside
 *      real fees. Billing against it charges the user a share of their own
 *      withdrawn capital every time they trim a position.
 *   2. Fees earned before enrolment are not ours to charge for.
 *
 * Hence:
 *
 *     earned = (Σ Collect − Σ DecreaseLiquidity)      over blocks after enrolment
 *            + (uncollectedNow − uncollectedAtEnrolment)
 *
 * Recomputed from scratch every cycle, never accumulated (`AL-8.3`). A per-cycle
 * delta double-charges on a retry and loses income on a missed cycle, and neither
 * is detectable afterwards.
 */
import { EventModel } from '../db/models/event.js'

/** Sums of the two event families, in smallest units. */
export interface EventTotals {
  collected0: bigint
  collected1: bigint
  decreased0: bigint
  decreased1: bigint
}

export interface LifetimeFeesInput extends EventTotals {
  /** `collect()` value now — fees *and* uncollected principal. */
  uncollected0: bigint
  uncollected1: bigint
  /** The same figure captured when the owner enrolled. */
  baseline0: bigint
  baseline1: bigint
}

export interface LifetimeFees {
  fees0: bigint
  fees1: bigint
}

/**
 * Fees earned since enrolment. Pure.
 *
 * Clamped at zero. A position can be enrolled at any point in its life and the
 * indexer only has history from `INDEXER_START_BLOCK`, so an incomplete event
 * record is a normal state rather than a corruption. Negative income is not a
 * meaningful quantity; the floor makes an incomplete record undercharge instead
 * of inverting into a refund.
 */
export function lifetimeFeesEarned(input: LifetimeFeesInput): LifetimeFees {
  const raw0 = input.collected0 - input.decreased0 + (input.uncollected0 - input.baseline0)
  const raw1 = input.collected1 - input.decreased1 + (input.uncollected1 - input.baseline1)
  return {
    fees0: raw0 > 0n ? raw0 : 0n,
    fees1: raw1 > 0n ? raw1 : 0n,
  }
}

/**
 * The platform's share, floor-divided.
 *
 * Rounding down is the direction that cannot be gamed against the user: the
 * remainder always stays with the LP. `002/design.md` rounds the *other* way for
 * the bonding curve, and the asymmetry is deliberate — there, rounding toward the
 * caller lets repeated dust trades drain a pool; here, rounding toward the
 * platform lets repeated dust accruals skim one.
 */
export function platformShare(fees: LifetimeFees, feeRateBps: number): LifetimeFees {
  const bps = BigInt(feeRateBps)
  return {
    fees0: (fees.fees0 * bps) / 10_000n,
    fees1: (fees.fees1 * bps) / 10_000n,
  }
}

/**
 * What is still owed after whatever Phase 5 has already settled.
 *
 * Floored at zero so a recomputation that lowers the accrual — a reorg, a late
 * `DecreaseLiquidity`, an indexer backfill — can never turn into a negative
 * charge, and a settlement can never be collected twice.
 */
export function outstandingFee(accrued: bigint, settled: bigint): bigint {
  const owed = accrued - settled
  return owed > 0n ? owed : 0n
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return 0n
}

/**
 * Sum `Collect` and `DecreaseLiquidity` for one position after a block.
 *
 * **The finality filter is deliberately asymmetric**, and it is the reason this
 * is one query per family rather than one aggregate over both.
 *
 * `uncollectedNow` is read at the chain head, so it already reflects the last 32
 * blocks. Pairing it with finalized-only events would mean an unfinalized
 * `decreaseLiquidity` shows up as a jump in `tokensOwed` with no matching
 * subtraction — the released principal would be billed as income until the event
 * finalized. So decreases count at any confirmation depth, while collections
 * count only once final.
 *
 * Both asymmetries err the same way: they understate what the platform is owed.
 * Undercharging corrects itself on the next cycle, because nothing here
 * accumulates. Overcharging a user does not correct itself.
 */
export async function sumPositionFeeEvents(params: {
  chainId: number
  positionKey: string
  afterBlock: number
}): Promise<EventTotals> {
  const { chainId, positionKey, afterBlock } = params

  const [collects, decreases] = await Promise.all([
    EventModel.find({
      chainId,
      positionKey,
      eventName: 'Collect',
      finalized: true,
      blockNumber: { $gt: afterBlock },
    })
      .select({ args: 1 })
      .lean(),
    EventModel.find({
      chainId,
      positionKey,
      eventName: 'DecreaseLiquidity',
      blockNumber: { $gt: afterBlock },
    })
      .select({ args: 1 })
      .lean(),
  ])

  const totals: EventTotals = { collected0: 0n, collected1: 0n, decreased0: 0n, decreased1: 0n }

  for (const e of collects) {
    const args = (e.args ?? {}) as Record<string, unknown>
    totals.collected0 += toBigInt(args.amount0)
    totals.collected1 += toBigInt(args.amount1)
  }
  for (const e of decreases) {
    const args = (e.args ?? {}) as Record<string, unknown>
    totals.decreased0 += toBigInt(args.amount0)
    totals.decreased1 += toBigInt(args.amount1)
  }

  return totals
}
