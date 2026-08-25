/**
 * Telegram delivery links — T3.9, T3.10 / AL-3.5, AL-3.8, AL-3.9.
 *
 * Two documents, deliberately separate:
 *
 *   TelegramLink       an established address → chat_id binding, long-lived
 *   TelegramLinkToken  a single-use claim on that binding, minutes-lived
 *
 * They are split because they have opposite security properties. A link is
 * durable and idempotent to re-read; a token is a **bearer credential** — whoever
 * presents it to the bot receives that address's alerts from then on. Keeping the
 * two in one document would mean the long-lived row carries a secret field for
 * its whole life.
 *
 * Tokens are stored as SHA-256 digests for the same reason session tokens are:
 * the plaintext exists only in the QR code and the user's Telegram client, so a
 * database disclosure yields nothing replayable.
 */
import { createHash, randomBytes } from 'node:crypto'
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, chainId } from '../fields.js'

/** Why a link stopped delivering. `blocked` and `chat_deleted` are terminal (AL-3.9). */
export const LINK_INACTIVE_REASONS = ['blocked', 'chat_deleted', 'revoked'] as const

const TelegramLinkSchema = new Schema(
  {
    chainId,
    ownerAddress: address({ required: true }),

    /**
     * Telegram chat ids exceed 2^32 and, for some chat types, approach the edge of
     * IEEE-754 integer safety. Stored as a string so no arithmetic is ever
     * performed on one and no precision can be lost in transit.
     */
    chatId: { type: String, required: true },
    /** Display only — `@name` is mutable in Telegram and never used as a key. */
    username: { type: String, default: null },

    /**
     * WA-6.5 — alert types the user does not want in Telegram. Server-side by
     * necessity: with Web Push the service worker could drop a payload before it
     * was shown, but a Telegram message is already delivered by the time any
     * client could filter it. Muting is therefore a send-time decision here.
     *
     * Stored as an opt-out list so a newly introduced alert type is delivered by
     * default rather than silently withheld from everyone who linked earlier.
     */
    mutedTypes: { type: [String], default: [] },

    linkedAt: { type: Date, default: () => new Date() },
    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    failureCount: { type: Number, default: 0 },

    /**
     * Set when Telegram reports the recipient unreachable, or when the user
     * revokes from settings. A row is kept rather than deleted so the web app can
     * explain *why* delivery stopped (WA-6.9) instead of silently showing
     * "not connected".
     */
    inactiveAt: { type: Date, default: null },
    inactiveReason: { type: String, enum: LINK_INACTIVE_REASONS, default: null },
  },
  { timestamps: true, collection: 'telegram_links' },
)

/*
 * One active link per address per chain. The partial filter is what makes it
 * "one *active*": revoked rows stay for their explanatory value, and a user who
 * relinks after being blocked must not collide with their own dead row.
 */
TelegramLinkSchema.index(
  { chainId: 1, ownerAddress: 1 },
  { unique: true, partialFilterExpression: { inactiveAt: null } },
)
// The send path: every active link for an address.
TelegramLinkSchema.index({ ownerAddress: 1, inactiveAt: 1 })
/*
 * Not unique. One person may watch several wallets from a single Telegram
 * account, and forbidding that would be a limitation with no security value —
 * each link still required its own address proof (AL-3.8).
 */
TelegramLinkSchema.index({ chatId: 1 })

export type TelegramLink = InferSchemaType<typeof TelegramLinkSchema>
export type TelegramLinkDoc = HydratedDocument<TelegramLink>
export const TelegramLinkModel = model('TelegramLink', TelegramLinkSchema)

// ── Link tokens ──────────────────────────────────────────────────────────────

/**
 * Telegram truncates the `start` deep-link payload at 64 characters and accepts
 * only `[A-Za-z0-9_-]`. 32 random bytes is 43 base64url characters — comfortably
 * inside both limits, and 256 bits against a guessing attack that would otherwise
 * redirect someone else's position alerts to the guesser's chat.
 */
const TOKEN_BYTES = 32

const TelegramLinkTokenSchema = new Schema(
  {
    chainId,
    ownerAddress: address({ required: true }),

    /** SHA-256 of the token. The plaintext is never written down here. */
    tokenHash: { type: String, required: true },

    expiresAt: { type: Date, required: true },
    /** Single use (AL-3.8): set on redemption, and checked before honouring one. */
    consumedAt: { type: Date, default: null },
    consumedByChatId: { type: String, default: null },
  },
  { timestamps: true, collection: 'telegram_link_tokens' },
)

TelegramLinkTokenSchema.index({ tokenHash: 1 }, { unique: true })
TelegramLinkTokenSchema.index({ ownerAddress: 1, createdAt: -1 })
/*
 * Mongo reaps expired tokens on its own. Expiry is still enforced in the redeem
 * path rather than trusted to this index — the TTL monitor runs about once a
 * minute, so a token is readable for up to a minute past its expiry.
 */
TelegramLinkTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export type TelegramLinkToken = InferSchemaType<typeof TelegramLinkTokenSchema>
export const TelegramLinkTokenModel = model('TelegramLinkToken', TelegramLinkTokenSchema)

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function generateLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}
