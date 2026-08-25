/**
 * Local chain autostart — a development convenience, and local only.
 *
 * Booting with nothing on 127.0.0.1:8545 fails at the live half of the mainnet
 * guard (004 section 3) with a viem fetch stack, which says "HTTP request
 * failed" when the actual fact is "you have no node running". This module makes
 * that case self-healing on a developer machine and leaves every other
 * environment exactly as it was.
 *
 * The rules it holds itself to, because a module that spawns processes has to
 * be boring:
 *
 *   - `APP_ENV=local` only. `staging` and `production` return a no-op
 *     handle before anything is inspected. A deployed process must never grow a
 *     chain of its own; if its RPC is down that is an incident, not a task.
 *   - loopback URLs only. If RPC_PRIMARY points at a real host, there is nothing
 *     here to start and nothing this module may do about it.
 *   - probe before spawn. An anvil you started yourself — with your own flags,
 *     your own fork, your own deployed contracts — always wins. This process
 *     only fills a hole.
 *   - the chain id comes from `env.CHAIN_ID`, which `assertConfiguredChain` has
 *     already pinned to Anvil's 31337 for local. The node this starts therefore
 *     cannot be one the guard would go on to reject.
 *
 * The child is owned by this process: it is stopped on shutdown, and on a bare
 * `process.exit` too, so a crashed boot does not leave an orphan holding 8545.
 * Want a chain that survives restarts? Run `anvil` yourself and this steps aside.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { componentLogger } from '../lib/logger.js'
import type { Env } from '../config/env.js'

/** How long a single liveness probe may take. Loopback — it answers or it is not there. */
const PROBE_TIMEOUT_MS = 1_000
/** Total time anvil gets to accept its first request before this is called a failure. */
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 200

/**
 * Hostnames that mean "this machine". `0.0.0.0` is included because it is a
 * common typo for a client URL, and it does resolve to loopback when dialled.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])

export interface LocalChain {
  /** Stop anything this process started. Safe to call twice, and when nothing was started. */
  stop(): void
}

const NOOP: LocalChain = { stop() {} }

interface LoopbackEndpoint {
  url: string
  port: number
}

/**
 * The distinct loopback ports the configured endpoints need. Deduplicated by
 * port because the shipped configuration points primary and fallback at the
 * same node — one anvil serves both, and starting two would be a second chain
 * with different state answering half the calls.
 */
function loopbackEndpoints(env: Env): LoopbackEndpoint[] {
  const byPort = new Map<number, LoopbackEndpoint>()
  for (const raw of [env.RPC_PRIMARY, env.RPC_FALLBACK]) {
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      continue
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) continue
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    if (!byPort.has(port)) byPort.set(port, { url: raw, port })
  }
  return [...byPort.values()]
}

/**
 * Is *something* serving JSON-RPC here? Deliberately not "is it the right
 * chain" — the mainnet guard answers that a moment later, and it answers it
 * better. All this decides is whether to spawn.
 */
async function respondsToChainId(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function missingAnvil(): Error {
  return new Error(
    'FATAL: no chain is running on the configured RPC port and `anvil` is not on PATH. ' +
      'Install Foundry (https://getfoundry.sh), or start a node yourself with `npm run chain:local`, ' +
      'or set LOCAL_CHAIN_AUTOSTART=false to boot without one.',
  )
}

/** Spawn anvil on one port and wait until it answers. Throws with the reason if it does not. */
async function startAnvil(env: Env, endpoint: LoopbackEndpoint, log: ReturnType<typeof componentLogger>) {
  log.info({ port: endpoint.port, chainId: env.CHAIN_ID }, 'no chain on the configured RPC port — starting anvil')

  const child = spawn(
    'anvil',
    ['--chain-id', String(env.CHAIN_ID), '--port', String(endpoint.port), '--host', '127.0.0.1'],
    // stdout is discarded on purpose: anvil prints ten well-known private keys
    // at startup, and key-shaped material has no business in an application log
    // even when it is public knowledge (see lib/redact.ts).
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )

  // Held in one object rather than as bare `let`s so reads after an `await` are
  // typed as what the listeners may have written, not as their initial value.
  const state: { error?: Error; exitCode?: number | null; stderr: string } = { stderr: '' }
  child.stderr?.on('data', (chunk: Buffer) => {
    state.stderr = (state.stderr + chunk.toString()).slice(-2_000)
  })
  child.once('error', (err) => {
    state.error = (err as NodeJS.ErrnoException).code === 'ENOENT' ? missingAnvil() : err
  })
  child.once('exit', (code) => {
    state.exitCode = code
  })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (state.error) throw state.error
    if (state.exitCode !== undefined) {
      const detail = state.stderr.trim()
      throw new Error(
        `anvil exited (code ${state.exitCode}) before it was ready on port ${endpoint.port}` +
          (detail ? `: ${detail}` : ''),
      )
    }
    if (await respondsToChainId(endpoint.url)) {
      log.info({ port: endpoint.port, pid: child.pid }, 'local chain ready')
      return child
    }
    await sleep(READY_POLL_MS)
  }

  child.kill()
  throw new Error(`anvil did not accept a request on port ${endpoint.port} within ${READY_TIMEOUT_MS}ms`)
}

/**
 * Make sure the configured local RPC answers, starting a node if it does not.
 *
 * Call after `assertConfiguredChain` — the static guard must still be the first
 * thing that runs, before this opens a socket to probe — and before the
 * ChainClient's live guard.
 */
export async function ensureLocalChain(env: Env): Promise<LocalChain> {
  if (env.APP_ENV !== 'local') return NOOP

  const log = componentLogger('local-chain')
  if (env.LOCAL_CHAIN_AUTOSTART === false) {
    log.debug('LOCAL_CHAIN_AUTOSTART=false — not starting a chain')
    return NOOP
  }

  const endpoints = loopbackEndpoints(env)
  if (endpoints.length === 0) {
    log.debug({ primary: env.RPC_PRIMARY }, 'RPC is not loopback — nothing to start')
    return NOOP
  }

  const children: ChildProcess[] = []
  let stopping = false
  const stop = () => {
    stopping = true
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill()
    }
  }

  try {
    for (const endpoint of endpoints) {
      if (await respondsToChainId(endpoint.url)) {
        log.info({ port: endpoint.port }, 'a chain is already running — reusing it')
        continue
      }
      children.push(await startAnvil(env, endpoint, log))
    }
  } catch (err) {
    // Half-started is worse than not started: kill whatever did come up before
    // the failure propagates and boot dies.
    stop()
    throw err
  }

  if (children.length === 0) return NOOP

  for (const child of children) {
    child.once('exit', (code, signal) => {
      if (!stopping) log.error({ pid: child.pid, code, signal }, 'the local chain exited — RPC calls will now fail')
    })
  }

  // Safety net for the paths that never reach the shutdown handler — a later
  // boot step throwing, or an explicit process.exit. Sync work only.
  process.once('exit', stop)

  return { stop }
}
