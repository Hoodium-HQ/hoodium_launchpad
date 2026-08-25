/**
 * Sign-in endpoints — WA-1.6 to WA-1.9.
 *
 *   POST /api/auth/nonce   → server-issued, single-use, domain-bound message
 *   POST /api/auth/verify  → redeem it, receive an httpOnly session cookie
 *   POST /api/auth/logout  → revoke this session
 *   GET  /api/auth/me      → who am I
 */
import type { FastifyInstance } from 'fastify'
import { getAddress, isAddress } from 'viem'
import { z } from 'zod'
import { componentLogger } from '../lib/logger.js'
import { ChallengeError, consumeChallenge, issueChallenge, verifyChallengeSignature } from '../auth/siwe.js'
import { createSession, readSession, revokeAllSessions, revokeSession } from '../auth/session.js'
import { requireSession } from './guard.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: { env: Env; chain: ChainClient },
): Promise<void> {
  const { env, chain } = deps
  const log = componentLogger('auth')

  app.post('/api/auth/nonce', async (request, reply) => {
    const body = z.object({ address: z.string() }).safeParse(request.body)
    if (!body.success || !isAddress(body.data.address)) {
      return reply.status(400).send({ error: 'a valid address is required' })
    }

    const checksum = getAddress(body.data.address)
    const challenge = await issueChallenge(env, checksum.toLowerCase(), checksum)

    // The client signs `message` verbatim. It never composes one itself (WA-1.7).
    return {
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    }
  })

  app.post('/api/auth/verify', async (request, reply) => {
    const body = z
      .object({ nonce: z.string().min(8).max(128), signature: z.string().min(4).max(4096) })
      .safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: 'nonce and signature are required' })

    try {
      // Consumed first, so a wrong signature burns the nonce rather than
      // allowing unlimited attempts against one challenge.
      const challenge = await consumeChallenge(body.data.nonce)
      await verifyChallengeSignature(chain, challenge, body.data.signature)

      const session = await createSession(env, reply, challenge.address, request.headers['user-agent'])
      log.info({ wallet: challenge.address }, 'sign-in succeeded')

      return reply.status(200).send({
        address: session.address,
        expiresAt: session.expiresAt.toISOString(),
      })
    } catch (err) {
      if (err instanceof ChallengeError) {
        log.warn({ reason: err.reason }, 'sign-in rejected')
        // One message for every failure mode. Distinguishing "expired" from
        // "bad signature" tells an attacker which nonces are real.
        return reply.status(401).send({ error: 'sign-in failed', code: 'challenge_rejected' })
      }
      throw err
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    await revokeSession(request, reply)
    return { signedOut: true }
  })

  /** Sign out on every device — the shared-computer escape hatch. */
  app.post('/api/auth/logout-all', { preHandler: requireSession }, async (request, reply) => {
    const address = request.session!.address
    const revoked = await revokeAllSessions(address)
    await revokeSession(request, reply)
    return { signedOut: true, sessionsRevoked: revoked }
  })

  app.get('/api/auth/me', async (request) => {
    const session = await readSession(request)
    if (!session) return { authenticated: false, address: null }
    return {
      authenticated: true,
      address: session.address,
      expiresAt: session.expiresAt.toISOString(),
    }
  })
}
