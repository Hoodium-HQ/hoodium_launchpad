/**
 * Values that must agree across the backend, the web app, and the contracts.
 *
 * These are defaults and protocol facts, not configuration. Anything that
 * identifies an environment — chain ids, RPC URLs, contract addresses — stays in
 * each app's own config with no default, because 004 section 9 is explicit that
 * "a default is how production gets misidentified as staging".
 */

/** Auto LP (spec 001). */
export const DEFAULT_EXPOSURE_THRESHOLD_PCT = 68 // AL glossary
export const DEFAULT_EMERGENCY_THRESHOLD_PCT = 85 // AL-5.3
export const DEFAULT_RANGE_PROXIMITY_PCT = 10 // AL-3.1
export const DEFAULT_ALERT_DEDUPE_HOURS = 6 // AL-3.3
export const MONITOR_INTERVAL_MS = 60_000 // AL-2.1
export const FINALITY_CONFIRMATIONS = 32 // AL-N6
export const REORG_BUFFER_BLOCKS = 64 // 001/design section 5

/** Launchpad (spec 002/design section 2). Placeholders until T0.1 models them. */
export const DEFAULT_TRADE_FEE_BPS = 100n // 1% (LP-2.3)
// Matched to the incumbent's terms — 002/requirements.md R3 records the decision
// and what it costs. Nothing reads this to display terms: those are read from the
// factory itself (see abi/index.ts), because a constant here that drifts from the
// deployed factory would show a creator terms they are not launching under.
export const DEFAULT_CREATOR_FEE_SHARE_BPS = 7_000n // 70% of fees (LP-3.1)
export const DEFAULT_DEV_BUY_MAX_BPS = 500n // 5% of supply (LP-1.6)
export const DEFAULT_SNIPE_BLOCKS = 3n // LP-2.5
export const DEFAULT_SNIPE_MAX_BPS = 100n // 1% of supply per tx

/** Uniswap v3 tick spacing per fee tier. */
export const TICK_SPACING_BY_FEE: Record<number, number> = {
  100: 1,
  500: 10,
  3_000: 60,
  10_000: 200,
}

/** The largest usable tick for a spacing — Uniswap requires multiples. */
export function maxUsableTick(tickSpacing: number): number {
  return Math.floor(887272 / tickSpacing) * tickSpacing
}
