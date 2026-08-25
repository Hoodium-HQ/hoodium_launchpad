/**
 * T3.6 · AL-3.3 — "two identical alerts in 6h send once".
 *
 * This one cannot be faked. The guarantee comes from a unique index and a
 * conditional upsert resolving a race inside MongoDB, so a mocked model would
 * test the mock rather than the requirement.
 *
 * Runs against a real replica set when `MONGO_TEST_URI` is set:
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Skipped otherwise, and reported as skipped rather than passing silently — a
 * suite that quietly drops its most important test is worse than no suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { AlertModel } from '../src/db/models/alert.js'
import { NotificationModel } from '../src/db/models/notification.js'
import { raiseAlert } from '../src/alerts/dedupe.js'

const uri = process.env.MONGO_TEST_URI
const dbName = 'hoodium_test_dedupe'

const baseAlert = {
  chainId: 31337,
  ownerAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
  positionKey: '31337:0xpm:1',
  type: 'out_of_range' as const,
  severity: 'critical' as const,
  dedupeKey: 'out_of_range:31337:0xpm:1:upper',
  title: 'MEME/USDG is out of range',
  body: 'Price has moved past the upper boundary.',
  context: {},
  dedupeHours: 6,
}

describe.skipIf(!uri)('alert dedupe against MongoDB — AL-3.3', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName })
    await AlertModel.createIndexes()
  }, 30_000)

  afterAll(async () => {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    await AlertModel.deleteMany({})
    await NotificationModel.deleteMany({})
  })

  it('sends once for two identical alerts inside the window', async () => {
    const first = await raiseAlert(baseAlert)
    const second = await raiseAlert(baseAlert)

    expect(first.sent).toBe(true)
    expect(second.sent).toBe(false)
    expect(second.suppressed).toBe(true)
    expect(await AlertModel.countDocuments({ dedupeKey: baseAlert.dedupeKey })).toBe(1)
    expect(await NotificationModel.countDocuments({})).toBe(1)
  })

  it('sends once when two workers race on the same trigger', async () => {
    // The concurrency case the unique index exists for: no read-then-write gap
    // to lose, because MongoDB picks the winner.
    const results = await Promise.all(Array.from({ length: 8 }, () => raiseAlert(baseAlert)))

    expect(results.filter((r) => r.sent)).toHaveLength(1)
    expect(results.filter((r) => r.suppressed)).toHaveLength(7)
    expect(await NotificationModel.countDocuments({})).toBe(1)
  })

  it('sends again once the window has passed', async () => {
    await raiseAlert(baseAlert)
    // Age the existing alert past the 6-hour window.
    await AlertModel.updateOne(
      { dedupeKey: baseAlert.dedupeKey },
      { $set: { lastSentAt: new Date(Date.now() - 7 * 60 * 60 * 1000) } },
    )

    const again = await raiseAlert(baseAlert)
    expect(again.sent).toBe(true)

    const alert = await AlertModel.findOne({ dedupeKey: baseAlert.dedupeKey })
    expect(alert!.sendCount).toBe(2)
    // Still one alert row — the document is reused, so history is not lost.
    expect(await AlertModel.countDocuments({})).toBe(1)
    expect(await NotificationModel.countDocuments({})).toBe(2)
  })

  it('does not suppress a different position with the same alert type', async () => {
    await raiseAlert(baseAlert)
    const other = await raiseAlert({
      ...baseAlert,
      positionKey: '31337:0xpm:2',
      dedupeKey: 'out_of_range:31337:0xpm:2:upper',
    })

    expect(other.sent).toBe(true)
    expect(await AlertModel.countDocuments({})).toBe(2)
  })

  it('does not suppress the opposite boundary of the same position', async () => {
    await raiseAlert(baseAlert)
    const lower = await raiseAlert({ ...baseAlert, dedupeKey: 'out_of_range:31337:0xpm:1:lower' })

    expect(lower.sent).toBe(true)
    expect(await AlertModel.countDocuments({})).toBe(2)
  })
})

describe.skipIf(uri)('alert dedupe (skipped)', () => {
  it('needs MONGO_TEST_URI — set it to run the AL-3.3 test', () => {
    expect(uri).toBeUndefined()
  })
})
