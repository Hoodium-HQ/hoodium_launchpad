/**
 * Trade deadline — `buy`/`sell` take a unix timestamp (seconds) past which the
 * curve reverts `Expired`. Ten minutes covers a slow wallet prompt and a
 * congested block without letting a stale, signed trade sit in a mempool for
 * an hour and execute at a price the user never saw.
 */
export const TRADE_DEADLINE_SECONDS = 10 * 60

/** `now + TRADE_DEADLINE_SECONDS`, as the bigint the contract argument needs. */
export function tradeDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + TRADE_DEADLINE_SECONDS)
}
