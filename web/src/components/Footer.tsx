import { Link } from 'react-router'
import { Logo } from './Logo'

const PRODUCT = [
  { to: '/', label: 'Explore' },
  { to: '/create', label: 'Create a token' },
  { to: '/profile', label: 'Profile' },
] as const

const LEGAL = [
  { href: 'https://hoodium.app/privacy', label: 'Privacy' },
  { href: 'https://hoodium.app/terms', label: 'Terms' },
] as const

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="container max-w-7xl pad-safe-x py-10 sm:px-6">
        <div className="grid gap-8 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <Logo markClassName="size-5" />
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              Launch and explore fixed-supply tokens on Robinhood Chain. Your wallet submits every
              transaction. Hoodium does not custody assets.
            </p>
          </div>

          <div>
            <p className="text-label font-medium uppercase tracking-wide text-muted-foreground">Product</p>
            <ul className="mt-3 space-y-2 text-sm">
              {PRODUCT.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="text-muted-foreground hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <a
                  href="https://hoodium.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Hoodium
                </a>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-label font-medium uppercase tracking-wide text-muted-foreground">Legal</p>
            <ul className="mt-3 space-y-2 text-sm">
              {LEGAL.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-8 border-t border-border pt-6 text-xs text-muted-foreground">
          <span className="text-foreground">Risk notice.</span> Anyone can launch a token here; Hoodium does not
          review, endorse, or rank any of them for payment, and issues no token of its own. Most tokens never
          graduate and can go to zero. Hoodium charges a fee on every curve trade and a share of locked-pool
          fees, whether or not a token succeeds. You can lose everything you put in.
        </p>
      </div>
    </footer>
  )
}
