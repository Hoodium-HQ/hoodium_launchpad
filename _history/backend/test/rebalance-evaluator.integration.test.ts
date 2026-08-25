/**
 * T4.1, T4.3, T4.4 · AL-4.3, AL-5.3, AL-5.5, AL-N5.
 *
 * Two of these guarantees cannot be faked with a mock, and they are the two
 * design section 8 calls "the most expensive requirements to get wrong and the cheapest to
 * test": the idempotency key is enforced by a unique index, and the decision
 * record is a conditional upsert. A mocked model would be testing the mock.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 npm test
 *
 * Skipped otherwise, and reported as skipped rather than passing silently.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { loadEnv, type Env } from '../src/config/env.js'
import { initKillSwitch, setKillSwitch } from '../src/lib/kill-switch.js'
import { PositionModel, positionKey } from '../src/db/models/position.js'
import { ExecutionIntentModel } from '../src/db/models/execution-intent.js'
import { ShadowActionModel } from '../src/db/models/shadow-action.js'
import { AlertModel } from '../src/db/models/alert.js'
import { NotificationModel } from '../src/db/models/notification.js'
import { SystemFlagModel } from '../src/db/models/system-flag.js'
import { computeExposure, getSqrtRatioAtTick } from '../src/monitor/rangemath.js'
import { evaluateRebalance } from '../src/rebalance/evaluator.js'

const uri = process.env.MONGO_TEST_URI
const dbName = 'hoodium_test_rebalance'
const CHAIN_ID = 31337

const OWNER = '0xaaaa000000000000000000000000000000000001'
const POSITION_MANAGER = '0x' + '2'.repeat(40)

/*
 * A position whose range is symmetric around tick 0, priced 500 ticks below the
 * middle. That puts ~74% of its value in token0 — past the 68% threshold and
 * short of the 85% emergency one, which is the interesting band.
 */
const TICK_LOWER = -1_000
const TICK_UPPER = 1_000
const TICK_NOW = -500
const LIQUIDITY = 10n ** 22n
const BLOCK = 4_242

function env(overrides: Partial<Record<string, string>> = {}): Env {
  return loadEnv({
    APP_ENV: 'local',
    CHAIN_ID: String(CHAIN_ID),
    ROBINHOOD_MAINNET_CHAIN_ID: '4663',
    ROBINHOOD_TESTNET_CHAIN_ID: String(CHAIN_ID),
    RPC_PRIMARY: 'https://rpc.example/1',
    RPC_FALLBACK: 'https://rpc.example/2',
    MONGO_URI: uri ?? 'mongodb://127.0.0.1:27017',
    QUOTE_TOKEN_ADDRESS: '0x' + '1'.repeat(40),
    POSITION_MANAGER_ADDRESS: POSITION_MANAGER,
    UNISWAP_V3_FACTORY_ADDRESS: '0x' + '3'.repeat(40),
    APP_ORIGIN: 'https://local.hoodium.app',
    ...overrides,
  })
}

const pool = { sqrtPriceX96: getSqrtRatioAtTick(TICK_NOW), tick: TICK_NOW, blockNumber: BLOCK }

const exposure = computeExposure({
  sqrtPriceX96: pool.sqrtPriceX96,
  tickCurrent: TICK_NOW,
  tickLower: TICK_LOWER,
  tickUpper: TICK_UPPER,
  liquidity: LIQUIDITY,
  quoteIsToken0: false,
  decimals0: 18,
  decimals1: 18,
})

async function makePosition(overrides: Record<string, unknown> = {}) {
  return PositionModel.create({
    chainId: CHAIN_ID,
    positionManager: POSITION_MANAGER,
    tokenId: '1',
    ownerAddress: OWNER,
    poolAddress: '0x' + '4'.repeat(40),
    token0: { address: '0x' + '5'.repeat(40), symbol: 'MEME', decimals: 18 },
    token1: { address: '0x' + '1'.repeat(40), symbol: 'USDG', decimals: 18 },
    fee: 3000,
    tickSpacing: 60,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    liquidity: LIQUIDITY.toString(),
    quoteIsToken0: false,
    ...overrides,
  })
}

describe.skipIf(!uri)('rebalance evaluator against MongoDB', () => {
  beforeAll(async () => {
    await mongoose.connect(uri!, { dbName })
    await Promise.all([ExecutionIntentModel.createIndexes(), ShadowActionModel.createIndexes(), AlertModel.createIndexes()])
  }, 30_000)

  afterAll(async () => {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  beforeEach(async () => {
    initKillSwitch(false)
    await Promise.all([
      PositionModel.deleteMany({}),
      ExecutionIntentModel.deleteMany({}),
      ShadowActionModel.deleteMany({}),
      AlertModel.deleteMany({}),
      NotificationModel.deleteMany({}),
      SystemFlagModel.deleteMany({}),
    ])
  })

  afterEach(async () => {
    await setKillSwitch(false, '', 'test')
  })

  it('puts the fixture in the band this suite is about', () => {
    expect(exposure.exposurePct.toNumber()).toBeGreaterThan(68)
    expect(exposure.exposurePct.toNumber()).toBeLessThan(85)
  })

  it('approves past the threshold and settles the intent in shadow mode', async () => {
    const position = await makePosition()

    const outcome = await evaluateRebalance({
      env: env(),
      position,
      pool,
      exposure,
      executionSuspended: false,
    })

    expect(outcome.kind).toBe('intent')
    if (outcome.kind !== 'intent') return
    expect(outcome.reason).toBe('threshold_breached')

    // AL-5.5 — the decision is recorded.
    const action = await ShadowActionModel.findOne({ positionKey: positionKey(position) })
    expect(action!.decision).toBe('execute')
    expect(action!.plan.tickUpper!).toBeGreaterThan(action!.plan.tickLower!)

    // Nothing was broadcast: the intent stops at SHADOW_LOGGED and carries no tx.
    const intent = await ExecutionIntentModel.findById(outcome.intentId)
    expect(intent!.state).toBe('SHADOW_LOGGED')
    expect(intent!.txHash).toBeNull()
    expect(intent!.settledAt).not.toBeNull()
    expect(intent!.triggerBlockNumber).toBe(BLOCK)

    // AL-3.4 — the user is told what would have happened.
    const notification = await NotificationModel.findOne({ type: 'rebalance_shadow' })
    expect(notification).not.toBeNull()
    expect(notification!.body).toContain(String(intent!.plan.tickLower))
  })

  it('refuses the second pass inside the cooldown, and counts it (AL-5.3)', async () => {
    const position = await makePosition()
    await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false })

    // Re-read: the first pass anchored the cooldown on the document.
    const refreshed = (await PositionModel.findById(position._id))!
    expect(refreshed.lastShadowRebalanceAt).not.toBeNull()

    const second = await evaluateRebalance({
      env: env(),
      pool: { ...pool, blockNumber: BLOCK + 1 },
      position: refreshed,
      exposure,
      executionSuspended: false,
    })

    expect(second).toEqual({ kind: 'skipped', reason: 'cooldown' })
    expect(await ExecutionIntentModel.countDocuments({})).toBe(1)

    const third = await evaluateRebalance({
      env: env(),
      pool: { ...pool, blockNumber: BLOCK + 2 },
      position: refreshed,
      exposure,
      executionSuspended: false,
    })
    expect(third).toEqual({ kind: 'skipped', reason: 'cooldown' })

    // One row for the refusal, not one per pass — with the count kept.
    const refusals = await ShadowActionModel.find({ decision: 'skip', reason: 'cooldown' })
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.occurrences).toBe(2)
    expect(refusals[0]!.firstAt.getTime()).toBeLessThanOrEqual(refusals[0]!.lastAt.getTime())
  })

  it('produces exactly one intent when workers race on the same block (AL-4.3, AL-N5)', async () => {
    const position = await makePosition()

    // Every worker sees the same position document, so none of them is held off
    // by the cooldown — the only thing that can separate them is the unique
    // index on the idempotency key.
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false }),
      ),
    )

    expect(outcomes.filter((o) => o.kind === 'intent')).toHaveLength(1)
    expect(await ExecutionIntentModel.countDocuments({})).toBe(1)
  })

  it('treats a different block as a different decision', async () => {
    const position = await makePosition()
    await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false })

    // Same position, later block, and the cooldown deliberately not re-read —
    // the key must differ, or a genuinely new trigger could never be acted on.
    const later = await evaluateRebalance({
      env: env(),
      position,
      pool: { ...pool, blockNumber: BLOCK + 1 },
      exposure,
      executionSuspended: false,
    })

    expect(later.kind).toBe('intent')
    expect(await ExecutionIntentModel.countDocuments({})).toBe(2)
  })

  it('records nothing at all below the threshold', async () => {
    const position = await makePosition()
    const calm = computeExposure({
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tickCurrent: 0,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: LIQUIDITY,
      quoteIsToken0: false,
      decimals0: 18,
      decimals1: 18,
    })
    expect(calm.exposurePct.toNumber()).toBeLessThan(68)

    const outcome = await evaluateRebalance({
      env: env(),
      position,
      pool: { sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, blockNumber: BLOCK },
      exposure: calm,
      executionSuspended: false,
    })

    expect(outcome).toEqual({ kind: 'not_triggered' })
    expect(await ShadowActionModel.countDocuments({})).toBe(0)
    expect(await ExecutionIntentModel.countDocuments({})).toBe(0)
  })

  it('halts on the kill switch and says so (AL-N8)', async () => {
    const position = await makePosition()
    await setKillSwitch(true, 'incident drill', 'test')

    const outcome = await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'kill_switch' })
    expect(await ExecutionIntentModel.countDocuments({})).toBe(0)
    expect(await ShadowActionModel.countDocuments({ reason: 'kill_switch' })).toBe(1)
  })

  it('does not act on degraded reads (AL-2.5)', async () => {
    const position = await makePosition()

    const outcome = await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: true })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'execution_suspended' })
    expect(await ExecutionIntentModel.countDocuments({})).toBe(0)
  })

  it('refuses a pool whose tick grid it cannot know', async () => {
    // v4 pools may use any tick spacing, so an unrecognised fee with no stored
    // spacing is a refusal rather than a guess — a misaligned mint reverts.
    const position = await makePosition({ tickSpacing: null, fee: 4_242 })

    const outcome = await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unknown_tick_spacing' })
  })

  it('falls back to the canonical v3 spacing when the pool stored none', async () => {
    const position = await makePosition({ tickSpacing: null, fee: 3_000 })

    const outcome = await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false })

    expect(outcome.kind).toBe('intent')
    if (outcome.kind !== 'intent') return
    const intent = await ExecutionIntentModel.findById(outcome.intentId)
    // `% 60 === 0` rather than `toBe(0)`: these ticks are negative, and a
    // negative multiple leaves -0, which Object.is separates from 0.
    expect(intent!.plan.tickLower % 60 === 0).toBe(true)
    expect(intent!.plan.tickUpper % 60 === 0).toBe(true)
  })

  it('refuses when the round trip costs more than it protects (AL-5.2)', async () => {
    const position = await makePosition()
    // Same exposure, a gas figure no position of this size could justify.
    const outcome = await evaluateRebalance({
      env: env({ REBALANCE_GAS_COST_QUOTE: '100000' }),
      position,
      pool,
      exposure,
      executionSuspended: false,
    })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'cost_exceeds_benefit' })
    const action = await ShadowActionModel.findOne({ reason: 'cost_exceeds_benefit' })
    // The refusal carries the numbers that produced it — design section 6 wants these
    // counted, and a reason without its arithmetic cannot be argued with.
    expect(Number(action!.estimatedCostQuote!.toString())).toBeGreaterThan(
      Number(action!.expectedBenefitQuote!.toString()),
    )
  })

  it('overrides the cooldown once exposure reaches the emergency threshold (AL-5.3)', async () => {
    const position = await makePosition()
    await evaluateRebalance({ env: env(), position, pool, exposure, executionSuspended: false })
    const refreshed = (await PositionModel.findById(position._id))!

    const deep = computeExposure({
      sqrtPriceX96: getSqrtRatioAtTick(-900),
      tickCurrent: -900,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: LIQUIDITY,
      quoteIsToken0: false,
      decimals0: 18,
      decimals1: 18,
    })
    expect(deep.exposurePct.toNumber()).toBeGreaterThan(85)

    const outcome = await evaluateRebalance({
      env: env(),
      position: refreshed,
      pool: { sqrtPriceX96: getSqrtRatioAtTick(-900), tick: -900, blockNumber: BLOCK + 1 },
      exposure: deep,
      executionSuspended: false,
    })

    expect(outcome.kind).toBe('intent')
    if (outcome.kind !== 'intent') return
    expect(outcome.reason).toBe('emergency_threshold')
  })
})

describe.skipIf(uri)('rebalance evaluator (skipped)', () => {
  it('needs MONGO_TEST_URI — set it to run the AL-4.3 and AL-5.5 tests', () => {
    expect(uri).toBeUndefined()
  })
})
