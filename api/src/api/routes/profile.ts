import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { buildActivity, buildProfile } from '../../services/portfolio.js'
import type { ProfileActivityResponse, ProfileResponse } from '../../types.js'
import { addressSchema, terms, type AppContext } from '../context.js'

export async function registerProfileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { env, chain } = ctx

  app.get('/api/profile/:address', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })

    const body: ProfileResponse = await buildProfile({
      chainId: env.CHAIN_ID,
      address: params.data.address,
      chain,
      terms: await terms(ctx),
      usdgDecimals: env.USDG_DECIMALS,
      tokenDecimals: env.TOKEN_DECIMALS,
    })
    return body
  })

  app.get('/api/profile/:address/activity', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })

    const body: ProfileActivityResponse = {
      entries: await buildActivity({
        chainId: env.CHAIN_ID,
        address: params.data.address,
        limit: query.data.limit,
        usdgDecimals: env.USDG_DECIMALS,
      }),
    }
    return body
  })
}
