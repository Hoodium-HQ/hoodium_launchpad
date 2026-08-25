/**
 * Tick math — re-exported from `@hoodium/shared/tickmath`.
 *
 * 003/design.md section 2 is the reason it moved: "Tick math (AL-2.2) and curve
 * math must produce identical results on both sides — the frontend previews a
 * trade, the backend decides on one. Two implementations mean two answers, and
 * the divergence surfaces as a user losing money on a bad preview."
 *
 * The implementation and its 27 fixture tests are unchanged; only their home is.
 */
export {
  Decimal,
  MIN_TICK,
  MAX_TICK,
  Q96,
  getSqrtRatioAtTick,
  priceFromSqrtRatio,
  priceAtTick,
  humanPrice,
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  getAmountsForLiquidity,
  computeExposure,
  planRebalance,
  type ExposureInput,
  type ExposureResult,
  type RebalancePlan,
  type RebalancePlanInput,
} from '@hoodium/shared/tickmath'
