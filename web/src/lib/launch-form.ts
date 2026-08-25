/**
 * Pure helpers for the launch form — validation, the dev-buy cap, and the file
 * read. Split out of the component so each one is testable without a DOM and a
 * wallet.
 */
import { quoteBuy, type CurveState } from './curve'
import { hasLinkLike } from './utils'
import type { LaunchTerms } from './launchpad-api'

export const NAME_MAX = 32
export const SYMBOL_MAX = 10
export const DESCRIPTION_MAX = 256

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const IMAGE_MAX_BYTES = 1024 * 1024

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
  bytes: number
}

export class ImageRejected extends Error {}

/**
 * Read one picked file into the shape the pinning route takes.
 *
 * The type and size are checked here as well as on the server. This copy exists
 * to give an answer before a megabyte crosses the network; the server's copy is
 * the one that is load-bearing, and it verifies magic bytes rather than trusting
 * the browser's guess at a type.
 */
export async function readImageFile(file: File): Promise<PickedImage> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new ImageRejected('Choose a PNG, JPEG, WebP or GIF.')
  }
  if (file.size === 0 || file.size > IMAGE_MAX_BYTES) {
    throw new ImageRejected('Artwork must be under 1 MB.')
  }

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  // Chunked rather than `String.fromCharCode(...bytes)`: spreading a megabyte
  // into an argument list overflows the call stack in every engine.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }

  return {
    data: btoa(binary),
    contentType: file.type,
    previewUrl: URL.createObjectURL(file),
    bytes: file.size,
  }
}
