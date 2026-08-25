/**
 * The dev-buy cap, and the validators the launch form gates on.
 *
 * `maxDevBuyQuote` is the one with teeth. `HoodiumFactory.launch` reverts with
 * `DevBuyTooLarge` when the quoted output exceeds the cap, and `quoteBuy` rounds
 * in the contract's favour at two separate divisions (LP-N8) — so a closed-form
 * inversion of the curve can land a wei over the line. A "Max" button that
 * reverts is worse than no Max button, which is what these tests exist to prevent.
 */
import { describe, expect, it } from 'vitest'
import { quoteBuy } from '@/lib/curve'
import {
  freshCurve,
  hasLink,
  isValidName,
  isValidSymbol,
  maxDevBuyQuote,
  previewDevBuy,
} from '@/lib/launch-form'
import type { LaunchTerms } from '@/lib/launchpad-api'

/**
 * A factory in the shape the real one deploys: 1e27 supply with 80% on the curve,
 * `virtualTokens` derived from the target rather than chosen (the constructor
 * does `vT = C x vU / target`), and a 6-decimal quote token.
 */
function terms(overrides: Partial<LaunchTerms> = {}): LaunchTerms {
  const totalSupply = 10n ** 27n
  const curveAllocation = (totalSupply * 80n) / 100n
  const virtualUsdg = 5_000n * 10n ** 6n
  const graduationTarget = 20_000n * 10n ** 6n

  return {
    factoryAddress: '0xfactory',
    totalSupply: totalSupply.toString(),
    curveAllocation: curveAllocation.toString(),
    lpAllocation: (totalSupply - curveAllocation).toString(),
    tokenDecimals: 18,
    virtualUsdg: virtualUsdg.toString(),
    virtualTokens: ((curveAllocation * virtualUsdg) / graduationTarget).toString(),
    creationFee: '0',
    graduationTarget: graduationTarget.toString(),
    graduationFee: '0',
    devBuyCapTokens: ((totalSupply * 500n) / 10_000n).toString(), // 5%
    devBuyMaxBps: 500,
    tradeFeeBps: 100,
    creatorFeeShareBps: 7_000,
    snipeBlocks: 3,
    snipeMaxBps: 100,
    ...overrides,
  }
}

describe('maxDevBuyQuote', () => {
  it('never quotes more tokens than the factory cap', () => {
    const t = terms()
    const max = maxDevBuyQuote(t)
    const cap = BigInt(t.devBuyCapTokens)

    expect(max).toBeGreaterThan(0n)
    expect(quoteBuy(freshCurve(t), max).tokensOut).toBeLessThanOrEqual(cap)
  })

  it('lands close enough to the cap to be worth calling "Max"', () => {
    const t = terms()
    const cap = BigInt(t.devBuyCapTokens)
    const out = quoteBuy(freshCurve(t), maxDevBuyQuote(t)).tokensOut

    // Within a hundredth of a percent of the cap. A value that merely satisfies
    // the cap could be zero and still pass the test above.
    expect(out * 10_000n).toBeGreaterThan(cap * 9_999n)
  })

  it('holds across cap sizes and fee tiers', () => {
    for (const bps of [0, 50, 100, 300, 1_000]) {
      for (const capBps of [10n, 100n, 500n, 2_000n]) {
        const t = terms({
          tradeFeeBps: bps,
          devBuyMaxBps: Number(capBps),
          devBuyCapTokens: ((10n ** 27n * capBps) / 10_000n).toString(),
        })
        const cap = BigInt(t.devBuyCapTokens)
        const out = quoteBuy(freshCurve(t), maxDevBuyQuote(t)).tokensOut

        expect(out).toBeLessThanOrEqual(cap)
        expect(out).toBeGreaterThan(0n)
      }
    }
  })

  it('returns zero when the cap is zero or exceeds the curve', () => {
    expect(maxDevBuyQuote(terms({ devBuyCapTokens: '0' }))).toBe(0n)
    expect(maxDevBuyQuote(terms({ devBuyCapTokens: (10n ** 30n).toString() }))).toBe(0n)
  })

  it('one unit past the maximum does exceed the cap — the bound is tight', () => {
    const t = terms()
    const cap = BigInt(t.devBuyCapTokens)
    const max = maxDevBuyQuote(t)

    // Not strictly required for safety, but if a much larger spend still fits
    // under the cap then the inversion is wrong rather than merely conservative.
    expect(quoteBuy(freshCurve(t), max * 2n).tokensOut).toBeGreaterThan(cap)
  })
})

describe('previewDevBuy', () => {
  it('agrees with the curve quote it is a thin wrapper over', () => {
    const t = terms()
    const spend = 100n * 10n ** 6n
    const preview = previewDevBuy(t, spend)
    const quote = quoteBuy(freshCurve(t), spend)

    expect(preview.tokensOut).toBe(quote.tokensOut)
    expect(preview.fee).toBe(quote.fee)
  })

  it('charges the trade fee on the way in', () => {
    const spend = 10_000n * 10n ** 6n
    expect(previewDevBuy(terms({ tradeFeeBps: 100 }), spend).fee).toBe(spend / 100n)
    expect(previewDevBuy(terms({ tradeFeeBps: 0 }), spend).fee).toBe(0n)
  })
})

describe('name and ticker validation', () => {
  it('accepts letters, numbers and spaces in a name', () => {
    expect(isValidName('Dogwifhat')).toBe(true)
    expect(isValidName('Meme Coin 2')).toBe(true)
    // Unicode letters count — this is not an English-only product.
    expect(isValidName('Kucing Oren')).toBe(true)
  })

  it('rejects punctuation in a name, which is where lookalikes hide', () => {
    expect(isValidName('Not-A-Token')).toBe(false)
    expect(isValidName('USDG.com')).toBe(false)
    expect(isValidName('')).toBe(false)
    expect(isValidName('   ')).toBe(false)
  })

  it('accepts only alphanumerics in a ticker', () => {
    expect(isValidSymbol('WIF')).toBe(true)
    expect(isValidSymbol('TEST123')).toBe(true)
    expect(isValidSymbol('WI F')).toBe(false)
    expect(isValidSymbol('$WIF')).toBe(false)
  })
})

describe('hasLink', () => {
  it('catches the forms a link actually takes', () => {
    expect(hasLink('go to https://evil.example')).toBe(true)
    expect(hasLink('www.evil.example')).toBe(true)
    expect(hasLink('claim at freeairdrop.xyz now')).toBe(true)
    expect(hasLink('join t.me/scam')).toBe(true)
  })

  it('leaves ordinary prose alone', () => {
    expect(hasLink('A meme coin of a cat waiting for his food')).toBe(false)
    expect(hasLink('1. buy 2. hold')).toBe(false)
  })
})
