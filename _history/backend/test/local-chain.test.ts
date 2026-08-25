/**
 * dev/local-chain.ts — the guards, not the spawning.
 *
 * What matters here is everything this module *declines* to do. Actually
 * starting anvil is left to `npm run dev`; what a test can prove cheaply, and
 * what would be expensive to get wrong, is that no environment other than local
 * ever reaches the spawn at all.
 */
import { describe, expect, it } from 'vitest'
import { ensureLocalChain } from '../src/dev/local-chain.js'
import { loadEnv, type Env } from '../src/config/env.js'

const MAINNET = 4663
const TESTNET = 421614

function rawEnv(overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'local',
    CHAIN_ID: '31337',
    ROBINHOOD_MAINNET_CHAIN_ID: String(MAINNET),
    ROBINHOOD_TESTNET_CHAIN_ID: String(TESTNET),
    // A port nothing sane is listening on: if a guard leaks, the test spawns a
    // node instead of failing, and that is exactly what must not happen.
    RPC_PRIMARY: 'http://127.0.0.1:59545',
    RPC_FALLBACK: 'http://127.0.0.1:59545',
    MONGO_URI: 'mongodb://127.0.0.1:27017',
    QUOTE_TOKEN_ADDRESS: '0x' + '1'.repeat(40),
    POSITION_MANAGER_ADDRESS: '0x' + '2'.repeat(40),
    UNISWAP_V3_FACTORY_ADDRESS: '0x' + '3'.repeat(40),
    APP_ORIGIN: 'http://localhost:5173',
    ...overrides,
  }
}

function envFor(overrides: Partial<Record<string, string>> = {}): Env {
  return loadEnv(rawEnv(overrides))
}

const deployedEnv = (appEnv: 'staging' | 'production') =>
  envFor({
    APP_ENV: appEnv,
    CHAIN_ID: appEnv === 'production' ? String(MAINNET) : String(TESTNET),
    KMS_KEY_ID: 'k',
    TELEGRAM_BOT_TOKEN: '123456:test-bot-token',
    TELEGRAM_BOT_USERNAME: 'HoodiumTestBot',
    TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32),
    RPC_PRIMARY: 'http://127.0.0.1:59545',
    RPC_FALLBACK: 'http://127.0.0.1:59545',
  })

describe('ensureLocalChain', () => {
  /*
   * The one that matters. A deployed process pointed at a loopback URL is
   * already broken; growing it a chain of its own would turn a loud failure
   * into a process happily indexing an empty local node.
   */
  it.each(['staging', 'production'] as const)('does nothing in %s, even on a loopback RPC', async (appEnv) => {
    const handle = await ensureLocalChain(deployedEnv(appEnv))
    expect(() => handle.stop()).not.toThrow()
  })

  it('does nothing when the local RPC is a real host — there is nothing here to start', async () => {
    const handle = await ensureLocalChain(
      envFor({ RPC_PRIMARY: 'https://rpc.example/1', RPC_FALLBACK: 'https://rpc.example/2' }),
    )
    expect(() => handle.stop()).not.toThrow()
  })

  it('does nothing when explicitly switched off', async () => {
    const handle = await ensureLocalChain(envFor({ LOCAL_CHAIN_AUTOSTART: 'false' }))
    expect(() => handle.stop()).not.toThrow()
  })

  it('stop() is safe to call twice', async () => {
    const handle = await ensureLocalChain(envFor({ LOCAL_CHAIN_AUTOSTART: 'false' }))
    handle.stop()
    expect(() => handle.stop()).not.toThrow()
  })
})

describe('LOCAL_CHAIN_AUTOSTART — configuration', () => {
  it('is accepted in local', () => {
    expect(() => envFor({ LOCAL_CHAIN_AUTOSTART: 'true' })).not.toThrow()
  })

  it.each(['staging', 'production'] as const)('is refused when switched on in %s', (appEnv) => {
    expect(() =>
      loadEnv({
        // Everything the deployed environments demand in their own right, so the
        // only issue this can raise is the one being asserted.
        ...rawEnv({
          APP_ENV: appEnv,
          CHAIN_ID: appEnv === 'production' ? String(MAINNET) : String(TESTNET),
          KMS_KEY_ID: 'k',
          TELEGRAM_BOT_TOKEN: '123456:test-bot-token',
          TELEGRAM_BOT_USERNAME: 'HoodiumTestBot',
          TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32),
        }),
        LOCAL_CHAIN_AUTOSTART: 'true',
      }),
    ).toThrow(/LOCAL_CHAIN_AUTOSTART/)
  })

  it('is absent by default — an unset switch stays distinguishable from a set one', () => {
    expect(envFor().LOCAL_CHAIN_AUTOSTART).toBeUndefined()
  })
})
