/**
 * Operator control for the global kill switch — AL-N8.
 *
 *   tsx src/scripts/kill-switch.ts on  "rpc returning stale state"
 *   tsx src/scripts/kill-switch.ts off
 *
 * Deliberately a script rather than an HTTP route: 001 and 003 specify no
 * authentication scheme, and an unauthenticated endpoint that halts every user's
 * automation is a denial-of-service handed out for free. The switch must also
 * work "without shell access" (design section 7) — that path is writing the
 * `system_flags` document directly from the Atlas console, which this script
 * documents by example.
 */
import { loadEnv } from '../config/env.js'
import { assertConfiguredChain } from '../config/chain-guard.js'
import { connectDb, disconnectDb } from '../db/connect.js'
import { setKillSwitch } from '../lib/kill-switch.js'
import { initLogger } from '../lib/logger.js'

async function main() {
  const action = process.argv[2]
  const reason = process.argv[3] ?? 'engaged by operator'

  if (action !== 'on' && action !== 'off') {
    process.stderr.write('usage: kill-switch.ts <on|off> [reason]\n')
    process.exit(2)
  }

  const env = loadEnv()
  initLogger({ level: env.LOG_LEVEL, pretty: true })
  assertConfiguredChain(env)

  await connectDb(env.MONGO_URI, env.MONGO_DB_NAME)
  await setKillSwitch(action === 'on', reason, process.env.USER ?? process.env.USERNAME ?? 'unknown')
  await disconnectDb()

  process.stdout.write(`kill switch ${action === 'on' ? 'ENGAGED' : 'released'} (${env.APP_ENV})\n`)
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`)
  process.exit(1)
})
