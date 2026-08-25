/**
 * Monetary values — T1.1 / AL-N4.
 *
 * "All monetary values SHALL be stored as `Decimal128`; on-chain amounts as
 * strings. `Number` for money SHALL be rejected in code review."
 *
 * Code review is a weak enforcement point, so this module makes it mechanical.
 *
 * Two layers, because they fail differently:
 *
 *   1. `toDecimal128()` throws `MoneyTypeError` synchronously. Every code path
 *      that builds a money value goes through it, so this is the one that fires
 *      in practice.
 *   2. The mongoose `money()` field rejects a `number` during cast. Mongoose
 *      converts a throwing setter into a `CastError` rather than propagating it,
 *      so assignment does not throw — instead the value is *discarded* and
 *      `validate()`/`save()` reject. A `Number` therefore cannot reach the
 *      database, which is the property AL-N4 actually needs.
 */
import Decimal from 'decimal.js'
import { Schema, Types } from 'mongoose'

// 34 significant digits is the Decimal128 envelope; keep decimal.js inside it so
// a value that round-trips through the DB is the value we computed.
Decimal.set({ precision: 34, toExpPos: 34, toExpNeg: -34 })

export { Decimal }
export type MoneyInput = string | Decimal | Types.Decimal128 | bigint

export class MoneyTypeError extends TypeError {
  constructor(received: unknown, field?: string) {
    super(
      `AL-N4: money must be a string, Decimal, bigint or Decimal128 — received ${typeof received}` +
        (field ? ` for field "${field}"` : '') +
        '. A JS Number silently loses precision above 2^53 and cannot represent 0.1 exactly.',
    )
    this.name = 'MoneyTypeError'
  }
}

/**
 * A decimal.js instance — from *any* copy of the module.
 *
 * `@hoodium/shared` declares its own `decimal.js` dependency and resolves it from
 * its own `node_modules`, so a `Decimal` returned by `computeExposure` or
 * `planRebalance` is not an instance of the class this file imported. `instanceof`
 * across the two is false, and the value would fall through to the final throw —
 * a `MoneyTypeError` complaining that a Decimal is not a Decimal.
 *
 * So the test is structural, which is what AL-N4 is actually about: the
 * requirement is that a `Number` cannot reach the database, not that money
 * carries a particular class identity. `typeof value === 'number'` above is what
 * enforces it, and it runs first.
 */
function isDecimalLike(value: unknown): value is Decimal {
  if (value instanceof Decimal) return true
  if (typeof value !== 'object' || value === null) return false
  const v = value as { constructor?: { name?: string }; isFinite?: unknown; toFixed?: unknown }
  return v.constructor?.name === 'Decimal' && typeof v.isFinite === 'function' && typeof v.toFixed === 'function'
}

export function toDecimal128(value: MoneyInput, field?: string): Types.Decimal128 {
  if (typeof value === 'number') throw new MoneyTypeError(value, field)
  if (value instanceof Types.Decimal128) return value
  if (typeof value === 'bigint') return Types.Decimal128.fromString(value.toString())
  if (isDecimalLike(value)) {
    if (!value.isFinite()) throw new MoneyTypeError(value.toString(), field)
    return Types.Decimal128.fromString(value.toFixed())
  }
  if (typeof value === 'string') {
    const d = new Decimal(value) // throws on garbage, which is what we want
    if (!d.isFinite()) throw new MoneyTypeError(value, field)
    return Types.Decimal128.fromString(d.toFixed())
  }
  throw new MoneyTypeError(value, field)
}

export function toDecimal(value: Types.Decimal128 | Decimal | string | bigint | null | undefined): Decimal {
  if (value == null) return new Decimal(0)
  if (value instanceof Decimal) return value
  return new Decimal(value.toString())
}

/** Serialise a money value for the API. Strings, never numbers, all the way out. */
export function moneyToJson(value: Types.Decimal128 | Decimal | null | undefined): string | null {
  if (value == null) return null
  return toDecimal(value).toFixed()
}

/**
 * Mongoose field factory for money. Use for *every* monetary field.
 *
 *   valueUsd: money({ required: true })
 */
export function money(opts: { required?: boolean; default?: string } = {}) {
  return {
    type: Schema.Types.Decimal128,
    required: opts.required ?? false,
    ...(opts.default !== undefined ? { default: () => Types.Decimal128.fromString(opts.default!) } : {}),
    set(this: unknown, v: unknown) {
      if (v === null || v === undefined) return v
      return toDecimal128(v as MoneyInput)
    },
  } as const
}

/**
 * Mongoose field factory for a raw on-chain amount (AL-N4: "on-chain amounts as
 * strings"). Base-10 integer in the token's smallest unit — no decimals applied,
 * no precision to lose.
 */
export function onChainAmount(opts: { required?: boolean; default?: string } = {}) {
  return {
    type: String,
    required: opts.required ?? false,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    set(v: unknown) {
      if (v === null || v === undefined) return v
      if (typeof v === 'number') throw new MoneyTypeError(v)
      if (typeof v === 'bigint') return v.toString()
      return v
    },
    validate: {
      validator: (v: string | null) => v == null || /^-?\d+$/.test(v),
      message: 'on-chain amounts must be base-10 integer strings (AL-N4)',
    },
  } as const
}
