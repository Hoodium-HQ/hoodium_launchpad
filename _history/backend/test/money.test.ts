/**
 * T1.1 · AL-N4 — "reject a `Number` written to a money field".
 *
 * The requirement says `Number` for money "SHALL be rejected in code review".
 * Code review is a person having a bad afternoon; these tests are not.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Schema, Types, model } from 'mongoose'
import { Decimal, MoneyTypeError, money, onChainAmount, toDecimal, toDecimal128, moneyToJson } from '../src/lib/money.js'
import { computeExposure, getSqrtRatioAtTick } from '../src/monitor/rangemath.js'

const TestSchema = new Schema({
  valueUsd: money({ required: true }),
  rawAmount: onChainAmount(),
})
const TestModel = model('MoneyTest', TestSchema)

describe('toDecimal128 — AL-N4', () => {
  it('rejects a Number', () => {
    expect(() => toDecimal128(1234.56 as never)).toThrow(MoneyTypeError)
    expect(() => toDecimal128(0 as never)).toThrow(MoneyTypeError)
  })

  it('accepts strings, Decimals, bigints and Decimal128', () => {
    expect(toDecimal128('1234.56').toString()).toBe('1234.56')
    expect(toDecimal128(new Decimal('0.1')).toString()).toBe('0.1')
    expect(toDecimal128(10n ** 20n).toString()).toBe('100000000000000000000')
    expect(toDecimal128(Types.Decimal128.fromString('7')).toString()).toBe('7')
  })

  it('preserves precision a double would destroy', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754. This is the entire reason for AL-N4.
    const sum = toDecimal(toDecimal128('0.1')).plus(toDecimal(toDecimal128('0.2')))
    expect(sum.toFixed()).toBe('0.3')

    // Beyond 2^53 a Number silently rounds; a string does not.
    const big = '9007199254740993'
    expect(toDecimal128(big).toString()).toBe(big)
  })

  it('rejects non-finite and malformed values', () => {
    expect(() => toDecimal128('not-a-number')).toThrow()
    expect(() => toDecimal128(new Decimal(Infinity))).toThrow(MoneyTypeError)
  })

  /*
   * `@hoodium/shared` resolves its own copy of decimal.js, so a Decimal returned
   * by `computeExposure` or `planRebalance` is not an instance of the class this
   * module imported. An `instanceof` check rejects it with "money must be a
   * string, Decimal, bigint or Decimal128" — about a Decimal.
   *
   * It reached production code before it reached a test: the Evaluator writes
   * `exposure.exposurePct` straight to a money field, and every intent it tried
   * to create failed validation.
   */
  it('accepts a Decimal from the shared package, not just this module’s copy', () => {
    const shared = computeExposure({
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tickCurrent: 0,
      tickLower: -60,
      tickUpper: 60,
      liquidity: 10n ** 18n,
      quoteIsToken0: false,
      decimals0: 18,
      decimals1: 18,
    }).exposurePct

    expect(toDecimal128(shared).toString()).toBe(shared.toFixed())

    const doc = new TestModel({ valueUsd: shared })
    expect(doc.validateSync()).toBeUndefined()
  })

  /*
   * The case above used to assert `shared instanceof Decimal === false` itself.
   * That held only because of how npm happened to lay out `node_modules`: under
   * a `file:` link the shared package resolved its own decimal.js, so the two
   * classes were distinct. Consumed as a git dependency they dedupe into one and
   * the assertion inverts — while the guarantee it protects has not changed at
   * all. A test that passes or fails on npm's hoisting decisions is testing npm.
   *
   * So the foreign class is built here rather than hoped for: a second, genuinely
   * separate module instance of decimal.js. `Decimal.clone()` does not work for
   * this — decimal.js hands every clone the same prototype object, so `instanceof`
   * still passes and the test would prove nothing.
   */
  it('accepts a Decimal built by an independent copy of decimal.js', async () => {
    const href = pathToFileURL(createRequire(import.meta.url).resolve('decimal.js')).href
    const { default: Foreign } = (await import(`${href}?copy`)) as { default: typeof Decimal }
    const value = new Foreign('1.5')

    expect(value instanceof Decimal).toBe(false) // the point of the test
    expect(value.constructor.name).toBe('Decimal') // …and still Decimal-shaped
    expect(toDecimal128(value).toString()).toBe('1.5')

    const doc = new TestModel({ valueUsd: value })
    expect(doc.validateSync()).toBeUndefined()
  })

  it('still rejects a plain object wearing a Decimal-shaped name', () => {
    const impostor = { constructor: { name: 'Decimal' } }
    expect(() => toDecimal128(impostor as never)).toThrow(MoneyTypeError)
  })
})

describe('money() mongoose field', () => {
  // Mongoose turns a throwing setter into a CastError instead of propagating it,
  // so the rejection surfaces as "the value was discarded and validation fails"
  // rather than as a synchronous throw. That still satisfies AL-N4: a Number
  // cannot reach the database.
  it('discards a Number assigned to a money field', () => {
    const doc = new TestModel()
    doc.valueUsd = 42.5 as never
    expect(doc.valueUsd).toBeUndefined()
  })

  it('fails validation when a Number reaches a money field', () => {
    const doc = new TestModel({ valueUsd: 42.5 })
    const err = doc.validateSync()
    expect(err).toBeDefined()
    expect(err!.errors.valueUsd).toBeDefined()
    expect(err!.errors.valueUsd!.name).toBe('CastError')
    expect(String(err!.errors.valueUsd!.message)).toContain('type number')
  })

  it('rejects on save so a Number can never be persisted', async () => {
    const doc = new TestModel({ valueUsd: 42.5 })
    await expect(doc.validate()).rejects.toThrow()
  })

  it('accepts a string and stores it as Decimal128', () => {
    const doc = new TestModel({ valueUsd: '1234.5678' })
    expect(doc.valueUsd).toBeInstanceOf(Types.Decimal128)
    expect(doc.valueUsd!.toString()).toBe('1234.5678')
  })

  it('still throws MoneyTypeError on the path production code uses', () => {
    expect(() => toDecimal128(42.5 as never)).toThrow(MoneyTypeError)
  })
})

describe('onChainAmount() — raw amounts stay strings', () => {
  it('discards a Number and fails validation', () => {
    const doc = new TestModel({ valueUsd: '0', rawAmount: 100 })
    expect(doc.rawAmount).toBeUndefined()
    expect(doc.validateSync()!.errors.rawAmount!.name).toBe('CastError')
  })

  it('accepts a bigint and stores its base-10 string', () => {
    const doc = new TestModel({ valueUsd: '0', rawAmount: 2n ** 100n })
    expect(doc.rawAmount).toBe('1267650600228229401496703205376')
  })

  it('rejects a non-integer string at validation time', async () => {
    const doc = new TestModel({ valueUsd: '0', rawAmount: '1.5' })
    await expect(doc.validate()).rejects.toThrow()
  })
})

describe('moneyToJson', () => {
  it('serialises money as a string so JSON.parse cannot make it a double', () => {
    const json = moneyToJson(Types.Decimal128.fromString('9007199254740993.25'))
    expect(json).toBe('9007199254740993.25')
    expect(typeof json).toBe('string')
  })

  it('passes null through', () => {
    expect(moneyToJson(null)).toBeNull()
  })
})
