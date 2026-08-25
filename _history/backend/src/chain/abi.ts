/**
 * Uniswap ABIs — re-exported from `@hoodium/shared/abi`.
 *
 * WA-N6: "no duplicated ABI or model definitions." The definitions live in the
 * shared package; this file only maps them onto the names this codebase already
 * uses, so call sites did not have to churn when the package was introduced.
 *
 * The router and `decreaseLiquidity`/`collect` write paths remain absent by
 * design — they belong to 001 Phase 5, and nothing in phases 1–3 should be able
 * to build a transaction.
 */
export {
  erc20Abi,
  positionManagerAbi,
  poolAbi,
  uniswapFactoryAbi as factoryAbi,
  AUTO_LP_INDEXED_EVENTS as INDEXED_EVENTS,
} from '@hoodium/shared/abi'

export type IndexedEventName = 'Transfer' | 'IncreaseLiquidity' | 'DecreaseLiquidity' | 'Collect'
