import { BookOpen, Compass, Plus, User } from 'lucide-react'
import { useRef } from 'react'
import { Link, useLocation } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * The mobile tab bar — primary navigation below `md`, at the bottom edge.
 *
 * Ported from hoodium.app, where the same bar carries Home / Pools / Alerts /
 * Portfolio. Here it carries the four destinations this product has: what
 * there is to buy, how the whole thing works, the form that makes more of it,
 * and your own holdings. Four is what hoodium.app's bar carries too, so the
 * row's measurements were sized for it.
 *
 * Above `md` it is not rendered at all: the navbar carries the same links
 * there, and two navigations claiming the same destinations is a second focus
 * stop for every keyboard user.
 */

/**
 * Which tab is lit, from the URL. A token page lights nothing: the web has no
 * navigation stack to keep a section lit through, and guessing which tab a
 * detail page "came from" would light one the reader may have arrived at from
 * a shared link.
 */
function activeKey(pathname: string): 'explore' | 'learn' | 'create' | 'profile' | null {
  if (pathname === '/') return 'explore'
  if (pathname === '/learn') return 'learn'
  if (pathname === '/create') return 'create'
  if (pathname === '/profile' || pathname.startsWith('/profile/')) return 'profile'
  return null
}

/**
 * Left to right, and the only place the order is written down: the pill that
 * slides between tabs is positioned by index, and `length` is what tells the
 * CSS how wide a column is.
 */
const ORDER = ['explore', 'learn', 'create', 'profile'] as const

export function TabBar() {
  const location = useLocation()
  const active = activeKey(location.pathname)
  const index = active === null ? -1 : ORDER.indexOf(active)

  /*
   * Where the pill rests when nothing is lit — a token page. It fades out in
   * place rather than travelling to a tab that is not lit. A ref, written
   * during render, because nothing re-renders when it changes.
   */
  const resting = useRef(0)
  if (index >= 0) resting.current = index

  return (
    <nav className="tabbar md:hidden" aria-label="Primary">
      <ul
        className="relative flex items-stretch"
        style={{ '--tab-count': ORDER.length } as React.CSSProperties}
      >
        {/* The lit tab's pill — one element that travels. See `.tab-indicator`. */}
        <span
          aria-hidden
          className="tab-indicator"
          style={{
            transform: `translateX(${(index >= 0 ? index : resting.current) * 100}%)`,
            opacity: index >= 0 ? 1 : 0,
          }}
        />

        <TabLink to="/" label="Explore" icon={Compass} active={active === 'explore'} />
        <TabLink to="/learn" label="Learn" icon={BookOpen} active={active === 'learn'} />
        <TabLink to="/create" label="Create" icon={Plus} active={active === 'create'} />
        <TabLink to="/profile" label="Profile" icon={User} active={active === 'profile'} />
      </ul>
    </nav>
  )
}

type Icon = typeof Compass

/**
 * The row every tab occupies. `relative` is load-bearing: the pill is absolutely
 * positioned and comes first in the DOM, so this is what puts the icon and the
 * label on top of it rather than under it.
 */
const TAB_CLASS =
  'relative flex h-[var(--tab-row-h)] w-full flex-col items-center justify-center outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'

function TabLink({
  to,
  label,
  icon: Icon,
  active,
}: {
  to: string
  label: string
  icon: Icon
  active: boolean
}) {
  return (
    <li className="flex-1">
      {/*
        A plain `Link`, not `NavLink`: `activeKey` above is the one authority on
        which tab is current, and `NavLink` would write its own `aria-current`
        over the one passed in.
      */}
      <Link
        to={to}
        className={cn(TAB_CLASS, active ? 'text-foreground' : 'text-muted-foreground')}
        aria-current={active ? 'page' : undefined}
      >
        <span className="flex flex-col items-center justify-center gap-[var(--tab-gap)]">
          <span className="relative flex h-[var(--tab-icon-h)] w-12 items-center justify-center">
            {/* The weight is a CSS transition keyed off `data-active` — see `.tab-icon`. */}
            <Icon className="tab-icon size-5" data-active={active} aria-hidden />
          </span>
          {/* Labelled, not icons alone: an icon-only bar is the one navigation
              pattern that cannot be read by anyone who has not already learned it. */}
          <span className="text-[length:var(--tab-label-h)] leading-none">{label}</span>
        </span>
      </Link>
    </li>
  )
}
