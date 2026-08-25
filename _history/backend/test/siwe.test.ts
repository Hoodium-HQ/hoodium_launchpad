/**
 * T1.9 · WA-1.6, WA-1.7, WA-1.8, WA-1.9 — sign-in message construction and
 * signature verification.
 *
 * Nonce single-use and session storage are database behaviour and live in the
 * integration suite; these cover the parts that are pure, including the one that
 * matters most — that a signature over one message does not verify another.
 */
import { describe, expect, it } from 'vitest'
import { createWalletClient, http, verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSiweMessage } from '../src/auth/siwe.js'

// Anvil/ganache deterministic account 0. A throwaway key that has never held
// value on any network — safe to commit, and the logger would redact it anyway.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(TEST_KEY)

const wallet = createWalletClient({ account, transport: http('http://127.0.0.1:8545') })

const baseInput = {
  domain: 'localhost:5173',
  address: account.address,
  statement: 'Sign in to Hoodium.',
  uri: 'http://localhost:5173',
  chainId: 31337,
  nonce: 'abc123def456',
  issuedAt: new Date('2026-07-29T00:00:00.000Z'),
  expiresAt: new Date('2026-07-29T00:05:00.000Z'),
}

describe('buildSiweMessage — EIP-4361 shape', () => {
  it('emits the canonical field order', () => {
    expect(buildSiweMessage(baseInput)).toBe(
      [
        'localhost:5173 wants you to sign in with your Ethereum account:',
        account.address,
        '',
        'Sign in to Hoodium.',
        '',
        'URI: http://localhost:5173',
        'Version: 1',
        'Chain ID: 31337',
        'Nonce: abc123def456',
        'Issued At: 2026-07-29T00:00:00.000Z',
        'Expiration Time: 2026-07-29T00:05:00.000Z',
      ].join('\n'),
    )
  })

  it('binds the domain — the anti-phishing property (WA-1.7)', () => {
    const ours = buildSiweMessage(baseInput)
    const phishing = buildSiweMessage({ ...baseInput, domain: 'hoodium.app.evil.com' })
    expect(ours).not.toBe(phishing)
    expect(ours.startsWith('localhost:5173 wants you')).toBe(true)
  })

  it('binds the chain id', () => {
    expect(buildSiweMessage({ ...baseInput, chainId: 1 })).toContain('Chain ID: 1')
  })
})

describe('signature verification', () => {
  it('accepts a signature over the exact message', async () => {
    const message = buildSiweMessage(baseInput)
    const signature = await wallet.signMessage({ message })

    await expect(verifyMessage({ address: account.address, message, signature })).resolves.toBe(true)
  })

  it('rejects a signature over a different message — replay across challenges', async () => {
    const signed = buildSiweMessage(baseInput)
    const other = buildSiweMessage({ ...baseInput, nonce: 'zzz999zzz999' })
    const signature = await wallet.signMessage({ message: signed })

    await expect(verifyMessage({ address: account.address, message: other, signature })).resolves.toBe(false)
  })

  it('rejects a signature from a phishing domain being replayed here', async () => {
    const phishing = buildSiweMessage({ ...baseInput, domain: 'hoodium.app.evil.com' })
    const ours = buildSiweMessage(baseInput)
    const signature = await wallet.signMessage({ message: phishing })

    await expect(verifyMessage({ address: account.address, message: ours, signature })).resolves.toBe(false)
  })

  it('rejects a valid signature presented for a different address', async () => {
    const message = buildSiweMessage(baseInput)
    const signature = await wallet.signMessage({ message })
    const other = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )

    await expect(verifyMessage({ address: other.address, message, signature })).resolves.toBe(false)
  })

  it('rejects a tampered signature', async () => {
    const message = buildSiweMessage(baseInput)
    const signature = await wallet.signMessage({ message })
    const tampered = (signature.slice(0, -2) + (signature.endsWith('1b') ? '1c' : '1b')) as `0x${string}`

    await expect(
      verifyMessage({ address: account.address, message, signature: tampered }),
    ).resolves.toBe(false)
  })
})
