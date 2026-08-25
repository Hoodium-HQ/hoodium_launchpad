/**
 * Token read routes — the explore page and the token page.
 *
 * Read-only and unauthenticated on purpose: a token page is the growth loop.
 * Every ordering is a plain sort on a measured column; there is no boost field
 * and no place to put one (LP-5.5).
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { HolderModel, TokenModel, TradeModel } from '../../db/models.js'
import { toBigInt } from '../../lib/amounts.js'
import { componentLogger } from '../../lib/logger.js'
import { loadCandles } from '../../services/candles.js'
import { fetchIpfsImage, fetchTokenMetadata } from '../../services/ipfs.js'
import type {
  CandlesResponse,
  HoldersResponse,
  PriceSeriesResponse,
  TokenDetailResponse,
  TokenListResponse,
  TokenListSort,
  TradesResponse,
} from '../../types.js'
import { addressSchema, escapeRegex, pageSchema, terms, type AppContext } from '../context.js'
import { serializeHolder, serializeTokenDetail, serializeTokenItem, serializeTrade } from '../serialize.js'

const log = componentLogger('tokens-api')

const SORTS = ['recent_buys', 'newest', 'oldest', 'market_cap', 'volume', 'progress', 'recent'] as const
const WINDOWS = ['all', '24h', '7d'] as const
const STATUSES = ['live', 'graduated', 'all'] as const

function sortSpec(sort: TokenListSort, window: (typeof WINDOWS)[number]): Record<string, 1 | -1> {
  switch (sort) {
    case 'recent_buys':
      return { lastBuyAt: -1, createdAtChain: -1 }
    case 'recent':
      return { lastTradeAt: -1, createdAtChain: -1 }
    case 'newest':
      return { createdAtChain: -1 }
    case 'oldest':
      return { createdAtChain: 1 }
    case 'market_cap':
      return { marketCapUsd: -1, createdAtChain: -1 }
    case 'progress':
      return { progressBps: -1, createdAtChain: -1 }
    case 'volume':
      return window === '24h'
        ? { volumeUsd24h: -1, createdAtChain: -1 }
        : window === '7d'
          ? { volumeUsd7d: -1, createdAtChain: -1 }
          : { volumeUsdAll: -1, createdAtChain: -1 }
  }
}

const SERIES_WINDOWS = { '1h': 1, '6h': 6, '1d': 24, '7d': 24 * 7, '30d': 24 * 30, all: 0 } as const

export async function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { env } = ctx

  app.get('/api/tokens', async (request, reply) => {
    const query = z
      .object({
        status: z.enum(STATUSES).default('all'),
        sort: z.enum(SORTS).default('recent_buys'),
        window: z.enum(WINDOWS).default('all'),
        q: z.string().trim().max(64).optional(),
        creator: addressSchema.optional(),
        ...pageSchema(100, 24).shape,
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })
    const { status, sort, window, q, creator, page, limit } = query.data

    const filter: Record<string, unknown> = { chainId: env.CHAIN_ID }
    if (status === 'live') filter.status = 'curve'
    if (status === 'graduated') filter.status = 'graduated'
    if (creator) filter.creator = creator
    if (q) {
      if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
        filter.$or = [{ tokenAddress: q.toLowerCase() }, { curveAddress: q.toLowerCase() }, { creator: q.toLowerCase() }]
      } else {
        const re = new RegExp(escapeRegex(q.toLowerCase()))
        filter.$or = [{ nameLower: re }, { symbolLower: re }]
      }
    }

    const [items, total, launched, graduated] = await Promise.all([
      TokenModel.find(filter)
        .sort(sortSpec(sort, window))
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TokenModel.countDocuments(filter),
      TokenModel.countDocuments({ chainId: env.CHAIN_ID }),
      TokenModel.countDocuments({ chainId: env.CHAIN_ID, status: 'graduated' }),
    ])

    const body: TokenListResponse = {
      items: items.map((t) => serializeTokenItem(t, window)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
      sort,
      window,
      status,
      counts: { launched, graduated, live: launched - graduated, matched: total },
    }
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=30')
    return body
  })

  app.get('/api/tokens/:address', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })

    const scope = { chainId: env.CHAIN_ID, tokenAddress: params.data.address }
    const token = await TokenModel.findOne(scope).lean()
    if (!token) return reply.status(404).send({ error: 'token not found', code: 'not_found' })

    // Self-healing metadata: fill in a document the indexer never managed to read.
    if (token.metadataURI && !token.metadata?.resolvedAt) {
      void fetchTokenMetadata(env.IPFS_GATEWAY_URL, token.metadataURI)
        .then((metadata) => {
          if (!metadata) return
          return TokenModel.updateOne(scope, {
            $set: {
              'metadata.description': metadata.description,
              'metadata.image': metadata.image,
              'metadata.x': metadata.x,
              'metadata.telegram': metadata.telegram,
              'metadata.website': metadata.website,
              'metadata.resolvedAt': new Date(),
            },
          })
        })
        .catch((err) => log.warn({ err, token: params.data.address }, 'lazy metadata resolve failed'))
    }

    const [launchTerms, ath] = await Promise.all([
      terms(ctx),
      TradeModel.aggregate<{ _id: null; ath: number }>([
        { $match: scope },
        { $group: { _id: null, ath: { $max: '$priceUsd' } } },
      ]),
    ])

    const body: TokenDetailResponse = {
      token: serializeTokenDetail(token, launchTerms, env.USDG_DECIMALS, { priceUsd: ath[0]?.ath ?? null }),
    }
    reply.header('cache-control', 'public, max-age=3, stale-while-revalidate=15')
    return body
  })

  app.get('/api/tokens/:address/trades', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })
    const query = z
      .object({ ...pageSchema(200, 50).shape, side: z.enum(['buy', 'sell']).optional(), trader: addressSchema.optional() })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })
    const { page, limit, side, trader } = query.data

    const filter: Record<string, unknown> = { chainId: env.CHAIN_ID, tokenAddress: params.data.address }
    if (side) filter.side = side
    if (trader) filter.trader = trader

    const [items, total] = await Promise.all([
      TradeModel.find(filter)
        .sort({ blockNumber: -1, logIndex: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      TradeModel.countDocuments(filter),
    ])
    const body: TradesResponse = { items: items.map(serializeTrade), page, limit, total, hasMore: page * limit < total }
    return body
  })

  app.get('/api/tokens/:address/holders', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })
    const query = pageSchema(200, 50).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })
    const { page, limit } = query.data

    const token = await TokenModel.findOne({ chainId: env.CHAIN_ID, tokenAddress: params.data.address })
      .select('creator curveAddress tokensSold')
      .lean()
    if (!token) return reply.status(404).send({ error: 'token not found', code: 'not_found' })

    const filter = { chainId: env.CHAIN_ID, tokenAddress: params.data.address, balance: { $ne: '0' } }
    const [items, total] = await Promise.all([
      HolderModel.find(filter)
        .sort({ balanceUnits: -1, holder: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      HolderModel.countDocuments(filter),
    ])

    const sold = toBigInt(token.tokensSold ?? '0')
    const body: HoldersResponse = {
      items: items.map((h) => serializeHolder(h, { creator: token.creator, curve: token.curveAddress, tokensSold: sold })),
      page,
      limit,
      total,
      hasMore: page * limit < total,
      basis: 'curve_trades',
      tokensSold: sold.toString(),
    }
    return body
  })

  app.get('/api/tokens/:address/candles', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })
    const query = z
      .object({
        interval: z.enum(['1m', '5m', '15m', '1h', '6h', '1d', 'all']).default('5m'),
        from: z.coerce.number().int().min(0).optional(),
        to: z.coerce.number().int().min(0).optional(),
        fill: z
          .string()
          .optional()
          .transform((s) => s !== '0' && s !== 'false'),
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })

    const exists = await TokenModel.exists({ chainId: env.CHAIN_ID, tokenAddress: params.data.address })
    if (!exists) return reply.status(404).send({ error: 'token not found', code: 'not_found' })

    const result = await loadCandles({
      chainId: env.CHAIN_ID,
      tokenAddress: params.data.address,
      interval: query.data.interval,
      from: query.data.from,
      to: query.data.to,
      fill: query.data.fill,
    })
    const body: CandlesResponse = result
    reply.header('cache-control', 'public, max-age=5, stale-while-revalidate=30')
    return body
  })

  /** Raw trade-by-trade price series — on a curve every trade is a price change. */
  app.get('/api/tokens/:address/price-series', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })
    const query = z
      .object({ window: z.enum(['1h', '6h', '1d', '7d', '30d', 'all']).default('1d') })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: 'invalid query', issues: query.error.issues })

    const hours = SERIES_WINDOWS[query.data.window]
    const filter: Record<string, unknown> = { chainId: env.CHAIN_ID, tokenAddress: params.data.address }
    if (hours > 0) filter.at = { $gte: new Date(Date.now() - hours * 3600 * 1000) }

    const rows = await TradeModel.find(filter).select('priceUsd at').sort({ blockNumber: 1, logIndex: 1 }).limit(5000).lean()
    const body: PriceSeriesResponse = {
      window: query.data.window,
      points: rows.map((r) => ({ t: Math.floor(new Date(r.at).getTime() / 1000), priceUsd: r.priceUsd ?? 0 })),
    }
    return body
  })

  /** Token artwork re-served from our origin; the IPFS ref comes from our indexed copy, never the request. */
  app.get('/api/tokens/:address/image', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: 'invalid address' })

    const token = await TokenModel.findOne({ chainId: env.CHAIN_ID, tokenAddress: params.data.address })
      .select('metadata.image')
      .lean()
    const image = await fetchIpfsImage(env.IPFS_GATEWAY_URL, token?.metadata?.image ?? null)
    if (!image) return reply.status(404).send({ error: 'no artwork for this token' })

    return reply
      .header('content-type', image.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(image.body)
  })
}
