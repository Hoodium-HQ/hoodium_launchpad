/**
 * Metadata pinning — LP-1.7.
 *
 * "Token metadata SHALL be stored on IPFS with the hash recorded on-chain."
 *
 * The launch form posts artwork and a description here; this pins both and hands
 * back an `ipfs://…` URI, which the browser then passes to `launch()` as
 * `metadataURI`. Two properties matter:
 *
 *  - **Nothing is inferred.** With no `PINATA_JWT` configured the route refuses
 *    outright. It does not fall back to a data URI, an origin-hosted copy, or an
 *    empty string — a token whose on-chain URI points at nothing is permanent,
 *    and the failure would land on the creator's *first* transaction.
 *
 *  - **The bytes are validated before they are pinned, not after.** What we pin
 *    is later re-served from our own origin (`ipfs.ts`), so a file whose declared
 *    type disagrees with its magic bytes never gets that far.
 */
import { componentLogger } from '../lib/logger.js'
import { isAllowedImageType, type AllowedImageType } from './ipfs.js'

const log = componentLogger('pinata')

const PIN_TIMEOUT_MS = 30_000

/** Artwork ceiling. Comfortably above a 512×512 PNG, far below anything abusive. */
export const MAX_IMAGE_UPLOAD_BYTES = 1024 * 1024

export class PinningUnavailableError extends Error {
  constructor() {
    super('metadata pinning is not configured')
    this.name = 'PinningUnavailableError'
  }
}

export class PinningFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PinningFailedError'
  }
}

/**
 * Magic-byte signatures for the formats `ipfs.ts` will re-serve.
 *
 * A client-declared content type is a claim, not evidence. This is the check
 * that makes the claim true — without it a creator could pin an HTML document
 * labelled `image/png` and have our own origin serve it back.
 */
const SIGNATURES: Array<{ type: AllowedImageType; test: (b: Buffer) => boolean }> = [
  { type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    type: 'image/webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
]

/**
 * @returns the format the bytes actually are, or `null` when they are not one of
 * the four we accept — including the case where they *are* an image but not the
 * one the caller claimed.
 */
export function sniffImageType(bytes: Buffer, declared: string): AllowedImageType | null {
  if (bytes.byteLength < 12) return null
  if (!isAllowedImageType(declared)) return null

  const match = SIGNATURES.find((s) => s.test(bytes))
  return match && match.type === declared ? match.type : null
}

export interface PinataConfig {
  jwt: string | undefined
  apiUrl: string
}

export function isPinningEnabled(config: PinataConfig): boolean {
  return Boolean(config.jwt)
}

async function post(
  config: PinataConfig,
  path: string,
  body: FormData | string,
  headers: Record<string, string> = {},
): Promise<string> {
  if (!config.jwt) throw new PinningUnavailableError()

  let response: Response
  try {
    response = await fetch(`${config.apiUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.jwt}`, ...headers },
      body,
      signal: AbortSignal.timeout(PIN_TIMEOUT_MS),
    })
  } catch (err) {
    log.warn({ err, path }, 'pinning request failed')
    throw new PinningFailedError('the pinning service did not respond')
  }

  if (!response.ok) {
    // The upstream body can echo the credential back in an error envelope, so it
    // is logged at debug and never returned to the caller (AL-N3).
    log.warn({ path, status: response.status }, 'pinning service rejected the request')
    throw new PinningFailedError('the pinning service rejected the upload')
  }

  const payload = (await response.json().catch(() => null)) as { IpfsHash?: string } | null
  const cid = payload?.IpfsHash
  if (!cid || typeof cid !== 'string') throw new PinningFailedError('the pinning service returned no hash')

  return cid
}

/** Pin one image. `bytes` must already have passed {@link sniffImageType}. */
export async function pinImage(
  config: PinataConfig,
  bytes: Buffer,
  contentType: AllowedImageType,
): Promise<string> {
  const form = new FormData()
  const extension = contentType.split('/')[1]!
  form.append('file', new Blob([bytes], { type: contentType }), `artwork.${extension}`)
  // Names are not derived from creator input: a filename travels into the
  // gateway's directory listing, and there is nothing to gain by letting it be chosen.
  form.append('pinataMetadata', JSON.stringify({ name: 'hoodium-token-artwork' }))

  return `ipfs://${await post(config, '/pinning/pinFileToIPFS', form)}`
}

/** Pin the metadata document itself. */
export async function pinJson(config: PinataConfig, document: Record<string, unknown>): Promise<string> {
  const cid = await post(
    config,
    '/pinning/pinJSONToIPFS',
    JSON.stringify({ pinataContent: document, pinataMetadata: { name: 'hoodium-token-metadata' } }),
    { 'content-type': 'application/json' },
  )
  return `ipfs://${cid}`
}
