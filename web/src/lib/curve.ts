/**
 * Bonding curve math, mirrored from `BondingCurve.sol` bit for bit.
 *
 * Vendored from the retired `@hoodium/shared/curve` module. The **authoritative**
 * quote is the contract's own `quoteBuy`/`quoteSell`, and the trade panel calls
 * it on-chain. This exists for the paths where an on-chain call is not available
 * or not appropriate: the launch form's dev-buy preview (the curve does not exist
 * yet), and unit tests.
 *
 * ── The rounding rule ────────────────────────────────────────────────────────
 * "Every division rounds in the contract's favour, never the caller's." Both
 * quote paths divide `k` and round the quotient **up**, making the output round
 * **down**. Fees round up. Reproduced here exactly; getting this wrong in the
 * preview direction would overstate what a user receives.
 */

/* eslint-disable money/no-number-on-money -- every operand in this file is a bigint in base units, which is exactly the arithmetic the rule exists to push people towards; it cannot see through the CurveState type. */

export const BPS = 10_000n

export interface CurveState {
  virtualUsdg: bigint
  virtualTokens: bigint
  curveAllocation: bigint
  reserveUsdg: bigint
  tokensSold: bigint
  graduationTarget: bigint
  tradeFeeBps: bigint
}

export interface BuyQuote {
  tokensOut: bigint
  fee: bigint
  /** Returned to the caller because the buy would overshoot the target. */
  refund: bigint
  netIn: bigint
}

export interface SellQuote {
  usdgOut: bigint
  fee: bigint
  grossOut: bigint
}

/** Ceiling division for positive integers — `Math.Rounding.Ceil` in Solidity. */
export function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero')
  return (numerator + denominator - 1n) / denominator
}

/** `mulDiv` with the rounding direction stated, matching OpenZeppelin's Math. */
export function mulDiv(a: bigint, b: bigint, denominator: bigint, rounding: 'floor' | 'ceil' = 'floor'): bigint {
  return rounding === 'ceil' ? divCeil(a * b, denominator) : (a * b) / denominator
}

export function reserveX(state: CurveState): bigint {
  return state.virtualUsdg + state.reserveUsdg
}

export function reserveY(state: CurveState): bigint {
  return state.virtualTokens + state.curveAllocation - state.tokensSold
}

export function currentK(state: CurveState): bigint {
  return reserveX(state) * reserveY(state)
}

export function remainingToTarget(state: CurveState): bigint {
  return state.reserveUsdg >= state.graduationTarget ? 0n : state.graduationTarget - state.reserveUsdg
}

export function curveComplete(state: CurveState): boolean {
  return state.reserveUsdg >= state.graduationTarget
}

/** Progress in basis points — an integer, so it cannot drift like a float. */
export function progressBps(state: CurveState): number {
  if (state.graduationTarget === 0n) return 0
  if (state.reserveUsdg >= state.graduationTarget) return 10_000
  return Number(mulDiv(state.reserveUsdg, BPS, state.graduationTarget))
}

/**
 * Split gross input into (net, fee, refund), clamped to what the curve can still
 * absorb. Mirrors `BondingCurve._splitBuyInput`.
 */
export function splitBuyInput(state: CurveState, usdgIn: bigint): { netIn: bigint; fee: bigint; refund: bigint } {
  let fee = mulDiv(usdgIn, state.tradeFeeBps, BPS, 'ceil')
  let netIn = usdgIn - fee
  let refund = 0n

  const remaining = remainingToTarget(state)
  if (netIn > remaining) {
    netIn = remaining
    // fee / (net + fee) = bps / BPS  =>  fee = net * bps / (BPS - bps)
    fee = mulDiv(netIn, state.tradeFeeBps, BPS - state.tradeFeeBps, 'ceil')
    refund = usdgIn - netIn - fee
  }

  return { netIn, fee, refund }
}

/** Mirrors `BondingCurve.quoteBuy`. */
export function quoteBuy(state: CurveState, usdgIn: bigint): BuyQuote {
  if (usdgIn <= 0n || curveComplete(state)) {
    return { tokensOut: 0n, fee: 0n, refund: usdgIn > 0n ? usdgIn : 0n, netIn: 0n }
  }

  const { netIn, fee, refund } = splitBuyInput(state, usdgIn)
  if (netIn === 0n) return { tokensOut: 0n, fee: 0n, refund: usdgIn, netIn: 0n }

  const x = reserveX(state)
  const y = reserveY(state)
  // Round the quotient up so `tokensOut` rounds down.
  const newY = mulDiv(x, y, x + netIn, 'ceil')

  return { tokensOut: y - newY, fee, refund, netIn }
}

/** Mirrors `BondingCurve.quoteSell`. */
export function quoteSell(state: CurveState, tokensIn: bigint): SellQuote {
  if (tokensIn <= 0n || tokensIn > state.tokensSold || curveComplete(state)) {
    return { usdgOut: 0n, fee: 0n, grossOut: 0n }
  }

  const x = reserveX(state)
  const y = reserveY(state)
  const newX = mulDiv(x, y, y + tokensIn, 'ceil')

  let grossOut = x - newX
  // The virtual reserve is not real money and can never be paid out.
  if (grossOut > state.reserveUsdg) grossOut = state.reserveUsdg

  const fee = mulDiv(grossOut, state.tradeFeeBps, BPS, 'ceil')
  return { usdgOut: grossOut - fee, fee, grossOut }
}

/** Apply a buy, returning the state after it. Used for projections. */
export function applyBuy(state: CurveState, usdgIn: bigint): { state: CurveState; quote: BuyQuote } {
  const quote = quoteBuy(state, usdgIn)
  return {
    quote,
    state: {
      ...state,
      reserveUsdg: state.reserveUsdg + quote.netIn,
      tokensSold: state.tokensSold + quote.tokensOut,
    },
  }
}

export function applySell(state: CurveState, tokensIn: bigint): { state: CurveState; quote: SellQuote } {
  const quote = quoteSell(state, tokensIn)
  return {
    quote,
    state: {
      ...state,
      reserveUsdg: state.reserveUsdg - quote.grossOut,
      tokensSold: state.tokensSold - tokensIn,
    },
  }
}

/**
 * The virtual token reserve the factory derives, not a free parameter.
 *
 * Setting `tokensSold(target) = curveAllocation` and solving gives
 * `vT = C x vU / target`.
 */
export function deriveVirtualTokens(curveAllocation: bigint, virtualUsdg: bigint, graduationTarget: bigint): bigint {
  return mulDiv(curveAllocation, virtualUsdg, graduationTarget)
}

/** Spot price in USDG per whole token, scaled by 10^tokenDecimals. */
export function spotPrice(state: CurveState, tokenDecimals = 18): bigint {
  const y = reserveY(state)
  if (y === 0n) return 0n
  return mulDiv(reserveX(state), 10n ** BigInt(tokenDecimals), y)
}
