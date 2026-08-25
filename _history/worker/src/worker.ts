/**
 * Worker boot — 001 design section 7, 004 section 3.
 *
 * The half of the backend that must run exactly once. The indexer holds a
 * cursor, the monitor runs on a fixed interval, and the kill-switch poller
 * decides whether either may act — none of that tolerates a second copy, which
 * is precisely why it no longer shares a process with the API.
 *
 * Two indexers writing one `indexer_cursors` document is not merely wasteful.
 * `blockBuffer` is the reorg-detection state, written read-modify-write with no
 * lock; interleaved writers produce a buffer that no longer matches the chain,
 * and a rewind *deletes events*. So this service runs at one instance, and the
 * platform config says so out loud.
 *
 * Boot order is not arbitrary. The mainnet guard runs before anything else can
 * open a connection or start a job — "a guard that runs after the job queue
 * starts has already lost" (004 section 3).
 */
import { loadEnv, setEnvForTesting, assertConfiguredChain } from '@hoodium/core/config'
import { initLogger, componentLogger, initSentry, flushSentry, captureError, initKillSwitch } from '@hoodium/core/lib'
import { connectDb, disconnectDb, ensureIndexes } from '@hoodium/core/db'
import { ChainClient } from '@hoodium/core/chain'
import { initTelegram } from '@hoodium/core/notify'
import { Indexer } from './indexer/indexer.js'
import { LaunchpadIndexer } from './launchpad/indexer.js'
import { Monitor } from './monitor/monitor.js'
import { PoolDiscovery } from './market/pool-discovery.js'

async function main(): Promise<void> {
  // 1. Configuration. No defaults for anything environment-identifying (004 section 9).
  const env = loadEnv()
  setEnvForTesting(env)

  const log = initLogger({ level: env.LOG_LEVEL, pretty: env.APP_ENV === 'local' })

  // 2. The mainnet guard, static half — before any socket is opened.
  assertConfiguredChain(env)
  log.info({ appEnv: env.APP_ENV, chainId: env.CHAIN_ID, role: 'worker' }, 'configured chain accepted')

  initSentry({ dsn: env.SENTRY_DSN, environment: env.APP_ENV })

  // 3. The mainnet guard, live half — both endpoints, because the fallback is a
  //    second place a wrong endpoint can enter (004 section 3).
  const chain = new ChainClient(env)
  await chain.verifyBothEndpoints()

  // 4. Storage, with the unique constraints the indexer and dedupe rely on.
  //    Both services call this; it is idempotent, and whichever boots first wins.
  await connectDb(env.MONGO_URI, env.MONGO_DB_NAME)
  await ensureIndexes()

  // 5. Kill switch before any worker — a switch that starts after the workers do
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

  // 6. The workers themselves.
  const indexer = new Indexer(env, chain)
  const monitor = new Monitor(env, chain)
  // No-ops when LAUNCHPAD_FACTORY_ADDRESS is unset — Auto LP ships first and must
  // run with no launchpad deployed (specs/README.md).
  const launchpadIndexer = new LaunchpadIndexer(env, chain)
  // 003 R7: the gateway's top-pools list is not the universe of pools, so the
  // universe is recovered from swap activity here. No-op without a v4 manager.
  const poolDiscovery = new PoolDiscovery(env, chain)

  await indexer.start()
  await monitor.start()
  await launchpadIndexer.start()
  await poolDiscovery.start()
  log.info({ pollMs: env.INDEXER_POLL_MS, monitorMs: env.MONITOR_INTERVAL_MS }, 'workers started')

  // 7. Shutdown. Workers stop before the DB closes, so nothing writes into a
  //    closing connection and logs a scary error on a clean deploy.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutting down')
    indexer.stop()
    launchpadIndexer.stop()
    poolDiscovery.stop()
    monitor.stop()
    ks.stop()
    await disconnectDb().catch((err) => log.error({ err }, 'error closing mongo'))
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
