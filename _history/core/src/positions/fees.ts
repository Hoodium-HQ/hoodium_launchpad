/**
 * Fee ledger lifecycle — T7.4, T7.5 / 001 `R8`.
 *
 * Owns `fee_accruals`: when a ledger opens, what it records each cycle, and what
 * happens when an owner leaves.
 *
 * **Ledgers open lazily, on the first monitor cycle after enrolment.** The API
 * route only flips the wallet flag, because capturing a baseline needs four chain
 * reads and the monitor is already holding them behind a per-cycle cache. The
 * cost is that up to one cycle of fees is earned after enrolment but before the
 * baseline is taken, and is therefore never billed. That is the safe direction,
 * and paying for it buys a fee system with no chain access in the HTTP path.
 */
import Decimal from 'decimal.js'
import { componentLogger } from '../lib/logger.js'
import { toDecimal128 } from '../lib/money.js'
import { FeeAccrualModel, type FeeAccrualDoc } from '../db/models/fee-accrual.js'
import { lifetimeFeesEarned, outstandingFee, platformShare, sumPositionFeeEvents } from './accounting.js'
import type { UncollectedFees } from './feemath.js'

const log = componentLogger('fees')

/** The slice of config this module reads. Keeps it testable without a full `Env`. */
export interface FeeConfig {
  AUTO_LP_FEE_ENABLED: boolean
  AUTO_LP_FEE_BPS: number
  SHADOW_MODE: boolean
}

export interface AccrueParams {
  config: FeeConfig
  chainId: number
  positionKey: string
  ownerAddress: string
  /** Whether the owner has opted in right now (`AL-8.1`). */
  enrolled: boolean
  /** Rate agreed at the wallet's enrolment; falls back to the configured rate. */
  walletFeeRateBps?: number | null
  /** What `collect()` would return at `blockNumber`. */
  uncollected: Pick<UncollectedFees, 'fees0' | 'fees1'>
  blockNumber: number
  /** Optional valuation inputs for the display estimate. */
  quote?: QuoteContext
}

export interface QuoteContext {
  /** token1 per token0, decimal-adjusted — `position_snapshots.price`. */
  price: Decimal
  quoteIsToken0: boolean
  decimals0: number
  decimals1: number
}

export interface AccrualSummary {
  accruedFee0: bigint
  accruedFee1: bigint
  outstanding0: bigint
  outstanding1: bigint
  billable: boolean
}

/**
 * Why this accrual is not billable, or `null` if it is.
 *
 * Separated out because `AL-8.5` is about the *reason* being recorded, not just
 * the flag. A row that says `false` with no explanation forces whoever reads the
 * collection later to reconstruct which switch was off at the time.
 */
export function nonBillableReason(config: FeeConfig): string | null {
  if (!config.AUTO_LP_FEE_ENABLED) return 'AUTO_LP_FEE_ENABLED=false — this deployment does not charge a fee'
  if (config.SHADOW_MODE) return 'shadow mode — nothing has been managed, so nothing is billable (AL-8.5)'
  return null
}

/**
 * Recompute one position's ledger. Returns `null` when the owner is not enrolled.
 *
 * Idempotent by construction: every figure is derived from finalized events plus
 * the current chain state (`AL-8.3`), so running it twice at the same block
 * writes the same numbers. Nothing here is `$inc`.
 */
export async function accruePositionFee(params: AccrueParams): Promise<AccrualSummary | null> {
  const { config, chainId, positionKey, ownerAddress, enrolled, uncollected, blockNumber } = params

  let ledger = await FeeAccrualModel.findOne({ chainId, positionKey })

  if (!enrolled) {
    /*
     * Opting out freezes the ledger where it stands rather than deleting it.
     * Fees already earned under the agreement were still earned, and a user who
     * leaves and returns should not find the record of what they owe gone.
     */
    if (ledger && !ledger.unenrolledAt) {
      ledger.unenrolledAt = new Date()
      await ledger.save()
      log.info({ positionKey }, 'fee ledger frozen — owner is no longer enrolled')
    }
    return null
  }

  const rate = params.walletFeeRateBps ?? config.AUTO_LP_FEE_BPS

  if (!ledger) {
    ledger = await openLedger({ chainId, positionKey, ownerAddress, rate, uncollected, blockNumber })
  } else if (ledger.unenrolledAt) {
    reopenLedger(ledger, { rate, uncollected, blockNumber })
  }

  const totals = await sumPositionFeeEvents({ chainId, positionKey, afterBlock: ledger.baselineBlock ?? 0 })

  const lifetime = lifetimeFeesEarned({
    ...totals,
    uncollected0: uncollected.fees0,
    uncollected1: uncollected.fees1,
    baseline0: BigInt(ledger.baselineFees0 ?? '0'),
    baseline1: BigInt(ledger.baselineFees1 ?? '0'),
  })

  const share = platformShare(lifetime, ledger.feeRateBps)

  // Periods before an opt-out are carried, not recomputed — their baseline is gone.
  const accrued0 = share.fees0 + BigInt(ledger.carriedFee0 ?? '0')
  const accrued1 = share.fees1 + BigInt(ledger.carriedFee1 ?? '0')

  const reason = nonBillableReason(config)

  ledger.lifetimeFees0 = lifetime.fees0.toString()
  ledger.lifetimeFees1 = lifetime.fees1.toString()
  ledger.accruedFee0 = accrued0.toString()
  ledger.accruedFee1 = accrued1.toString()
  ledger.billable = reason === null
  ledger.nonBillableReason = reason
  ledger.lastAccruedAt = new Date()
  ledger.lastAccruedBlock = blockNumber

  const outstanding0 = outstandingFee(accrued0, BigInt(ledger.settledFee0 ?? '0'))
  const outstanding1 = outstandingFee(accrued1, BigInt(ledger.settledFee1 ?? '0'))

  if (params.quote) {
    const value = valueInQuote({ amount0: outstanding0, amount1: outstanding1 }, params.quote)
    // The schema's setter would accept the string; go through toDecimal128 so the
    // AL-N4 rejection is the one that fires, not a mongoose cast error.
    if (value) ledger.accruedFeeQuote = toDecimal128(value.toFixed(), 'accruedFeeQuote')
  }

  await ledger.save()

  return { accruedFee0: accrued0, accruedFee1: accrued1, outstanding0, outstanding1, billable: reason === null }
}

async function openLedger(params: {
  chainId: number
  positionKey: string
  ownerAddress: string
  rate: number
  uncollected: Pick<UncollectedFees, 'fees0' | 'fees1'>
  blockNumber: number
}): Promise<FeeAccrualDoc> {
  const { chainId, positionKey, ownerAddress, rate, uncollected, blockNumber } = params

  /*
   * The baseline is what makes the fee a charge for *management* rather than a
   * claim on the position's whole history. A position enrolled after a year of
   * earning owes nothing for that year.
   */
  const created = await FeeAccrualModel.create({
    chainId,
    positionKey,
    ownerAddress,
    feeRateBps: rate,
    enrolledAt: new Date(),
    baselineBlock: blockNumber,
    baselineFees0: uncollected.fees0.toString(),
    baselineFees1: uncollected.fees1.toString(),
  })

  log.info({ positionKey, feeRateBps: rate, baselineBlock: blockNumber }, 'fee ledger opened')
  return created
}

/**
 * Re-enrolment after an opt-out.
 *
 * The old period's accrual moves into `carriedFee` and the baseline is retaken at
 * today's uncollected balance. Without the carry, re-enrolling would recompute
 * from a fresh baseline and silently forgive everything owed from before; without
 * retaking the baseline, fees earned *while opted out* would be billed.
 */
function reopenLedger(
  ledger: FeeAccrualDoc,
  params: { rate: number; uncollected: Pick<UncollectedFees, 'fees0' | 'fees1'>; blockNumber: number },
): void {
  ledger.carriedFee0 = (BigInt(ledger.carriedFee0 ?? '0') + BigInt(ledger.accruedFee0 ?? '0')).toString()
  ledger.carriedFee1 = (BigInt(ledger.carriedFee1 ?? '0') + BigInt(ledger.accruedFee1 ?? '0')).toString()
  ledger.unenrolledAt = null
  ledger.enrolledAt = new Date()
  ledger.feeRateBps = params.rate
  ledger.baselineBlock = params.blockNumber
  ledger.baselineFees0 = params.uncollected.fees0.toString()
  ledger.baselineFees1 = params.uncollected.fees1.toString()

  log.info({ positionKey: ledger.positionKey, feeRateBps: params.rate }, 'fee ledger reopened')
}

/**
 * Both fee sides expressed in the quote asset. `null` when there is no price.
 *
 * A display estimate only — the ledger is the raw token pair. Settlement moves
 * token0 and token1, so converting them to one number here and treating that as
 * the debt would bake in whatever the price happened to be on some cycle.
 */
export function valueInQuote(
  amounts: { amount0: bigint; amount1: bigint },
  quote: QuoteContext,
): Decimal | null {
  if (!quote.price.isFinite() || quote.price.lte(0)) return null

  const human0 = new Decimal(amounts.amount0.toString()).div(new Decimal(10).pow(quote.decimals0))
  const human1 = new Decimal(amounts.amount1.toString()).div(new Decimal(10).pow(quote.decimals1))

  // `price` is token1 per token0.
  return quote.quoteIsToken0 ? human0.plus(human1.div(quote.price)) : human1.plus(human0.times(quote.price))
}
