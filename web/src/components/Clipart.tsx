import { cn } from '@/lib/utils'

/**
 * The sticker illustrations in `public/clipart/`.
 *
 * One flat style — lime, off-white, grey, a dark outline — so the set reads as
 * one family whichever page it lands on. Every file is a 512px PNG with a
 * transparent background, which is what lets one asset sit on both themes: the
 * outline carries the shape on near-black and on white alike.
 *
 * Decoration, never information. Every one is `aria-hidden` with an empty alt,
 * and nothing a page says depends on the picture being there: a blocked image
 * leaves a gap, not a missing fact. That is also why a page chooses one by
 * *subject* (a wallet on the portfolio, a compass on a page that is not there)
 * rather than by state — the words beside it do the stating.
 */
/*
 * The subset of hoodium.app's set that this product has a subject for. The
 * files are byte-identical to the ones there, so a sticker reads the same on
 * both sites.
 */
export const CLIPART = {
  'coins-sprout': 'Coins with a sprout',
  telescope: 'Telescope on a rising chart',
  wallet: 'Open wallet',
  ticket: 'Price tag',
  compass: 'Spinning compass',
  rocket: 'Rocket over a bar chart',
} as const

export type ClipartName = keyof typeof CLIPART

export function clipartSrc(name: ClipartName): string {
  return `/clipart/${name}.png`
}

export function Clipart({
  name,
  className,
  float = false,
}: {
  name: ClipartName
  className?: string
  /** A slow bob, for the ones that sit beside a heading rather than in a card. */
  float?: boolean
}) {
  return (
    <img
      src={clipartSrc(name)}
      alt=""
      aria-hidden
      draggable={false}
      width={512}
      height={512}
      loading="lazy"
      decoding="async"
      data-clipart={name}
      className={cn(
        'pointer-events-none select-none',
        float && 'motion-safe:animate-float',
        className,
      )}
    />
  )
}
