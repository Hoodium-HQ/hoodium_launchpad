/**
 * 004 section 3 — the mainnet guard.
 *
 * "The realistic accident is not a hack. It is a staging process booting with a
 *  production RPC URL." These tests are that accident, written down.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ANVIL_CHAIN_ID,
  ChainMismatchError,
  assertConfiguredChain,
  assertLiveChain,
  expectedChainId,
} from '../src/config/chain-guard.js'
import { loadEnv, type Env } from '../src/config/env.js'

const MAINNET = 42161
const TESTNET = 421614

/**
 * Raw process-env shaped record. Kept separate from the parsed result because
 * `loadEnv` output is not valid input to `loadEnv` — CORS_ORIGINS has already
 * become an array by then.
 */
function rawEnv(overrides: Partial<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'staging',
    CHAIN_ID: String(TESTNET),
    ROBINHOOD_MAINNET_CHAIN_ID: String(MAINNET),
    ROBINHOOD_TESTNET_CHAIN_ID: String(TESTNET),
    RPC_PRIMARY: 'https://rpc.example/1',
    RPC_FALLBACK: 'https://rpc.example/2',
    MONGO_URI: 'mongodb://127.0.0.1:27017',
    QUOTE_TOKEN_ADDRESS: '0x' + '1'.repeat(40),
    POSITION_MANAGER_ADDRESS: '0x' + '2'.repeat(40),
    UNISWAP_V3_FACTORY_ADDRESS: '0x' + '3'.repeat(40),
    TELEGRAM_BOT_TOKEN: '123456:test-bot-token',
    TELEGRAM_BOT_USERNAME: 'HoodiumTestBot',
    TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32),
    APP_ORIGIN: 'https://staging.hoodium.app',
    ...overrides,
  }
}

function envFor(overrides: Partial<Record<string, string>> = {}): Env {
  return loadEnv(rawEnv(overrides))
}

describe('expectedChainId', () => {
  it('pins local to Anvil', () => {
    expect(expectedChainId(envFor({ APP_ENV: 'local', CHAIN_ID: '31337' }))).toBe(ANVIL_CHAIN_ID)
  })

  it('pins staging to testnet and production to mainnet', () => {
    expect(expectedChainId(envFor({ APP_ENV: 'staging' }))).toBe(TESTNET)
    expect(expectedChainId(envFor({ APP_ENV: 'production', CHAIN_ID: String(MAINNET), KMS_KEY_ID: 'k' }))).toBe(MAINNET)
  })
})

describe('assertConfiguredChain', () => {
  it('accepts a correctly configured staging process', () => {
    expect(() => assertConfiguredChain(envFor())).not.toThrow()
  })

  it('crashes when staging is pointed at mainnet — the accident this control exists for', () => {
    const env = envFor({ CHAIN_ID: String(MAINNET) })
    expect(() => assertConfiguredChain(env)).toThrow(ChainMismatchError)
  })

  it('names both sides in the error so the fix is obvious from the crash log', () => {
    try {
      assertConfiguredChain(envFor({ CHAIN_ID: String(MAINNET) }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(String(err)).toContain('staging')
      expect(String(err)).toContain(String(TESTNET))
      expect(String(err)).toContain(String(MAINNET))
    }
  })

  it('crashes when local is pointed at anything but Anvil', () => {
    expect(() => assertConfiguredChain(envFor({ APP_ENV: 'local', CHAIN_ID: String(TESTNET) }))).toThrow(
      ChainMismatchError,
    )
  })
})

describe('assertLiveChain', () => {
  it('accepts an RPC that reports the expected chain', async () => {
    await expect(assertLiveChain(envFor(), async () => TESTNET)).resolves.toBeUndefined()
  })

  it('crashes when the RPC reports mainnet to a staging process', async () => {
    await expect(assertLiveChain(envFor(), async () => MAINNET)).rejects.toBeInstanceOf(ChainMismatchError)
  })

  it('reports which endpoint lied — fallback URLs are a second entry point (004 section 3)', async () => {
    const getChainId = vi.fn(async () => MAINNET)
    await expect(assertLiveChain(envFor(), getChainId, 'RPC(fallback)')).rejects.toThrow(/RPC\(fallback\)/)
  })
})

describe('configuration schema — 004 section 9', () => {
  it('refuses to boot without APP_ENV — a default is how production gets misidentified', () => {
    const source = rawEnv()
    delete source.APP_ENV
    expect(() => loadEnv(source)).toThrow(/APP_ENV/)
  })

  it('requires KMS_KEY_ID in production (004 section 4)', () => {
    expect(() => envFor({ APP_ENV: 'production', CHAIN_ID: String(MAINNET) })).toThrow(/KMS_KEY_ID/)
  })

  it('requires Telegram credentials in deployed environments (AL-3.5)', () => {
    const source = rawEnv()
    delete source.TELEGRAM_BOT_TOKEN
    delete source.TELEGRAM_BOT_USERNAME
    delete source.TELEGRAM_WEBHOOK_SECRET
    expect(() => loadEnv(source)).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('allows a local process to run without Telegram — alerts stay in-app', () => {
    const source = rawEnv({ APP_ENV: 'local', CHAIN_ID: '31337' })
    delete source.TELEGRAM_BOT_TOKEN
    delete source.TELEGRAM_BOT_USERNAME
    delete source.TELEGRAM_WEBHOOK_SECRET
    expect(() => loadEnv(source)).not.toThrow()
  })

  /*
   * A bot with no webhook secret cannot receive `/start`, so linking is
   * impossible and every user waits forever. Caught at boot rather than
   * discovered by the first person who tries to connect.
   */
  it('refuses a bot token with no webhook secret, in any environment (AL-3.8)', () => {
    const source = rawEnv({ APP_ENV: 'local', CHAIN_ID: '31337' })
    delete source.TELEGRAM_WEBHOOK_SECRET
    expect(() => loadEnv(source)).toThrow(/TELEGRAM_WEBHOOK_SECRET/)
  })

  it('rejects a bot username carrying the @ — it would break the deep link', () => {
    expect(() => envFor({ TELEGRAM_BOT_USERNAME: '@HoodiumTestBot' })).toThrow(/TELEGRAM_BOT_USERNAME/)
  })

  it('rejects an emergency threshold below the exit threshold (AL-5.3)', () => {
    expect(() => envFor({ EXPOSURE_THRESHOLD_PCT: '90', EMERGENCY_THRESHOLD_PCT: '80' })).toThrow(/EMERGENCY/)
  })

  it('rejects identical testnet and mainnet ids — the guard could not tell them apart', () => {
    expect(() => envFor({ ROBINHOOD_TESTNET_CHAIN_ID: String(MAINNET) })).toThrow(/differ/)
  })
})
