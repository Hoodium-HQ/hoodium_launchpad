/**
 * T3.10 · AL-3.8, AL-3.9 — link lifecycle against a real MongoDB.
 *
 * Like the dedupe suite, this cannot be faked. Single-use redemption is enforced
 * by a conditional update resolving a race inside MongoDB, and "one active link
 * per address" by a partial unique index. A mocked model would test the mock.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Skipped otherwise, and reported as skipped rather than passing silently.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  TelegramLinkModel,
  TelegramLinkTokenModel,
  hashLinkToken,
} from '../src/db/models/telegram-link.js'
import {
  getTelegramLinkStatus,
  redeemTelegramLink,
  revokeTelegramLink,
  setTelegramAlertType,
  setTelegramConfigForTesting,
  startTelegramLink,
} from '../src/notify/telegram.js'

const uri = process.env.MONGO_TEST_URI
const dbName = 'hoodium_test_telegram'

const OWNER = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'
const CHAIN_ID = 31337
const CHAT = '123456789'

describe.skipIf(!uri)('telegram link lifecycle — AL-3.8, AL-3.9', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName })
    await TelegramLinkModel.createIndexes()
    await TelegramLinkTokenModel.createIndexes()
    // A config without a real token: the lifecycle never calls the Bot API, and
    // a send would fail loudly rather than reaching Telegram.
    setTelegramConfigForTesting({
      botToken: 'test:token',
      botUsername: 'HoodiumTestBot',
      appOrigin: 'https://app.example',
    })
  }, 30_000)

  afterAll(async () => {
    setTelegramConfigForTesting(null)
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  afterEach(async () => {
    await TelegramLinkModel.deleteMany({})
    await TelegramLinkTokenModel.deleteMany({})
  })

  it('mints a deep link carrying the token', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    expect(result).not.toBeNull()
    expect(result!.deepLink).toBe(`https://t.me/HoodiumTestBot?start=${result!.token}`)
    expect(result!.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('stores only the hash, never the token itself', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    const stored = await TelegramLinkTokenModel.findOne({ tokenHash: hashLinkToken(result!.token) })
    expect(stored).not.toBeNull()
    expect(JSON.stringify(stored!.toObject())).not.toContain(result!.token)
  })

  it('redeems a token into an active link', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    const redeemed = await redeemTelegramLink({ token: result!.token, chatId: CHAT, username: 'adihanif' })

    expect(redeemed).toEqual({ ok: true, ownerAddress: OWNER })
    const status = await getTelegramLinkStatus(OWNER)
    expect(status.linked).toBe(true)
    expect(status.username).toBe('adihanif')
  })

  /* The property the whole token design exists for. */
  it('refuses a second redemption of the same token', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    await redeemTelegramLink({ token: result!.token, chatId: CHAT })

    const second = await redeemTelegramLink({ token: result!.token, chatId: '999' })
    expect(second).toEqual({ ok: false, reason: 'already_used' })

    // The first chat keeps the link; the second never gets one.
    const link = await TelegramLinkModel.findOne({ ownerAddress: OWNER, inactiveAt: null })
    expect(link!.chatId).toBe(CHAT)
  })

  /*
   * Two /start taps arriving together. Both pass any read-then-write check, so
   * the conditional update is what has to decide it — exactly one may win.
   */
  it('lets only one of two concurrent redemptions win', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    const [a, b] = await Promise.all([
      redeemTelegramLink({ token: result!.token, chatId: 'A' }),
      redeemTelegramLink({ token: result!.token, chatId: 'B' }),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(await TelegramLinkModel.countDocuments({ ownerAddress: OWNER, inactiveAt: null })).toBe(1)
  })

  it('refuses an expired token', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    // Expiry is enforced in the redeem path, not left to the TTL monitor — which
    // runs about once a minute and would leave a window of readable dead tokens.
    await TelegramLinkTokenModel.updateOne(
      { tokenHash: hashLinkToken(result!.token) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    )

    expect(await redeemTelegramLink({ token: result!.token, chatId: CHAT })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('refuses a token that was never issued', async () => {
    expect(await redeemTelegramLink({ token: 'not-a-real-token', chatId: CHAT })).toEqual({
      ok: false,
      reason: 'unknown_token',
    })
  })

  it('invalidates an earlier unused token when a new one is minted', async () => {
    const first = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })

    expect(await redeemTelegramLink({ token: first!.token, chatId: CHAT })).toEqual({
      ok: false,
      reason: 'unknown_token',
    })
  })

  it('reports a revoked link as simply not connected, not as a fault', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    await redeemTelegramLink({ token: result!.token, chatId: CHAT })

    expect(await revokeTelegramLink(OWNER)).toBe(true)
    const status = await getTelegramLinkStatus(OWNER)
    expect(status.linked).toBe(false)
    expect(status.inactiveReason).toBeNull()
  })

  /* WA-6.9 — a user who was blocked must be told why, not shown "not connected". */
  it('surfaces the reason when a link was deactivated by a block', async () => {
    const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    await redeemTelegramLink({ token: result!.token, chatId: CHAT })
    await TelegramLinkModel.updateOne(
      { ownerAddress: OWNER },
      { $set: { inactiveAt: new Date(), inactiveReason: 'blocked' } },
    )

    const status = await getTelegramLinkStatus(OWNER)
    expect(status.linked).toBe(false)
    expect(status.inactiveReason).toBe('blocked')
  })

  it('relinks after a block without colliding with the dead row', async () => {
    const first = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    await redeemTelegramLink({ token: first!.token, chatId: CHAT })
    await TelegramLinkModel.updateOne(
      { ownerAddress: OWNER },
      { $set: { inactiveAt: new Date(), inactiveReason: 'blocked' } },
    )

    const second = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
    expect(await redeemTelegramLink({ token: second!.token, chatId: 'new-chat' })).toEqual({
      ok: true,
      ownerAddress: OWNER,
    })

    const status = await getTelegramLinkStatus(OWNER)
    expect(status.linked).toBe(true)
    expect(status.inactiveReason).toBeNull()
  })

  describe('alert type preferences — WA-6.5', () => {
    it('mutes and unmutes a type', async () => {
      const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
      await redeemTelegramLink({ token: result!.token, chatId: CHAT })

      await setTelegramAlertType({ ownerAddress: OWNER, type: 'range_proximity', enabled: false })
      expect((await getTelegramLinkStatus(OWNER)).mutedTypes).toEqual(['range_proximity'])

      await setTelegramAlertType({ ownerAddress: OWNER, type: 'range_proximity', enabled: true })
      expect((await getTelegramLinkStatus(OWNER)).mutedTypes).toEqual([])
    })

    it('does not duplicate a type muted twice', async () => {
      const result = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
      await redeemTelegramLink({ token: result!.token, chatId: CHAT })

      await setTelegramAlertType({ ownerAddress: OWNER, type: 'out_of_range', enabled: false })
      await setTelegramAlertType({ ownerAddress: OWNER, type: 'out_of_range', enabled: false })
      expect((await getTelegramLinkStatus(OWNER)).mutedTypes).toEqual(['out_of_range'])
    })

    /* Preferences are the user's, not the link's — a relink must not resurrect
       an alert type they had turned off. */
    it('survives revoking and relinking', async () => {
      const first = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
      await redeemTelegramLink({ token: first!.token, chatId: CHAT })
      await setTelegramAlertType({ ownerAddress: OWNER, type: 'monitoring_degraded', enabled: false })
      await revokeTelegramLink(OWNER)

      const second = await startTelegramLink({ chainId: CHAIN_ID, ownerAddress: OWNER })
      await redeemTelegramLink({ token: second!.token, chatId: CHAT })

      expect((await getTelegramLinkStatus(OWNER)).mutedTypes).toEqual(['monitoring_degraded'])
    })
  })
})
