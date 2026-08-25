/**
 * Boot.
 *
 *   1. Validate env — fail fast, before any socket opens.
 *   2. Verify the RPC serves CHAIN_ID (a wrong endpoint must never index the
 *      wrong chain into the right database).
 *   3. Connect Mongo, sync indexes.
 *   4. Listen — the platform health check must not wait on the indexer.
 *   5. Start the indexer (idles when LAUNCHPAD_FACTORY is unset).
 */
import { ChainClient } from './chain/client.js'
import { loadEnv } from './config/env.js'
import { connectDb, disconnectDb, ensureIndexes } from './db/connect.js'
import { LaunchpadIndexer } from './indexer/indexer.js'
import { buildServer } from './api/server.js'
import { componentLogger, initLogger } from './lib/logger.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const log = initLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY })

  const chain = new ChainClient({ rpcUrl: env.RPC_URL, chainId: env.CHAIN_ID, timeoutMs: env.RPC_TIMEOUT_MS })
  await chain.verify()

  await connectDb(env.MONGO_URI, env.MONGO_DB_NAME)
  await ensureIndexes()

  const indexer = new LaunchpadIndexer(env, chain)
  const app = await buildServer({ env, chain, indexerStatus: () => indexer.status(), startedAt: Date.now() })
  await app.listen({ port: env.PORT, host: env.HOST })
  log.info(
    { port: env.PORT, host: env.HOST, chainId: env.CHAIN_ID, factory: env.LAUNCHPAD_FACTORY ?? '(unset)' },
    'launchpad api listening',
  )

  await indexer.start()

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutting down')
    indexer.stop()
    await app.close().catch((err) => log.error({ err }, 'error closing http'))
    await disconnectDb().catch((err) => log.error({ err }, 'error closing mongo'))
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', (reason) => componentLogger('process').error({ err: reason }, 'unhandled rejection'))
  process.on('uncaughtException', (err) => {
    componentLogger('process').fatal({ err }, 'uncaught exception — exiting')
    process.exit(1)
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
