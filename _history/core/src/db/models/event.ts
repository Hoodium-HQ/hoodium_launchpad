/**
 * On-chain events — T2.1 / AL-2.3, AL-7.2.
 *
 * The indexer writes here and interprets nothing (design section 1). Every reported
 * figure is recomputed from this collection rather than read from an aggregate
 * (AL-7.2), which is only safe if the collection is exactly-once.
 *
 * The unique index on `{chainId, txHash, logIndex}` is what makes re-indexing
 * after a reorg idempotent **by construction** (design section 5) — the rewind can
 * re-scan the same blocks and the duplicates are simply rejected.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId, hash32 } from '../fields.js'

const EventSchema = new Schema(
  {
    chainId,
    blockNumber: blockNumber({ required: true }),
    blockHash: hash32({ required: true }),
    txHash: hash32({ required: true }),
    logIndex: { type: Number, required: true, min: 0 },
    blockTimestamp: { type: Date, default: null },

    /** Emitting contract. */
    address: address({ required: true }),
    eventName: { type: String, required: true },
    /** Decoded args, with all uint256 values as strings (AL-N4). */
    args: { type: Schema.Types.Mixed, default: {} },

    /** Correlation, filled in where the event carries it. */
    ownerAddress: address(),
    positionKey: { type: String, default: null },
    tokenId: { type: String, default: null },

    /**
     * AL-N6 — an event is only final after 32 confirmations. Anything reading
     * events for money purposes filters on `finalized: true`.
     */
    finalized: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'events' },
)

// The exactly-once constraint. Everything else in the indexer leans on it.
EventSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true })
// Reorg rewind deletes/refreshes by block range; reporting reads by position.
EventSchema.index({ chainId: 1, blockNumber: 1 })
EventSchema.index({ positionKey: 1, blockNumber: 1 })
EventSchema.index({ ownerAddress: 1, blockNumber: -1 })
EventSchema.index({ chainId: 1, finalized: 1, blockNumber: 1 })

export type ChainEvent = InferSchemaType<typeof EventSchema>
export type ChainEventDoc = HydratedDocument<ChainEvent>
export const EventModel = model('Event', EventSchema)
