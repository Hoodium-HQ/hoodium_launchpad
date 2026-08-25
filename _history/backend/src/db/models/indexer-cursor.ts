/**
 * Indexer cursor + reorg buffer — T2.1, T2.2 / AL-N6.
 *
 * `blockBuffer` is the rolling window of the last N block hashes (default 64,
 * design section 5). On a mismatched parent hash the indexer rewinds the cursor into
 * that window and re-scans; the unique index on `events` absorbs the overlap.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { blockNumber, chainId, hash32 } from '../fields.js'

const BlockRefSchema = new Schema(
  {
    number: blockNumber({ required: true }),
    hash: hash32({ required: true }),
    parentHash: hash32({ required: true }),
  },
  { _id: false },
)

const IndexerCursorSchema = new Schema(
  {
    chainId,
    /** Cursor name — one per logical stream, e.g. `position-manager`. */
    name: { type: String, required: true },

    lastProcessedBlock: blockNumber({ required: true }),
    /** Newest block the chain reported on the last poll. */
    chainHeadBlock: blockNumber(),
    /** lastProcessedBlock minus the confirmation depth (AL-N6). */
    finalizedThroughBlock: blockNumber(),

    blockBuffer: { type: [BlockRefSchema], default: [] },

    reorgCount: { type: Number, default: 0 },
    lastReorgAt: { type: Date, default: null },
    lastReorgDepth: { type: Number, default: null },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, collection: 'indexer_cursors' },
)

IndexerCursorSchema.index({ chainId: 1, name: 1 }, { unique: true })

export type IndexerCursor = InferSchemaType<typeof IndexerCursorSchema>
export type IndexerCursorDoc = HydratedDocument<IndexerCursor>
export const IndexerCursorModel = model('IndexerCursor', IndexerCursorSchema)
