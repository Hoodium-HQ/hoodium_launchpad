/**
 * Boot — 001 design section 7, 004 section 3.
 *
 * Five long-lived components in one Node process. Not serverless: nonce
 * assignment is centralised (design section 5) and subscriptions are long-lived.
 * Phases 1–3 run three of the five (Indexer, Monitor, Notifier); the Evaluator
 * and Executor arrive with shadow mode and execution.
 *
 * Boot order is not arbitrary. The mainnet guard runs before anything else can
 * open a connection or start a job — "a guard that runs after the job queue
 * starts has already lost" (004 section 3).
 */
import { loadEnv, setEnvForTesting } from './config/env.js'
import { assertConfiguredChain } from './config/chain-guard.js'
import { initLogger, componentLogger } from './lib/logger.js'
import { initSentry, flushSentry, captureError } from './lib/sentry.js'
import { connectDb, disconnectDb, ensureIndexes } from './db/connect.js'
import { initKillSwitch, killSwitch } from './lib/kill-switch.js'
import { initTelegram } from './notify/telegram.js'
import { ChainClient } from './chain/rpc.js'
import { ensureLocalChain } from './dev/local-chain.js'
import { Indexer } from './indexer/indexer.js'
import { LaunchpadIndexer } from './launchpad/indexer.js'
import { Monitor } from './monitor/monitor.js'
import { PositionDiscovery } from './positions/discovery.js'
import { buildServer } from './api/server.js'

async function main(): Promise<void> {
  // 1. Configuration. No defaults for anything environment-identifying (004 section 9).
  const env = loadEnv()
  setEnvForTesting(env)

  const log = initLogger({ level: env.LOG_LEVEL, pretty: env.APP_ENV === 'local' })

  // 2. The mainnet guard, static half — before any socket is opened.
  assertConfiguredChain(env)
  log.info({ appEnv: env.APP_ENV, chainId: env.CHAIN_ID }, 'configured chain accepted')

  initSentry({ dsn: env.SENTRY_DSN, environment: env.APP_ENV })

  // 3. Local only: start a node if the loopback RPC has nothing on it. After the
  //    static guard, which must precede every socket this process opens, and
  //    before the live guard, which is what would otherwise fail. A no-op in
  //    every other environment (dev/local-chain.ts).
  const localChain = await ensureLocalChain(env)

  // 4. The mainnet guard, live half — both endpoints, because the fallback is a
  //    second place a wrong endpoint can enter (004 section 3).
  const chain = new ChainClient(env)
  await chain.verifyBothEndpoints()

  // 5. Storage, with the unique constraints the indexer and dedupe rely on.
  await connectDb(env.MONGO_URI, env.MONGO_DB_NAME)
  await ensureIndexes()

  // 6. Kill switch before any worker — a switch that starts after the workers do
  //    has a window in which it cannot stop them (AL-N8).
  const ks = initKillSwitch(env.KILL_SWITCH)
  await ks.start()
  if (ks.isEngaged()) {
    log.warn({ reason: ks.getReason() }, 'kill switch is engaged at boot — execution halted')
  }

  initTelegram({
    botToken: env.TELEGRAM_BOT_TOKEN,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    appOrigin: env.APP_ORIGIN,
  })

  // 7. Workers.
  const indexer = new Indexer(env, chain)
  const monitor = new Monitor(env, chain)
  const discovery = new PositionDiscovery(env, chain)
  const launchpadIndexer = new LaunchpadIndexer(env, chain)

  await indexer.start()
  await monitor.start()
  // No-ops when LAUNCHPAD_FACTORY_ADDRESS is unset — Auto LP ships first and must
  // run with no launchpad deployed (specs/README.md).
  await launchpadIndexer.start()
  log.info({ pollMs: env.INDEXER_POLL_MS, monitorMs: env.MONITOR_INTERVAL_MS }, 'workers started')

  // 8. API.
  const app = await buildServer({ env, chain, discovery })
  await app.listen({ port: env.PORT, host: env.HOST })
  log.info({ port: env.PORT }, 'api listening')

  // 9. Shutdown. Workers stop before the DB closes, so nothing writes into a
  //    closing connection and logs a scary error on a clean deploy.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutting down')
    indexer.stop()
    launchpadIndexer.stop()
    monitor.stop()
    ks.stop()
    await app.close().catch((err) => log.error({ err }, 'error closing api'))
    await disconnectDb().catch((err) => log.error({ err }, 'error closing mongo'))
    // Last: a node we started is only ours for as long as this process lives.
    localChain.stop()
    await flushSentry()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    componentLogger('process').error({ err: reason }, 'unhandled rejection')
    captureError(reason)
  })
}

main().catch(async (err) => {
  // Nothing is running yet, so the logger may not exist. Print and die — the
  // mainnet guard in particular must crash, never warn (004 section 3).
  console.error(err instanceof Error ? err.message : err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  await flushSentry()
  process.exit(1)
})
