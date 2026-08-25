/**
 * `@hoodium/shared` — the one place a definition lives.
 *
 * WA-N6: "Shared types SHALL come from one package consumed by both frontend and
 * backend; no duplicated ABI or model definitions."
 *
 * 003/design.md section 2 names this package as "the load-bearing piece", and
 * says why: tick math and curve math "must produce identical results on both
 * sides — the frontend previews a trade, the backend decides on one. Two
 * implementations mean two answers, and the divergence surfaces as a user losing
 * money on a bad preview."
 *
 * Subpath imports keep consumers from pulling in more than they use:
 *
 *   import { computeExposure } from '@hoodium/shared/tickmath'
 *   import { compareToHodl }   from '@hoodium/shared/performance'
 *   import { quoteBuy }        from '@hoodium/shared/curve'
 *   import { formatAmount }    from '@hoodium/shared/money'
 *   import { bondingCurveAbi } from '@hoodium/shared/abi'
 *   import type { Position }   from '@hoodium/shared/types'
 */
export * from './abi/index.js'
export * from './money/index.js'
export * from './tickmath/index.js'
export * from './types/index.js'
/*
 * Named rather than star-exported: `performance` re-exports `Decimal` from
 * `tickmath`, and two `export *` lines offering the same binding make it
 * ambiguous — TypeScript drops it from the root barrel rather than choosing.
 * The subpath import is the intended route in any case.
 */
export {
  type LiquidityDelta,
  type SolvedPrice,
  type QuoteValuationInput,
  type HodlComparisonInput,
  type HodlComparison,
  type PricedFlow,
  type CostBasisInput,
  type CostBasis,
  type TimeInRangeSample,
  type TimeInRange,
  MIN_APR_AGE_MS,
  solveSqrtPriceFromDelta,
  valueInQuote,
  compareToHodl,
  computeCostBasis,
  annualisedFeeApr,
  timeInRange,
} from './performance/index.js'
export * as curve from './curve/index.js'
export * from './constants.js'
