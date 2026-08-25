import { useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * Token artwork.
 *
 * The `src` is always our own origin: creator-supplied artwork lives on IPFS
 * and is re-served by the API proxy, which resolves the CID from *our* indexed
 * copy rather than from anything in this request. That is what keeps the CSP's
 * `img-src` honest and keeps a creator from deciding which host learns who
 * viewed their token.
 *
 * The fetch can still fail — a dead pin, a gateway outage — so `onError` falls
 * back to the same deterministic initials tile a token with no artwork gets.
 * The fallback is never a broken-image glyph.
 */
export function TokenAvatar({
  tokenAddress,
  name,
  src,
  className,
  rounded = 'rounded-xl',
}: {
  tokenAddress: string
  name: string
  /** Resolved via `tokenImageUrl`; null means no artwork. */
  src: string | null
  className?: string
  rounded?: string
}) {
  const [failed, setFailed] = useState(false)
  const showImage = Boolean(src) && !failed

  // Deterministic hue from the address, so a token looks the same everywhere.
  const hue = Number.parseInt(tokenAddress.slice(2, 8), 16) % 360
  const initials = name.slice(0, 2).toUpperCase() || '??'

  return (
    <div className={cn('relative overflow-hidden bg-muted', rounded, className)}>
      {showImage ? (
        <img
          src={src!}
          // Creator-supplied, sanitised by the caller. Kept short so a screen
          // reader announcing a grid of cards is not reading paragraphs.
          alt={name}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        <div
          className="flex size-full items-center justify-center"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 30% 14%), hsl(${(hue + 40) % 360} 25% 9%))`,
          }}
          aria-hidden
        >
          <span className="num text-[1em] font-semibold text-foreground/70">{initials}</span>
        </div>
      )}
    </div>
  )
}
