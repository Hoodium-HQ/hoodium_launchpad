/**
 * Evaluator — T4.1, T4.3, T4.4, T4.5 / AL-4.1, AL-3.4, AL-5.3, AL-5.5.
 *
 * design section 1 gives this component one job and forbids it another:
 *
 *   | **Evaluator** | Apply thresholds + cost guard, emit an intent | Sign or broadcast |
 *
 * So this file decides and records. It never touches a wallet, never builds
 * calldata, and never reaches the chain — the Monitor hands it a snapshot that
 * has already been read.
 *
 * ── What happens when exposure crosses the threshold ─────────────────────────
 *
 *   1. Refuse outright if the system is not in a state to act at all: kill
 *      switch (AL-N8), suspended reads (AL-2.5).
 *   2. Plan the replacement range — `planRebalance`, pure tick math.
 *   3. Ask the cost guard (AL-5.1–5.3). It is the only thing that can approve.
 *   4. Record the decision, whichever way it went (AL-5.5).
 *   5. On approval, create an intent under an idempotency key (AL-4.3).
 *   6. In shadow mode, settle that intent as `SHADOW_LOGGED` and tell the user
 *      what would have happened (AL-3.4) — nothing is broadcast.
 *
 * Step 6 is the whole of the current phase. There is no Executor: `SHADOW_MODE`
 * cannot be turned off (config/env.ts refuses to boot), because a system that
 * silently declined to execute would be worse than one that says it will not.
 */
import { createHash } from 'node:crypto'
import type { Types } from 'mongoose'
import { componentLogger } from '../lib/logger.js'
import { Decimal } from '../lib/money.js'
import { killSwitch } from '../lib/kill-switch.js'
import type { Env } from '../config/env.js'
import { PositionModel, positionKey, type PositionDoc } from '../db/models/position.js'
import { ExecutionIntentModel } from '../db/models/execution-intent.js'
import { ShadowActionModel, type ShadowReason } from '../db/models/shadow-action.js'
import { planRebalance, type ExposureResult, type RebalancePlan } from '../monitor/rangemath.js'
import { evaluateCostGuard, feeTierToPct } from './cost-guard.js'
import { raiseAlert } from '../alerts/dedupe.js'

const log = componentLogger('evaluator')
const DUPLICATE_KEY = 11000

export interface RebalanceEvaluationInput {
  env: Env
  position: PositionDoc
  pool: { sqrtPriceX96: bigint; tick: number; blockNumber: number }
  exposure: ExposureResult
  /** AL-2.5 — two failed cycles suspend execution for the wallet. */
  executionSuspended: boolean
}

export type RebalanceOutcome =
  | { kind: 'not_triggered' }
  | { kind: 'skipped'; reason: ShadowReason }
  | { kind: 'intent'; reason: ShadowReason; intentId: Types.ObjectId }

export async function evaluateRebalance(input: RebalanceEvaluationInput): Promise<RebalanceOutcome> {
  const { env, position, pool, exposure } = input

  /*
   * AL-4.1's trigger. Below the threshold there is no decision to make, and so
   * nothing to record: AL-5.5 is about decisions, and "we were not asked to act"
   * is not one. Writing a row per healthy position per minute would bury the
   * refusals design section 6 actually wants counted.
   */
  if (exposure.exposurePct.lt(env.EXPOSURE_THRESHOLD_PCT)) return { kind: 'not_triggered' }

  const ctx = { position, pool, exposure, env }

  // Nothing below this point may act. Recorded rather than dropped, because
  // "the guard was up and we did not act" is data the comparison (AL-5.6) needs.
  if (killSwitch().isEngaged()) return skip(ctx, 'kill_switch', null, null)
  if (input.executionSuspended) return skip(ctx, 'execution_suspended', null, null)

  const tickSpacing = resolveTickSpacing(position)
  if (tickSpacing === null) {
    log.warn(
      { position: positionKey(position), fee: position.fee },
      'cannot plan a rebalance without a tick spacing — a range not aligned to it would be rejected by the pool',
    )
    return skip(ctx, 'unknown_tick_spacing', null, null)
  }

  let plan: RebalancePlan
  try {
    plan = planRebalance({
      sqrtPriceX96: pool.sqrtPriceX96,
      tickCurrent: pool.tick,
      tickSpacing,
      depthPct: env.REBALANCE_DEPTH_PCT,
      maxBasePct: env.REBALANCE_MAX_BASE_PCT,
    })
  } catch (err) {
    log.error({ err, position: positionKey(position) }, 'rebalance planning failed')
    return skip(ctx, 'plan_failed', null, null)
  }

  const lastRebalanceAt = lastRebalance(position, env)
  const verdict = evaluateCostGuard({
    exposurePct: exposure.exposurePct,
    targetExposurePct: plan.baseSharePct,
    emergencyThresholdPct: new Decimal(env.EMERGENCY_THRESHOLD_PCT),
    positionValueQuote: exposure.valueQuote,
    poolFeeTierPct: feeTierToPct(position.fee),
    slippagePct: new Decimal(env.REBALANCE_SLIPPAGE_PCT),
    gasCostQuote: new Decimal(env.REBALANCE_GAS_COST_QUOTE),
    adverseMoveProbability: new Decimal(env.ADVERSE_MOVE_PROBABILITY),
    hoursSinceLastRebalance: lastRebalanceAt === null ? null : hoursSince(lastRebalanceAt),
    cooldownHours: new Decimal(env.REBALANCE_COOLDOWN_HOURS),
  })

  if (verdict.decision === 'skip') {
    return skip(ctx, verdict.reason, plan, verdict)
  }

  // Approved. The intent is the ledger entry — one per approval, keyed so a
  // restart between deciding and acting cannot produce a second one (AL-N5).
  const intentId = await createIntent(ctx, plan, verdict)
  if (intentId === null) {
    // Another worker won the same trigger block. Its intent stands; ours would
    // have been identical.
    log.debug({ position: positionKey(position) }, 'duplicate intent suppressed by idempotency key (AL-4.3)')
    return { kind: 'skipped', reason: verdict.reason }
  }

  await record(ctx, 'execute', verdict.reason, plan, verdict, intentId)

  if (env.SHADOW_MODE) {
    await ExecutionIntentModel.updateOne(
      { _id: intentId, state: 'INTENT_CREATED' },
      { $set: { state: 'SHADOW_LOGGED', settledAt: new Date() } },
    )
    // The cooldown has to bite in shadow mode too, or the recorded behaviour is
    // not the behaviour Phase 5 would have (AL-5.3, AL-5.6).
    await PositionModel.updateOne({ _id: position._id }, { $set: { lastShadowRebalanceAt: new Date() } })
    await notifyShadowDecision(ctx, plan, verdict)
  }

  log.info(
    {
      position: positionKey(position),
      exposurePct: exposure.exposurePct.toFixed(2),
      reason: verdict.reason,
      costQuote: verdict.estimatedCostQuote.toFixed(),
      benefitQuote: verdict.expectedBenefitQuote.toFixed(),
      shadow: env.SHADOW_MODE,
    },
    // AL-N7 — every execution decision logged structurally, with inputs and reason.
    'rebalance approved',
  )

  return { kind: 'intent', reason: verdict.reason, intentId }
}

// ── Internals ───────────────────────────────────────────────────────────────

type Ctx = Pick<RebalanceEvaluationInput, 'env' | 'position' | 'pool' | 'exposure'>
type Verdict = ReturnType<typeof evaluateCostGuard>

/**
 * Uniswap's canonical v3 fee-to-spacing table. Only a fallback: discovery stores
 * the pool's own `tickSpacing`, and v4 pools may use any value at all — which is
 * why an unknown fee returns null rather than a guess. A range guessed onto the
 * wrong grid is a mint that reverts.
 */
const V3_FEE_TO_TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10_000: 200 }

function resolveTickSpacing(position: PositionDoc): number | null {
  if (position.tickSpacing && position.tickSpacing > 0) return position.tickSpacing
  return V3_FEE_TO_TICK_SPACING[position.fee] ?? null
}

/** AL-5.3's clock. In shadow mode a recorded decision counts as a rebalance. */
function lastRebalance(position: PositionDoc, env: Env): Date | null {
  const executed = position.lastRebalanceAt ?? null
  const shadowed = env.SHADOW_MODE ? (position.lastShadowRebalanceAt ?? null) : null
  if (executed && shadowed) return executed > shadowed ? executed : shadowed
  return executed ?? shadowed
}

function hoursSince(at: Date): Decimal {
  return new Decimal(Date.now() - at.getTime()).div(60 * 60 * 1000)
}

/**
 * design section 2: `idempotencyKey = sha256(positionId | action | triggerBlockNumber | thresholdVersion)`.
 *
 * The threshold version is part of it so that changing a threshold produces a
 * fresh key — otherwise a re-tuned system would be unable to act on a position
 * it had already decided about at the old setting.
 */
function idempotencyKey(env: Env, position: PositionDoc, action: string, blockNumber: number): string {
  const thresholdVersion = `${env.EXPOSURE_THRESHOLD_PCT}/${env.EMERGENCY_THRESHOLD_PCT}`
  return createHash('sha256')
    .update([positionKey(position), action, String(blockNumber), thresholdVersion].join('|'))
    .digest('hex')
}

async function createIntent(ctx: Ctx, plan: RebalancePlan, verdict: Verdict): Promise<Types.ObjectId | null> {
  const { env, position, pool, exposure } = ctx
  try {
    const intent = await ExecutionIntentModel.create({
      chainId: position.chainId,
      ownerAddress: position.ownerAddress,
      positionKey: positionKey(position),
      idempotencyKey: idempotencyKey(env, position, 'rebalance', pool.blockNumber),
      action: 'rebalance',
      reason: verdict.reason,
      state: 'INTENT_CREATED',
      triggerBlockNumber: pool.blockNumber,
      exposurePct: exposure.exposurePct,
      positionValueQuote: exposure.valueQuote,
      estimatedCostQuote: verdict.estimatedCostQuote,
      expectedBenefitQuote: verdict.expectedBenefitQuote,
      plan: {
        tickLower: plan.tickLower,
        tickUpper: plan.tickUpper,
        targetExposurePct: plan.baseSharePct,
        dropPct: plan.dropPct,
        offsetPct: plan.offsetPct,
        inRangeAtOpen: plan.inRangeAtOpen,
      },
    })
    return intent._id
  } catch (err) {
    if (isDuplicateKey(err)) return null
    throw err
  }
}

/**
 * AL-5.5 — record the decision.
 *
 * Identical verdicts collapse onto one row and increment `occurrences` rather
 * than inserting once a minute; see the model for why. The row always carries
 * the *latest* numbers, and the per-approval detail lives in `execution_intents`,
 * so nothing is lost by the collapse.
 */
async function record(
  ctx: Ctx,
  decision: 'execute' | 'skip',
  reason: ShadowReason,
  plan: RebalancePlan | null,
  verdict: Verdict | null,
  intentId: Types.ObjectId | null = null,
): Promise<void> {
  const { env, position, pool, exposure } = ctx
  const key = positionKey(position)
  const now = new Date()

  const update = {
    $set: {
      triggerBlockNumber: pool.blockNumber,
      exposurePct: exposure.exposurePct,
      thresholdPct: new Decimal(env.EXPOSURE_THRESHOLD_PCT),
      positionValueQuote: exposure.valueQuote,
      estimatedCostQuote: verdict?.estimatedCostQuote ?? null,
      expectedBenefitQuote: verdict?.expectedBenefitQuote ?? null,
      plan: {
        tickLower: plan?.tickLower ?? null,
        tickUpper: plan?.tickUpper ?? null,
        targetExposurePct: plan?.baseSharePct ?? null,
        inRangeAtOpen: plan?.inRangeAtOpen ?? null,
      },
      ...(intentId ? { intentId } : {}),
      lastAt: now,
    },
    $setOnInsert: {
      chainId: position.chainId,
      ownerAddress: position.ownerAddress,
      positionKey: key,
      action: 'rebalance' as const,
      decision,
      reason,
      dedupeKey: `rebalance:${decision}:${reason}:${key}`,
      firstAt: now,
    },
    $inc: { occurrences: 1 },
  }

  const filter = { dedupeKey: `rebalance:${decision}:${reason}:${key}` }
  try {
    await ShadowActionModel.updateOne(filter, update, { upsert: true })
  } catch (err) {
    // Two workers upserting the same new key: one inserts, the other collides.
    // The row now exists, so the same update applied again is the increment.
    if (!isDuplicateKey(err)) throw err
    await ShadowActionModel.updateOne(filter, update, { upsert: true })
  }

  if (decision === 'skip') {
    // AL-N7 — refusals are decisions, and they are logged like decisions.
    log.debug({ position: key, reason, exposurePct: exposure.exposurePct.toFixed(2) }, 'rebalance refused')
  }
}

/** Record a refusal and report it. Every non-approving path leaves through here. */
async function skip(
  ctx: Ctx,
  reason: ShadowReason,
  plan: RebalancePlan | null,
  verdict: Verdict | null,
): Promise<RebalanceOutcome> {
  await record(ctx, 'skip', reason, plan, verdict)
  return { kind: 'skipped', reason }
}

/**
 * AL-3.4 — "WHEN exposure crosses the threshold WHILE automation is disabled THEN
 * the system SHALL tell the user what it **would** have done."
 *
 * Deliberately concrete: the range, the cost, and whether the replacement would
 * be earning from the first block. A message that only said "I would have
 * rebalanced" gives the user nothing to disagree with, and disagreement is the
 * signal the shadow period exists to collect (AL-5.6).
 */
async function notifyShadowDecision(ctx: Ctx, plan: RebalancePlan, verdict: Verdict): Promise<void> {
  const { env, position, pool, exposure } = ctx
  const pair = `${position.token0.symbol}/${position.token1.symbol}`
  const baseSymbol = position.quoteIsToken0 ? position.token1.symbol : position.token0.symbol
  const quote = env.QUOTE_TOKEN_SYMBOL

  const body =
    `Exposure to ${baseSymbol} reached ${exposure.exposurePct.toFixed(1)}%, past the ` +
    `${env.EXPOSURE_THRESHOLD_PCT}% threshold. Automation is in shadow mode, so nothing was executed. ` +
    `What it would have done: exit the position and reopen it at ticks ` +
    `[${plan.tickLower}, ${plan.tickUpper}] — a range ${plan.dropPct.toFixed(1)}% deep that would open ` +
    (plan.inRangeAtOpen
      ? `in range and earning immediately, with ${plan.baseSharePct.toFixed(1)}% starting exposure. `
      : `just below price, fully in ${quote} and earning nothing until price falls into it. `) +
    `Estimated cost ${verdict.estimatedCostQuote.toFixed(2)} ${quote} against an expected benefit of ` +
    `${verdict.expectedBenefitQuote.toFixed(2)} ${quote}.`

  await raiseAlert({
    chainId: position.chainId,
    ownerAddress: position.ownerAddress,
    positionKey: positionKey(position),
    type: 'rebalance_shadow',
    severity: verdict.reason === 'emergency_threshold' ? 'critical' : 'warning',
    dedupeKey: `rebalance_shadow:${positionKey(position)}`,
    title: `${pair} — exposure ${exposure.exposurePct.toFixed(0)}%, a rebalance was simulated`,
    body,
    context: {
      exposurePct: exposure.exposurePct.toFixed(),
      price: exposure.price.toFixed(),
      tickCurrent: pool.tick,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      decision: 'execute',
      reason: verdict.reason,
      targetTickLower: plan.tickLower,
      targetTickUpper: plan.tickUpper,
      targetExposurePct: plan.baseSharePct.toFixed(),
      estimatedCostQuote: verdict.estimatedCostQuote.toFixed(),
      expectedBenefitQuote: verdict.expectedBenefitQuote.toFixed(),
      shadow: true,
    },
    dedupeHours: env.ALERT_DEDUPE_HOURS,
  })
}

function isDuplicateKey(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; cause?: { code?: number }; codeName?: string }
  return e.code === DUPLICATE_KEY || e.cause?.code === DUPLICATE_KEY || e.codeName === 'DuplicateKey'
}
