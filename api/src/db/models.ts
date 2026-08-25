/**
 * Collections.
 *
 * Every on-chain amount is a decimal string in base units — exact, never a
 * `Number`. Alongside the exact fields each token carries a handful of
 * floating-point *sort keys* (`marketCapUsd`, `volumeUsd24h`, …) which exist
 * only so the explore page can order and paginate at the database. They are
 * derived from the exact fields, never the other way round.
 *
 * Addresses and hashes are stored lowercase so index lookups never miss on
 * checksum casing.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument, type Model } from 'mongoose'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/
const INT_RE = /^-?\d+$/

function address(opts: { required?: boolean } = {}) {
  return {
    type: String,
    required: opts.required ?? false,
    lowercase: true,
    trim: true,
    validate: {
      validator: (v: string | null) => v == null || ADDRESS_RE.test(v.toLowerCase()),
      message: (p: { value: string }) => `"${p.value}" is not a 20-byte hex address`,
    },
  } as const
}

function hash32(opts: { required?: boolean } = {}) {
  return {
    type: String,
    required: opts.required ?? false,
    lowercase: true,
    trim: true,
    validate: {
      validator: (v: string | null) => v == null || HASH_RE.test(v.toLowerCase()),
      message: (p: { value: string }) => `"${p.value}" is not a 32-byte hex hash`,
    },
  } as const
}

/** Base-10 integer in base units. A JS number is refused at the setter. */
function amount(opts: { required?: boolean; default?: string } = {}) {
  return {
    type: String,
    required: opts.required ?? false,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    set(v: unknown) {
      if (v === null || v === undefined) return v
      if (typeof v === 'number') throw new TypeError('on-chain amounts must be strings or bigints, never numbers')
      if (typeof v === 'bigint') return v.toString()
      const s = String(v)
      if (!INT_RE.test(s)) throw new TypeError(`not an integer amount: ${s}`)
      return s
    },
  } as const
}

const blockNumber = (opts: { required?: boolean } = {}) =>
  ({ type: Number, required: opts.required ?? false, min: 0 }) as const

const chainId = { type: Number, required: true } as const

export const TOKEN_STATUSES = ['curve', 'graduated'] as const
export const TRADE_SIDES = ['buy', 'sell'] as const

// ── Tokens ──────────────────────────────────────────────────────────────────

const TokenSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    curveAddress: address({ required: true }),
    creator: address({ required: true }),

    /** Creator-supplied, stored verbatim; the client sanitises at render. */
    name: { type: String, required: true, maxlength: 128 },
    symbol: { type: String, required: true, maxlength: 32 },
    /** Lowercased copies for search. */
    nameLower: { type: String, default: '' },
    symbolLower: { type: String, default: '' },
    metadataURI: { type: String, default: null },

    metadata: {
      description: { type: String, default: null, maxlength: 512 },
      image: { type: String, default: null, maxlength: 256 },
      x: { type: String, default: null, maxlength: 64 },
      telegram: { type: String, default: null, maxlength: 64 },
      website: { type: String, default: null, maxlength: 256 },
      resolvedAt: { type: Date, default: null },
    },

    /** Creator-editable socials, off-chain overlay over the pinned document. */
    links: {
      x: { type: String, default: null, maxlength: 64 },
      telegram: { type: String, default: null, maxlength: 64 },
      website: { type: String, default: null, maxlength: 256 },
      updatedAt: { type: Date, default: null },
    },

    status: { type: String, enum: TOKEN_STATUSES, default: 'curve', required: true },

    /** Curve state after the latest indexed trade. Exact. */
    reserveUsdg: amount({ default: '0' }),
    tokensSold: amount({ default: '0' }),
    graduationTarget: amount({ default: '0' }),
    /** Quote base units per whole token, after the latest trade. */
    lastPrice: amount({ default: '0' }),
    progressBps: { type: Number, default: 0 },

    /** Dev buy at launch (LP-1.6), exact. */
    devBuyUsdg: amount({ default: '0' }),
    devBuyTokens: amount({ default: '0' }),

    /** Lifetime aggregates. Exact. */
    volumeUsdg: amount({ default: '0' }),
    buyVolumeUsdg: amount({ default: '0' }),
    sellVolumeUsdg: amount({ default: '0' }),
    feesUsdg: amount({ default: '0' }),
    creatorFeesClaimedUsdg: amount({ default: '0' }),
    tradeCount: { type: Number, default: 0 },
    buyCount: { type: Number, default: 0 },
    sellCount: { type: Number, default: 0 },
    holderCount: { type: Number, default: 0 },
    lastTradeAt: { type: Date, default: null },
    lastBuyAt: { type: Date, default: null },

    /** Sort keys, floating USD. Derived from the exact fields by the indexer. */
    priceUsd: { type: Number, default: 0 },
    marketCapUsd: { type: Number, default: 0 },
    fdvUsd: { type: Number, default: 0 },
    volumeUsdAll: { type: Number, default: 0 },
    volumeUsd24h: { type: Number, default: 0 },
    volumeUsd7d: { type: Number, default: 0 },
    trades24h: { type: Number, default: 0 },
    trades7d: { type: Number, default: 0 },
    statsRefreshedAt: { type: Date, default: null },

    /** Graduation outcome. */
    poolAddress: address(),
    graduatedAt: { type: Date, default: null },
    graduatedBlock: blockNumber(),
    graduationTxHash: hash32(),
    /** uint256 as a string; a Number rounds past 2^53. */
    lpTokenId: { type: String, default: null },
    graduationUsdgIn: amount({ default: '0' }),
    graduationTokensIn: amount({ default: '0' }),

    risk: {
      creatorSharePct: { type: String, default: '0' },
      creatorPriorLaunches: { type: Number, default: 0 },
      creatorPriorGraduations: { type: Number, default: 0 },
      hasConfusableSymbol: { type: Boolean, default: false },
      flags: { type: [String], default: [] },
      computedAt: { type: Date, default: null },
    },

    createdBlock: blockNumber({ required: true }),
    createdTxHash: hash32(),
    createdAtChain: { type: Date, required: true },
  },
  { timestamps: true, collection: 'tokens' },
)

TokenSchema.index({ chainId: 1, tokenAddress: 1 }, { unique: true })
TokenSchema.index({ chainId: 1, curveAddress: 1 }, { unique: true })
TokenSchema.index({ chainId: 1, creator: 1, createdAtChain: -1 })
TokenSchema.index({ chainId: 1, status: 1, createdAtChain: -1 })
TokenSchema.index({ chainId: 1, status: 1, lastBuyAt: -1 })
TokenSchema.index({ chainId: 1, status: 1, lastTradeAt: -1 })
TokenSchema.index({ chainId: 1, status: 1, marketCapUsd: -1 })
TokenSchema.index({ chainId: 1, status: 1, volumeUsdAll: -1 })
TokenSchema.index({ chainId: 1, status: 1, volumeUsd24h: -1 })
TokenSchema.index({ chainId: 1, status: 1, volumeUsd7d: -1 })
TokenSchema.index({ chainId: 1, createdBlock: 1 })
TokenSchema.index({ chainId: 1, nameLower: 1 })
TokenSchema.index({ chainId: 1, symbolLower: 1 })

export type Token = InferSchemaType<typeof TokenSchema>
export type TokenDoc = HydratedDocument<Token>
export const TokenModel = model('Token', TokenSchema)

// ── Trades ──────────────────────────────────────────────────────────────────

const TradeSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    curveAddress: address({ required: true }),
    trader: address({ required: true }),
    side: { type: String, enum: TRADE_SIDES, required: true },

    usdgAmount: amount({ required: true }),
    tokenAmount: amount({ required: true }),
    feeUsdg: amount({ default: '0' }),
    refundUsdg: amount({ default: '0' }),

    /** Curve state immediately after this trade. */
    reserveAfter: amount({ default: '0' }),
    tokensSoldAfter: amount({ default: '0' }),
    /** Quote base units per whole token. */
    priceUsdg: amount({ default: '0' }),
    /** Floats for candle aggregation only. */
    priceUsd: { type: Number, default: 0 },
    usdValue: { type: Number, default: 0 },

    blockNumber: blockNumber({ required: true }),
    txHash: hash32({ required: true }),
    logIndex: { type: Number, required: true, min: 0 },
    at: { type: Date, required: true },
    finalized: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'trades' },
)

TradeSchema.index({ chainId: 1, txHash: 1, logIndex: 1 }, { unique: true })
TradeSchema.index({ chainId: 1, tokenAddress: 1, blockNumber: -1, logIndex: -1 })
TradeSchema.index({ chainId: 1, tokenAddress: 1, at: 1 })
TradeSchema.index({ chainId: 1, trader: 1, blockNumber: 1, logIndex: 1 })
TradeSchema.index({ chainId: 1, blockNumber: 1 })
TradeSchema.index({ chainId: 1, at: -1 })
TradeSchema.index({ chainId: 1, finalized: 1, blockNumber: 1 })

export type Trade = InferSchemaType<typeof TradeSchema>
export const TradeModel = model('Trade', TradeSchema)

// ── Holders ─────────────────────────────────────────────────────────────────

/**
 * Reconstructed from curve trades only: a plain ERC-20 `transfer` is invisible
 * here. Everything derived from these says so (`basis: 'curve_trades'`).
 */
const HolderSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    holder: address({ required: true }),
    balance: amount({ required: true, default: '0' }),
    /** Sort key: balance as a float in whole tokens. */
    balanceUnits: { type: Number, default: 0 },
    /** Quote base units spent on buys / received on sells, lifetime. */
    boughtUsdg: amount({ default: '0' }),
    soldUsdg: amount({ default: '0' }),
    firstSeenAt: { type: Date, default: null },
    lastTradeAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'holders' },
)

HolderSchema.index({ chainId: 1, tokenAddress: 1, holder: 1 }, { unique: true })
HolderSchema.index({ chainId: 1, tokenAddress: 1, balanceUnits: -1 })
HolderSchema.index({ chainId: 1, holder: 1, balanceUnits: -1 })

export type Holder = InferSchemaType<typeof HolderSchema>
export const HolderModel = model('Holder', HolderSchema)

// ── Messages (token chat) ───────────────────────────────────────────────────

const MessageSchema = new Schema(
  {
    chainId,
    tokenAddress: address({ required: true }),
    author: address({ required: true }),
    body: { type: String, required: true, maxlength: 280 },
    authorBalance: amount({ default: '0' }),
    isCreator: { type: Boolean, default: false },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false, collection: 'messages' },
)

MessageSchema.index({ chainId: 1, tokenAddress: 1, at: -1 })
MessageSchema.index({ chainId: 1, author: 1, at: -1 })

export type Message = InferSchemaType<typeof MessageSchema>
export const MessageModel = model('Message', MessageSchema)

// ── Indexer cursor ──────────────────────────────────────────────────────────

const BlockRefSchema = new Schema(
  {
    number: blockNumber({ required: true }),
    hash: hash32({ required: true }),
    parentHash: hash32({ required: true }),
  },
  { _id: false },
)

const CursorSchema = new Schema(
  {
    chainId,
    name: { type: String, required: true },
    lastProcessedBlock: blockNumber({ required: true }),
    chainHeadBlock: blockNumber(),
    finalizedThroughBlock: blockNumber(),
    blockBuffer: { type: [BlockRefSchema], default: [] },
    reorgCount: { type: Number, default: 0 },
    lastReorgAt: { type: Date, default: null },
    lastReorgDepth: { type: Number, default: null },
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'indexer_cursors' },
)

CursorSchema.index({ chainId: 1, name: 1 }, { unique: true })

export type Cursor = InferSchemaType<typeof CursorSchema>
export type CursorDoc = HydratedDocument<Cursor>
export const CursorModel = model('IndexerCursor', CursorSchema)

export const models: Model<any>[] = [TokenModel, TradeModel, HolderModel, MessageModel, CursorModel]
