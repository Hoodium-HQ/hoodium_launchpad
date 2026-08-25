import { Check, Loader2 } from 'lucide-react'
import { env } from '@/config/env'
import type { TxStep } from '@/lib/tx-steps'
import { cn, truncateMiddle } from '@/lib/utils'

/**
 * The two-signature flow made visible: "Approve" then "Launch"/"Buy"/"Sell".
 *
 * A finished approval stays on screen as a ticked step (with its hash) instead
 * of a green "Confirmed" strip under a button that would do the same thing
 * again. The current step is the primary button's job; nothing here is clickable.
 */
export function TxSteps({
  steps,
  hashes = {},
  busyKey = null,
  className,
}: {
  steps: TxStep[]
  /** Hash per step, shown next to a done step as an explorer link. */
  hashes?: Partial<Record<TxStep['key'], `0x${string}` | null>>
  /** The step whose transaction is in flight right now. */
  busyKey?: TxStep['key'] | null
  className?: string
}) {
  if (steps.length < 2) return null

  return (
    <ol className={cn('flex flex-col gap-1.5 text-xs', className)} aria-label="Transaction steps">
      {steps.map((step, index) => {
        const done = step.status === 'done'
        const current = step.status === 'current'
        const busy = busyKey === step.key
        const hash = hashes[step.key]
        return (
          <li key={step.key} className="flex items-center gap-2" aria-current={current ? 'step' : undefined}>
            <span
              aria-hidden
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-medium',
                done && 'border-up/40 bg-up/15 text-up',
                current && !done && 'border-primary bg-primary/10 text-primary',
                step.status === 'upcoming' && 'border-border text-muted-foreground',
              )}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : done ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={cn(done || current ? 'text-foreground' : 'text-muted-foreground', done && 'line-through decoration-muted-foreground/50')}>
              {step.label}
            </span>
            {done && <span className="sr-only">(done)</span>}
            {hash && (
              <span className="num ml-auto text-muted-foreground">
                {env.explorerUrl ? (
                  <a href={`${env.explorerUrl}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="underline">
                    {truncateMiddle(hash, 8, 6)}
                  </a>
                ) : (
                  truncateMiddle(hash, 8, 6)
                )}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
