/**
 * Regression for `Cannot parse color` — the chart libraries in this app accept
 * hex/rgb/rgba/named colours only, and throw during construction on anything
 * else. The theme stores bare HSL components, so every value handed to a chart
 * has to be converted, and the one property that must always hold is that what
 * comes out is never hsl.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { themeColor } from '../src/lib/theme-color'

const RGBA = /^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*[\d.]+\)$/

describe('themeColor', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--test-hsl-components', '110 4% 56%')
    document.documentElement.style.setProperty('--test-hex', '#c3f53c')
    document.documentElement.style.removeProperty('--test-missing')
  })

  it('never returns an hsl string, whatever the token holds', () => {
    for (const token of ['--test-hsl-components', '--test-hex', '--test-missing']) {
      const value = themeColor(token)
      expect(value).not.toContain('hsl')
      expect(value).toMatch(RGBA)
    }
  })

  it('carries the requested alpha through', () => {
    expect(themeColor('--test-hex', 0.25)).toMatch(/,\s*0\.25\)$/)
    expect(themeColor('--test-hex')).toMatch(/,\s*1\)$/)
  })

  it('falls back to a usable colour when the token is unset', () => {
    // A missing token must not produce `rgba(, , , 1)`, which would throw in the
    // same place the original bug did.
    expect(themeColor('--test-missing')).toMatch(RGBA)
  })
})
