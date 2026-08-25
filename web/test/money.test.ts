/**
 * T1.5 · WA-N4 — money is string/bigint end to end.
 */
import { describe, expect, it } from 'vitest'
import {
  compareMoney,
  direction,
  formatAmount,
  formatPercent,
  formatPrice,
  fromBaseUnits,
  isNegative,
  isZero,
  NotMoneyError,
  round,
} from '../src/lib/money'

describe('input validation', () => {
  it('rejects a number at runtime as well as at compile time', () => {
    expect(() => formatAmount(1234.5 as never)).toThrow(NotMoneyError)
    expect(() => round(0.1 as never, 2)).toThrow(NotMoneyError)
  })

  it('rejects values that are not decimal strings', () => {
    expect(() => formatAmount('1e18')).toThrow(NotMoneyError)
    expect(() => formatAmount('abc')).toThrow(NotMoneyError)
    expect(() => formatAmount('')).toThrow(NotMoneyError)
  })

  it('accepts bigints', () => {
    expect(formatAmount(1234n, { dp: 0 })).toBe('1,234')
  })
})

describe('precision — the reason WA-N4 exists', () => {
  it('survives values above 2^53, which Number does not', () => {
    const big = '9007199254740993'
    expect(formatAmount(big, { dp: 0 })).toBe('9,007,199,254,740,993')
    // For contrast: Number('9007199254740993') === 9007199254740992
    expect(String(Number(big))).toBe('9007199254740992')
  })

  it('rounds decimal strings exactly', () => {
    expect(round('0.1', 2)).toBe('0.10')
    expect(round('2.345', 2)).toBe('2.35')
    expect(round('2.344', 2)).toBe('2.34')
    expect(round('-2.345', 2)).toBe('-2.35')
    expect(round('9.999', 2)).toBe('10.00')
    expect(round('0.005', 2)).toBe('0.01')
  })

  it('converts base units without floating point', () => {
    expect(fromBaseUnits('1000000000000000000', 18)).toBe('1')
    expect(fromBaseUnits('1234567', 6)).toBe('1.234567')
    expect(fromBaseUnits(1500000n, 6)).toBe('1.5')
    expect(fromBaseUnits('1', 18)).toBe('0.000000000000000001')
    expect(fromBaseUnits('0', 18)).toBe('0')
  })
})

describe('formatAmount', () => {
  it('groups thousands', () => {
    expect(formatAmount('1234567.891', { dp: 2 })).toBe('1,234,567.89')
  })

  it('drops a zero fraction', () => {
    expect(formatAmount('1200.00', { dp: 2 })).toBe('1,200')
  })

  it('abbreviates large values', () => {
    expect(formatAmount('35140000', { compact: true })).toBe('35.14M')
    expect(formatAmount('29700', { compact: true })).toBe('29.7k')
    expect(formatAmount('2500000000', { compact: true })).toBe('2.5B')
    expect(formatAmount('999', { compact: true, dp: 0 })).toBe('999')
  })

  it('applies prefix and suffix', () => {
    expect(formatAmount('1234.5', { dp: 2, prefix: '$' })).toBe('$1,234.50')
    expect(formatAmount('1234.5', { dp: 2, suffix: ' USDG' })).toBe('1,234.50 USDG')
  })

  it('uses a true minus sign, and pairs a sign with every non-zero signed value', () => {
    expect(formatAmount('-42.5', { dp: 2 })).toBe('−42.50')
    expect(formatAmount('42.5', { dp: 2, signed: true })).toBe('+42.50')
    // Zero gets no sign — "+0.00" reads as a gain that did not happen.
    expect(formatAmount('0', { dp: 2, signed: true })).toBe('0')
  })
})

describe('comparison', () => {
  it('orders values without converting to float', () => {
    expect(compareMoney('10', '9')).toBe(1)
    expect(compareMoney('9', '10')).toBe(-1)
    expect(compareMoney('10.0', '10')).toBe(0)
    expect(compareMoney('0.1', '0.09')).toBe(1)
  })

  it('orders negatives correctly', () => {
    expect(compareMoney('-10', '-9')).toBe(-1)
    expect(compareMoney('-1', '1')).toBe(-1)
  })

  it('distinguishes values that collide as floats', () => {
    expect(compareMoney('9007199254740993', '9007199254740992')).toBe(1)
  })
})

describe('sign helpers — WA-5.5', () => {
  it('reports direction so colour is never the only cue', () => {
    expect(direction('5')).toBe('up')
    expect(direction('-5')).toBe('down')
    expect(direction('0')).toBe('flat')
    expect(direction('-0.00')).toBe('flat')
  })

  it('treats signed zero as zero', () => {
    expect(isZero('-0.000')).toBe(true)
    expect(isNegative('-0.000')).toBe(false)
    expect(isNegative('-0.001')).toBe(true)
  })
})

describe('formatPercent', () => {
  it('renders exposure the way the alert copy does', () => {
    expect(formatPercent('68.4321', 1)).toBe('68.4%')
    expect(formatPercent('100', 0)).toBe('100%')
    expect(formatPercent('0', 2)).toBe('0.00%')
  })
})

describe('formatPrice — tiny launchpad prices', () => {
  it('never collapses a real price to zero', () => {
    expect(formatPrice('0.0000062513', '$')).toBe('$0.000006251')
    expect(formatPrice('0.00000000012345')).toBe('0.0000000001235')
  })

  it('keeps ordinary prices readable', () => {
    expect(formatPrice('1.23456', '$')).toBe('$1.2346')
    expect(formatPrice('12345.678', '$')).toBe('$12,345.68')
    expect(formatPrice('0', '$')).toBe('$0')
  })
})
