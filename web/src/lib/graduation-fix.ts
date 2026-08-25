/**
 * Routing for the one buy a primed pool can block.
 *
 * The buy that completes the curve graduates it in the same transaction, and
 * `GraduationManager` refuses to migrate into a pool that someone has primed
 * with liquidity at a hostile price. The plain buy's *simulation* then reverts
 * with one of the manager's pricing errors, before any signature. When a
 * `GraduationHelper` is configured, that is the moment to offer the atomic
 * "fix the pool and buy" instead of "try again later".
 *
 * Pure functions, so the decision is testable without a wallet.
 */

/** The manager's pricing reverts that the helper can resolve. */
export const POOL_FIX_ERRORS = ['PoolPriceManipulated', 'UnexpectedSwapPayment', 'RepriceFailed'] as const

/** `decodeTxError` renders custom errors as `Name (arg, arg)`; take the name. */
export function revertName(error: string | null | undefined): string | null {
  if (!error) return null
  const name = error.split('(')[0]?.trim()
  return name || null
}

/**
 * Whether a failed buy should be routed through `GraduationHelper.fixAndBuy`.
 * Only for a buy (a sell never graduates) and only when a helper is deployed.
 */
export function shouldOfferPoolFix(args: {
  side: 'buy' | 'sell'
  error: string | null | undefined
  helperAddress: string | undefined
}): boolean {
  if (args.side !== 'buy') return false
  if (!args.helperAddress || !/^0x[0-9a-fA-F]{40}$/.test(args.helperAddress)) return false
  const name = revertName(args.error)
  return name !== null && (POOL_FIX_ERRORS as readonly string[]).includes(name)
}

/**
 * Default fix budget: 1% of the buy, in base units. A dust griefing position
 * costs a fraction of a USDG to re-price; the budget is a ceiling the helper
 * refunds from, not an amount it spends.
 */
export function defaultMaxFix(usdgIn: bigint): bigint {
  return usdgIn / 100n
}
