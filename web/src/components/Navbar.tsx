import { Menu, Moon, Plus, Search as SearchIcon, Sun, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { cn } from '@/lib/utils'
import { useTheme } from '@/store/ui'
import { Button } from './ui/button'
import { CommandSearch } from './CommandSearch'
import { ConnectButton } from './ConnectButton'
import { Logo } from './Logo'

/**
 * Fixed navbar with the progressive blur treatment — design-system.md section 9.
 *
 * Ported from hoodium.app's bar so the two products share one shell: the same
 * mark, the same search field with its shortcut hint, the same outline wallet
 * control on the right. What is this product's own is the link set — Explore,
 * Create, Profile — and the accent "Create" button, which is the launchpad's
 * one primary action and belongs in persistent chrome for the same reason a
 * "new" button does in any authoring tool.
 *
 * Two layers: the bar itself, and a taller non-interactive fade whose blur is
 * masked by a gradient so there is no hard seam where the treatment stops.
 * Bar height is fixed at 64px and never content-dependent — a bar that changes
 * height on scroll reflows the page under the user's finger.
 *
 * **Below `md` the primary navigation is the bottom tab bar** (`TabBar`), so the
 * disclosure behind the hamburger carries only what the tab bar does not: the
 * theme toggle and the way back to hoodium.app.
 */
const LINKS = [
  { to: '/', label: 'Explore', end: true },
  { to: '/create', label: 'Create', end: false },
  { to: '/profile', label: 'Profile', end: false },
] as const

/**
 * ⌘K on a Mac, Ctrl+K everywhere else — the label has to match the keyboard it
 * is read on. `navigator.platform` is deprecated and still the only thing that
 * answers this in every browser we serve.
 */
const IS_APPLE =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? '')
const shortcutHint = IS_APPLE ? '⌘K' : 'Ctrl K'

export function Navbar() {
  const [searchOpen, setSearchOpen] = useState(false)

  /*
   * The shortcut, and the two guards that keep it from being a nuisance: it
   * never fires while the reader is typing somewhere else (Ctrl+K in a text
   * field is "delete to end of line" on every Unix-descended input), and it
   * toggles rather than only opening, so the key that summons it dismisses it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      event.preventDefault()
      setSearchOpen((wasOpen) => !wasOpen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const { theme, toggle } = useTheme()
  const location = useLocation()
  const sentinel = useRef<HTMLDivElement>(null)
  const panelId = useId()

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
  useEffect(() => setOpen(false), [location.pathname, location.search])

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
      {/* Watched by the observer above; never painted. */}
      <div ref={sentinel} aria-hidden className="absolute inset-x-0 top-0 h-px" />

      {/* Layer 2 first in the DOM so it can never sit above the bar. */}
      <div className="navbar-fade" aria-hidden />

      <header className="navbar" data-scrolled={scrolled}>
        <nav className="container flex items-center gap-2 sm:gap-4" aria-label="Main">
          <NavLink to="/" className="shrink-0 rounded-lg" aria-label="Hoodium Launchpad home">
            {/* The one place the mark animates. */}
            <Logo markClassName="size-6" animate />
          </NavLink>

          {/* Desktop navigation. Hidden rather than wrapped: a two-line bar
              would break the fixed 64px height the treatment depends on. */}
          <div className="hidden items-center gap-1 md:flex">
            {LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} end={link.end} className={linkClass}>
                {link.label}
              </NavLink>
            ))}
          </div>

          {/*
            The search, between navigation and chrome because it is both. It
            looks like a field and behaves like a button: a real input in a
            fixed bar would have to own focus and a value on every route, and
            the moment it opens a dialog with its own input, the one in the bar
            is a decoy that eats the first keystroke.
          */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="ml-auto hidden h-9 min-w-0 items-center gap-2 rounded-lg border border-border/70 pl-3 pr-2 text-sm text-muted-foreground outline-none transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:flex md:w-56 lg:w-72"
          >
            <SearchIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">Search tokens</span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-border/70 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground lg:block">
              {shortcutHint}
            </kbd>
          </button>

          <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2 md:ml-3">
            {/* The same search, as a target on a phone. */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSearchOpen(true)}
              className="md:hidden"
              aria-label="Search tokens"
            >
              <SearchIcon aria-hidden />
            </Button>

            {/*
              The launchpad's one primary action, in the accent. Desktop only:
              below `md` the tab bar carries Create as a destination, and a
              lime button beside a lime tab would be the same action twice.
            */}
            <NavLink
              to="/create"
              className={cn(
                'hidden h-8 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-primary-foreground',
                'transition-[color,background-color,transform] duration-[120ms] hover:bg-primary/90 active:scale-[0.98] md:inline-flex',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              <Plus className="size-3.5" aria-hidden />
              Create
            </NavLink>

            {/* The toggle is in the panel on mobile, so it is not duplicated here. */}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              className="hidden md:inline-flex"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
            </Button>

            {/* Outline rather than the accent: the bar is persistent chrome,
                and the accent is already spent on Create. */}
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

      <CommandSearch open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/*
        The panel. Rendered outside the bar so the bar's height stays fixed, and
        below `md` only. It carries what the tab bar does not.
      */}
      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => setOpen(false)}
            className="animate-fade-in fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
          />
          <div
            id={panelId}
            className="panel-in fixed inset-x-0 top-16 z-50 border-b border-border bg-popover md:hidden"
            style={{
              paddingLeft: 'max(1rem, env(safe-area-inset-left))',
              paddingRight: 'max(1rem, env(safe-area-inset-right))',
            }}
          >
            <div className="flex flex-col py-2">
              <a
                href="https://hoodium.app"
                target="_blank"
                rel="noopener noreferrer"
                style={{ '--i': 0 } as React.CSSProperties}
                className="stagger-in rounded-lg px-3 py-3 text-base text-muted-foreground transition-colors duration-[120ms] hover:text-foreground"
              >
                Hoodium — liquidity positions
              </a>

              <button
                type="button"
                onClick={toggle}
                style={{ '--i': 1 } as React.CSSProperties}
                className="stagger-in mt-1 flex items-center gap-2 rounded-lg px-3 py-3 text-base text-muted-foreground transition-colors duration-[120ms] hover:text-foreground"
              >
                {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
                Switch to {theme === 'dark' ? 'light' : 'dark'} theme
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
