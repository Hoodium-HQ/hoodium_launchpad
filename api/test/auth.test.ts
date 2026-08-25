import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { AUTH_MAX_AGE_MS, buildAuthMessage, verifySignedRequest } from '../src/auth.js'

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const token = '0x1111111111111111111111111111111111111111'

async function sign(input: Parameters<typeof buildAuthMessage>[0]) {
  return account.signMessage({ message: buildAuthMessage(input) })
}

describe('verifySignedRequest', () => {
  it('accepts a fresh signature from the claimed address', async () => {
    const issuedAt = Date.now()
    const input = { action: 'chat' as const, chainId: 4663, address: account.address, token, issuedAt, payload: '0xabc' }
    const signature = await sign(input)
    expect(await verifySignedRequest({ ...input, signature })).toEqual({ ok: true })
  })

  it('is case-insensitive on the address', async () => {
    const issuedAt = Date.now()
    const input = { action: 'links' as const, chainId: 4663, address: account.address.toLowerCase(), token, issuedAt }
    const signature = await sign({ ...input, address: account.address })
    expect(await verifySignedRequest({ ...input, signature })).toEqual({ ok: true })
  })

  it('rejects a signature from another address', async () => {
    const issuedAt = Date.now()
    const input = { action: 'chat' as const, chainId: 4663, address: token, token, issuedAt }
    const signature = await sign({ ...input, address: account.address })
    expect(await verifySignedRequest({ ...input, signature })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('binds the action, token and payload', async () => {
    const issuedAt = Date.now()
    const base = { chainId: 4663, address: account.address, token, issuedAt, payload: '0x01' }
    const signature = await sign({ ...base, action: 'chat' })
    expect((await verifySignedRequest({ ...base, action: 'links', signature })).ok).toBe(false)
    expect((await verifySignedRequest({ ...base, action: 'chat', token: '0x' + '2'.repeat(40), signature })).ok).toBe(false)
    expect((await verifySignedRequest({ ...base, action: 'chat', payload: '0x02', signature })).ok).toBe(false)
  })

  it('refuses stale and future timestamps', async () => {
    const now = Date.now()
    const stale = { action: 'chat' as const, chainId: 4663, address: account.address, token, issuedAt: now - AUTH_MAX_AGE_MS - 1 }
    expect(await verifySignedRequest({ ...stale, signature: await sign(stale) }, now)).toEqual({ ok: false, reason: 'expired' })
    const future = { ...stale, issuedAt: now + 10 * 60_000 }
    expect(await verifySignedRequest({ ...future, signature: await sign(future) }, now)).toEqual({ ok: false, reason: 'future' })
  })

  it('refuses a malformed signature without throwing', async () => {
    const r = await verifySignedRequest({ action: 'chat', chainId: 1, address: account.address, issuedAt: Date.now(), signature: 'nope' })
    expect(r).toEqual({ ok: false, reason: 'malformed' })
  })
})
