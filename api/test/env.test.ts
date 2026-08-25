import { describe, expect, it } from 'vitest'
import { EnvError, loadEnv } from '../src/config/env.js'

const base = { MONGO_URI: 'mongodb://localhost:27017', RPC_URL: 'https://rpc.example' }

describe('loadEnv', () => {
  it('applies the documented defaults', () => {
    const env = loadEnv(base)
    expect(env.PORT).toBe(8080)
    expect(env.CHAIN_ID).toBe(4663)
    expect(env.MONGO_DB_NAME).toBe('hoodium_launchpad')
    expect(env.GETLOGS_MAX_RANGE).toBe(2000)
    expect(env.INDEXER_ENABLED).toBe(true)
    expect(env.CORS_ORIGINS).toEqual(['https://launchpad.hoodium.app'])
    expect(env.LAUNCHPAD_FACTORY).toBeNull()
    expect(env.PINATA_JWT).toBeUndefined()
  })

  it('treats an empty or zero factory as unset', () => {
    expect(loadEnv({ ...base, LAUNCHPAD_FACTORY: '' }).LAUNCHPAD_FACTORY).toBeNull()
    expect(loadEnv({ ...base, LAUNCHPAD_FACTORY: '0x0000000000000000000000000000000000000000' }).LAUNCHPAD_FACTORY).toBeNull()
    expect(loadEnv({ ...base, LAUNCHPAD_FACTORY: '0xAbCdEF0000000000000000000000000000000001' }).LAUNCHPAD_FACTORY).toBe(
      '0xabcdef0000000000000000000000000000000001',
    )
  })

  it('rejects a malformed factory address', () => {
    expect(() => loadEnv({ ...base, LAUNCHPAD_FACTORY: 'not-an-address' })).toThrow(EnvError)
  })

  it('fails fast on missing required values', () => {
    expect(() => loadEnv({ RPC_URL: 'https://rpc.example' })).toThrow(/MONGO_URI/)
    expect(() => loadEnv({ MONGO_URI: 'mongodb://x' })).toThrow(/RPC_URL/)
  })

  it('parses booleans and CSV lists', () => {
    const env = loadEnv({ ...base, INDEXER_ENABLED: 'false', CORS_ORIGINS: 'https://a.example, https://b.example' })
    expect(env.INDEXER_ENABLED).toBe(false)
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example'])
  })
})
