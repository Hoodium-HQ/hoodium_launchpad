/**
 * Pools discovered from chain activity — 003 R7.
 *
 * `R7` originally took Uniswap's hosted gateway as the universe of pools, on the
 * grounds that it "already indexes this chain". It does index it — asked for a
 * pool by id, the gateway answers in full — but its `topV4Pools` list is not
 * that universe. Asked for 100 it returns 83, and pools well above the smallest
 * one it does return are simply absent. A pool at $48k TVL earning 6,361% APR
 * was invisible on a surface whose entire purpose is ranking by APR.
 *
 * So the universe is recovered from the chain instead, and the signal is
 * **swap activity, not pool creation**. That distinction is the whole design:
 *
 *   - ~4,600 v4 pools are created on this chain every day, almost all dust that
 *     never crosses the TVL floor. Tracking creation would accumulate ~140k rows
 *     a month and ask the gateway about each one.
 *   - ~177 distinct pools trade in any six-minute window. That is bounded, it is
 *     cheap to read, and it is what "top pools" means — pools being traded, not
 *     pools that once existed.
 *
 * A row here is a claim that a pool traded recently, nothing more. TVL, volume
 * and fees still come from the gateway; this only decides which pools are worth
 * asking about.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { blockNumber, chainId, hash32 } from '../fields.js'

const PoolSchema = new Schema(
  {
    chainId,

    /**
     * v4 pool id — the keccak of the pool key, as it appears in the `Swap`
     * event's first indexed topic and in the gateway's `v4Pool(poolId:)`.
     */
    poolId: hash32({ required: true }),

    /** Only v4 is discovered this way; v3 pools are addresses and come from the factory. */
    version: { type: String, enum: ['v4'], default: 'v4' },

    /** Where the most recent swap was seen. Advances with the discovery cursor. */
    lastSwapBlock: blockNumber({ required: true }),
    lastSwapAt: { type: Date, required: true },

    /**
     * Swaps counted in the most recent scan window. A rate, not a total — it is
     * overwritten each pass rather than accumulated, because its only job is to
     * rank which pools are worth an enrichment call this cycle. A lifetime
     * counter would keep long-dead pools near the top forever.
     */
    swapsInWindow: { type: Number, default: 0 },

    /** First time this pool was seen trading. Never moves once set. */
    firstSeenBlock: blockNumber({ required: true }),
  },
  { timestamps: true, collection: 'pools' },
)

/**
 * One row per pool per chain. The discovery pass upserts against this, so a
 * pool that trades in every window is written repeatedly and never duplicated.
 */
PoolSchema.index({ chainId: 1, poolId: 1 }, { unique: true })

/** The read the market surface makes: most recently active first. */
PoolSchema.index({ chainId: 1, lastSwapBlock: -1 })

export type Pool = InferSchemaType<typeof PoolSchema>
export type PoolDoc = HydratedDocument<Pool>
export const PoolModel = model<Pool>('Pool', PoolSchema)
