import { useAppKit } from '@reown/appkit/react'
import { Check, Coins, Copy, LogOut, RefreshCw, User, Wallet } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useDisconnect } from 'wagmi'
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
 * The pill carries a badge with the number of tokens whose creator fees are
 * ready to claim, and the menu lists them with a Claim button each — a creator
 * should never have to remember which of their launches is owed money. The
 * claim goes straight to the curve; the API only says where to look.
 *
 * Elevation level 3: popover surface and a border, no shadow.
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
  const [copied, setCopied] = useState(false)
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard is permission-gated and can simply refuse. The address is on
      // screen either way.
    }
  }

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
        className="relative max-w-[12rem] truncate font-mono tabular-nums"
      >
        <Wallet aria-hidden />
        {truncateMiddle(address)}
        {fees.count > 0 && (
          <span
            className="num absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground"
            aria-label={`${fees.count} token${fees.count === 1 ? '' : 's'} with creator fees ready`}
          >
            {fees.count}
          </span>
        )}
      </Button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-border bg-popover"
        >
          <div className="border-b border-border px-3 py-3">
            <p className="text-label text-muted-foreground">Connected</p>
            <p className="truncate font-mono text-xs text-foreground" title={address}>
              {truncateMiddle(address, 10, 8)}
            </p>
          </div>

          {/* Creator fees ready — one row per token, each with its own claim. */}
          <div className="border-b border-border p-1.5">
            <p className="flex items-center gap-1.5 px-3 pb-1 pt-1.5 text-label text-muted-foreground">
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

            <button type="button" role="menuitem" onClick={() => void copy()} className={rowClass}>
              {copied ? <Check className="size-4 text-up" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              {copied ? 'Copied' : 'Copy address'}
            </button>

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
