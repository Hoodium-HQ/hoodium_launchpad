/**
 * T4.2, T4.3 · AL-5.1, AL-5.2, AL-5.3 — the cost guard as a decision table.
 *
 * Tasks: "Cost-guard decision function · test: decision table". Pure inputs,
 * pure outputs, no chain and no clock — which is the property design section 1 split the
 * Evaluator out to get.
 */
import { describe, expect, it } from 'vitest'
import Decimal from 'decimal.js'
import { evaluateCostGuard, feeTierToPct, type CostGuardInput } from '../src/rebalance/cost-guard.js'

const d = (v: string | number) => new Decimal(v)

/**
 * A position well past the threshold, in a pool cheap enough that acting is
 * clearly worth it. Every case below is this, minus one thing.
 *
 *   swap value  = 1000 × (75 − 1)/100  = 740 quote
 *   cost        = 0.5 + 740 × 0.8%     ≈ 6.42 quote
 *   benefit     = 740 × 0.35           = 259 quote
 */
const baseline: CostGuardInput = {
  exposurePct: d(75),
  targetExposurePct: d(1),
  emergencyThresholdPct: d(85),
  positionValueQuote: d(1000),
  poolFeeTierPct: feeTierToPct(3000), // 0.3%
  slippagePct: d('0.5'),
  gasCostQuote: d('0.50'),
  adverseMoveProbability: d('0.35'),
  hoursSinceLastRebalance: null,
  cooldownHours: d(4),
}

describe('evaluateCostGuard', () => {
  it('approves a position past the threshold when the trade pays for itself', () => {
    const v = evaluateCostGuard(baseline)
    expect(v.decision).toBe('execute')
    expect(v.reason).toBe('threshold_breached')
    expect(v.swapValueQuote.toNumber()).toBeCloseTo(740, 6)
    expect(v.estimatedCostQuote.toNumber()).toBeCloseTo(6.42, 2)
    expect(v.expectedBenefitQuote.toNumber()).toBeCloseTo(259, 6)
  })

  it('refuses inside the 4-hour cooldown (AL-5.3)', () => {
    const v = evaluateCostGuard({ ...baseline, hoursSinceLastRebalance: d('3.9') })
    expect(v.decision).toBe('skip')
    expect(v.reason).toBe('cooldown')
    // The numbers are still reported: a refusal without them cannot be reviewed.
    expect(v.expectedBenefitQuote.toNumber()).toBeGreaterThan(0)
  })

  it('acts once the cooldown has elapsed', () => {
    expect(evaluateCostGuard({ ...baseline, hoursSinceLastRebalance: d(4) }).decision).toBe('execute')
  })

  it('overrides the cooldown at the emergency threshold (AL-5.3)', () => {
    const v = evaluateCostGuard({ ...baseline, exposurePct: d(85), hoursSinceLastRebalance: d('0.1') })
    expect(v.decision).toBe('execute')
    expect(v.reason).toBe('emergency_threshold')
  })

  it('refuses when cost exceeds benefit (AL-5.2)', () => {
    // A dust position: the same gas, spread over almost nothing to protect.
    const v = evaluateCostGuard({ ...baseline, positionValueQuote: d('1.5') })
    expect(v.decision).toBe('skip')
    expect(v.reason).toBe('cost_exceeds_benefit')
    expect(v.estimatedCostQuote.gte(v.expectedBenefitQuote)).toBe(true)
  })

  it('refuses on a tie — a round trip that gains nothing is not worth taking', () => {
    // Choose gas so that cost == benefit exactly:
    //   benefit = 740 × 0.35 = 259 ; swapCost = 740 × 0.8% = 5.92 ; gas = 253.08
    const v = evaluateCostGuard({ ...baseline, gasCostQuote: d('253.08') })
    expect(v.estimatedCostQuote.eq(v.expectedBenefitQuote)).toBe(true)
    expect(v.decision).toBe('skip')
    expect(v.reason).toBe('cost_exceeds_benefit')
  })

  it('applies the cost guard even in an emergency (AL-5.1 has no exemption)', () => {
    const v = evaluateCostGuard({
      ...baseline,
      exposurePct: d(90),
      positionValueQuote: d('1.5'),
      hoursSinceLastRebalance: d('0.1'),
    })
    expect(v.decision).toBe('skip')
    expect(v.reason).toBe('cost_exceeds_benefit')
  })

  it('refuses a replacement that would open no less exposed', () => {
    const v = evaluateCostGuard({ ...baseline, targetExposurePct: d(75) })
    expect(v.decision).toBe('skip')
    expect(v.reason).toBe('no_exposure_reduction')
    expect(v.expectedBenefitQuote.toNumber()).toBe(0)
  })

  it('refuses when the replacement would be more exposed than the position is now', () => {
    const v = evaluateCostGuard({ ...baseline, exposurePct: d(70), targetExposurePct: d(80) })
    expect(v.reason).toBe('no_exposure_reduction')
    expect(v.exposureReductionPct.isNegative()).toBe(true)
  })

  it('lets a fee tier make the difference on a marginal position', () => {
    // Benefit is 35% of the swapped value, so a 40% round trip cannot pay for
    // itself and a 30.05% one can.
    const marginal = { ...baseline, slippagePct: d(30), poolFeeTierPct: feeTierToPct(100_000) }
    expect(evaluateCostGuard(marginal).decision).toBe('skip')
    expect(evaluateCostGuard({ ...marginal, poolFeeTierPct: feeTierToPct(500) }).decision).toBe('execute')
  })

  it('reads Uniswap fee units as hundredths of a basis point', () => {
    expect(feeTierToPct(100).toNumber()).toBe(0.01)
    expect(feeTierToPct(500).toNumber()).toBe(0.05)
    expect(feeTierToPct(3000).toNumber()).toBe(0.3)
    expect(feeTierToPct(10_000).toNumber()).toBe(1)
  })
})
