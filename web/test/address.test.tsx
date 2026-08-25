/**
 * `Address` — the truncated identifier.
 *
 * One rule, and the component exists because it kept being broken: an address
 * short enough to read must still be gettable in full. A truncated address with
 * no copy is enough to recognise and not enough to use, so the reader has to go
 * find the real value somewhere else — which is the exact failure the truncation
 * was supposed to spare them.
 *
 * The copy target is the whole chip, not the 12px icon beside it. These tests
 * hold that: clicking the text copies, and what lands on the clipboard is the
 * full value rather than the ellipsised one on screen.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Address } from '../src/components/Address'

const VALUE = '0xd9a8373812d4bcf01b195355a4ad270242c50b1e'

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined)
  // jsdom ships no clipboard at all, and `navigator.clipboard` is read-only on
  // the prototype, so this is defined rather than assigned.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
})

afterEach(() => vi.restoreAllMocks())

describe('Address', () => {
  it('truncates in the middle, keeping the tail people compare', () => {
    render(<Address value={VALUE} />)

    expect(screen.getByText('0xd9a8…0b1e')).toBeInTheDocument()
  })

  it('copies the full value when the address text itself is clicked', async () => {
    render(<Address value={VALUE} />)

    // The whole chip is the button, so this is a click on the text.
    await userEvent.click(screen.getByText('0xd9a8…0b1e'))

    // The full forty-two characters, never the ellipsised rendering.
    expect(writeText).toHaveBeenCalledWith(VALUE)
  })

  it('acknowledges the copy, so the click does not look like it did nothing', async () => {
    render(<Address value={VALUE} />)

    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName(`Copy address ${VALUE}`)

    await userEvent.click(button)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('names what it identifies, so a screen reader is not told "address" six times', () => {
    render(<Address value={VALUE} label="factory address" />)

    expect(screen.getByRole('button')).toHaveAccessibleName(`Copy factory address ${VALUE}`)
  })

  it('splits into a link and a copy button when the text has somewhere to go', async () => {
    render(
      <MemoryRouter>
        <Address value={VALUE} to={`/profile/${VALUE}`} />
      </MemoryRouter>,
    )

    // Navigating and copying are two intents, so they are two targets.
    expect(screen.getByRole('link')).toHaveAttribute('href', `/profile/${VALUE}`)

    await userEvent.click(screen.getByRole('button'))
    expect(writeText).toHaveBeenCalledWith(VALUE)
  })

  it('stays a copy button when no explorer is configured to link to', async () => {
    // `VITE_EXPLORER_URL` is unset in tests, so `link` has no destination. The
    // control must not degrade into inert text.
    render(<Address value={VALUE} link />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button'))
    expect(writeText).toHaveBeenCalledWith(VALUE)
  })

  it('survives a clipboard that refuses, rather than throwing into the page', async () => {
    // Permission-gated, and absent entirely on an insecure origin.
    writeText.mockRejectedValue(new Error('denied'))
    render(<Address value={VALUE} />)

    await userEvent.click(screen.getByRole('button'))

    // No "Copied" claim for a copy that did not happen.
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
  })
})
