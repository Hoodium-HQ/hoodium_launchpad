/**
 * Exact on-chain amounts travel as decimal strings (base units) end to end.
 * `Number` is only ever produced for display-grade USD figures and sort keys,
 * never fed back into any exact arithmetic.
 */

export const BPS = 10_000n

export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (value === null || value === undefined || value === '') return 0n
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  const s = String(value).trim()
  if (!/^-?\d+$/.test(s)) throw new TypeError(`not an integer amount: ${s}`)
  return BigInt(s)
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

export function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

/** Base units → floating value. Display and sort keys only. */
export function toUnits(value: bigint | string | null | undefined, decimals: number): number {
  const v = toBigInt(value ?? 0n)
  const negative = v < 0n
  const abs = negative ? -v : v
  const scale = 10n ** BigInt(decimals)
  const whole = abs / scale
  const frac = abs % scale
  const n = Number(whole) + Number(frac) / Number(scale)
  return negative ? -n : n
}

/**
 * Quote base units per whole token, scaled by 10^tokenDecimals.
 * `price = quote * 10^tokenDecimals / tokens`, rounded down.
 */
export function pricePerToken(quoteAmount: bigint, tokenAmount: bigint, tokenDecimals: number): bigint {
  if (tokenAmount <= 0n) return 0n
  return (quoteAmount * 10n ** BigInt(tokenDecimals)) / tokenAmount
}

/** `price` (quote base units per whole token) × `supply` (token base units) → quote base units. */
export function valueOf(priceScaled: bigint, tokenAmount: bigint, tokenDecimals: number): bigint {
  return (priceScaled * tokenAmount) / 10n ** BigInt(tokenDecimals)
}

/** Basis points of `part` in `whole`, clamped to [0, 10000]. */
export function bps(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0
  if (part >= whole) return 10_000
  if (part <= 0n) return 0
  return Number((part * BPS) / whole)
}
