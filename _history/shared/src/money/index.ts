/**
 * Money primitives — WA-N4 / AL-N4.
 *
 * "Monetary values SHALL use string/bigint end to end; JS `Number` for money
 *  SHALL be rejected in review."
 *
 * Shared because both sides format the same figures and must agree on them: a
 * balance that reads `1,234.50` in the app and `1,234.5` in an alert is a support
 * ticket, and one that rounds differently is a bug.
 *
 * What is deliberately **not** here: the backend's Mongoose `Decimal128` field
 * helpers. Those depend on Mongoose and only make sense server-side. This module
 * is the pure arithmetic both sides share; storage stays where storage lives.
 */

/** The only shapes money may take. `number` is deliberately absent. */
export type Money = string | bigint

interface Decomposed {
  neg: boolean
  int: string
  frac: string
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

export class NotMoneyError extends TypeError {
  constructor(received: unknown) {
    super(
      `WA-N4: expected a decimal string or bigint, received ${typeof received} (${String(received)}). ` +
        'Money never becomes a JS Number.',
    )
    this.name = 'NotMoneyError'
  }
}

function decompose(value: Money): Decomposed {
  const raw = typeof value === 'bigint' ? value.toString() : value
  if (typeof raw !== 'string' || !DECIMAL_RE.test(raw.trim())) throw new NotMoneyError(value)

  const trimmed = raw.trim()
  const neg = trimmed.startsWith('-')
  const body = neg ? trimmed.slice(1) : trimmed
  const [int = '0', frac = ''] = body.split('.')
  return { neg, int: int.replace(/^0+(?=\d)/, ''), frac }
}

function recompose({ neg, int, frac }: Decomposed): string {
  const body = frac.length > 0 ? `${int}.${frac}` : int
  return neg && !isZeroDigits(int, frac) ? `-${body}` : body
}

function isZeroDigits(int: string, frac: string): boolean {
  return /^0*$/.test(int) && /^0*$/.test(frac)
}

/** Convert a raw on-chain amount into a human decimal string. */
export function fromBaseUnits(raw: Money, decimals: number): string {
  const { neg, int } = decompose(typeof raw === 'bigint' ? raw : (raw.split('.')[0] ?? '0'))
  const digits = int.padStart(decimals + 1, '0')
  const cut = digits.length - decimals
  const whole = digits.slice(0, cut)
  const frac = decimals > 0 ? digits.slice(cut).replace(/0+$/, '') : ''
  return recompose({ neg, int: whole, frac })
}

/** Convert a human decimal string into raw base units. Truncates, never rounds up. */
export function toBaseUnits(value: Money, decimals: number): bigint {
  const { neg, int, frac } = decompose(value)
  const padded = frac.padEnd(decimals, '0').slice(0, decimals)
  const magnitude = BigInt(int + padded)
  return neg ? -magnitude : magnitude
}

/** Round-half-up to `dp` decimal places, using integer arithmetic only. */
export function round(value: Money, dp: number): string {
  const { neg, int, frac } = decompose(value)
  if (frac.length <= dp) return recompose({ neg, int, frac: frac.padEnd(dp, '0') })

  const keep = frac.slice(0, dp)
  const nextDigit = frac.charCodeAt(dp) - 48
  let scaled = BigInt(int + keep)
  if (nextDigit >= 5) scaled += 1n

  const asString = scaled.toString().padStart(dp + 1, '0')
  const cut = asString.length - dp
  return recompose({ neg, int: asString.slice(0, cut), frac: dp > 0 ? asString.slice(cut) : '' })
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export interface FormatOptions {
  dp?: number
  compact?: boolean
  prefix?: string
  suffix?: string
  /** Always show a leading + or −. WA-5.5 pairs sign with colour. */
  signed?: boolean
}

const COMPACT_TIERS = [
  { digits: 10, suffix: 'B', shift: 9 },
  { digits: 7, suffix: 'M', shift: 6 },
  { digits: 4, suffix: 'k', shift: 3 },
] as const

/** Format money for display. String or bigint in, string out — never a Number. */
export function formatAmount(value: Money, options: FormatOptions = {}): string {
  const { dp = 2, compact = false, prefix = '', suffix = '', signed = false } = options
  const parts = decompose(value)

  let body: string
  let unit = ''

  if (compact) {
    const tier = COMPACT_TIERS.find((t) => parts.int.length >= t.digits)
    if (tier) {
      const shifted = shiftLeft(parts, tier.shift)
      body = round(recompose({ ...shifted, neg: false }), 2)
      unit = tier.suffix
    } else {
      body = round(recompose({ ...parts, neg: false }), dp)
    }
  } else {
    body = round(recompose({ ...parts, neg: false }), dp)
  }

  const [int = '0', rawFrac = ''] = body.split('.')

  // Compact drops trailing zeros — "$29.7k", not "$29.70k" (design-system
  // section 8). Full precision keeps them: "1,200.00 USDG" reading as "1,200"
  // loses the cents a balance is stated to.
  const frac = unit ? rawFrac.replace(/0+$/, '') : rawFrac

  const grouped = unit ? int : group(int)
  const magnitude = frac && !/^0*$/.test(frac) ? `${grouped}.${frac}` : grouped

  const zero = isZeroDigits(int, rawFrac)
  const sign = zero ? '' : parts.neg ? '−' : signed ? '+' : ''

  return `${sign}${prefix}${magnitude}${unit}${suffix}`
}

/** Move the decimal point left by `n` places without dividing. */
function shiftLeft({ neg, int, frac }: Decomposed, n: number): Decomposed {
  const digits = int + frac
  const pointAt = int.length - n
  if (pointAt <= 0) return { neg, int: '0', frac: '0'.repeat(-pointAt) + digits }
  return { neg, int: digits.slice(0, pointAt), frac: digits.slice(pointAt) }
}

export function formatPercent(value: Money, dp = 1): string {
  return `${round(value, dp)}%`
}

/** Sort and threshold comparisons without converting to a float. */
export function compareMoney(a: Money, b: Money): number {
  const da = decompose(a)
  const db = decompose(b)
  if (da.neg !== db.neg) return da.neg ? -1 : 1

  const width = Math.max(da.frac.length, db.frac.length)
  const ia = BigInt(da.int + da.frac.padEnd(width, '0'))
  const ib = BigInt(db.int + db.frac.padEnd(width, '0'))
  const cmp = ia === ib ? 0 : ia > ib ? 1 : -1
  return da.neg ? -cmp : cmp
}

/** Exact addition. The alternative is `Number(a) + Number(b)`, which WA-N4 bans. */
export function addMoney(a: Money, b: Money, scale = 18): string {
  const sum = toBaseUnits(a, scale) + toBaseUnits(b, scale)
  return fromBaseUnits(sum, scale)
}

export function subMoney(a: Money, b: Money, scale = 18): string {
  const diff = toBaseUnits(a, scale) - toBaseUnits(b, scale)
  return fromBaseUnits(diff, scale)
}

export function isZero(value: Money): boolean {
  const { int, frac } = decompose(value)
  return isZeroDigits(int, frac)
}

export function isNegative(value: Money): boolean {
  const { neg, int, frac } = decompose(value)
  return neg && !isZeroDigits(int, frac)
}

/** WA-5.5 — direction is never carried by colour alone; pair this with a glyph. */
export function direction(value: Money): 'up' | 'down' | 'flat' {
  if (isZero(value)) return 'flat'
  return isNegative(value) ? 'down' : 'up'
}
