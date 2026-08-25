/**
 * The Learn page is static: it has to read whole with no API behind it, and
 * every section the navbar promises has to be on the page. These hold the
 * headings and the default figures, with the config query left unanswered so
 * the page is exercised the way a reader without a backend sees it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { Learn } from '../src/routes/Learn'

function renderLearn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/learn']}>
        <Learn />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Learn', () => {
  it('renders the page title and every section heading', () => {
    renderLearn()
    expect(screen.getByRole('heading', { level: 1, name: 'How Hoodium Launchpad works' })).toBeInTheDocument()
    for (const name of [
      'The lifecycle',
      'Tokenomics',
      'The curve, in one formula',
      'Fees, and who gets them',
      'Protections',
      'Risks — read this',
      'Glossary',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
  })

  it('shows the deploy defaults, and says so, when there are no live terms', () => {
    renderLearn()
    expect(screen.getByText(/Defaults shown — contracts not deployed yet/)).toBeInTheDocument()
    expect(screen.getByText('1,000,000,000')).toBeInTheDocument()
    expect(screen.getByText('800,000,000')).toBeInTheDocument()
    expect(screen.getAllByText('69,000 USDG').length).toBeGreaterThan(0)
    // The derived virtual reserve with the deploy defaults, not a configured 12,000.
    expect(screen.getAllByText('23,000 USDG').length).toBeGreaterThan(0)
    expect(screen.queryByText('12,000 USDG')).toBeNull()
  })

  it('describes the mechanics the fix pass changed', () => {
    renderLearn()
    expect(screen.getByText(/cap is cumulative/)).toBeInTheDocument()
    expect(screen.getByText(/closes the curve and creates the pool in the same transaction/)).toBeInTheDocument()
    expect(screen.getByText(/ten-minute deadline/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing is pushed' })).toBeInTheDocument()
  })

  it('illustrates every lifecycle step and section with a decorative sticker', () => {
    const { container } = renderLearn()
    for (const name of ['rocket', 'curve', 'graduation', 'padlock', 'pie', 'scale', 'coins-sprout', 'shield', 'warning', 'book']) {
      const img = container.querySelector(`img[data-clipart="${name}"]`)
      expect(img).not.toBeNull()
      expect(img).toHaveAttribute('alt', '')
      expect(img).toHaveAttribute('aria-hidden')
    }
  })

  it('draws the lifecycle, with the flow available to a screen reader as words', () => {
    const { container } = renderLearn()

    /*
     * Two drawings are in the DOM at once — the wide swimlanes and the compact
     * column — and CSS, not React, picks which one a viewport sees. jsdom
     * applies no stylesheet, so both are here; what matters is that each is an
     * `img` carrying the same summary, so whichever one is displayed is named.
     */
    const drawn = screen.getAllByRole('img', { name: /Lifecycle of a token on Hoodium Launchpad/ })
    expect(drawn).toHaveLength(2)
    for (const svg of drawn) {
      expect(svg.tagName.toLowerCase()).toBe('svg')
      expect(svg.querySelector('title')?.textContent).toBe('How a token moves through Hoodium Launchpad')
      expect(svg.querySelector('desc')?.textContent).toMatch(/locked forever/)
    }

    // The picture is not the only copy of the information.
    const steps = container.querySelectorAll('ol.sr-only > li')
    expect(steps).toHaveLength(7)
    const words = Array.from(steps, (li) => li.textContent ?? '')
    expect(words[0]).toMatch(/pinned to IPFS/)
    expect(words[1]).toMatch(/capped at 5% of supply/)
    expect(words[1]).toMatch(/1% per-address anti-snipe cap/)
    expect(words[2]).toMatch(/USDG in, tokens out/)
    expect(words[3]).toMatch(/70% to the creator/)
    expect(words[4]).toMatch(/69,000 USDG raised/)
    expect(words[5]).toMatch(/GraduationHelper\.fixAndBuy\(\)/)
    expect(words[6]).toMatch(/no withdrawal path — this is irreversible/)
  })

  it('sets the document title', () => {
    renderLearn()
    expect(document.title).toContain('How it works')
  })

  it('links onward to explore, create and the contracts', () => {
    renderLearn()
    expect(screen.getByRole('link', { name: /Explore tokens/ })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: /Create a token/ })).toHaveAttribute('href', '/create')
    expect(screen.getByRole('link', { name: /Read the contracts/ })).toHaveAttribute(
      'href',
      'https://github.com/Hoodium-HQ/hoodium_launchpad',
    )
  })
})
