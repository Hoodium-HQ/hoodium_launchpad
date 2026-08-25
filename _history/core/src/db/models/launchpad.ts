/**
 * Launchpad collections — T3.2 / spec 002.
 *
 * The indexer writes here from launchpad contract events. As with Auto LP, every
 * monetary value is `Decimal128` and every raw on-chain amount is a string
 * (AL-N4 / LP-N8) — a bonding curve's whole point is exact arithmetic, and it
 * would be absurd to preserve that on-chain and then round it in Mongo.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId, hash32 } from '../fields.js'
import { money, onChainAmount } from '../../lib/money.js'

export const TOKEN_STATUSES = ['curve', 'graduated'] as const
export const TRADE_SIDES = ['buy', 'sell'] as const

const LaunchpadTokenSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    curveAddress: address({ required: true }),
    creator: address({ required: true, index: true }),

    // Creator-supplied and therefore attacker-controlled (WA-N3). Stored raw;
    // sanitisation happens at render time, never here — mangling it on the way in
    // would make the stored value disagree with the chain.
    name: { type: String, required: true, maxlength: 128 },
    symbol: { type: String, required: true, maxlength: 32 },
    metadataURI: { type: String, default: null }, // LP-1.7

    /**
     * The metadata document, resolved once from IPFS and cached here.
     *
     * Resolved at index time rather than at read time because the discovery feed
     * renders 50 cards and would otherwise make 50 gateway round-trips per view.
     * `resolvedAt: null` with a non-null `metadataURI` means we have not managed
     * to read it yet — which the API reports as "no description", never as an
     * empty one.
     */
    metadata: {
      description: { type: String, default: null, maxlength: 512 },
      /** `ipfs://…`; re-parsed before anything fetches it (launchpad/ipfs.ts). */
      image: { type: String, default: null, maxlength: 256 },
      x: { type: String, default: null, maxlength: 64 },
      telegram: { type: String, default: null, maxlength: 64 },
      resolvedAt: { type: Date, default: null },
    },

    /**
     * Creator-editable socials, kept off-chain.
     *
     * `metadataURI` is immutable once launched — the whole point of recording it
     * on-chain — so a creator who moves their Telegram has no way to correct the
     * pinned document. These fields override the resolved ones at render, and are
     * writable only by the creator's own signed session.
     */
    links: {
      x: { type: String, default: null, maxlength: 64 },
      telegram: { type: String, default: null, maxlength: 64 },
      updatedAt: { type: Date, default: null },
    },

    status: { type: String, enum: TOKEN_STATUSES, default: 'curve', required: true },

    /** Curve state, refreshed from events and periodic reads. */
    reserveUsdg: money({ default: '0' }),
    tokensSold: onChainAmount({ default: '0' }),
    graduationTarget: money({ default: '0' }),
    /** 0–10000. Basis points rather than a float, so it never drifts. */
    progressBps: { type: Number, default: 0 },

    /** Rolling aggregates for ranking (LP-5.2). Recomputed, never trusted blindly. */
    volumeUsdg: money({ default: '0' }),
    volumeUsdg24h: money({ default: '0' }),
    tradeCount: { type: Number, default: 0 },
    holderCount: { type: Number, default: 0 },
    lastTradeAt: { type: Date, default: null },

    /** Graduation outcome (LP-4.5). */
    poolAddress: address(),
    graduatedAt: { type: Date, default: null },
    graduationTxHash: hash32(),
    /**
     * The locked LP position's NFT id (T0.4). A string, because it is a uint256
     * and a Number would silently round one past 2^53.
     *
     * Kept so the token page can show accrued pool fees without scanning the
     * locker's whole inventory to find which position backs this token. The
     * browser reads the fees from the chain itself — LP-N7 requires the claim
     * path to work with our servers down — so this is a pointer, never a figure.
     */
    lpTokenId: { type: String, default: null },
    /** LP-6.1 — marks this pool as Auto LP inventory once it exists. */
    registeredAsCandidate: { type: Boolean, default: false },

    /** Creator risk flags (LP-5.4). Computed, with the inputs kept for display. */
    risk: {
      creatorSharePct: money(),
      creatorPriorLaunches: { type: Number, default: 0 },
      creatorPriorGraduations: { type: Number, default: 0 },
      hasConfusableSymbol: { type: Boolean, default: false },
      flags: { type: [String], default: [] },
      computedAt: { type: Date, default: null },
    },

    createdBlock: blockNumber(),
    createdAtChain: { type: Date, default: null },
  },
  { timestamps: true, collection: 'launchpad_tokens' },
)

// One document per token per chain.
LaunchpadTokenSchema.index({ chainId: 1, tokenAddress: 1 }, { unique: true })
LaunchpadTokenSchema.index({ chainId: 1, curveAddress: 1 }, { unique: true })
// The discovery surface: newest first, and each ranking axis (LP-5.2).
LaunchpadTokenSchema.index({ chainId: 1, createdAtChain: -1 })
LaunchpadTokenSchema.index({ chainId: 1, status: 1, progressBps: -1 })
LaunchpadTokenSchema.index({ chainId: 1, status: 1, lastTradeAt: -1 })
LaunchpadTokenSchema.index({ chainId: 1, volumeUsdg24h: -1 })
LaunchpadTokenSchema.index({ creator: 1, createdAtChain: -1 })

export type LaunchpadToken = InferSchemaType<typeof LaunchpadTokenSchema>
export type LaunchpadTokenDoc = HydratedDocument<LaunchpadToken>
export const LaunchpadTokenModel = model('LaunchpadToken', LaunchpadTokenSchema)

const LaunchpadTradeSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    curveAddress: address({ required: true }),
    trader: address({ required: true }),
    side: { type: String, enum: TRADE_SIDES, required: true },

    usdgAmount: money({ required: true }),
    tokenAmount: onChainAmount({ required: true }),
    feeUsdg: money({ default: '0' }),

    /** Curve state immediately after this trade — what the chart plots. */
    reserveAfter: money({ default: '0' }),
    priceUsdg: money({ default: '0' }),

    blockNumber: blockNumber({ required: true }),
    txHash: hash32({ required: true }),
    logIndex: { type: Number, required: true, min: 0 },
    at: { type: Date, default: null },

    /**
     * design.md section 5 — the feed broadcasts on unconfirmed events and
     * reconciles at finality. The UI renders unconfirmed rows at reduced opacity;
     * a row that silently vanished after a reorg would read as a bug and erode
     * trust in every number on the page.
     */
    finalized: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'launchpad_trades' },
)

// Exactly-once, same constraint the Auto LP events collection relies on (AL-N6).
LaunchpadTradeSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true })
LaunchpadTradeSchema.index({ tokenAddress: 1, blockNumber: -1 })
LaunchpadTradeSchema.index({ tokenAddress: 1, at: -1 })
LaunchpadTradeSchema.index({ trader: 1, at: -1 })
LaunchpadTradeSchema.index({ chainId: 1, blockNumber: 1 })

export type LaunchpadTrade = InferSchemaType<typeof LaunchpadTradeSchema>
export type LaunchpadTradeDoc = HydratedDocument<LaunchpadTrade>
export const LaunchpadTradeModel = model('LaunchpadTrade', LaunchpadTradeSchema)

/** Holder balances, maintained from trades so holder count is cheap (LP-5.2). */
const LaunchpadHolderSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    holder: address({ required: true }),
    balance: onChainAmount({ required: true, default: '0' }),
    firstSeenAt: { type: Date, default: null },
    lastTradeAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'launchpad_holders' },
)

LaunchpadHolderSchema.index({ chainId: 1, tokenAddress: 1, holder: 1 }, { unique: true })
LaunchpadHolderSchema.index({ tokenAddress: 1, balance: -1 })

export type LaunchpadHolder = InferSchemaType<typeof LaunchpadHolderSchema>
export const LaunchpadHolderModel = model('LaunchpadHolder', LaunchpadHolderSchema)

/**
 * Token chat.
 *
 * Posting is gated on holding the token, which is the only moderation lever that
 * costs an attacker anything: an address with no position can be minted for free,
 * one holding the token cannot. `authorBalance` records what that stake was at
 * post time — a message from someone who has since sold still shows what they
 * held when they said it, which is the information a reader actually wants.
 *
 * `body` is attacker-controlled and stored verbatim (WA-N3). Links are refused at
 * the write, not stripped at render: a stripped link leaves a message that reads
 * as if it said something it did not.
 */
const LaunchpadMessageSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    author: address({ required: true }),
    body: { type: String, required: true, maxlength: 280 },
    authorBalance: onChainAmount({ default: '0' }),
    /** Denormalised so a long thread does not need one token lookup per row. */
    isCreator: { type: Boolean, default: false },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: { createdAt: false, updatedAt: false }, collection: 'launchpad_messages' },
)

LaunchpadMessageSchema.index({ chainId: 1, tokenAddress: 1, at: -1 })
LaunchpadMessageSchema.index({ author: 1, at: -1 })

export type LaunchpadMessage = InferSchemaType<typeof LaunchpadMessageSchema>
export const LaunchpadMessageModel = model('LaunchpadMessage', LaunchpadMessageSchema)
