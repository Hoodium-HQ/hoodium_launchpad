import { useAppKit } from '@reown/appkit/react'
import { Coins, LogOut, RefreshCw, User, Wallet } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useDisconnect } from 'wagmi'
import { Address } from '@/components/Address'
import { TokenIcon } from '@/components/TokenIcon'
import { TxStatus } from '@/components/TxStatus'
import { Button, type ButtonProps } from '@/components/ui/button'
import { env } from '@/config/env'
import { useCreatorFees } from '@/hooks/useCreatorFees'
import { tokenImageUrl } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { cn, sanitizeText, truncateMiddle } from '@/lib/utils'

/**
 * The connected-wallet pill and its menu.
 *
 * The shell is hoodium.app's account menu — the same address header with the
 * inline copy, the same rows, the same popover entrance growing out of the
 * corner it hangs from. What is this product's own is the middle band: the
 * pill carries a badge with the number of tokens whose creator fees are ready
 * to claim, and the menu lists them with a Claim button each, because a
 * creator should never have to remember which of their launches is owed money.
 * The claim goes straight to the curve; the API only says where to look.
 *
 * Elevation level 3 (design-system.md section 4): popover surface and a border,
 * no shadow.
 */
export function AccountMenu({
  address,
  variant = 'outline',
  size = 'sm',
  className,
}: {
  address: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const menuId = useId()

  const { open: openAppKit } = useAppKit()
  const { disconnect } = useDisconnect()
  const fees = useCreatorFees()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const rowClass =
    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm text-muted-foreground ' +
    'transition-colors duration-[120ms] hover:bg-muted/60 hover:text-foreground'

  return (
    <div ref={wrapper} className={cn('relative', className)}>
      <Button
        variant={variant}
        size={size}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={menuId}
        /* An address is hex people compare character by character and gets the
           mono face (design-system.md section 6). */
        className="max-w-[12rem] font-mono tabular-nums"
      >
        <Wallet aria-hidden />
        {/* The truncation belongs to the address, not to the button. On the
            button it was `overflow: hidden` over the whole control, which
            clipped the badge below to a wedge in the corner. */}
        <span className="truncate">{truncateMiddle(address)}</span>
      </Button>

      {/* Outside the button for the same reason: hung off the wrapper, no
          overflow rule on the control can ever cut it in half. `pointer-events-none`
          because it sits over the button's own corner and every click there is
          meant for the button. */}
      {fees.count > 0 && (
        <span
          className="num pointer-events-none absolute -right-1.5 -top-1.5 z-10 grid size-5 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
          aria-label={`${fees.count} token${fees.count === 1 ? '' : 's'} with creator fees ready`}
        >
          {fees.count}
        </span>
      )}

      {open && (
        <div
          id={menuId}
          role="menu"
          /* `origin-top-right` is the whole point of the entrance: the menu is
             pinned to the button's right edge, so that is the corner it has to
             grow out of for the motion to say where it came from. */
          className="popover-in absolute right-0 top-full z-50 mt-2 w-72 origin-top-right overflow-hidden rounded-2xl border border-border bg-popover"
        >
          <div className="border-b border-border px-3 py-3">
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Connected
            </p>
            {/* Copying lives on the address itself, which is where every other
                address in the product puts it. */}
            <Address value={address} lead={10} tail={8} className="mt-1" />
          </div>

          {/* Creator fees ready — one row per token, each with its own claim. */}
          <div className="border-b border-border p-1.5">
            <p className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <Coins className="size-3.5" aria-hidden />
              Creator fees ready
            </p>
            {fees.count === 0 ? (
              <p className="px-3 pb-2 text-xs text-muted-foreground">
                {fees.isLoading ? 'Checking your launches…' : 'Nothing to claim right now.'}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {fees.claimable.map((fee) => (
                  <li key={fee.token.address} className="flex items-center gap-2 rounded-lg px-3 py-1.5">
                    <TokenIcon symbol={fee.token.symbol} address={fee.token.address} src={tokenImageUrl(fee.token)} />
                    <span className="min-w-0 flex-1">
                      <Link
                        to={`/t/${fee.token.address}`}
                        onClick={() => setOpen(false)}
                        className="block truncate text-sm hover:underline"
                      >
                        {sanitizeText(fee.token.name, 24) || 'Unnamed'}
                      </Link>
                      <span className="num block text-xs text-muted-foreground">
                        {formatAmount(fromBaseUnits(fee.amount, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
                      </span>
                    </span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={fees.tx.isBusy}
                      onClick={() => void fees.claim(fee)}
                    >
                      Claim
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <TxStatus tx={fees.tx} className="mx-1.5 mb-1.5 mt-1" />
          </div>

          <div className="p-1.5">
            <Link to="/profile" role="menuitem" onClick={() => setOpen(false)} className={rowClass}>
              <User className="size-4" aria-hidden />
              Profile
            </Link>
          </div>

          <div className="border-t border-border p-1.5">
            {/* The one thing AppKit does that we are not rebuilding. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                openAppKit()
              }}
              className={rowClass}
            >
              <RefreshCw className="size-4" aria-hidden />
              Switch wallet
            </button>

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                disconnect()
              }}
              className={cn(rowClass, 'text-down hover:text-down')}
            >
              <LogOut className="size-4" aria-hidden />
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Shown where nobody is connected yet. Kept here so the two states sit together. */
export function ConnectPrompt({
  variant = 'outline',
  size = 'sm',
  label = 'Connect',
  className,
}: {
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  label?: string
  className?: string
}) {
  const { open } = useAppKit()

  return (
    <Button variant={variant} size={size} onClick={() => open()} className={className}>
      <Wallet aria-hidden />
      {label}
    </Button>
  )
}
