/**
 * The creator-fee badge on the wallet pill is not clipped.
 *
 * The badge hangs off the pill's top-right corner by design — it is a count,
 * and a count that sits inside the control competes with the address. It was
 * rendered *inside* the button, and the button carried `truncate` to keep long
 * addresses in bounds. `truncate` is `overflow: hidden`, so the half of the
 * badge outside the button was cut away and what reached the screen was a
 * wedge in the corner.
 *
 * The rule this file holds: the badge is a sibling of the button, and no
 * ancestor between it and the page hides its overflow.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const fees = { count: 0 }

vi.mock('@reown/appkit/react', () => ({
  useAppKit: () => ({ open: vi.fn() }),
  useAppKitAccount: () => ({ address: undefined, isConnected: false }),
}))
// `useDisconnect` is wagmi's, and it reaches for a provider this render has no
// reason to stand up — the badge is markup, not a transaction.
vi.mock('wagmi', () => ({
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useAccount: () => ({ address: undefined }),
  useConfig: () => ({}),
}))
vi.mock('../src/hooks/useCreatorFees', () => ({ useCreatorFees: () => fees }))

const { AccountMenu } = await import('../src/components/AccountMenu')

const ADDRESS = '0xD9A8f1c4b3e5a7d2f9c1b4e6a8d0f2c4b6e80b1E'

afterEach(cleanup)

describe('the wallet pill’s creator-fee badge', () => {
  it('is not inside the element that truncates the address', () => {
    fees.count = 3
    render(<AccountMenu address={ADDRESS} />)

    const badge = screen.getByLabelText('3 tokens with creator fees ready')
    const button = screen.getByRole('button', { name: /0xD9A8/i })
    expect(button.contains(badge)).toBe(false)
  })

  it('keeps the address truncating, just not over the whole control', () => {
    fees.count = 1
    const { container } = render(<AccountMenu address={ADDRESS} />)

    const button = screen.getByRole('button', { name: /0xD9A8/i })
    expect(button.className).not.toContain('truncate')
    // The address still gets its own clip, so a long one cannot widen the bar.
    expect(container.querySelector('span.truncate')).toBeTruthy()
  })

  it('hangs the badge off an ancestor that does not hide overflow', () => {
    fees.count = 2
    render(<AccountMenu address={ADDRESS} />)

    const badge = screen.getByLabelText('2 tokens with creator fees ready')
    for (let el = badge.parentElement; el && el !== document.body; el = el.parentElement) {
      expect(el.className).not.toContain('overflow-hidden')
      expect(el.className).not.toContain('truncate')
    }
  })

  it('says nothing when no fees are waiting', () => {
    fees.count = 0
    render(<AccountMenu address={ADDRESS} />)
    expect(screen.queryByLabelText(/creator fees ready/)).toBeNull()
  })
})
