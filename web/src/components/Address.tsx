import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { env } from '@/config/env'
import { cn, truncateMiddle } from '@/lib/utils'
import { Hint } from '@/components/ui/tooltip'

/**
 * `Address` — design-system.md section 7. Truncated mono identifier, click to copy.
 *
 * Truncation is in the middle, not the tail: the trailing characters are what
 * people actually compare when checking they are looking at the right contract.
 *
 * ── The whole chip copies, not just the icon ─────────────────────────────────
 * A 12px icon beside a truncated address is a small target for the one thing
 * anybody wants from a truncated address. So in the default shape the text and
 * the icon are one button — clicking anywhere on `0xb40c…7bc2` copies the full
 * value, and the icon is a hint about what the click does rather than the only
 * place it works.
 *
 * `link` is the exception, and it has to be. Text cannot be both a link to the
 * explorer and a copy button, so there the text navigates and the icon beside it
 * copies. That is two targets because it is genuinely two actions.
 *
 * ── Why every call site gets this rather than plain `truncateMiddle` ─────────
 * A truncated address that cannot be copied is worse than no address at all: it
 * is enough to recognise and not enough to use, so the reader has to go find the
 * full value somewhere else. Rendering `truncateMiddle(x)` into a `<span>` is the
 * shape that keeps reintroducing that, which is why this component exists and
 * why it covers the sizes the call sites actually need.
 */
const SIZES = {
  xs: { text: 'text-xs', icon: 'size-3' },
  sm: { text: 'text-sm', icon: 'size-3.5' },
  base: { text: 'text-base', icon: 'size-4' },
  lg: { text: 'text-section-title', icon: 'size-5' },
} as const

export function Address({
  value,
  className,
  link = false,
  to,
  label,
  size = 'xs',
  lead = 6,
  tail = 4,
  muted = true,
}: {
  value: string
  className?: string
  /** Link out to the explorer. Splits the control in two: text navigates, icon copies. */
  link?: boolean
  /**
   * An in-app route for the text instead of the explorer — a creator address
   * belongs on its Hoodium profile, not on Etherscan. Takes precedence over
   * `link`, since the two would be two destinations for one piece of text.
   */
  to?: string
  /** What this identifies, for the screen-reader label. Defaults to "address". */
  label?: string
  size?: keyof typeof SIZES
  /** Characters kept at each end. Widen both for a hash, which collides sooner. */
  lead?: number
  tail?: number
  /** False renders at full contrast, for a heading rather than a table cell. */
  muted?: boolean
}) {
  const [copied, setCopied] = useState(false)

  /*
   * The reset timer, cleared on unmount. Without this a row copied and then
   * scrolled out of a virtualised list — or any address inside a dialog that is
   * closed within the second — leaves `setState` firing on a gone component.
   */
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1200)
    } catch {
      // Clipboard is permission-gated, and absent entirely on an insecure
      // origin. The address is still on screen and `title` still carries it in
      // full, so there is nothing to recover from.
    }
  }

  const { text, icon } = SIZES[size]
  const truncated = truncateMiddle(value, lead, tail)
  const what = label ?? 'address'
  /*
   * The tick carries `.mark-in`, and what makes a keyframe fire at all here is
   * that this is a *different component* — React replaces the element rather
   * than re-rendering it, so the animation starts from scratch on every copy
   * and again on every reset. A `className` toggled on one persistent element
   * would play once and never again.
   */
  const Mark = copied ? Check : Copy

  const base = cn('font-mono', text, muted && 'text-muted-foreground', className)

  // Linked: two controls, because navigating and copying are two intents.
  const linkClass = 'rounded hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
  const destination = to ? (
    <Hint content={value} contentClassName="font-mono" render={<Link to={to} className={linkClass} />}>
      {truncated}
    </Hint>
  ) : link && env.explorerUrl ? (
    <Hint
      content={value}
      contentClassName="font-mono"
      render={
        <a
          href={`${env.explorerUrl}/address/${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        />
      }
    >
      {truncated}
    </Hint>
  ) : null

  if (destination) {
    return (
      <span className={cn('inline-flex items-center gap-1.5', base)}>
        {destination}
        <button
          type="button"
          onClick={copy}
          className="rounded p-0.5 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={copied ? 'Copied' : `Copy ${what} ${value}`}
        >
          <Mark className={cn(icon, copied && 'mark-in text-up')} aria-hidden />
        </button>
      </span>
    )
  }

  return (
    <Hint
      content={value}
      contentClassName="font-mono"
      render={<button type="button" onClick={copy} aria-label={copied ? 'Copied' : `Copy ${what} ${value}`} />}
      className={cn(
        'inline-flex items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        base,
      )}
    >
      {truncated}
      <Mark className={cn(icon, 'shrink-0', copied && 'mark-in text-up')} aria-hidden />
    </Hint>
  )
}
