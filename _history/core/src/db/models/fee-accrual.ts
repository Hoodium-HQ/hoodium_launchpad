/**
 * Performance-fee ledger — T7.4 / 001 `R8`, design section 2.
 *
 * One document per enrolled position. It is the record of what the platform has
 * earned for managing that position, and it is the only place in this codebase
 * where a figure exists that Hoodium would eventually ask a user to pay. That
 * makes two properties non-negotiable:
 *
 *   1. **Nothing here is accumulated.** `lifetimeFees` and `accruedFee` are
 *      recomputed from finalized events plus chain state on every cycle
 *      (`AL-8.3`). A running total cannot be audited, and a retry silently
 *      doubles it.
 *   2. **The rate is captured, not referenced.** `feeRateBps` is written once at
 *      enrolment (`AL-8.4`). Reading the environment variable at charge time
 *      would let a config change re-price fees that were already earned, which is
 *      the difference between a price and a claim.
 *
 * Raw token amounts, never the quote valuation, are the ledger. `accruedFeeQuote`
 * exists so the UI has something to render and is explicitly an estimate at one
 * price at one instant — it is never what gets settled.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId } from '../fields.js'
import { money, onChainAmount } from '../../lib/money.js'

const FeeAccrualSchema = new Schema(
  {
    chainId,
    /** `positionKey()` — the stable id used across alerts, snapshots and events. */
    positionKey: { type: String, required: true },
    ownerAddress: address({ required: true, index: true }),

    /**
     * The rate in force for this position, fixed at enrolment (`AL-8.4`).
     * `AUTO_LP_FEE_MAX_BPS` bounds it at boot; this field is what makes a later
     * change to the configured rate apply to new enrolments only.
     */
    feeRateBps: { type: Number, required: true, min: 0, max: 10_000 },
    enrolledAt: { type: Date, required: true },
    unenrolledAt: { type: Date, default: null },

    /**
     * Enrolment baseline. Fees the position had already earned before anyone
     * agreed to pay for management are not ours, so every figure below is
     * measured *from here* rather than from the position's mint.
     */
    baselineBlock: blockNumber({ required: true }),
    baselineFees0: onChainAmount({ required: true, default: '0' }),
    baselineFees1: onChainAmount({ required: true, default: '0' }),

    /** Fees earned since the baseline. Recomputed, never incremented. */
    lifetimeFees0: onChainAmount({ required: true, default: '0' }),
    lifetimeFees1: onChainAmount({ required: true, default: '0' }),

    /**
     * Accrual from *earlier* enrolment periods, carried across an opt-out.
     *
     * Opting out retakes the baseline on re-enrolment, so the previous period's
     * figure is no longer recomputable — the events it was derived from now sit
     * before the new baseline block. Carrying it is what stops a user from
     * clearing what they owe by toggling enrolment off and on.
     */
    carriedFee0: onChainAmount({ required: true, default: '0' }),
    carriedFee1: onChainAmount({ required: true, default: '0' }),

    /** The platform's share of the above, floor-divided, plus anything carried. */
    accruedFee0: onChainAmount({ required: true, default: '0' }),
    accruedFee1: onChainAmount({ required: true, default: '0' }),

    /** Written by Phase 5 settlement (T7.8). Nothing lowers these but a payment. */
    settledFee0: onChainAmount({ required: true, default: '0' }),
    settledFee1: onChainAmount({ required: true, default: '0' }),

    /**
     * Display estimate of the outstanding fee in the quote asset, at the price of
     * the most recent accrual. Not the ledger, and never settled against.
     */
    accruedFeeQuote: money(),

    /**
     * `AL-8.5` — false while shadow mode is on.
     *
     * Nothing has been managed, so nothing is billable. The accrual is still
     * computed, because the whole point of the shadow period is to find out what
     * the fee model would have produced before committing to it. A row that is
     * both recorded and unbillable is the honest representation of that.
     */
    billable: { type: Boolean, required: true, default: false },
    /** Why, in words, so the state is legible without reading the config. */
    nonBillableReason: { type: String, default: null },

    lastAccruedAt: { type: Date, default: null },
    lastAccruedBlock: blockNumber(),
  },
  { timestamps: true, collection: 'fee_accruals' },
)

// One ledger per position (design section 2).
FeeAccrualSchema.index({ chainId: 1, positionKey: 1 }, { unique: true })
// The owner's fee summary, and the monitor's enrolled-position filter.
FeeAccrualSchema.index({ ownerAddress: 1, unenrolledAt: 1 })

export type FeeAccrual = InferSchemaType<typeof FeeAccrualSchema>
export type FeeAccrualDoc = HydratedDocument<FeeAccrual>
export const FeeAccrualModel = model('FeeAccrual', FeeAccrualSchema)
