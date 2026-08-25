import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { CursorModel } from '../db/models.js'
import { dbReady } from '../db/connect.js'
import { CURSOR_NAME } from '../indexer/indexer.js'
import { isPinningEnabled } from '../services/pinata.js'
import type { ConfigResponse, HealthResponse } from '../types.js'
import { terms, type AppContext } from './context.js'
import { registerProfileRoutes } from './routes/profile.js'
import { registerTokenRoutes } from './routes/tokens.js'
import { registerWriteRoutes } from './routes/writes.js'

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const { env } = ctx
  const app: FastifyInstance = Fastify({
    // Fastify's own request/response lines log at info; `warn` keeps per-request
    // noise out of production logs while still surfacing failures.
    logger: { level: env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace' ? env.LOG_LEVEL : 'warn', base: { service: 'launchpad-api', component: 'http' } },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  })

  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / curl requests carry no Origin header; allow them.
      if (!origin) return cb(null, true)
      cb(null, env.CORS_ORIGINS.includes(origin) || env.CORS_ORIGINS.includes('*'))
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  })

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
  })

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) request.log.error({ err, url: request.url }, 'request failed')
    reply.status(status).send({ error: status >= 500 ? 'internal error' : err.message, code: err.code })
  })

  app.get('/health', async () => {
    const status = ctx.indexerStatus()
    let lastProcessed = status.lastProcessedBlock
    let head = status.chainHeadBlock
    let lastRunAt = status.lastRunAt
    let lastError = status.lastError
    if (dbReady() && lastProcessed === null) {
      const cursor = await CursorModel.findOne({ chainId: env.CHAIN_ID, name: CURSOR_NAME }).lean().catch(() => null)
      if (cursor) {
        lastProcessed = cursor.lastProcessedBlock
        head = cursor.chainHeadBlock ?? null
        lastRunAt = cursor.lastRunAt ?? null
        lastError = cursor.lastError ?? null
      }
    }
    const body: HealthResponse = {
      ok: dbReady(),
      service: 'hoodium-launchpad-api',
      chainId: env.CHAIN_ID,
      factoryConfigured: env.LAUNCHPAD_FACTORY !== null,
      db: dbReady() ? 'up' : 'down',
      indexer: {
        enabled: status.enabled,
        running: status.running,
        lastProcessedBlock: lastProcessed,
        chainHeadBlock: head,
        lag: lastProcessed !== null && head !== null ? Math.max(0, head - lastProcessed) : null,
        lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
        lastError,
      },
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
    }
    return body
  })

  app.get('/api/config', async (_request, reply) => {
    const body: ConfigResponse = {
      chainId: env.CHAIN_ID,
      factoryAddress: env.LAUNCHPAD_FACTORY,
      usdgAddress: env.USDG_ADDRESS,
      usdgDecimals: env.USDG_DECIMALS,
      tokenDecimals: env.TOKEN_DECIMALS,
      appOrigin: env.APP_ORIGIN,
      pinningEnabled: isPinningEnabled({ jwt: env.PINATA_JWT, apiUrl: env.PINATA_API_URL }),
      terms: await terms(ctx),
    }
    reply.header('cache-control', 'public, max-age=60')
    return body
  })

  await registerTokenRoutes(app, ctx)
  await registerProfileRoutes(app, ctx)
  await registerWriteRoutes(app, ctx)

  return app
}
