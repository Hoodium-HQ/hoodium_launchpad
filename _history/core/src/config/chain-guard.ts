/**
 * The mainnet guard — spec 004 section 3.
 *
 * "The single most important control in this document."
 *
 * The realistic accident is not a hack. It is a staging process booting with a
 * production RPC URL and then executing automation against real positions with a
 * testnet session key it believes is safe.
 *
 * Rules this module enforces:
 *   - runs before any other initialisation
 *   - crashes — never warns, never degrades
 *   - `env` comes from an explicit variable with no default (see config/env.ts)
 *   - asserted again after every RPC failover
 */
import type { AppEnv, Env } from './env.js'

/**
 * Anvil's chain id. `local` is not a provisioned environment (004 section 1), and
 * CI runs against the same Anvil, so it configures itself as `local` rather than
 * carrying a fourth name this table would have to hold without ever using it.
 */
export const ANVIL_CHAIN_ID = 31337

export class ChainMismatchError extends Error {
  constructor(
    readonly appEnv: AppEnv,
    readonly expected: number,
    readonly actual: number,
    readonly source: string,
  ) {
    super(
      `FATAL: env=${appEnv} expects chain ${expected}, ${source} reports ${actual}. ` +
        `Refusing to start — this is the mainnet guard (specs/004-environments/README.md section 3).`,
    )
    this.name = 'ChainMismatchError'
  }
}

/** The chain each environment is allowed to talk to, and only that chain. */
export function expectedChainId(env: Env): number {
  const table: Record<AppEnv, number> = {
    local: ANVIL_CHAIN_ID,
    staging: env.ROBINHOOD_TESTNET_CHAIN_ID,
    production: env.ROBINHOOD_MAINNET_CHAIN_ID,
  }
  return table[env.APP_ENV]
}

/**
 * Static half of the guard: does the *configured* chain id match what this
 * environment is permitted to use? Runs with no network, so a misconfigured
 * process dies before it opens a socket.
 */
export function assertConfiguredChain(env: Env): void {
  const expected = expectedChainId(env)
  if (env.CHAIN_ID !== expected) {
    throw new ChainMismatchError(env.APP_ENV, expected, env.CHAIN_ID, 'CHAIN_ID')
  }
  // Belt and braces: no non-production environment may ever name the mainnet id,
  // even if someone edits the table above.
  if (env.APP_ENV !== 'production' && env.CHAIN_ID === env.ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new ChainMismatchError(env.APP_ENV, expected, env.CHAIN_ID, 'CHAIN_ID (mainnet id in a non-production env)')
  }
}

/**
 * Live half of the guard: what does the RPC actually say it is? Call at boot and
 * again after every failover — "fallback URLs are a second place a wrong endpoint
 * can enter" (004 section 3).
 */
export async function assertLiveChain(
  env: Env,
  getChainId: () => Promise<number>,
  source = 'RPC',
): Promise<void> {
  const expected = expectedChainId(env)
  const actual = await getChainId()
  if (actual !== expected) {
    throw new ChainMismatchError(env.APP_ENV, expected, actual, source)
  }
}
