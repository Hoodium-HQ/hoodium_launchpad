import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Small round token mark, for rows and menus where the square avatar is too
 * much. Drawn locally unless the API holds artwork; the generated mark is
 * derived from the address, so two tokens sharing a symbol still look
 * different — which is the case that matters, since tokens impersonate each
 * other by name.
 */
const LIGHTNESS_STEPS = [26, 32, 38, 44] as const

function hashOf(seed: string): number {
  // FNV-1a. Small, stable, and dependency-free — this only has to spread evenly.
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** First character that will actually render — symbols can lead with punctuation. */
function initialOf(symbol: string): string {
  const letter = [...symbol].find((c) => /\p{L}|\p{N}/u.test(c))
  return (letter ?? '?').toUpperCase()
}

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
  const hash = hashOf(address.toLowerCase())
  const hue = hash % 360
  const lightness = LIGHTNESS_STEPS[(hash >>> 9) % LIGHTNESS_STEPS.length]!

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
        className={cn('inline-block size-6 shrink-0 rounded-full bg-muted object-cover', className)}
      />
    )
  }

  return (
    <span
      className={cn(
        'inline-flex size-6 shrink-0 select-none items-center justify-center rounded-full text-[0.6rem] font-semibold',
        className,
      )}
      style={{
        backgroundColor: `hsl(${hue} 62% ${lightness}%)`,
        color: `hsl(${hue} 85% 90%)`,
      }}
      aria-hidden
    >
      {initialOf(symbol)}
    </span>
  )
}
