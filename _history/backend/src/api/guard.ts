/**
 * Route guards — WA-1.6.
 *
 * "WHEN a user requests data scoped to an address THEN the system SHALL require
 *  proof of control of that address before returning it."
 *
 * Note what is *not* guarded: `POST /api/wallets`. AL-1.1 says registration
 * requires no credential, and that stays true. Registering an address is a
 * public, watch-only act; reading its alert history is not.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { readSession, type SessionIdentity } from '../auth/session.js'
import { componentLogger } from '../lib/logger.js'

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionIdentity | null
  }
}

/** Attach the session when present. Does not reject — for mixed-access routes. */
export async function attachSession(request: FastifyRequest): Promise<void> {
  request.session = await readSession(request)
}

/** Reject anonymous callers. */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await readSession(request)
  if (!session) {
    await reply.status(401).send({ error: 'sign-in required', code: 'unauthenticated' })
    return
  }
  request.session = session
}

/**
 * Reject callers who are not the address in the route.
 *
 * The response is 403 with no detail about whether that address exists or holds
 * positions — an error that distinguishes "not yours" from "not found" is an
 * address-enumeration oracle.
 */
export async function requireAddressOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await readSession(request)
  if (!session) {
    await reply.status(401).send({ error: 'sign-in required', code: 'unauthenticated' })
    return
  }

  const params = request.params as { address?: string }
  const requested = params.address?.toLowerCase()

  if (!requested || requested !== session.address) {
    componentLogger('api').warn(
      { session: session.address, requested },
      'rejected cross-address read (WA-1.6)',
    )
    await reply.status(403).send({ error: 'not your address', code: 'forbidden' })
    return
  }

  request.session = session
}
