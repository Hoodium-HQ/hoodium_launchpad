/**
 * Sign-in state — WA-1.6, WA-1.7, WA-1.8.
 *
 * Two short-lived collections. Neither ever holds key material (AL-1.6): a
 * challenge holds a message we generated, and a session holds the *hash* of a
 * token we generated. Both are useless to an attacker who reads the database —
 * the raw session token exists only in the user's cookie.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, chainId } from '../fields.js'

/**
 * The message the server issued and expects back, signed.
 *
 * WA-1.7 — the *server* composes the message. A client that supplies its own
 * message can claim any domain and any chain id, which is exactly the property
 * domain binding is supposed to provide. Nothing here is parsed from user input.
 */
const AuthChallengeSchema = new Schema(
  {
    nonce: { type: String, required: true },
    address: address({ required: true }),
    chainId,
    domain: { type: String, required: true },
    uri: { type: String, required: true },
    /** The exact bytes to be signed. Verification compares against this, not a rebuild. */
    message: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    /** Set the moment it is redeemed. Single-use is enforced by the atomic update. */
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'auth_challenges' },
)

AuthChallengeSchema.index({ nonce: 1 }, { unique: true })
// Challenges are worthless once expired; let Mongo sweep them.
AuthChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export type AuthChallenge = InferSchemaType<typeof AuthChallengeSchema>
export type AuthChallengeDoc = HydratedDocument<AuthChallenge>
export const AuthChallengeModel = model('AuthChallenge', AuthChallengeSchema)

/**
 * An authenticated session.
 *
 * WA-1.8 — the cookie is httpOnly, so JavaScript cannot read it; and only the
 * SHA-256 of the token is stored, so a database leak does not hand over live
 * sessions. Absolute expiry, no sliding renewal: a session that refreshes itself
 * forever is a session that never really expires.
 */
const SessionSchema = new Schema(
  {
    /** sha256(token), hex. The token itself is never persisted. */
    tokenHash: { type: String, required: true },
    address: address({ required: true }),
    chainId,
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: true, collection: 'sessions' },
)

SessionSchema.index({ tokenHash: 1 }, { unique: true })
SessionSchema.index({ address: 1, revokedAt: 1 })
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export type Session = InferSchemaType<typeof SessionSchema>
export type SessionDoc = HydratedDocument<Session>
export const SessionModel = model('Session', SessionSchema)
