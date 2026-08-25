/**
 * The generated mark — the disc a token, venue, or chain wears when no image of
 * it exists that we are willing to fetch.
 *
 * Extracted from `TokenIcon`, which held the only copy until venues and chains
 * needed the same thing. The rules it encodes are worth stating once:
 *
 *  - **Derived, not chosen.** The colour comes from a hash of an identifier, so
 *    it is stable across renders and sessions, and two different things that
 *    share a label still look different. That last case is the point: tokens
 *    impersonate each other by name, and a mark that collapsed with the name
 *    would help them do it.
 *  - **Never the accent.** Saturation and lightness stay in a band that reads on
 *    both themes and well away from the brand colour. A mark must not look like
 *    an endorsement (LP-5.5).
 */

/**
 * Hue spans the full circle and lightness takes one of four steps, so a mark has
 * roughly 1,440 states rather than a handful. A short palette looked tidier but
 * collided constantly — with eight colours, one pair in eight is identical, and
 * "these two look the same" is the exact failure the mark exists to prevent.
 */
const LIGHTNESS_STEPS = [26, 32, 38, 44] as const

export function hashOf(seed: string): number {
  // FNV-1a. Small, stable, and dependency-free — this only has to spread evenly,
  // not resist anything.
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** First character that will actually render — labels can lead with punctuation. */
export function initialOf(label: string): string {
  const letter = [...label].find((c) => /\p{L}|\p{N}/u.test(c))
  return (letter ?? '?').toUpperCase()
}

/**
 * Ink that survives being put on a given brand colour.
 *
 * White is not a safe default across a brand table: it is right on Uniswap's
 * pink and close to unreadable on BNB's yellow. Relative luminance decides,
 * which is the same quantity the contrast ratio is built from — the threshold is
 * where the ratio against white and against near-black cross over.
 */
function readableOn(hex: string): string {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  if (!Number.isFinite(value)) return '#fff'

  // sRGB channels, linearised, then weighted the way the eye weights them.
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!

  return luminance > 0.35 ? 'rgba(0,0,0,0.78)' : '#fff'
}

/**
 * Disc and text colour for a seed.
 *
 * `brand` overrides the derived hue where we actually know a protocol's or a
 * chain's colour. It is an override rather than a default because knowing one is
 * the exception: everything without an entry keeps the derived mark, which
 * claims nothing.
 */
export function markStyle(seed: string, brand?: string): { backgroundColor: string; color: string } {
  if (brand) return { backgroundColor: brand, color: readableOn(brand) }

  const hash = hashOf(seed)
  const hue = hash % 360
  // A different slice of the hash, so hue and lightness do not move together.
  const lightness = LIGHTNESS_STEPS[(hash >>> 9) % LIGHTNESS_STEPS.length]!

  return {
    backgroundColor: `hsl(${hue} 62% ${lightness}%)`,
    color: `hsl(${hue} 85% 90%)`,
  }
}
