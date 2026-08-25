/**
 * T1.4 · AL-N3 — "assert a key-shaped string never reaches output".
 */
import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { createLogger } from '../src/lib/logger.js'
import { isDeniedField, scrub, scrubString, REDACTED } from '../src/lib/redact.js'

/*
 * Published test vectors, deliberately committed. Both appear verbatim in
 * go-ethereum's and BIP-39's own documentation and have never held value on any
 * network. A redaction test needs a real key-shaped string to prove it redacts —
 * inventing a fake one would test a pattern that does not occur in practice.
 */
const PRIVATE_KEY = '0x4c0883a69102937d6231471b5dbb6204fe512961708279f2c3ecbd8f4b5d0e1a'
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'

function captureOutput(fn: (log: ReturnType<typeof createLogger>) => void): string {
  let output = ''
  const sink = new Writable({
    write(chunk, _enc, cb) {
      output += String(chunk)
      cb()
    },
  })
  const log = createLogger({ level: 'trace', destination: sink })
  fn(log)
  return output
}

describe('scrubString', () => {
  it('redacts a 0x-prefixed private key', () => {
    expect(scrubString(`key=${PRIVATE_KEY}`)).toBe(`key=${REDACTED}`)
  })

  it('redacts a bare 64-hex key', () => {
    expect(scrubString(PRIVATE_KEY.slice(2))).toBe(REDACTED)
  })

  it('redacts a BIP-39 mnemonic', () => {
    expect(scrubString(MNEMONIC)).toBe(REDACTED)
  })

  it('redacts credentials embedded in a connection string', () => {
    expect(scrubString('mongodb+srv://admin:hunter2@cluster0.mongodb.net/hoodium')).toBe(
      'mongodb+srv://[REDACTED]@cluster0.mongodb.net/hoodium',
    )
  })

  it('leaves addresses alone — the logs are useless without them', () => {
    const addr = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'
    expect(scrubString(`owner=${addr}`)).toBe(`owner=${addr}`)
  })
})

describe('field denylist', () => {
  it.each(['privateKey', 'private_key', 'PRIVATE-KEY', 'mnemonic', 'seedPhrase', 'authorization', 'mongoUri'])(
    'denies %s',
    (field) => {
      expect(isDeniedField(field)).toBe(true)
    },
  )

  it('allows ordinary fields', () => {
    expect(isDeniedField('walletAddress')).toBe(false)
    expect(isDeniedField('exposurePct')).toBe(false)
  })

  it('redacts by field name even when the value looks harmless', () => {
    expect(scrub({ apiKey: 'abc123' })).toEqual({ apiKey: REDACTED })
  })

  it('keeps tx hashes, which share the shape of a private key', () => {
    const txHash = '0x' + 'a'.repeat(64)
    expect(scrub({ txHash })).toEqual({ txHash })
  })
})

describe('scrub — structure handling', () => {
  it('does not mutate the caller’s object', () => {
    const input = { privateKey: 'secret' }
    scrub(input)
    expect(input.privateKey).toBe('secret')
  })

  it('handles cycles without hanging', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect(scrub(a)).toEqual({ name: 'a', self: '[CIRCULAR]' })
  })

  it('stringifies bigints, which JSON cannot serialise', () => {
    expect(scrub({ liquidity: 10n ** 20n })).toEqual({ liquidity: '100000000000000000000' })
  })

  it('scrubs error messages and stacks', () => {
    const scrubbed = scrub(new Error(`failed signing with ${PRIVATE_KEY}`)) as { message: string }
    expect(scrubbed.message).not.toContain(PRIVATE_KEY)
  })
})

describe('logger output — AL-N3', () => {
  it('never emits a key-shaped string, whatever the field is called', () => {
    const output = captureOutput((log) => {
      log.info({ privateKey: PRIVATE_KEY }, 'signing')
      log.info({ note: `recovered with ${PRIVATE_KEY}` }, 'oops')
      log.info({ nested: { deep: { sessionKeyPrivate: PRIVATE_KEY } } }, 'nested')
      log.info(`interpolated ${PRIVATE_KEY}`)
      log.error({ err: new Error(`boom ${PRIVATE_KEY}`) }, 'failure')
    })

    expect(output).not.toContain(PRIVATE_KEY)
    expect(output).not.toContain(PRIVATE_KEY.slice(2))
    expect(output).toContain(REDACTED)
  })

  it('never emits a mnemonic', () => {
    const output = captureOutput((log) => {
      log.warn({ seedPhrase: MNEMONIC }, 'recovery')
      log.warn(`user pasted: ${MNEMONIC}`)
    })
    expect(output).not.toContain('sausage')
  })

  it('still emits the information an operator needs', () => {
    const output = captureOutput((log) => {
      log.info({ wallet: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', exposurePct: '71.4' }, 'threshold crossed')
    })
    expect(output).toContain('0x1f9840a85d5af5bf1d1762f925bdaddc4201f984')
    expect(output).toContain('71.4')
    expect(output).toContain('threshold crossed')
  })
})
