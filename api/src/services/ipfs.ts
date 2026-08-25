/**
 * IPFS reads for launch metadata — LP-1.7, WA-N2, WA-N3.
 *
 * A token's `metadataURI` is creator-supplied and therefore attacker-controlled.
 * Everything here is built around one rule, the same one that makes
 * `market/token-images.ts` not an SSRF endpoint:
 *
 *   **We never fetch a URL somebody handed us.** We parse a CID out of the URI,
 *   reject anything that is not one, and fetch it from *our* configured gateway.
 *   An `http://169.254.169.254/…` in `metadataURI` is not a URL to us; it is a
 *   malformed CID and is dropped.
 *
 * The browser never talks to a gateway itself. WA-N2 admits `img-src 'self'` plus
 * the API origin and nothing else, and hot-linking would hand the gateway a log
 * of who viewed which token.
 */
import { componentLogger } from '../lib/logger.js'

const log = componentLogger('launchpad-ipfs')

/**
 * CIDv0 (`Qm…`, base58btc) and CIDv1 (base32, lowercase, `b` multibase prefix).
 * Deliberately narrow: these are the two forms anything we pin can produce, and
 * a permissive pattern is how a path traversal gets in.
 */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/
/** One optional trailing path segment, alphanumerics and `.-_` only. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/

const MAX_JSON_BYTES = 64 * 1024
const MAX_IMAGE_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 60 * 60 * 1000
const NEGATIVE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 500

/**
 * Same rule as the market proxy: SVG is refused. Through `<img>` it is inert, but
 * this is re-served from our own origin, and an SVG opened directly in a tab is a
 * document that can carry script.
 */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

export function isAllowedImageType(value: string): value is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(value)
}

/** The subset of ERC-style token metadata the launch form writes and reads back. */
export interface TokenMetadata {
  description: string | null
  /** `ipfs://…` for the artwork, verbatim from the document. */
  image: string | null
  /** X handle without the `@`, Telegram path without the `t.me/`. */
  x: string | null
  telegram: string | null
  website: string | null
}

export interface IpfsImage {
  body: Buffer
  contentType: AllowedImageType
}

interface CacheEntry<T> {
  at: number
  value: T | null
}

const metadataCache = new Map<string, CacheEntry<TokenMetadata>>()
const imageCache = new Map<string, CacheEntry<IpfsImage>>()

export function resetIpfsCachesForTesting(): void {
  metadataCache.clear()
  imageCache.clear()
}

function remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T | null): void {
  // Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), value })
}

function read<T>(cache: Map<string, CacheEntry<T>>, key: string): { hit: true; value: T | null } | { hit: false } {
  const entry = cache.get(key)
  if (!entry) return { hit: false }
  const ttl = entry.value ? CACHE_TTL_MS : NEGATIVE_TTL_MS
  if (Date.now() - entry.at >= ttl) return { hit: false }
  return { hit: true, value: entry.value }
}

/**
 * Extract the CID (and at most one path segment) from a creator-supplied URI.
 *
 * @returns the gateway-relative path, e.g. `QmAbc…` or `bafy…/image.png`, or
 * `null` when the URI is anything other than a well-formed IPFS reference. HTTP
 * URLs return `null` on purpose — accepting them is what would make this
 * fetch-what-you-are-told.
 */
export function parseIpfsPath(uri: string | null | undefined): string | null {
  if (!uri) return null

  let rest = uri.trim()
  if (rest.startsWith('ipfs://')) rest = rest.slice('ipfs://'.length)
  // Some tools emit `ipfs://ipfs/<cid>`.
  if (rest.startsWith('ipfs/')) rest = rest.slice('ipfs/'.length)

  const parts = rest.split('/').filter((p) => p.length > 0)
  const cid = parts[0]
  if (!cid || !CID_RE.test(cid)) return null

  // At most one segment beyond the CID. Directory trees deeper than that are not
  // something we pin, and every extra segment is another chance at traversal.
  if (parts.length > 2) return null
  const segment = parts[1]
  if (segment !== undefined && !PATH_SEGMENT_RE.test(segment)) return null

  return segment === undefined ? cid : `${cid}/${segment}`
}

function gatewayUrl(gateway: string, path: string): string {
  return `${gateway.replace(/\/$/, '')}/ipfs/${path}`
}

async function fetchCapped(
  url: string,
  maxBytes: number,
): Promise<{ body: Buffer; contentType: string } | null> {
  let response: Response
  try {
    response = await fetch(url, {
      // A redirect is the gateway handing the request somewhere we did not choose.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    log.debug({ err, url }, 'ipfs fetch failed')
    return null
  }

  if (!response.ok) return null

  // Check the declared length, then the real one — a lying `content-length` is
  // exactly why the second check exists.
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) return null

  const body = Buffer.from(await response.arrayBuffer())
  if (body.byteLength === 0 || body.byteLength > maxBytes) return null

  return { body, contentType: (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() }
}

/** Trim a creator-supplied string to something a column can hold. Never rewritten otherwise. */
function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, max)
  return trimmed.length > 0 ? trimmed : null
}

/**
 * A social handle, reduced to the part we will later render inside a fixed
 * prefix. Anything with a scheme, a slash, or whitespace is dropped rather than
 * repaired: `x.com/foo?next=evil` must not become a link we vouch for.
 */
function handle(value: unknown, max = 64): string | null {
  const raw = str(value, max + 32)
  if (!raw) return null
  const cleaned = raw.replace(/^@/, '')
  if (!/^[A-Za-z0-9_]{1,64}$/.test(cleaned)) return null
  return cleaned.slice(0, max)
}

/**
 * A website link, accepted only as an absolute http(s) URL with a plain host.
 * Anything else (javascript:, data:, a bare path, credentials in the URL) is
 * dropped — the page renders this as an outbound link it vouches for.
 */
export function website(value: unknown, max = 256): string | null {
  const raw = str(value, max)
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (u.username || u.password) return null
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null
    return u.toString().slice(0, max)
  } catch {
    return null
  }
}

/**
 * Read and validate one metadata document.
 *
 * @returns `null` when the URI is not an IPFS reference, the document is
 * unreachable, or it is not JSON. A failure is cached too, so a token with a
 * dead pin does not cost an outbound request on every page view.
 */
export async function fetchTokenMetadata(gateway: string, uri: string | null): Promise<TokenMetadata | null> {
  const path = parseIpfsPath(uri)
  if (!path) return null

  const cached = read(metadataCache, path)
  if (cached.hit) return cached.value

  const fetched = await fetchCapped(gatewayUrl(gateway, path), MAX_JSON_BYTES)
  if (!fetched) {
    remember(metadataCache, path, null)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fetched.body.toString('utf8'))
  } catch {
    remember(metadataCache, path, null)
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) {
    remember(metadataCache, path, null)
    return null
  }

  const doc = parsed as Record<string, unknown>
  const metadata: TokenMetadata = {
    description: str(doc.description, 512),
    // Kept verbatim; it is re-parsed by `parseIpfsPath` before anything fetches it.
    image: str(doc.image, 256),
    x: handle(doc.x ?? doc.twitter),
    telegram: handle(doc.telegram),
    website: website(doc.website),
  }

  remember(metadataCache, path, metadata)
  return metadata
}

/**
 * Fetch one image by IPFS URI.
 *
 * @param uri comes from a metadata document we already fetched, never from a
 * request — the caller resolves it from our own indexed copy.
 */
export async function fetchIpfsImage(gateway: string, uri: string | null): Promise<IpfsImage | null> {
  const path = parseIpfsPath(uri)
  if (!path) return null

  const cached = read(imageCache, path)
  if (cached.hit) return cached.value

  const fetched = await fetchCapped(gatewayUrl(gateway, path), MAX_IMAGE_BYTES)
  if (!fetched || !isAllowedImageType(fetched.contentType)) {
    remember(imageCache, path, null)
    return null
  }

  const image: IpfsImage = { body: fetched.body, contentType: fetched.contentType }
  remember(imageCache, path, image)
  return image
}

export const IPFS_LIMITS = {
  MAX_JSON_BYTES,
  MAX_IMAGE_BYTES,
  ALLOWED_IMAGE_TYPES,
} as const
