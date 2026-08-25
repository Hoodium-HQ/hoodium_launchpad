/**
 * Pure helpers for the launch form — validation, the dev-buy cap, and the file
 * read. Split out of the component so each one is testable without a DOM and a
 * wallet.
 */
import { quoteBuy, type CurveState } from './curve'
import { hasLinkLike } from './utils'
import type { LaunchTerms } from './launchpad-api'
import {
  COMPRESS_TARGET_BYTES,
  ImageCompressError,
  PICK_MAX_BYTES,
  compressImage,
  type CompressOptions,
  type CompressResult,
} from './image-compress'

export const NAME_MAX = 32
export const SYMBOL_MAX = 10
export const DESCRIPTION_MAX = 256

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
/** What the pinning route accepts. Anything picked above this is compressed to fit. */
export const IMAGE_MAX_BYTES = COMPRESS_TARGET_BYTES
/** The largest file the picker takes at all. */
export const IMAGE_PICK_MAX_BYTES = PICK_MAX_BYTES

/** Letters, numbers and spaces. No punctuation, which is where lookalikes hide. */
export function isValidName(value: string): boolean {
  return /^[\p{L}\p{N} ]+$/u.test(value.trim())
}

export function isValidSymbol(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value.trim())
}

export function hasLink(value: string): boolean {
  return hasLinkLike(value)
}

/**
 * The opening curve, before anyone has traded it.
 *
 * The factory derives `virtualTokens` from the target rather than taking it as a
 * parameter, so this state is fully determined by the terms — every token this
 * factory deploys starts here, which is what makes a pre-launch quote meaningful.
 */
export function freshCurve(terms: LaunchTerms): CurveState {
  return {
    virtualUsdg: BigInt(terms.virtualUsdg),
    virtualTokens: BigInt(terms.virtualTokens),
    curveAllocation: BigInt(terms.curveAllocation),
    reserveUsdg: 0n,
    tokensSold: 0n,
    graduationTarget: BigInt(terms.graduationTarget),
    tradeFeeBps: BigInt(terms.tradeFeeBps),
  }
}

/**
 * The largest dev buy the factory will accept, in quote base units — LP-1.6.
 *
 * The cap on-chain is expressed in *tokens* ("a percentage of supply"), and the
 * form has to show it in the currency the creator is typing. Inverting the curve
 * gives the exact spend, and the loop below walks it down until the quote's token
 * output is genuinely at or under the cap.
 *
 * The loop is not defensive padding. `quoteBuy` rounds in the contract's favour
 * at two separate divisions (LP-N8), so the closed form can land one or two wei
 * over the cap — and `HoodiumFactory.launch` reverts with `DevBuyTooLarge` on
 * exactly that. A "Max" button that reverts is worse than no Max button.
 */
export function maxDevBuyQuote(terms: LaunchTerms): bigint {
  const state = freshCurve(terms)
  const cap = BigInt(terms.devBuyCapTokens)

  const x = state.virtualUsdg
  const y = state.virtualTokens + state.curveAllocation
  if (cap <= 0n || cap >= y || x <= 0n) return 0n

  // newY = y - cap  =>  netIn = x * cap / (y - cap)
  const netIn = (x * cap) / (y - cap)
  const bps = state.tradeFeeBps
  // gross = netIn + fee, where fee = netIn * bps / (BPS - bps)
  let gross = bps >= 10_000n ? netIn : netIn + (netIn * bps) / (10_000n - bps) + 1n

  for (let i = 0; i < 64 && gross > 0n; i++) {
    if (quoteBuy(state, gross).tokensOut <= cap) return gross
    // Step by a proportional amount first so a large overshoot converges, then by
    // one unit as it closes in.
    gross -= gross / 10_000n > 0n ? gross / 10_000n : 1n
  }

  return 0n
}

/** What the creator will actually receive for a given spend, at launch prices. */
export function previewDevBuy(terms: LaunchTerms, usdgIn: bigint): { tokensOut: bigint; fee: bigint } {
  const quote = quoteBuy(freshCurve(terms), usdgIn)
  return { tokensOut: quote.tokensOut, fee: quote.fee }
}

export interface PickedImage {
  /** base64, without the data-URI prefix — what the pinning route expects. */
  data: string
  contentType: string
  /** Object URL for the preview. The caller revokes it. */
  previewUrl: string
  /** Size of what will be uploaded. */
  bytes: number
  /** Size of the file that was picked — differs from `bytes` when compressed. */
  originalBytes: number
  width: number
  height: number
  /** True when the upload is a re-encoding rather than the picked file. */
  compressed: boolean
  /** Something to tell the creator about the conversion, e.g. a dropped animation. */
  note: string | null
}

export class ImageRejected extends Error {}

function readArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  // `Blob.arrayBuffer` is missing in older Safari and in jsdom; FileReader is everywhere.
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsArrayBuffer(blob)
  })
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await readArrayBuffer(blob))

  // Chunked rather than `String.fromCharCode(...bytes)`: spreading a megabyte
  // into an argument list overflows the call stack in every engine.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export interface ReadImageOptions {
  /** Replaces the canvas compressor — tests, mostly. */
  compress?: (file: File, opts: CompressOptions) => Promise<CompressResult>
}

/**
 * Read one picked file into the shape the pinning route takes, compressing it
 * first when it is over the route's limit.
 *
 * The type and the 10 MB pick ceiling are checked here as well as on the
 * server. This copy exists to give an answer before megabytes cross the network;
 * the server's copy is the one that is load-bearing, and it verifies magic
 * bytes rather than trusting the browser's guess at a type.
 */
export async function readImageFile(file: File, opts: ReadImageOptions = {}): Promise<PickedImage> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new ImageRejected(
      file.type === 'image/svg+xml' ? 'SVG artwork is not accepted. Export it as a PNG or WebP.' : 'Choose a PNG, JPEG, WebP or GIF.',
    )
  }
  if (file.size === 0) {
    throw new ImageRejected('That file is empty.')
  }
  if (file.size > IMAGE_PICK_MAX_BYTES) {
    throw new ImageRejected('Artwork must be under 10 MB.')
  }

  let result: CompressResult
  try {
    result = await (opts.compress ?? compressImage)(file, { targetBytes: IMAGE_MAX_BYTES })
  } catch (err) {
    throw new ImageRejected(
      err instanceof ImageCompressError ? err.message : 'That image could not be compressed. Try a smaller file.',
    )
  }
  if (result.bytes > IMAGE_MAX_BYTES) {
    throw new ImageRejected('That image could not be made small enough. Try a smaller or simpler picture.')
  }

  return {
    data: await blobToBase64(result.blob),
    contentType: result.contentType,
    previewUrl: URL.createObjectURL(result.blob),
    bytes: result.bytes,
    originalBytes: result.originalBytes,
    width: result.width,
    height: result.height,
    compressed: result.changed,
    note: result.note,
  }
}
