import { CloudOff, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useChainGuard } from '@/hooks/useChainGuard'
import { useBackendHealth } from '@/hooks/useLaunchpad'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

function Banner({
  tone,
  icon,
  children,
  action,
}: {
  tone: 'warning' | 'danger' | 'muted'
  icon: ReactNode
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-2xl border p-3 text-sm',
        tone === 'danger' && 'border-down/30 bg-down/10 text-down',
        tone === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
        tone === 'muted' && 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      <span className="shrink-0" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

/**
 * "WHEN connected to the wrong chain THEN the app SHALL prompt to switch to
 * Robinhood Chain and SHALL disable all actions until switched."
 */
export function WrongChainBanner() {
  const { isWrongChain, connectedChainId, expectedChainId, expectedChainName, switchToExpected, isSwitching } =
    useChainGuard()

  if (!isWrongChain) return null

  return (
    <Banner
      tone="danger"
      icon={<TriangleAlert className="size-4" />}
      action={
        <Button variant="primary" size="sm" onClick={switchToExpected} disabled={isSwitching}>
          {isSwitching ? 'Switching…' : `Switch to ${expectedChainName}`}
        </Button>
      }
    >
      <p className="font-medium">Wrong network</p>
      <p className="text-xs opacity-90">
        Your wallet is on chain {connectedChainId}; this app talks to {expectedChainName} (chain{' '}
        {expectedChainId}). Every action is disabled until you switch.
      </p>
    </Banner>
  )
}

/**
 * "IF the backend is unreachable THEN on-chain reads and trading SHALL still
 * function." States honestly what is stale rather than pretending nothing
 * happened.
 */
export function BackendOfflineBanner() {
  const { isUnreachable } = useBackendHealth()
  if (!isUnreachable) return null

  return (
    <Banner tone="muted" icon={<CloudOff className="size-4" />}>
      <p className="font-medium text-foreground">Hoodium's API is unreachable</p>
      <p className="text-xs">
        Wallet connection and trading still work — they read the chain directly. The token feed, charts and
        history are unavailable until it returns.
      </p>
    </Banner>
  )
}
