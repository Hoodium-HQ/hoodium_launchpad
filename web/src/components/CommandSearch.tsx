import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { TokenIcon } from '@/components/TokenIcon'
import { useTokenList } from '@/hooks/useLaunchpad'
import { tokenImageUrl } from '@/lib/launchpad-api'
import { formatAmount, usdToMoney } from '@/lib/money'
import { cn, isAddress, sanitizeText, truncateMiddle } from '@/lib/utils'
import { Modal } from './Modal'

/**
 * Search by name, symbol or address — ⌘K / Ctrl-K opens it from anywhere.
 *
 * Queries go to `/api/tokens?q=`; a pasted address opens the token page
 * directly, since a token the indexer has not seen yet still has a page.
 */
export function useCommandSearchShortcut(open: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])
}

/** ⌘K on a Mac, Ctrl+K everywhere else — the hint has to match the keyboard it is read on. */
const SHORTCUT_HINT =
  typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? '') ? '⌘K' : 'Ctrl K'

export function SearchTrigger({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        // The navbar's field, at page width: same hairline, same hint chip.
        'flex h-10 w-full items-center gap-2 rounded-lg border border-border/70 bg-card pl-3 pr-2 text-left text-sm text-muted-foreground',
        'transition-colors duration-[120ms] hover:border-border hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Search tokens by name, symbol or address</span>
      <kbd className="hidden shrink-0 rounded border border-border/70 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground sm:inline-block">
        {SHORTCUT_HINT}
      </kbd>
    </button>
  )
}

export function CommandSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 200)
    return () => clearTimeout(id)
  }, [q])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
    else setQ('')
  }, [open])

  const results = useTokenList({ q: debounced, limit: 8 }, { live: false })
  const items = debounced ? (results.data?.items ?? []) : []

  const go = (address: string) => {
    onClose()
    navigate(`/t/${address}`)
  }

  const onSubmit = () => {
    const first = items[0]
    if (isAddress(debounced)) go(debounced)
    else if (first) go(first.address)
  }

  return (
    <Modal open={open} onClose={onClose} title="Search">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, symbol or 0x address"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
            aria-label="Search tokens"
          />
        </label>
      </form>

      <div className="mt-3 max-h-80 overflow-y-auto">
        {!debounced ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Type to search. Paste an address to jump straight to it.</p>
        ) : results.isLoading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Searching…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {isAddress(debounced) ? 'Not indexed yet — press Enter to open it anyway.' : 'No tokens match.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((token) => (
              <li key={token.address}>
                <button
                  type="button"
                  onClick={() => go(token.address)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TokenIcon symbol={token.symbol} address={token.address} src={tokenImageUrl(token)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{sanitizeText(token.name, 40) || 'Unnamed'}</span>
                    <span className="num block truncate text-xs text-muted-foreground">
                      ${sanitizeText(token.symbol, 12) || '???'} · {truncateMiddle(token.address)}
                    </span>
                  </span>
                  <span className="num shrink-0 text-xs text-muted-foreground">
                    {formatAmount(usdToMoney(token.marketCapUsd), { compact: true, prefix: '$' })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
