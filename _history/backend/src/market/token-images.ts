/**
 * Token image proxy — 003 T5.6, WA-N2, WA-N3.
 *
 * The frontend CSP admits `img-src 'self'` and nothing else, so a token logo has
 * to be served from our own origin or not at all. That restriction is worth
 * keeping: token metadata is chosen by whoever launched the token, and a
 * hot-linked image would let that person decide what bytes a user's browser
 * requests, while handing the image host a log of who viewed which token.
 *
 * **The request never names what we fetch.** A caller supplies a token address;
 * the URL is looked up in our own cached market snapshot. That is the property
 * that makes this not an SSRF endpoint — an allowlist alone would only narrow
 * the blast radius of attacker-supplied URLs, whereas here there are none. The
 * host allowlist below is a second layer, for the case where the upstream
 * indexer itself starts serving URLs we would rather not follow.
 */
import { componentLogger } from '../lib/logger.js'

const log = componentLogger('token-images')

/** Hosts the upstream indexer is known to serve logos from. */
const ALLOWED_HOSTS = [
  'assets.coingecko.com',
  'coin-images.coingecko.com',
  'raw.githubusercontent.com',
  'tokens.1inch.io',
  'assets.uniswap.org',
  'token-icons.s3.amazonaws.com',
] as const

/**
 * SVG is refused. Rendered through `<img>` it is inert, but this endpoint serves
 * from our own origin, and an SVG opened directly in a tab is a document that can
 * carry script. Refusing the format outright is simpler than defending every way
 * it might later be loaded.
 */
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const MAX_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const NEGATIVE_TTL_MS = 10 * 60 * 1000
/** Bounded so a chain full of tokens cannot grow this without limit. */
const MAX_CACHE_ENTRIES = 500

export interface TokenImage {
  body: Buffer
  contentType: string
}

interface CacheEntry {
  at: number
  image: TokenImage | null
}

const cache = new Map<string, CacheEntry>()

export function resetTokenImageCacheForTesting(): void {
  cache.clear()
}

function remember(key: string, image: TokenImage | null): void {
  // Cheap LRU-ish bound: Map preserves insertion order, so the oldest key is first.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), image })
}

function hostAllowed(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'https:') return false
    return ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/**
 * Fetch, validate, and cache one logo.
 *
 * @param logoUrl resolved from our own snapshot — never from a request.
 * @returns the image, or `null` when it cannot be served for any reason. A
 * failure is cached too, so a token with a broken logo does not cost an outbound
 * request on every page view.
 */
export async function loadTokenImage(cacheKey: string, logoUrl: string): Promise<TokenImage | null> {
  const hit = cache.get(cacheKey)
  if (hit) {
    const ttl = hit.image ? CACHE_TTL_MS : NEGATIVE_TTL_MS
    if (Date.now() - hit.at < ttl) return hit.image
  }

  if (!hostAllowed(logoUrl)) {
    log.warn({ cacheKey }, 'logo host is not allowlisted')
    remember(cacheKey, null)
    return null
  }

  let response: Response
  try {
    response = await fetch(logoUrl, {
      // Do not follow redirects: a redirect is the upstream host handing the
      // request to somewhere the allowlist never approved.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    log.debug({ err, cacheKey }, 'logo fetch failed')
    remember(cacheKey, null)
    return null
  }

  if (!response.ok) {
    remember(cacheKey, null)
    return null
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!ALLOWED_TYPES.includes(contentType as (typeof ALLOWED_TYPES)[number])) {
    log.debug({ cacheKey, contentType }, 'logo rejected on content type')
    remember(cacheKey, null)
    return null
  }

  // Check the declared length first, then the real one. A lying `content-length`
  // is exactly why the second check exists.
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) {
    remember(cacheKey, null)
    return null
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) {
    remember(cacheKey, null)
    return null
  }

  const image: TokenImage = { body: buffer, contentType }
  remember(cacheKey, image)
  return image
}

export const TOKEN_IMAGE_LIMITS = {
  ALLOWED_HOSTS,
  ALLOWED_TYPES,
  MAX_BYTES,
} as const
