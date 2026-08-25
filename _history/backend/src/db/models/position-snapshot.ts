/**
 * Exposure snapshots — T3.2 / AL-2.1, AL-2.3.
 *
 * Written at least every 60 seconds while a position is open. Every monetary value
 * is `Decimal128` (AL-2.3, AL-N4); raw token amounts stay strings.
 *
 * Stored as a MongoDB time-series collection: this collection is insert-only and
 * always queried as "the last N minutes for one position", which is precisely the
 * access pattern time-series buckets are for.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { blockNumber } from '../fields.js'
import { money, onChainAmount } from '../../lib/money.js'

const PositionSnapshotSchema = new Schema(
  {
    /** Time-series timeField. */
    at: { type: Date, required: true },
    /** Time-series metaField — the series identity, kept small on purpose. */
    meta: {
      positionKey: { type: String, required: true },
      ownerAddress: { type: String, required: true },
      chainId: { type: Number, required: true },
    },

    blockNumber: blockNumber({ required: true }),
    tickCurrent: { type: Number, required: true },
    sqrtPriceX96: onChainAmount({ required: true }),
    liquidity: onChainAmount({ required: true }),

    /** Token amounts the position currently holds, in smallest units. */
    amount0: onChainAmount({ required: true }),
    amount1: onChainAmount({ required: true }),
    /** Uncollected fees, same units. */
    fees0: onChainAmount(),
    fees1: onChainAmount(),

    /** Share of position value in the non-quote token, 0–100 (AL-2.2). */
    exposurePct: money({ required: true }),
    /** Position value denominated in the quote asset. */
    valueQuote: money({ required: true }),
    /** Pool price as token1-per-token0, decimal-adjusted. */
    price: money({ required: true }),

    inRange: { type: Boolean, required: true },
    /** Distance from the current price to each boundary, as a % of price. */
    distanceToLowerPct: money(),
    distanceToUpperPct: money(),
  },
  {
    timestamps: false,
    collection: 'position_snapshots',
    timeseries: { timeField: 'at', metaField: 'meta', granularity: 'seconds' },
    // Snapshots are operational telemetry; reports are recomputed from `events`
    // (AL-7.2), so nothing depends on keeping these forever.
    expireAfterSeconds: 60 * 60 * 24 * 90,
    autoCreate: true,
  },
)

// Time-series collections index the metaField/timeField pair for range scans.
PositionSnapshotSchema.index({ 'meta.positionKey': 1, at: -1 })
PositionSnapshotSchema.index({ 'meta.ownerAddress': 1, at: -1 })

export type PositionSnapshot = InferSchemaType<typeof PositionSnapshotSchema>
export type PositionSnapshotDoc = HydratedDocument<PositionSnapshot>
export const PositionSnapshotModel = model('PositionSnapshot', PositionSnapshotSchema)
