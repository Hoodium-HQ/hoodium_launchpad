/**
 * Credential scrubbing — AL-N3: "Credentials SHALL never reach logs. The logger
 * SHALL maintain a field denylist."
 *
 * Two independent layers, because either one alone leaks:
 *   1. field names — anything named like a secret is replaced wholesale
 *   2. value shapes — a key-shaped string is replaced even when the field that
 *      carries it is innocently named (`{ note: '0x<64 hex>' }`)
 *
 * Addresses (0x + 40 hex) are deliberately *not* redacted. They are public
 * identifiers and the logs are useless without them.
 */

export const REDACTED = '[REDACTED]'

/** Field-name denylist. Matched case-insensitively, ignoring `_` and `-`. */
const DENIED_FIELDS = new Set([
  'privatekey',
  'private',
  'secret',
  'secretkey',
  'seed',
  'seedphrase',
  'mnemonic',
  'sessionkeyprivate',
  'signingkey',
  'password',
  'passphrase',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'token',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'credentials',
  'kmskeyid',
  // The bot token is a bare credential with no public half, and it appears in
  // every Bot API URL — so a logged request line would carry it verbatim.
  'telegrambottoken',
  'bottoken',
  'telegramwebhooksecret',
  'webhooksecret',
  // Link tokens are bearer credentials: presenting one to the bot redirects an
  // address's alerts (AL-3.8). `token` already covers the bare field name.
  'tokenhash',
  'linktoken',
  'deeplink',
  'mongouri',
  'mongourl',
  'connectionstring',
  'rpcprimary',
  'rpcfallback',
])

const normaliseKey = (key: string) => key.replace(/[_-]/g, '').toLowerCase()

export function isDeniedField(key: string): boolean {
  return DENIED_FIELDS.has(normaliseKey(key))
}

/** 0x-prefixed 32-byte hex — the shape of a secp256k1 private key. */
const PRIVATE_KEY_RE = /\b0x[0-9a-fA-F]{64}\b/g
/** Bare 64-hex (a private key with the 0x stripped off). Excludes 0x-prefixed runs. */
const BARE_KEY_RE = /(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g
/** BIP-39 mnemonic: 12/15/18/21/24 lowercase words. */
const MNEMONIC_RE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g
/** URL user-info — `mongodb+srv://user:pass@host`. */
const URL_USERINFO_RE = /:\/\/[^/\s:@]+:[^/\s@]+@/g

/**
 * A 32-byte hash is the same shape as a private key. Transaction hashes and
 * idempotency keys are load-bearing in the logs, so callers name them explicitly
 * and this module lets those specific fields through.
 */
const HASH_FIELDS = new Set(['txhash', 'blockhash', 'parenthash', 'idempotencykey', 'dedupekey', 'hash'])

export function isHashField(key: string): boolean {
  return HASH_FIELDS.has(normaliseKey(key))
}

export function scrubString(input: string): string {
  return input
    .replace(URL_USERINFO_RE, '://[REDACTED]@')
    .replace(PRIVATE_KEY_RE, REDACTED)
    .replace(BARE_KEY_RE, REDACTED)
    .replace(MNEMONIC_RE, REDACTED)
}

const MAX_DEPTH = 8

/**
 * Deep-scrub any log payload. Returns a new value; the input is never mutated,
 * because a logger that edits the caller's objects is its own kind of bug.
 */
export function scrub(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'

  const obj = value as object
  if (seen.has(obj)) return '[CIRCULAR]'
  seen.add(obj)

  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1, seen))

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    }
  }
  if (value instanceof Date) return value.toISOString()

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isDeniedField(k)) {
      out[k] = REDACTED
      continue
    }
    if (isHashField(k) && typeof v === 'string') {
      out[k] = v
      continue
    }
    out[k] = scrub(v, depth + 1, seen)
  }
  return out
}
