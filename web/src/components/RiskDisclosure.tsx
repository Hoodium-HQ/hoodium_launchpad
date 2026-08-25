import { useState } from 'react'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { useUiStore } from '@/store/ui'

/**
 * WA-2.6 / LP-N6 — "BEFORE a user's first purchase the app SHALL display a risk
 * disclosure requiring acknowledgement."
 *
 * Shown once per browser, before the first trade, and it blocks the trade panel
 * until acknowledged. LP-N5 constrains the wording: Hoodium issues no token,
 * promises no yield, and promotes nothing — so this says what is true and stops.
 * A disclosure that reassures is worse than none, because it converts a warning
 * into marketing.
 */
export function RiskDisclosure({ onAcknowledge }: { onAcknowledge?: () => void }) {
  const acknowledge = useUiStore((s) => s.acknowledgeRisk)
  const [checked, setChecked] = useState(false)

  return (
    <Card className="p-5">
      <h3 className="text-card-title">Before you trade</h3>

      <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
        <li>
          <span className="text-foreground">Anyone can launch a token here.</span> Hoodium does not review,
          endorse, or vet them. A name and symbol can be chosen to imitate something else.
        </li>
        <li>
          <span className="text-foreground">Most tokens never graduate.</span> Across comparable launchpads,
          roughly 1 in 100 reaches its target. Assume yours will not.
        </li>
        <li>
          <span className="text-foreground">The creator can sell whatever they hold, at any time,</span>{' '}
          including immediately after you buy.
        </li>
        <li>
          <span className="text-foreground">You can lose everything you put in.</span> There is no refund,
          no recovery, and no support that can reverse a trade.
        </li>
        <li>
          Hoodium charges a fee on every buy and sell, and a fee at graduation. Those are how it makes
          money — <span className="text-foreground">whether or not your token succeeds.</span>
        </li>
      </ul>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))]"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span>I understand I may lose everything I spend here.</span>
      </label>

      <Button
        variant="primary"
        className="mt-4 w-full"
        disabled={!checked}
        onClick={() => {
          acknowledge()
          onAcknowledge?.()
        }}
      >
        Continue
      </Button>
    </Card>
  )
}
