import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Elevation levels 1 and 2 — design-system.md section 4.
 * No shadows: depth comes from surface lightness and borders, because shadows
 * read as mud on a near-black canvas.
 */
export function Card({
  className,
  featured = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { featured?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl',
        // Level 2 carries a budget of one per viewport (design-system.md section 5).
        featured ? 'surface-featured' : 'border border-border bg-card',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-4 sm:p-5', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-card-title text-foreground', className)} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-label text-muted-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-0 sm:p-5 sm:pt-0', className)} {...props} />
}
