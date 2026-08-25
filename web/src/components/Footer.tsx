import { Mail } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * The site footer — hoodium.app's, plus the one paragraph this product cannot
 * do without.
 *
 * hoodium.app's footer is a copyright line and two ways to reach the people
 * behind the site. That shape is kept whole so the two products end the same
 * way. Above it sits the risk notice, because a launchpad that charges a fee
 * on every trade has to say so somewhere every page reaches, and the foot of
 * the page is where a reader (and a directory reviewer) looks for it.
 *
 * It also takes over clearing the mobile tab bar: `pad-main-bottom` belongs to
 * whatever renders last, and since the footer that is no longer `main`.
 */
export function Footer({ className }: { className?: string }) {
  return (
    <footer className={cn('container max-w-7xl pad-safe-x pad-main-bottom pt-10 sm:px-6', className)}>
      <div className="border-t border-border pt-5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="text-foreground">Risk notice.</span> Anyone can launch a token here; Hoodium does not
          review, endorse, or rank any of them for payment, and issues no token of its own. Most tokens never
          graduate and can go to zero. Hoodium charges a fee on every curve trade and a share of locked-pool
          fees, whether or not a token succeeds. Your wallet submits every transaction and Hoodium custodies
          nothing. You can lose everything you put in.
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="text-xs text-muted-foreground">
            {/* Computed rather than typed: a footer that says 2026 in 2027 is the
                most visible way a site announces nobody is home. */}
            &copy; {new Date().getFullYear()} Hoodium
          </p>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {/* Product first, then the people. */}
            <Link
              to="/learn"
              className="rounded text-xs text-muted-foreground transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              How it works
            </Link>

            <a
              href="https://hoodium.app"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-xs text-muted-foreground transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              hoodium.app
            </a>

            <a
              href="https://x.com/HoodiumHQ"
              target="_blank"
              rel="me noreferrer"
              className="inline-flex items-center gap-2 rounded text-xs text-muted-foreground transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* Drawn here rather than imported: lucide dropped its brand icons,
                  and `X` in this codebase is already the navbar's close button. */}
              <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor" aria-hidden>
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              @HoodiumHQ
            </a>

            <a
              href="mailto:hello@hoodium.app"
              className="inline-flex items-center gap-2 rounded text-xs text-muted-foreground transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Mail className="size-3.5" aria-hidden />
              hello@hoodium.app
            </a>
          </div>
        </div>
      </div>
    </footer>
  )
}
