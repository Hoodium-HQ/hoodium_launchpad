import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * shadcn/ui `new-york`, neutral base (design-system.md section 1). Owned source,
 * not a dependency.
 *
 * Note what is absent: no `up`/`down` variant. The accent is reserved for brand
 * (design-system.md section 3) and the semantic colours are reserved for price
 * direction — a green button would collide with "price up" on a page full of
 * numbers.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium ' +
    /*
     * `active:scale-[0.98]` — the only motion on this component, and it is
     * deliberately at the edge of perceptible.
     *
     * Buttons here are pressed dozens of times a session, which is the tier
     * where animation starts costing more than it returns: anything showier
     * would make the app feel slower with every press. What it buys is the one
     * thing a press had none of — confirmation that the click registered, on
     * controls that go on to open a wallet and ask for a signature, where the
     * next frame can be several hundred milliseconds away.
     *
     * The transition is now an explicit property list rather than
     * `transition-colors`, so `transform` shares the same 120ms curve instead
     * of snapping while the background eases. `disabled:pointer-events-none`
     * already keeps `:active` off a dead control.
     */
    'transition-[color,background-color,border-color,transform] duration-[120ms] ease-out active:scale-[0.98] ' +
    'focus-visible:outline-none focus-visible:ring-2 ' +
    'focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-muted text-foreground hover:bg-muted/70',
        outline: 'border border-border bg-transparent hover:bg-muted/50',
        ghost: 'hover:bg-muted/50',
        destructive: 'bg-destructive text-foreground hover:bg-destructive/90',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
)
Button.displayName = 'Button'

export { buttonVariants }
