/**
 * Uniswap v3/v4 LP positions.
 *
 * `quoteIsToken0` is resolved once at discovery: exposure (AL-2.2) is the share of
 * value in the **non-quote** token, so every downstream calculation needs to know
 * which side of the pair is the stable one.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId, TokenSchema } from '../fields.js'
import { onChainAmount } from '../../lib/money.js'

export const POSITION_STATUSES = ['open', 'closed'] as const

const PositionSchema = new Schema(
  {
    chainId,
    /** NonfungiblePositionManager that minted this position. */
    positionManager: address({ required: true }),
    /** ERC-721 token id, as a string — it is a uint256 (AL-N4). */
    tokenId: { type: String, required: true },

    ownerAddress: address({ required: true, index: true }),
    poolAddress: address({ required: true }),

    token0: { type: TokenSchema, required: true },
    token1: { type: TokenSchema, required: true },
    fee: { type: Number, required: true },
    tickSpacing: { type: Number, default: null },

    tickLower: { type: Number, required: true },
    tickUpper: { type: Number, required: true },
    liquidity: onChainAmount({ required: true, default: '0' }),

    /** Which side of the pair is the quote asset (default USDG). */
    quoteIsToken0: { type: Boolean, required: true },
    /**
     * False when neither side of the pair is the configured quote asset. Such a
     * position is still shown to the user — hiding a position someone owns would
     * be worse than showing it — but exposure (AL-2.2) is undefined for it, so
     * the monitor records state without an exposure figure or a threshold alert.
     */
    quoteSupported: { type: Boolean, required: true, default: true },

    status: { type: String, enum: POSITION_STATUSES, default: 'open', required: true },

    /**
     * Discovery provenance. `source: 'index'` means our own indexer found it;
     * AL-1.2 requires we find positions the Uniswap `ListPositions` API omits,
     * which is exactly why we index `Transfer` rather than trusting that API.
     */
    source: { type: String, enum: ['index', 'manual'], default: 'index' },

    createdBlock: blockNumber(),
    closedBlock: blockNumber(),
    lastSyncedBlock: blockNumber(),
    lastSnapshotAt: { type: Date, default: null },

    /** AL-5.3 — 4-hour rebalance cooldown reads this. Written by Phase 5. */
    lastRebalanceAt: { type: Date, default: null },
    /**
     * When shadow mode last *decided* to rebalance this position.
     *
     * The cooldown (AL-5.3) anchors on this too while shadow mode is on. Without
     * it the shadow run has no cooldown at all — nothing ever executes, so
     * `lastRebalanceAt` stays null and the evaluator re-approves every minute.
     * The shadow record would then show a rebalance frequency the real system
     * would never produce, which is precisely the comparison AL-5.6 gates the
     * whole of Phase 5 on.
     */
    lastShadowRebalanceAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'positions' },
)

// A position is uniquely identified by its NFT (T1.2, unique constraint).
PositionSchema.index({ chainId: 1, positionManager: 1, tokenId: 1 }, { unique: true })
// The monitor's hot path: every open position for a wallet.
PositionSchema.index({ ownerAddress: 1, status: 1 })
// The snapshot scheduler scans by staleness.
PositionSchema.index({ status: 1, lastSnapshotAt: 1 })
PositionSchema.index({ poolAddress: 1 })

export type Position = InferSchemaType<typeof PositionSchema>
export type PositionDoc = HydratedDocument<Position>
export const PositionModel = model('Position', PositionSchema)

/** Stable string id used in alerts, snapshots and idempotency keys (design section 2). */
export function positionKey(p: Pick<Position, 'chainId' | 'positionManager' | 'tokenId'>): string {
  return `${p.chainId}:${p.positionManager}:${p.tokenId}`
}
