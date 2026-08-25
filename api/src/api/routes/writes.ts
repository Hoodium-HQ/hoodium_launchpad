/**
 * The routes that write: metadata pinning, creator link edits, token chat.
 *
 * Chat and links carry a signed envelope (src/auth.ts). Pinning is
 * unauthenticated but rate-limited per IP and refused outright without a
 * PINATA_JWT — a launch form has nothing to sign for yet.
 */
import type { FastifyInstance } from 'fastify'
import { keccak256, toHex, type Address } from 'viem'
import { z } from 'zod'
import { verifySignedRequest } from '../../auth.js'
import { erc20Abi } from '../../chain/abi.js'
import { MessageModel, TokenModel } from '../../db/models.js'
import { componentLogger } from '../../lib/logger.js'
import { website } from '../../services/ipfs.js'
import {
  MAX_IMAGE_UPLOAD_BYTES,
  PinningFailedError,
  PinningUnavailableError,
  isPinningEnabled,
  pinImage,
  pinJson,
  sniffImageType,
} from '../../services/pinata.js'
import type { MessagesResponse, PinMetadataResponse } from '../../types.js'
import { LINK_RE, addressSchema, handleSchema, type AppContext } from '../context.js'
import { serializeMessage } from '../serialize.js'

const log = componentLogger('writes-api')

const signedSchema = z.object({
  address: addressSchema,
  issuedAt: z.coerce.number().int(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
})

const websiteSchema = z
  .string()
  .trim()
  .max(256)
  .transform((s) => (s.length === 0 ? null : website(s)))
  .nullable()

export async function registerWriteRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { env, chain } = ctx

  // ── Metadata pinning ─────────────────────────────────────────────────────

  app.post(
    '/api/metadata',
    {
      bodyLimit: 2 * MAX_IMAGE_UPLOAD_BYTES,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const pinata = { jwt: env.PINATA_JWT, apiUrl: env.PINATA_API_URL }
      if (!isPinningEnabled(pinata)) {
        return reply.status(503).send({ error: 'metadata pinning is not configured on this deployment', code: 'pinning_unavailable' })
      }

      const body = z
        .object({
          name: z.string().trim().min(1).max(64),
          symbol: z.string().trim().min(1).max(12),
          description: z.string().trim().max(256).optional(),
          x: handleSchema.optional(),
          telegram: handleSchema.optional(),
          website: websiteSchema.optional(),
          image: z.object({ contentType: z.string(), data: z.string().min(1) }).optional(),
        })
        .safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'invalid body', issues: body.error.issues })

      if (body.data.description && LINK_RE.test(body.data.description)) {
        return reply.status(400).send({ error: 'the description may not contain links', code: 'link_rejected' })
      }

      try {
        let imageUri: string | null = null
        if (body.data.image) {
          const bytes = Buffer.from(body.data.image.data, 'base64')
          if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
            return reply.status(400).send({ error: 'artwork must be between 1 byte and 1 MB', code: 'image_size' })
          }
          const sniffed = sniffImageType(bytes, body.data.image.contentType)
          if (!sniffed) {
            return reply.status(400).send({
              error: 'artwork must be a PNG, JPEG, WebP or GIF, and must match its declared type',
              code: 'image_type',
            })
          }
          imageUri = await pinImage(pinata, bytes, sniffed)
        }

        const uri = await pinJson(pinata, {
          name: body.data.name,
          symbol: body.data.symbol,
          description: body.data.description ?? null,
          image: imageUri,
          x: body.data.x ?? null,
          telegram: body.data.telegram ?? null,
          website: body.data.website ?? null,
        })
        const res: PinMetadataResponse = { uri, imageUri }
        return res
      } catch (err) {
        if (err instanceof PinningUnavailableError) {
          return reply.status(503).send({ error: 'pinning is not configured', code: 'pinning_unavailable' })
        }
        if (err instanceof PinningFailedError) {
          return reply.status(502).send({ error: err.message, code: 'pinning_failed' })
        }
        throw err
      }
    },
  )

  // ── Creator links ────────────────────────────────────────────────────────

  app.post(
    '/api/tokens/:address/links',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z.object({ address: addressSchema }).safeParse(request.params)
      if (!params.success) return reply.status(400).send({ error: 'invalid address' })
      const body = signedSchema
        .extend({ x: handleSchema.optional(), telegram: handleSchema.optional(), website: websiteSchema.optional() })
        .safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'invalid body', issues: body.error.issues })

      const token = await TokenModel.findOne({ chainId: env.CHAIN_ID, tokenAddress: params.data.address })
        .select('creator')
        .lean()
      if (!token) return reply.status(404).send({ error: 'token not found', code: 'not_found' })
      if (token.creator !== body.data.address) {
        return reply.status(403).send({ error: 'only the creator can edit these links', code: 'forbidden' })
      }

      const payload = keccak256(
        toHex(JSON.stringify({ x: body.data.x ?? null, telegram: body.data.telegram ?? null, website: body.data.website ?? null })),
      )
      const auth = await verifySignedRequest({
        action: 'links',
        chainId: env.CHAIN_ID,
        address: body.data.address,
        token: params.data.address,
        issuedAt: body.data.issuedAt,
        payload,
        signature: body.data.signature,
      })
      if (!auth.ok) return reply.status(401).send({ error: `signature ${auth.reason}`, code: auth.reason })

      await TokenModel.updateOne(
        { chainId: env.CHAIN_ID, tokenAddress: params.data.address },
        {
          $set: {
            'links.x': body.data.x ?? null,
            'links.telegram': body.data.telegram ?? null,
            'links.website': body.data.website ?? null,
            'links.updatedAt': new Date(),
          },
        },
      )
      return { x: body.data.x ?? null, telegram: body.data.telegram ?? null, website: body.data.website ?? null }
    },
  )

  // ── Token chat ───────────────────────────────────────────────────────────

  app.get('/api/tokens/:address/messages', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        /** ISO date or unix ms; returns messages strictly before it. */
        before: z.coerce.date().optional(),
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })

    const filter: Record<string, unknown> = { chainId: env.CHAIN_ID, tokenAddress: params.data.address }
    if (query.data.before) filter.at = { $lt: query.data.before }

    const rows = await MessageModel.find(filter)
      .sort({ at: -1 })
      .limit(query.data.limit + 1)
      .lean()
    const hasMore = rows.length > query.data.limit
    const body: MessagesResponse = {
      items: rows
        .slice(0, query.data.limit)
        .map((m) => serializeMessage(m))
        .reverse(),
      hasMore,
    }
    return body
  })

  /**
   * Gated on holding the token — the only moderation lever that costs an
   * attacker anything. Balance is read from the chain at post time, not from the
   * holder table, which would refuse someone transferred their tokens.
   */
  app.post(
    '/api/tokens/:address/messages',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z.object({ address: addressSchema }).safeParse(request.params)
      if (!params.success) return reply.status(400).send({ error: 'invalid address' })
      const body = signedSchema.extend({ body: z.string().trim().min(1).max(280) }).safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: 'invalid body', issues: body.error.issues })

      if (LINK_RE.test(body.data.body)) {
        return reply.status(400).send({ error: 'links are not allowed here', code: 'link_rejected' })
      }

      const token = await TokenModel.findOne({ chainId: env.CHAIN_ID, tokenAddress: params.data.address })
        .select('creator')
        .lean()
      if (!token) return reply.status(404).send({ error: 'token not found', code: 'not_found' })

      const auth = await verifySignedRequest({
        action: 'chat',
        chainId: env.CHAIN_ID,
        address: body.data.address,
        token: params.data.address,
        issuedAt: body.data.issuedAt,
        payload: keccak256(toHex(body.data.body)),
        signature: body.data.signature,
      })
      if (!auth.ok) return reply.status(401).send({ error: `signature ${auth.reason}`, code: auth.reason })

      const author = body.data.address
      let balance: bigint
      try {
        balance = await chain.call('balanceOf:chat', (client) =>
          client.readContract({
            address: params.data.address as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [author as Address],
          }),
        )
      } catch (err) {
        log.warn({ err, token: params.data.address }, 'chat balance check failed')
        // Fail closed: an unreadable chain is not permission to post.
        return reply.status(503).send({ error: 'could not verify your balance right now', code: 'chain_unreadable' })
      }

      const isCreator = token.creator === author
      if (balance <= 0n && !isCreator) {
        return reply.status(403).send({ error: 'only token holders can post here', code: 'not_a_holder' })
      }

      const created = await MessageModel.create({
        chainId: env.CHAIN_ID,
        tokenAddress: params.data.address,
        author,
        body: body.data.body,
        authorBalance: balance.toString(),
        isCreator,
        at: new Date(),
      })
      return reply.status(201).send({ posted: true, message: serializeMessage(created.toObject()) })
    },
  )
}
