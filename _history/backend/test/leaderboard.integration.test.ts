/**
 * LP leaderboard aggregation.
 *
 * The thing worth testing here is the double-count trap: snapshots arrive once a
 * minute per position, so a pipeline that groups straight to owner sums the same
 * position once per sample. A mocked model would happily agree with whichever
 * pipeline it was handed, so this runs against a real MongoDB:
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Skipped otherwise, and reported as skipped rather than passing silently.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { PositionSnapshotModel } from '../src/db/models/position-snapshot.js'
import { WalletModel } from '../src/db/models/wallet.js'
import { getLeaderboard, resetLeaderboardCacheForTesting } from '../src/leaderboard/lps.js'

const uri = process.env.MONGO_TEST_URI
const dbName = 'hoodium_test_leaderboard'
const CHAIN_ID = 31337

const ALICE = '0xaaaa000000000000000000000000000000000001'
const BOB = '0xbbbb000000000000000000000000000000000002'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** One snapshot row, with only the fields the leaderboard reads varying. */
function snapshot(opts: {
  owner: string
  positionKey: string
  agoMs: number
  valueQuote: string
  inRange?: boolean
}) {
  return {
    at: new Date(Date.now() - opts.agoMs),
    meta: { positionKey: opts.positionKey, ownerAddress: opts.owner, chainId: CHAIN_ID },
    blockNumber: 1,
    tickCurrent: 0,
    sqrtPriceX96: '79228162514264337593543950336',
    liquidity: '1000',
    amount0: '0',
    amount1: '0',
    exposurePct: '50',
    valueQuote: opts.valueQuote,
    price: '1',
    inRange: opts.inRange ?? true,
  }
}

describe.skipIf(!uri)('LP leaderboard aggregation', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName })
  }, 30_000)

  afterAll(async () => {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    /*
     * Time-series collections reject `deleteMany` on non-meta fields, and
     * dropping the view alone leaves its `system.buckets.*` collection behind —
     * which then refuses the re-create. Dropping the database takes both.
     */
    await mongoose.connection.dropDatabase()
    await mongoose.connection.createCollection('position_snapshots', {
      timeseries: { timeField: 'at', metaField: 'meta', granularity: 'seconds' },
    })
    resetLeaderboardCacheForTesting()
  })

  it('counts each position once, not once per snapshot', async () => {
    // Three samples of the same position, five minutes apart. A naive pipeline
    // reports 3 positions worth 300.
    await PositionSnapshotModel.insertMany([
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: 1 * MINUTE, valueQuote: '100' }),
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: 5 * MINUTE, valueQuote: '90' }),
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: 9 * MINUTE, valueQuote: '80' }),
    ])

    const board = await getLeaderboard(CHAIN_ID)

    expect(board.lps).toHaveLength(1)
    expect(board.lps[0]!.positions).toBe(1)
    // The most recent sample wins, not the first one written.
    expect(Number(board.lps[0]!.valueQuote)).toBe(100)
  })

  it('ranks by total value across positions and counts in-range', async () => {
    await PositionSnapshotModel.insertMany([
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: MINUTE, valueQuote: '100' }),
      snapshot({ owner: ALICE, positionKey: 'p2', agoMs: MINUTE, valueQuote: '50', inRange: false }),
      snapshot({ owner: BOB, positionKey: 'p3', agoMs: MINUTE, valueQuote: '400' }),
    ])

    const board = await getLeaderboard(CHAIN_ID)

    expect(board.lps.map((l) => l.address)).toEqual([BOB, ALICE])
    expect(board.lps[0]!.rank).toBe(1)
    expect(Number(board.lps[1]!.valueQuote)).toBe(150)
    expect(board.lps[1]!.positions).toBe(2)
    expect(board.lps[1]!.inRange).toBe(1)
  })

  it('drops positions whose snapshots stopped arriving', async () => {
    // A closed position stops being snapshotted; it must not linger on the board
    // at whatever it was worth the day it closed.
    await PositionSnapshotModel.insertMany([
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: MINUTE, valueQuote: '100' }),
      snapshot({ owner: BOB, positionKey: 'p3', agoMs: 3 * 60 * MINUTE, valueQuote: '9999' }),
    ])

    const board = await getLeaderboard(CHAIN_ID)

    expect(board.lps.map((l) => l.address)).toEqual([ALICE])
  })

  it('reports 24h change against a snapshot from a day ago, and null without one', async () => {
    await PositionSnapshotModel.insertMany([
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: MINUTE, valueQuote: '150' }),
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: DAY + 5 * MINUTE, valueQuote: '100' }),
      // Bob only started today, so his change is unknown — not flat.
      snapshot({ owner: BOB, positionKey: 'p3', agoMs: MINUTE, valueQuote: '400' }),
    ])

    const board = await getLeaderboard(CHAIN_ID)
    const alice = board.lps.find((l) => l.address === ALICE)!
    const bob = board.lps.find((l) => l.address === BOB)!

    expect(Number(alice.changePct)).toBeCloseTo(50, 2)
    expect(bob.changePct).toBeNull()
  })

  it('omits an address that opted out', async () => {
    await PositionSnapshotModel.insertMany([
      snapshot({ owner: ALICE, positionKey: 'p1', agoMs: MINUTE, valueQuote: '100' }),
      snapshot({ owner: BOB, positionKey: 'p3', agoMs: MINUTE, valueQuote: '400' }),
    ])
    await WalletModel.create({ chainId: CHAIN_ID, address: BOB, leaderboardOptOut: true })

    const board = await getLeaderboard(CHAIN_ID)

    expect(board.lps.map((l) => l.address)).toEqual([ALICE])
    expect(board.total).toBe(1)
  })
})
