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
    'transition-colors duration-[120ms] ease-out focus-visible:outline-none focus-visible:ring-2 ' +
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
