/**
 * Session lifecycle — WA-1.8.
 *
 * The cookie carries a random token; the database stores only its SHA-256. A
 * leaked database therefore yields no usable sessions, and the token is
 * `httpOnly` so no script on the page can read it either.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { SessionModel } from '../db/models/auth.js'
import { hashToken, newSessionToken } from './siwe.js'
import type { Env } from '../config/env.js'
import { isDeployed } from '../config/env.js'

export const SESSION_COOKIE = 'hoodium_session'

export interface SessionIdentity {
  address: string
  expiresAt: Date
}

export function sessionTtlMs(env: Env): number {
  return env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000
}

export async function createSession(
  env: Env,
  reply: FastifyReply,
  walletAddress: string,
  userAgent?: string,
): Promise<SessionIdentity> {
  const token = newSessionToken()
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + sessionTtlMs(env))

  await SessionModel.create({
    tokenHash: hashToken(token),
    address: walletAddress.toLowerCase(),
    chainId: env.CHAIN_ID,
    issuedAt,
    expiresAt,
    userAgent: userAgent ?? null,
  })

  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, // WA-1.8 — unreadable from JavaScript
    // `strict` over `lax`: nothing in this app is meant to be reached by
    // following a link from another site while authenticated.
    sameSite: 'strict',
    secure: isDeployed(env), // plain http on localhost would otherwise drop it
    path: '/',
    maxAge: Math.floor(sessionTtlMs(env) / 1000),
    signed: false, // the token is already unguessable; signing adds nothing
  })

  return { address: walletAddress.toLowerCase(), expiresAt }
}

/** Resolve the caller's session, or `null`. Never throws — callers decide. */
export async function readSession(request: FastifyRequest): Promise<SessionIdentity | null> {
  const token = request.cookies[SESSION_COOKIE]
  if (!token) return null

  const session = await SessionModel.findOne({
    tokenHash: hashToken(token),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
  if (!session) return null

  // Best-effort activity stamp; a failure here must not fail the request.
  void SessionModel.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {})

  return { address: session.address, expiresAt: session.expiresAt }
}

export async function revokeSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE]
  if (token) {
    await SessionModel.updateOne({ tokenHash: hashToken(token) }, { $set: { revokedAt: new Date() } })
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

/** Sign out everywhere — used when a wallet disconnects from a shared machine. */
export async function revokeAllSessions(walletAddress: string): Promise<number> {
  const result = await SessionModel.updateMany(
    { address: walletAddress.toLowerCase(), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  )
  return result.modifiedCount
}
