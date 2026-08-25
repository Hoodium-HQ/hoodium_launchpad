import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Truncate an address or hash in the middle. Truncating the tail alone loses
 * the checksum digits people actually compare.
 */
export function truncateMiddle(value: string, lead = 6, tail = 4): string {
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

/**
 * Compact relative time — "5s ago", "42d ago", "in 3h".
 *
 * `now` is a parameter so a ticking clock (`useNow`) can drive it without every
 * caller reading `Date.now()` on its own schedule, and so tests are
 * deterministic. Units are the short forms the explore grid has room for;
 * days run all the way to a year, so "42d ago" never becomes "1mo ago".
 */
const UNITS: Array<[string, number]> = [
  ['y', 31_536_000],
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
]

export function relativeTime(date: Date | string | number, now: number = Date.now()): string {
  const then = new Date(date).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.round((then - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 1) return 'now'

  for (const [unit, size] of UNITS) {
    if (abs >= size) {
      const n = Math.floor(abs / size)
      return seconds < 0 ? `${n}${unit} ago` : `in ${n}${unit}`
    }
  }
  return 'now'
}

/**
 * Token names, symbols and descriptions are attacker-controlled input.
 *
 * React escapes text nodes already; this strips the characters that survive
 * escaping and still cause harm: control characters, and the bidi overrides
 * used to make `SUDG` render as `USDG`. Never paired with
 * `dangerouslySetInnerHTML`, which the ESLint config bans outright.
 *
 * Built from escape sequences on purpose. These characters are invisible by
 * definition; pasted literally into the source, this pattern would be a line
 * nobody could review.
 */
const UNSAFE_CHARS = new RegExp(
  '[\\u0000-\\u001F' + // C0 controls
    '\\u007F-\\u009F' + // DEL and C1 controls
    '\\u200B-\\u200F' + // zero-width space/joiners, LTR/RTL marks
    '\\u202A-\\u202E' + // bidi embedding and override — the SUDG/USDG trick
    '\\u2066-\\u2069' + // bidi isolates
    '\\uFEFF]', // zero-width no-break space / BOM
  'g',
)

export function sanitizeText(value: string | null | undefined, maxLength = 64): string {
  if (!value) return ''
  return value.replace(UNSAFE_CHARS, '').trim().slice(0, maxLength)
}

/**
 * Characters commonly used to impersonate a known symbol: Cyrillic and Greek
 * lookalikes, plus fullwidth Latin.
 */
const CONFUSABLES = new RegExp(
  '[\\u0400-\\u04FF' + // Cyrillic — а, е, о, р, с, х all mimic Latin
    '\\u0370-\\u03FF' + // Greek — Α, Β, Ε, Ο, Ρ
    '\\uFF01-\\uFF5E]', // fullwidth Latin
)

export function hasConfusableCharacters(value: string): boolean {
  return CONFUSABLES.test(value)
}

/**
 * Anything that reads like a link.
 *
 * Used by the launch form to refuse — not strip — links in user-supplied text.
 * A token page is where a stranger arrives with no context, which is exactly
 * where a link is worth the most to a phisher. The backend's copy of this check
 * is the load-bearing one; this answers before a round trip.
 */
const LINK_LIKE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|me|gg|co|app|link|fun|to)\b)/i

export function hasLinkLike(value: string): boolean {
  return LINK_LIKE.test(value)
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}
