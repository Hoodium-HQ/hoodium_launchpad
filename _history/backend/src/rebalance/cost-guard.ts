/**
 * Cost guard — T4.2, T4.3 / AL-5.1, AL-5.2, AL-5.3.
 *
 * The requirement this implements exists because of a measured failure, not a
 * hypothetical one: a 213-position analysis (July 2026) found ~4% of value
 * consumed by sell-side costs from excessive rebalancing. R5 states the purpose
 * plainly — "so Hoodium does not worsen the very problem it claims to solve".
 *
 * design section 6:
 *
 *     expectedBenefit = exposureReduction × positionValue × P(further adverse move)
 *     estimatedCost   = gas + slippage + swapFee + spread
 *
 *     execute only if:
 *       estimatedCost < expectedBenefit
 *       AND hoursSinceLastRebalance ≥ 4  OR  exposure ≥ emergencyThreshold
 *
 * Pure, and deliberately so: design section 1 puts decisions in the Evaluator precisely so
 * they can be tested against a table without a chain. Nothing here reads a clock,
 * a database or an RPC.
 *
 * **Not** this function's job: deciding whether the threshold was crossed at all.
 * That is the trigger condition in AL-4.1 and belongs to the Evaluator. This is
 * only ever asked "given that we want to act, should we?".
 */
import { Decimal } from '../lib/money.js'

export interface CostGuardInput {
  /** Current exposure, 0–100 (AL-2.2). */
  exposurePct: Decimal
  /** Exposure the replacement range would open at, 0–100. */
  targetExposurePct: Decimal
  /** AL-5.3 — at or above this, the cooldown is overridden. */
  emergencyThresholdPct: Decimal
  /** Total position value in quote-token units. */
  positionValueQuote: Decimal
  /** Pool fee tier as a percentage — a `fee` of 3000 is 0.3. */
  poolFeeTierPct: Decimal
  /** Slippage tolerance the swap would be quoted at, as a percentage. */
  slippagePct: Decimal
  /** Flat gas estimate for one full rebalance, in quote-token units. */
  gasCostQuote: Decimal
  /**
   * P(further adverse move). design section 9 open question 3: "fixed constant in v1, or
   * derived from realized volatility? Start with a constant; revisit once shadow
   * data exists." A constant, therefore, and shadow data is exactly what this
   * guard is now producing.
   */
  adverseMoveProbability: Decimal
  /** Null when the position has never been rebalanced. */
  hoursSinceLastRebalance: Decimal | null
  cooldownHours: Decimal
}

export type CostGuardReason =
  | 'threshold_breached'
  | 'emergency_threshold'
  | 'cost_exceeds_benefit'
  | 'cooldown'
  | 'no_exposure_reduction'

export interface CostGuardVerdict {
  decision: 'execute' | 'skip'
  reason: CostGuardReason
  /** Percentage points of exposure the action would remove. */
  exposureReductionPct: Decimal
  /** Value that would pass through a swap, in quote-token units. */
  swapValueQuote: Decimal
  estimatedCostQuote: Decimal
  expectedBenefitQuote: Decimal
}

export function evaluateCostGuard(input: CostGuardInput): CostGuardVerdict {
  const {
    exposurePct,
    targetExposurePct,
    emergencyThresholdPct,
    positionValueQuote,
    poolFeeTierPct,
    slippagePct,
    gasCostQuote,
    adverseMoveProbability,
    hoursSinceLastRebalance,
    cooldownHours,
  } = input

  const exposureReductionPct = exposurePct.minus(targetExposurePct)

  // A replacement that opens as exposed as the position already is buys nothing
  // and still pays for the round trip. Reported before the cooldown check
  // because it is a property of the plan, not of timing.
  if (exposureReductionPct.lte(0)) {
    return {
      decision: 'skip',
      reason: 'no_exposure_reduction',
      exposureReductionPct,
      swapValueQuote: new Decimal(0),
      estimatedCostQuote: gasCostQuote,
      expectedBenefitQuote: new Decimal(0),
    }
  }

  // Only the exposed share above the replacement's own base leg is actually
  // sold. Selling everything and buying the leg back would pay the spread twice
  // to arrive at the same place.
  const swapValueQuote = positionValueQuote.mul(exposureReductionPct).div(100)

  // gas + (slippage + swapFee + spread). Slippage and spread are not separable
  // ex ante on a pool this thin — the tolerance the swap is quoted at is the
  // honest upper bound for both.
  const estimatedCostQuote = gasCostQuote.plus(swapValueQuote.mul(poolFeeTierPct.plus(slippagePct)).div(100))
  const expectedBenefitQuote = swapValueQuote.mul(adverseMoveProbability)

  const numbers = { exposureReductionPct, swapValueQuote, estimatedCostQuote, expectedBenefitQuote }

  const emergency = exposurePct.gte(emergencyThresholdPct)

  // AL-5.3. Checked before the economics because it is categorical: inside the
  // window the answer is no regardless of how attractive the trade looks, and
  // that is the point — over-rebalancing is what the guard exists to stop.
  if (!emergency && hoursSinceLastRebalance !== null && hoursSinceLastRebalance.lt(cooldownHours)) {
    return { decision: 'skip', reason: 'cooldown', ...numbers }
  }

  // AL-5.2. Ties refuse: equal cost and benefit is a round trip that moves the
  // user's money and gains them nothing.
  if (estimatedCostQuote.gte(expectedBenefitQuote)) {
    return { decision: 'skip', reason: 'cost_exceeds_benefit', ...numbers }
  }

  return {
    decision: 'execute',
    reason: emergency ? 'emergency_threshold' : 'threshold_breached',
    ...numbers,
  }
}

/** Uniswap fee units are hundredths of a basis point: 3000 → 0.3%. */
export function feeTierToPct(fee: number): Decimal {
  return new Decimal(fee).div(10_000)
}
