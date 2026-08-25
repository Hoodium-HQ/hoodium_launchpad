import { useAppKitAccount } from '@reown/appkit/react'
import { AccountMenu, ConnectPrompt } from '@/components/AccountMenu'
import type { ButtonProps } from '@/components/ui/button'

/**
 * The wallet control — WA-1.1. Connect when nobody is, an account menu when
 * somebody is.
 *
 * AppKit ships `<appkit-button>`, and it is not used. That element renders its
 * own chrome inside a shadow root: its own blue, its own height, its own radius,
 * none of it reachable from `design-system.md`. The `themeVariables` passed to
 * `createAppKit` reach the *modal*, which is why the modal already looks right,
 * but the button draws itself.
 *
 * So the connect modal stays theirs — it is genuinely good at picking a wallet —
 * and everything around it is ours.
 */
export function ConnectButton({
  variant = 'outline',
  size = 'sm',
  className,
  label = 'Connect',
}: {
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  className?: string
  /** Overridden where the button is the page's main call to action. */
  label?: string
}) {
  const { address, isConnected } = useAppKitAccount()

  if (isConnected && address) {
    return <AccountMenu address={address} variant={variant} size={size} className={className} />
  }

  return <ConnectPrompt variant={variant} size={size} label={label} className={className} />
}
