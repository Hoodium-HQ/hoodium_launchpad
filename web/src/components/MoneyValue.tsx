import { cn } from '@/lib/utils'
import { direction, formatAmount, type FormatOptions, type Money } from '@/lib/money'

/**
 * `MoneyValue` — design-system.md section 7, WA-N4.
 *
 * "String/bigint in, formatted out — **never accepts `number`**."
 *
 * The `value` prop is typed `Money`, which is `string | bigint`. Passing a
 * `number` is a compile error. That is the enforcement mechanism: a rule that
 * lives in a lint config gets disabled; a rule that lives in a prop type does not.
 */
export interface MoneyValueProps extends FormatOptions {
  value: Money
  className?: string
  /**
   * Colour by direction. WA-5.5 forbids colour alone, so this always renders a
   * sign glyph alongside — never one without the other.
   */
  colorBySign?: boolean
  /** Visual size. Numbers are always mono + tabular (design-system.md section 6). */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'display'
}

const SIZES = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-[17px]',
  xl: 'text-xl',
  /*
   * The scale stopped at 20px, which is why no page had a headline figure: a
   * position's profit was set at the same size as the sub-row qualifying it, so
   * three stacked figures read as three equal facts and the reader had to
   * find the important one by reading the labels.
   *
   * `leading-none` and `tracking-tight` because this is display type now, not
   * body type that happens to be large - at 36px the default line box adds
   * visible slack above a figure that is meant to sit tight under its label.
   */
  display: 'text-[2rem] leading-none tracking-tight sm:text-[2.5rem]',
} as const

export function MoneyValue({
  value,
  className,
  colorBySign = false,
  size = 'md',
  ...format
}: MoneyValueProps) {
  const text = formatAmount(value, { ...format, signed: colorBySign || format.signed })

  /*
   * Colour follows the figure **as printed**, not the one behind it.
   *
   * `direction` reads the exact value, and `formatAmount` rounds. Below half a
   * unit of the chosen precision the two part company: `-0.0000000000000000003`
   * at `dp={0}` prints `0` — no sign, because there is nothing left to sign —
   * while `direction` still says `down`. The result was a bare zero painted
   * red, which is the one thing the comment on `colorBySign` above promises
   * cannot happen (WA-5.5: never colour without a glyph), and it also reads as
   * a loss when the honest statement is "nothing, to the precision shown".
   *
   * Found on the live provider board the day P&L shipped as a column: three of
   * the top ten rows are dust, because a position whose deposits and current
   * value cancel lands a few atto-units either side of zero. No fixture had a
   * value small enough to round away, which is exactly the class of bug that
   * only real data carries.
   *
   * The sign in the text is the test rather than a re-rounding of the value:
   * it is the same string the reader sees, so the two cannot drift apart the
   * next time the formatter learns something.
   */
  const dir = /[+−-]/.test(text) ? direction(value) : 'flat'

  return (
    <span
      className={cn(
        // `tabular-nums` is mandatory: proportional digits make values jitter
        // horizontally on every tick, which reads as instability in the data.
        'num font-medium',
        SIZES[size],
        colorBySign && dir === 'up' && 'text-up',
        colorBySign && dir === 'down' && 'text-down',
        colorBySign && dir === 'flat' && 'text-muted-foreground',
        className,
      )}
    >
      {text}
    </span>
  )
}
