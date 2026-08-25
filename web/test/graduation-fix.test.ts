/**
 * The trade panel's routing decision for a completing buy blocked by a primed
 * pool: offer `GraduationHelper.fixAndBuy` only for a buy, only when a helper
 * is configured, and only for the manager's pricing reverts.
 */
import { describe, expect, it } from 'vitest'
import { defaultMaxFix, revertName, shouldOfferPoolFix } from '../src/lib/graduation-fix'

const HELPER = '0x1111111111111111111111111111111111111111'

describe('revertName', () => {
  it('takes the error name off a decoded custom error', () => {
    expect(revertName('PoolPriceManipulated (123, 456)')).toBe('PoolPriceManipulated')
    expect(revertName('Expired')).toBe('Expired')
  })

  it('is null for nothing', () => {
    expect(revertName(null)).toBeNull()
    expect(revertName('')).toBeNull()
    expect(revertName(undefined)).toBeNull()
  })
})

describe('shouldOfferPoolFix', () => {
  it.each(['PoolPriceManipulated (1, 2)', 'UnexpectedSwapPayment (1, 0)', 'RepriceFailed (1, 2)'])(
    'offers the fix for %s on a buy with a helper configured',
    (error) => {
      expect(shouldOfferPoolFix({ side: 'buy', error, helperAddress: HELPER })).toBe(true)
    },
  )

  it('never offers it without a helper address', () => {
    expect(shouldOfferPoolFix({ side: 'buy', error: 'PoolPriceManipulated (1, 2)', helperAddress: '' })).toBe(false)
    expect(shouldOfferPoolFix({ side: 'buy', error: 'PoolPriceManipulated (1, 2)', helperAddress: undefined })).toBe(
      false,
    )
    expect(shouldOfferPoolFix({ side: 'buy', error: 'PoolPriceManipulated (1, 2)', helperAddress: 'nonsense' })).toBe(
      false,
    )
  })

  it('never offers it on a sell', () => {
    expect(shouldOfferPoolFix({ side: 'sell', error: 'PoolPriceManipulated (1, 2)', helperAddress: HELPER })).toBe(false)
  })

  it('ignores every other revert', () => {
    for (const error of ['SlippageExceeded (1, 2)', 'Expired (5)', 'ExcessiveDust (0x, 1, 2)', 'AntiSnipeCapExceeded (1, 2)', null]) {
      expect(shouldOfferPoolFix({ side: 'buy', error, helperAddress: HELPER })).toBe(false)
    }
  })
})

describe('defaultMaxFix', () => {
  it('is 1% of the buy, in base units, rounded down', () => {
    expect(defaultMaxFix(500_000_000n)).toBe(5_000_000n)
    expect(defaultMaxFix(99n)).toBe(0n)
  })
})
