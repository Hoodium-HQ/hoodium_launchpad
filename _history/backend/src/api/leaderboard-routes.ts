/**
 * Public LP leaderboard (landing page) plus the switch that keeps an address
 * off it.
 *
 * The read is deliberately unauthenticated: it is an aggregate over public
 * on-chain state and the landing page must render for a visitor with no wallet
 * (WA-1.3). The write is not — deciding whether an address appears is a
 * decision only its owner may make, so it carries `requireAddressOwner` like
 * every other address-scoped write (WA-1.6).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WalletModel } from '../db/models/wallet.js'
import { getLeaderboard, MAX_LIMIT } from '../leaderboard/lps.js'
import { requireAddressOwner } from './guard.js'
import type { Env } from '../config/env.js'

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((s) => s.toLowerCase())

export async function registerLeaderboardRoutes(
  app: FastifyInstance,
  deps: { env: Env },
): Promise<void> {
  const { env } = deps

  app.get('/api/leaderboard/lps', async (request, reply) => {
    const query = z
      .object({ limit: z.coerce.number().min(1).max(MAX_LIMIT).default(25) })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const board = await getLeaderboard(env.CHAIN_ID)

    return {
      lps: board.lps.slice(0, query.data.limit),
      total: board.total,
      quoteSymbol: env.QUOTE_TOKEN_SYMBOL,
      /*
       * Stated, not implied. We rank the LPs we index, and we only index
       * addresses that registered with us — a page that presented this as "the
       * top LPs on this chain" would be claiming a survey we never ran.
       */
      scope: 'registered',
      builtAt: new Date(board.builtAt).toISOString(),
    }
  })

  /**
   * Appear on the board, or do not. Idempotent, and it never creates a wallet:
   * an address with nothing to rank has nothing to hide either.
   */
  app.post(
    '/api/wallets/:address/leaderboard',
    { preHandler: requireAddressOwner },
    async (request, reply) => {
      const params = z.object({ address: addressSchema }).safeParse(request.params)
      if (!params.success) return reply.status(400).send({ error: params.error.issues })

      const body = z.object({ visible: z.boolean() }).safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: body.error.issues })

      await WalletModel.updateOne(
        { chainId: env.CHAIN_ID, address: params.data.address },
        { $set: { leaderboardOptOut: !body.data.visible } },
      )

      /*
       * The cached board can be up to a minute old, so the caller is told the
       * setting is saved — not that the page already reflects it. Busting the
       * cache here would let anyone force a rebuild by toggling a switch.
       */
      return { visible: body.data.visible }
    },
  )
}
