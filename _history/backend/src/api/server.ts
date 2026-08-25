import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { logger } from '../lib/logger.js'
import { captureError } from '../lib/sentry.js'
import { registerAuthRoutes } from './auth-routes.js'
import { registerLaunchpadRoutes } from './launchpad-routes.js'
import { registerLeaderboardRoutes } from './leaderboard-routes.js'
import { registerMarketRoutes } from './market-routes.js'
import { registerRoutes, type RouteDeps } from './routes.js'
import { registerTelegramRoutes } from './telegram-routes.js'
import type { Env } from '../config/env.js'

export async function buildServer(deps: RouteDeps): Promise<FastifyInstance> {
  const env: Env = deps.env

  const app = Fastify({
    // Share the scrubbing logger (AL-N3) rather than letting Fastify make its own.
    // pino's `Logger` and Fastify's `FastifyBaseLogger` differ only in optional
    // `msgPrefix`; the instance satisfies everything Fastify actually calls.
    loggerInstance: logger() as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 256 * 1024,
  })

  /*
   * Fastify rejects an empty body when `content-type: application/json` is set.
   * A `fetch` with a method and no body still sends that header, so POSTs like
   * `/api/auth/logout` — which legitimately carry nothing — would 500. Treat an
   * empty body as an empty object.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim()
    if (raw.length === 0) return done(null, {})
    try {
      done(null, JSON.parse(raw))
    } catch (err) {
      const error = err as Error & { statusCode?: number }
      error.statusCode = 400
      done(error, undefined)
    }
  })

  await app.register(cookie)

  /*
   * `credentials: true` is what lets the session cookie travel, and it makes the
   * origin list load-bearing: a wildcard origin with credentials is rejected by
   * browsers, and would be a CSRF hole if it were not. So the allowed origins are
   * always explicit — APP_ORIGIN plus anything in CORS_ORIGINS.
   */
  const allowedOrigins = Array.from(new Set([env.APP_ORIGIN, ...env.CORS_ORIGINS]))
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE'],
  })

  // Wallet registration triggers a full chain scan (AL-1.2); without a limit one
  // client can point the indexer at arbitrary addresses as fast as it can loop.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  })

  app.setErrorHandler((err: unknown, request, reply) => {
    request.log.error({ err }, 'unhandled request error')
    captureError(err, { url: request.url, method: request.method })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    // Never echo the error back: a stack trace can carry a connection string,
    // and AL-N3 does not stop at the log file.
    reply.status(status).send({ error: status >= 500 ? 'internal error' : 'request rejected' })
  })

  await registerAuthRoutes(app, { env, chain: deps.chain })
  await registerLaunchpadRoutes(app, { env, chain: deps.chain })
  await registerLeaderboardRoutes(app, { env })
  await registerMarketRoutes(app, { env, chain: deps.chain })
  await registerTelegramRoutes(app, { env })
  await registerRoutes(app, deps)
  return app
}
