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
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const SIZES = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-[17px]',
  xl: 'text-xl',
} as const

export function MoneyValue({
  value,
  className,
  colorBySign = false,
  size = 'md',
  ...format
}: MoneyValueProps) {
  const dir = direction(value)
  const text = formatAmount(value, { ...format, signed: colorBySign || format.signed })

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
