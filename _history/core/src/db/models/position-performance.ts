/**
 * What a position earned — the reporting view of 003 `WA-3.3`, materialised.
 *
 * ── Why this is a collection and not a function call ─────────────────────────
 * Every figure here is *derived*: recomputed from `events` plus the latest
 * snapshot, never accumulated (`AL-7.2`, `AL-8.3`). It could therefore be
 * computed on read, and for a single position it is cheap enough that it nearly
 * is. What it cannot be is *ranked* on read — a board over every open position
 * would mean one event scan per row per viewer.
 *
 * So this is a cache with a database behind it, and the distinction that matters
 * is that nothing here is a source of truth. Deleting the whole collection costs
 * one rebuild pass and loses no information, which is the property that makes it
 * safe to change the maths later: there is no migration, only a recompute.
 *
 * ── The two frames, and why they are separate columns ────────────────────────
 * `hodl*` / `impermanentLoss*` / `netVsHodl*` value every side at the *current*
 * price. They are exact and need no price history — see
 * `@hoodium/shared/performance`.
 *
 * `costBasis*` / `netPnl*` / `roiPct` price each deposit at the moment it
 * happened, recovered by inverting the mint amounts. They are exact when every
 * deposit landed inside the range and the record reaches the mint, and estimates
 * otherwise. `basisComplete` is which.
 *
 * Merging the two into one "PnL" is how a dashboard shows a green number to
 * someone who lost money, so they never merge.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId } from '../fields.js'
import { money, onChainAmount } from '../../lib/money.js'

const PositionPerformanceSchema = new Schema(
  {
    chainId,
    /** `positionKey()` — the same id snapshots, alerts and the fee ledger use. */
    positionKey: { type: String, required: true },
    ownerAddress: address({ required: true, index: true }),
    poolAddress: address({ required: true }),

    /** Mirrored from the position so the board can filter without a join. */
    status: { type: String, enum: ['open', 'closed'], required: true },

    // ── Raw ledger. Everything below is a valuation of these. ────────────────
    deposited0: onChainAmount({ required: true, default: '0' }),
    deposited1: onChainAmount({ required: true, default: '0' }),
    withdrawn0: onChainAmount({ required: true, default: '0' }),
    withdrawn1: onChainAmount({ required: true, default: '0' }),
    /** Fees earned over the position's life, collected and not (`AL-8.2` maths). */
    fees0: onChainAmount({ required: true, default: '0' }),
    fees1: onChainAmount({ required: true, default: '0' }),

    // ── Frame 1: against holding. Exact, one price for both sides. ───────────
    positionValueQuote: money(),
    withdrawnValueQuote: money(),
    hodlValueQuote: money(),
    impermanentLossQuote: money(),
    feesValueQuote: money(),
    netVsHodlQuote: money(),

    // ── Frame 2: against cost basis. Degrades; `basisComplete` says when. ────
    costBasisQuote: money(),
    realisedQuote: money(),
    netPnlQuote: money(),
    roiPct: money(),
    basisComplete: { type: Boolean, required: true, default: false },

    /**
     * Fee income annualised on cost basis. Null below the age floor in
     * `@hoodium/shared/performance` — a rate extrapolated from an afternoon
     * describes the afternoon, and ranking by it surfaces whatever launched
     * yesterday rather than whatever worked.
     */
    feeAprPct: money(),

    /**
     * Share of the *sampled* window spent in range, with the window alongside
     * it. Snapshots expire (90 days), so this can never be a lifetime figure and
     * the dates are what stop it being read as one.
     */
    timeInRangePct: money(),
    timeInRangeFrom: { type: Date, default: null },
    timeInRangeTo: { type: Date, default: null },
    timeInRangeSamples: { type: Number, default: 0 },

    /** First event we hold for this position. Its mint, when we indexed that far. */
    firstEventAt: { type: Date, default: null },
    firstEventBlock: blockNumber(),
    /**
     * Whether `Σ IncreaseLiquidity − Σ DecreaseLiquidity` equals the position's
     * live `liquidity`.
     *
     * This is a stronger test than looking for the mint. A truncated history
     * fails it, but so does a single event dropped in the middle — and the
     * second failure is the one no start-block check would ever catch. It costs
     * nothing extra: the two sums are already being taken to build the ledger.
     */
    ledgerComplete: { type: Boolean, required: true, default: false },

    /**
     * Whether this row may appear on the public board.
     *
     * False for an owner who opted out, for a pair with no quote side (nothing
     * is measurable), and for anything whose basis is incomplete — a ranking
     * that mixes totals with floors ranks the gaps in our index.
     */
    rankable: { type: Boolean, required: true, default: false },

    computedAt: { type: Date, required: true },
    /** Snapshot block the valuation was taken at, so a stale row is legible. */
    computedBlock: blockNumber(),
  },
  { timestamps: true, collection: 'position_performance' },
)

// One derived row per position — the upsert key for every rebuild.
PositionPerformanceSchema.index({ chainId: 1, positionKey: 1 }, { unique: true })
// The board's read path: rankable rows for a chain, ordered by one of the sorts.
PositionPerformanceSchema.index({ chainId: 1, rankable: 1, netVsHodlQuote: -1 })
PositionPerformanceSchema.index({ chainId: 1, rankable: 1, feeAprPct: -1 })
// The rebuild scans by staleness, exactly as the snapshot scheduler does.
PositionPerformanceSchema.index({ chainId: 1, computedAt: 1 })

export type PositionPerformance = InferSchemaType<typeof PositionPerformanceSchema>
export type PositionPerformanceDoc = HydratedDocument<PositionPerformance>
export const PositionPerformanceModel = model('PositionPerformance', PositionPerformanceSchema)
