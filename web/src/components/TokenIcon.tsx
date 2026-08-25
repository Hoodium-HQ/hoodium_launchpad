import { useState } from 'react'
import { initialOf, markStyle } from '@/lib/mark'
import { cn } from '@/lib/utils'

/**
 * Small round token mark, for rows and menus where the square avatar is too
 * much. Drawn locally unless the API holds artwork; the generated mark is
 * derived from the address (`lib/mark`, shared with hoodium.app), so two tokens
 * sharing a symbol still look different — which is the case that matters,
 * since tokens impersonate each other by name.
 */
export function TokenIcon({
  symbol,
  address,
  src,
  className,
}: {
  symbol: string
  address: string
  /** Resolved via `tokenImageUrl`; null means draw the mark. */
  src?: string | null
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={24}
        height={24}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        /*
         * The disc behind the logo is white in both themes: a good share of
         * token artwork is black on a transparent ground, which on the dark
         * theme's muted grey renders as an empty hole.
         */
        className={cn('inline-block size-6 shrink-0 rounded-full bg-white object-cover', className)}
      />
    )
  }

  return (
    <span
      className={cn(
        'inline-flex size-6 shrink-0 select-none items-center justify-center rounded-full text-[0.6rem] font-semibold',
        className,
      )}
      style={markStyle(address.toLowerCase())}
      aria-hidden
    >
      {initialOf(symbol)}
    </span>
  )
}
