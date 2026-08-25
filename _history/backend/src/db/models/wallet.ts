/**
 * Watched wallets — T1.3 (multi-tenant), AL-1.1.
 *
 * "WHEN a user submits a wallet address THEN the system SHALL register it in
 * watch-only mode and SHALL NOT request any credential."
 *
 * Registration therefore takes an address and nothing else. There is no field on
 * this document that could hold a key, and AL-1.6 means there never will be.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId } from '../fields.js'

export const WALLET_MODES = ['watch_only', 'automated'] as const
export const BACKFILL_STATES = ['pending', 'running', 'complete', 'failed'] as const

const WalletSchema = new Schema(
  {
    chainId,
    address: address({ required: true }),
    label: { type: String, default: null },

    /**
     * Phases 1–3 only ever write `watch_only`. Moving to `automated` requires an
     * EIP-7702 grant (AL-1.3) which is Phase 5 work.
     */
    mode: { type: String, enum: WALLET_MODES, default: 'watch_only', required: true },

    /** Position discovery within 60s of registration (AL-1.2). */
    backfill: {
      state: { type: String, enum: BACKFILL_STATES, default: 'pending' },
      startedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
      fromBlock: blockNumber(),
      toBlock: blockNumber(),
      error: { type: String, default: null },
    },

    /**
     * Read health (AL-2.5). Two consecutive failed monitoring cycles suspend all
     * automated execution for this wallet until reads recover — degraded reads
     * must never produce confident actions.
     */
    monitoring: {
      consecutiveFailures: { type: Number, default: 0 },
      lastSuccessAt: { type: Date, default: null },
      lastFailureAt: { type: Date, default: null },
      executionSuspended: { type: Boolean, default: false },
      suspendedReason: { type: String, default: null },
    },

    /**
     * Excludes this address from the public LP leaderboard.
     *
     * Everything the leaderboard shows is derivable from the chain by anyone, so
     * the default is to appear. But there is a difference between "discoverable"
     * and "published next to a dollar figure on a landing page", and the owner
     * is the only one who gets to decide which side of it they are on.
     */
    leaderboardOptOut: { type: Boolean, default: false },

    /** AL-4.8 — daily automated transaction cap, counted per UTC day. */
    dailyTxCount: { type: Number, default: 0 },
    dailyTxCountDate: { type: String, default: null }, // YYYY-MM-DD, UTC

    disabledAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'wallets' },
)

// One document per address per chain (T1.2).
WalletSchema.index({ chainId: 1, address: 1 }, { unique: true })
// The monitor's work queue: every active wallet on this chain.
WalletSchema.index({ chainId: 1, disabledAt: 1 })
WalletSchema.index({ 'backfill.state': 1 })

export type Wallet = InferSchemaType<typeof WalletSchema>
export type WalletDoc = HydratedDocument<Wallet>
export const WalletModel = model('Wallet', WalletSchema)
