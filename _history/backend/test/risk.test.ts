/**
 * T3.6 · LP-5.4, LP-5.5 — creator risk flags.
 *
 * These are facts about the chain, never opinions. LP-5.5 forbids editorial
 * promotion or endorsement, and the inverse applies too: a flag that reads as a
 * verdict rather than a measurement is editorialising in the other direction.
 */
import { describe, expect, it } from 'vitest'
import { assessConfusable, buildFlags } from '../src/launchpad/risk.js'

describe('assessConfusable — LP-5.4, design.md section 8', () => {
  it('flags Cyrillic lookalikes', () => {
    expect(assessConfusable('USDС', 'Fake Dollar')).toBe(true) // Cyrillic С
    expect(assessConfusable('РEPE', 'Pepe')).toBe(true) // Cyrillic Р
  })

  it('flags Greek lookalikes', () => {
    expect(assessConfusable('ΡEPE', 'Pepe')).toBe(true) // Greek Rho
  })

  it('flags fullwidth impersonation', () => {
    expect(assessConfusable('ＵＳＤＧ', 'Global Dollar')).toBe(true)
  })

  it('leaves ordinary ASCII alone', () => {
    expect(assessConfusable('PEPE', 'Pepe')).toBe(false)
    expect(assessConfusable('WIF', 'dogwifhat')).toBe(false)
    expect(assessConfusable('USDG', 'Global Dollar')).toBe(false)
  })
})

describe('buildFlags', () => {
  const base = {
    creatorSharePct: '0',
    priorLaunches: 0,
    priorGraduations: 0,
    hasConfusableSymbol: false,
  }

  it('says nothing about an unremarkable launch', () => {
    expect(buildFlags(base)).toEqual([])
  })

  it('flags outsized creator concentration', () => {
    expect(buildFlags({ ...base, creatorSharePct: '41.5' })).toContain('creator_concentration')
    expect(buildFlags({ ...base, creatorSharePct: '20' })).toContain('creator_concentration')
    expect(buildFlags({ ...base, creatorSharePct: '19.99' })).not.toContain('creator_concentration')
  })

  it('compares concentration exactly, not as a float', () => {
    // A percentage carried as a string all the way from Decimal128.
    expect(buildFlags({ ...base, creatorSharePct: '19.999999999999999999' })).toEqual([])
    expect(buildFlags({ ...base, creatorSharePct: '20.000000000000000001' })).toContain('creator_concentration')
  })

  it('flags a creator whose prior launches never graduated', () => {
    expect(buildFlags({ ...base, priorLaunches: 5, priorGraduations: 0 })).toContain(
      'creator_no_prior_graduations',
    )
  })

  it('does not flag a first-time creator', () => {
    // 1–1.4% of tokens graduate industry-wide (specs/README.md). Flagging someone
    // for having launched once and not graduated would flag almost everybody, and
    // a flag that fires on everybody carries no information.
    expect(buildFlags({ ...base, priorLaunches: 0, priorGraduations: 0 })).toEqual([])
    expect(buildFlags({ ...base, priorLaunches: 2, priorGraduations: 0 })).toEqual([])
  })

  it('does not flag a creator with at least one graduation', () => {
    expect(buildFlags({ ...base, priorLaunches: 9, priorGraduations: 1 })).not.toContain(
      'creator_no_prior_graduations',
    )
  })

  it('flags a confusable symbol', () => {
    expect(buildFlags({ ...base, hasConfusableSymbol: true })).toContain('confusable_symbol')
  })

  it('reports every applicable flag, not just the first', () => {
    const flags = buildFlags({
      creatorSharePct: '55',
      priorLaunches: 4,
      priorGraduations: 0,
      hasConfusableSymbol: true,
    })
    expect(flags).toHaveLength(3)
  })

  it('emits machine-readable keys, never prose verdicts (LP-5.5)', () => {
    const flags = buildFlags({ ...base, creatorSharePct: '90', hasConfusableSymbol: true })
    // The UI supplies the wording; the backend supplies the fact. Nothing here
    // calls a token a scam, risky, or safe.
    for (const flag of flags) expect(flag).toMatch(/^[a-z_]+$/)
  })
})
