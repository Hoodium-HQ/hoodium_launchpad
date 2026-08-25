import { Menu, Moon, Plus, Search, Sun, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { cn } from '@/lib/utils'
import { useTheme } from '@/store/ui'
import { Button } from './ui/button'
import { CommandSearch, useCommandSearchShortcut } from './CommandSearch'
import { ConnectButton } from './ConnectButton'
import { Logo } from './Logo'

/**
 * Fixed navbar with the progressive blur treatment.
 *
 * Two layers: the bar itself, and a taller non-interactive fade whose blur is
 * masked by a gradient so there is no hard seam where the treatment stops.
 * Bar height is fixed at 64px and never content-dependent — a bar that changes
 * height on scroll reflows the page under the user's finger.
 *
 * Below `md` the links collapse into a disclosure panel. What stays in the bar
 * on mobile is what someone actually reaches for: search and the wallet.
 */
const LINKS = [
  { to: '/', label: 'Explore', end: true },
  { to: '/profile', label: 'Profile', end: false },
] as const

/** The accent button on desktop; a plain row in the mobile panel. */
const PANEL_LINKS = [LINKS[0], { to: '/create', label: 'Create', end: false }, LINKS[1]] as const

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const location = useLocation()
  const sentinel = useRef<HTMLDivElement>(null)
  const panelId = useId()

  const openSearch = useCallback(() => setSearchOpen(true), [])
  useCommandSearchShortcut(openSearch)

  /*
   * Scrolled state from an IntersectionObserver on a zero-height sentinel
   * rather than a scroll listener: it fires exactly when the sentinel crosses
   * the viewport edge and costs nothing in between.
   */
  useEffect(() => {
    const node = sentinel.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry?.isIntersecting), {
      threshold: 1,
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // A menu that survives navigation would cover the page the user just chose.
  useEffect(() => setOpen(false), [location.pathname])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'rounded-lg px-3 py-1.5 text-sm transition-colors duration-[120ms]',
      isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
    )

  return (
    <>
      <div ref={sentinel} aria-hidden className="absolute inset-x-0 top-0 h-px" />
      <div className="navbar-fade" aria-hidden />

      <header className="navbar" data-scrolled={scrolled}>
        <nav className="container flex max-w-7xl items-center gap-2 sm:gap-4" aria-label="Main">
          <NavLink to="/" className="shrink-0 rounded-lg" aria-label="Hoodium Launchpad — home">
            <Logo markClassName="size-6" />
          </NavLink>

          <div className="hidden items-center gap-1 md:flex">
            {LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={linkClass}>
                {link.label}
              </NavLink>
            ))}
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
            <Button variant="ghost" size="icon" onClick={openSearch} aria-label="Search tokens" title="Search (⌘K)">
              <Search aria-hidden />
            </Button>

            <NavLink
              to="/create"
              className={cn(
                'hidden h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground',
                'transition-colors duration-[120ms] hover:bg-primary/90 md:inline-flex',
              )}
            >
              <Plus className="size-3.5" aria-hidden />
              Create
            </NavLink>

            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              className="hidden md:inline-flex"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
            </Button>

            <ConnectButton className="min-w-0 shrink" />

            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 md:hidden"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={open ? 'Close menu' : 'Open menu'}
            >
              {open ? <X aria-hidden /> : <Menu aria-hidden />}
            </Button>
          </div>
        </nav>
      </header>

      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
          />
          <div
            id={panelId}
            className="fixed inset-x-0 top-16 z-50 border-b border-border bg-popover md:hidden"
            style={{
              paddingLeft: 'max(1rem, env(safe-area-inset-left))',
              paddingRight: 'max(1rem, env(safe-area-inset-right))',
            }}
          >
            <div className="flex flex-col py-2">
              {PANEL_LINKS.map((link, i) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  style={{ '--i': i } as React.CSSProperties}
                  className={({ isActive }) =>
                    cn(
                      'stagger-in rounded-lg px-3 py-3 text-base transition-colors duration-[120ms]',
                      isActive ? 'bg-muted/60 text-foreground' : 'text-muted-foreground',
                    )
                  }
                >
                  {link.label}
                </NavLink>
              ))}

              <button
                type="button"
                onClick={toggle}
                className="mt-1 flex items-center gap-2 rounded-lg px-3 py-3 text-base text-muted-foreground transition-colors duration-[120ms] hover:text-foreground"
              >
                {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
                Switch to {theme === 'dark' ? 'light' : 'dark'} theme
              </button>
            </div>
          </div>
        </>
      )}

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  )
}
