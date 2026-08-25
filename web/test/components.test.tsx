/**
 * Component behaviour the product depends on: money rendering, the segmented
 * control's accessibility, pagination, and the sanitisers that stand between
 * creator-supplied strings and the page.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MoneyValue } from '../src/components/MoneyValue'
import { CurveProgress } from '../src/components/CurveProgress'
import { pageWindow, Pagination } from '../src/components/Pagination'
import { SegmentedControl } from '../src/components/SegmentedControl'
import { hasConfusableCharacters, relativeTime, sanitizeText, truncateMiddle } from '../src/lib/utils'

describe('MoneyValue', () => {
  it('renders a value too large for a float without losing a digit', () => {
    render(<MoneyValue value="9007199254740993" dp={0} />)
    expect(screen.getByText('9,007,199,254,740,993')).toBeInTheDocument()
  })

  it('pairs colour with a sign glyph, never colour alone', () => {
    const { rerender } = render(<MoneyValue value="-12.5" colorBySign />)
    const negative = screen.getByText(/12.50/)
    expect(negative).toHaveClass('text-down')
    expect(negative.textContent).toContain('−')

    rerender(<MoneyValue value="12.5" colorBySign />)
    const positive = screen.getByText(/12.50/)
    expect(positive).toHaveClass('text-up')
    expect(positive.textContent).toContain('+')
  })

  it('always renders tabular numerals', () => {
    render(<MoneyValue value="1234.5" />)
    expect(screen.getByText('1,234.50')).toHaveClass('num')
  })
})

describe('CurveProgress', () => {
  it('states the percentage as a number, not only as a bar', () => {
    render(<CurveProgress progressBps={7_730} />)
    expect(screen.getByText('77.3%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '77.3')
  })

  it('clamps out-of-range input', () => {
    render(<CurveProgress progressBps={12_000} />)
    expect(screen.getByText('100%')).toBeInTheDocument()
  })
})

describe('SegmentedControl', () => {
  function Harness() {
    const [value, setValue] = useState<'a' | 'b'>('a')
    return (
      <SegmentedControl
        segments={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
        value={value}
        onChange={setValue}
        label="Test"
      />
    )
  }

  it('uses real buttons with aria-pressed', () => {
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('traverses with arrow keys and wraps', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Alpha' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('carries the active state without the brand accent', () => {
    render(<Harness />)
    const active = screen.getByRole('button', { name: 'Alpha' })
    expect(active.className).not.toContain('primary')
    expect(active.className).toContain('bg-card')
  })
})

describe('Pagination', () => {
  it('always shows the first and last page, with a gap in between', () => {
    expect(pageWindow(50, 100)).toEqual([1, null, 49, 50, 51, null, 100])
  })

  it('fills a gap of one rather than eliding a single page', () => {
    expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, null, 10])
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4])
    expect(pageWindow(1, 5)).toEqual([1, 2, null, 5])
  })

  it('collapses to nothing for a single page', () => {
    const { container } = render(<Pagination page={1} pages={1} onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks the current page and disables the edge arrows', async () => {
    const user = userEvent.setup()
    let picked = 0
    render(<Pagination page={1} pages={3} onChange={(p) => (picked = p)} />)

    expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '3' }))
    expect(picked).toBe(3)
  })
})

describe('sanitizeText', () => {
  it('strips bidi overrides used to fake a symbol', () => {
    expect(sanitizeText('US‮DG')).toBe('USDG')
  })

  it('strips control characters', () => {
    expect(sanitizeText('AB\u0007C')).toBe('ABC')
  })

  it('caps length so a long name cannot break the layout', () => {
    expect(sanitizeText('x'.repeat(500), 10)).toHaveLength(10)
  })

  it('handles null and undefined', () => {
    expect(sanitizeText(null)).toBe('')
    expect(sanitizeText(undefined)).toBe('')
  })
})

describe('homoglyph detection', () => {
  it('flags Cyrillic lookalikes', () => {
    expect(hasConfusableCharacters('USDС')).toBe(true) // Cyrillic С
    expect(hasConfusableCharacters('USDC')).toBe(false)
  })
})

describe('truncateMiddle', () => {
  it('keeps the trailing characters people actually compare', () => {
    expect(truncateMiddle('0xB9F5c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f624b0')).toBe('0xB9F5…24b0')
  })

  it('leaves short values alone', () => {
    expect(truncateMiddle('0xabc')).toBe('0xabc')
  })
})

describe('relativeTime', () => {
  const now = Date.UTC(2026, 7, 25, 12, 0, 0)

  it('reads in the compact form the card grid has room for', () => {
    expect(relativeTime(now - 5_000, now)).toBe('5s ago')
    expect(relativeTime(now - 90_000, now)).toBe('1m ago')
    expect(relativeTime(now - 42 * 86_400_000, now)).toBe('42d ago')
    expect(relativeTime(now + 3 * 3_600_000, now)).toBe('in 3h')
  })

  it('ticks with the clock it is given, not the wall clock', () => {
    const then = now - 5_000
    expect(relativeTime(then, now)).toBe('5s ago')
    expect(relativeTime(then, now + 1_000)).toBe('6s ago')
  })

  it('renders nothing for an unparseable date rather than NaN', () => {
    expect(relativeTime('not a date', now)).toBe('')
  })
})
