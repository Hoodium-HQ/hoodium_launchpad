/**
 * Client-side artwork compression.
 *
 * The pinning route takes at most 1 MB, and most people's artwork is a 3–8 MB
 * phone export. Rather than send them off to resize it, the form shrinks it here:
 * decode, draw onto a canvas no larger than 1024×1024, and re-encode, stepping
 * quality and then dimensions down until the result fits.
 *
 * The decision loop (`compressWithEncoder`) is separated from the canvas so it
 * can be tested without one — jsdom has no `toBlob`. The browser wiring lives in
 * `compressImage`, which is the only function that touches the DOM.
 */

/** What the pinning route accepts; anything larger is compressed to fit. */
export const COMPRESS_TARGET_BYTES = 1024 * 1024
/** The largest file the picker takes at all. Above this we do not even decode. */
export const PICK_MAX_BYTES = 10 * 1024 * 1024

export const DIMENSION_STEPS = [1024, 768, 512] as const
export const QUALITY_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5] as const

export type CompressibleType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export type LossyType = 'image/webp' | 'image/jpeg'

export interface CompressResult {
  blob: Blob
  contentType: string
  width: number
  height: number
  originalBytes: number
  bytes: number
  /** False when the original was returned untouched. */
  changed: boolean
  /** Something the user should know — currently only "animation was dropped". */
  note: string | null
}

export class ImageCompressError extends Error {}

/** Largest box of the same aspect ratio that fits inside `max`×`max`. Never upscales. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 1, height: 1 }
  const scale = Math.min(1, max / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface EncodeAttempt {
  type: 'image/png' | LossyType
  /** Longest side, in pixels. */
  maxDimension: number
  /** `undefined` for PNG, which is lossless. */
  quality?: number
}

export interface PlanOptions {
  sourceType: CompressibleType
  hasAlpha: boolean
  webpSupported: boolean
  dimensionSteps?: readonly number[]
  qualitySteps?: readonly number[]
}

/**
 * The ordered list of encodings to try. Pure, so the policy can be read in one
 * place and asserted in tests:
 *
 * 1. Transparency is worth one lossless try — a PNG or WebP with alpha is
 *    usually a logo, and a logo at 1024px often fits as PNG. Only the largest
 *    dimension is tried; if a lossless 1024px does not fit, smaller lossless
 *    steps rarely do either and the lossy path keeps alpha anyway (WebP).
 * 2. Lossy, quality 0.9 → 0.5, at each dimension 1024 → 768 → 512. WebP where
 *    the browser can encode it (it keeps alpha and is ~30% smaller), JPEG
 *    otherwise.
 */
export function planAttempts(opts: PlanOptions): EncodeAttempt[] {
  const dims = opts.dimensionSteps ?? DIMENSION_STEPS
  const qualities = opts.qualitySteps ?? QUALITY_STEPS
  const lossy: LossyType = opts.webpSupported ? 'image/webp' : 'image/jpeg'
  const attempts: EncodeAttempt[] = []

  const largest = dims[0]
  if (largest !== undefined && opts.hasAlpha && (opts.sourceType === 'image/png' || opts.sourceType === 'image/webp')) {
    attempts.push({ type: 'image/png', maxDimension: largest })
  }
  for (const maxDimension of dims) {
    for (const quality of qualities) {
      attempts.push({ type: lossy, maxDimension, quality })
    }
  }
  return attempts
}

export interface Encoded {
  blob: Blob
  width: number
  height: number
}

/**
 * Produce one encoding, or `null` when the browser cannot (an unsupported type,
 * a canvas that refused to export). Injected so the loop below is testable.
 */
export type Encoder = (attempt: EncodeAttempt) => Promise<Encoded | null>

/**
 * Walk the plan until an encoding is at or under `targetBytes`.
 *
 * @throws ImageCompressError when nothing in the plan fits — 512px at quality
 *   0.5 is a few tens of kilobytes for anything photographic, so reaching this
 *   means the encoder is broken rather than the picture is large.
 */
export async function compressWithEncoder(
  attempts: readonly EncodeAttempt[],
  encode: Encoder,
  targetBytes: number,
): Promise<Encoded & { contentType: string }> {
  let anyEncoded = false
  for (const attempt of attempts) {
    const out = await encode(attempt)
    if (!out) continue
    anyEncoded = true
    if (out.blob.size > 0 && out.blob.size <= targetBytes) {
      return { ...out, contentType: attempt.type }
    }
  }
  throw new ImageCompressError(
    anyEncoded
      ? 'That image could not be made small enough. Try a smaller or simpler picture.'
      : 'Your browser could not re-encode that image. Try a different browser, or a smaller file.',
  )
}

// ── Browser side ────────────────────────────────────────────────────────────

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void }

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
    } catch {
      // Fall through to <img>; some browsers refuse particular encodings here.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new ImageCompressError('That image could not be decoded.'))
      el.src = url
    })
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

function drawScaled(decoded: Decoded, maxDimension: number): HTMLCanvasElement {
  const { width, height } = fitWithin(decoded.width, decoded.height, maxDimension)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new ImageCompressError('Your browser could not open a drawing surface for the image.')
  ctx.drawImage(decoded.source, 0, 0, width, height)
  return canvas
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality)
    } catch {
      resolve(null)
    }
  })
}

/** Any pixel not fully opaque. Samples every 4th pixel — a decision, not a count. */
function detectAlpha(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  try {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] !== 255) return true
    }
  } catch {
    return false
  }
  return false
}

/** Canvas WebP support: Safari < 16 hands back a PNG when asked for WebP. */
async function canEncodeWebp(): Promise<boolean> {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const blob = await toBlob(canvas, 'image/webp', 0.8)
  return blob?.type === 'image/webp'
}

export interface CompressOptions {
  targetBytes?: number
  /** Overrides the canvas encoder — for tests and for callers with a worker. */
  encoder?: Encoder
}

/**
 * Compress `file` so it is at or under the pinning limit.
 *
 * - Already small: returned as-is (`changed: false`). Nothing to lose.
 * - GIF: kept whole when it fits. Otherwise only the first frame survives, and
 *   the result says so — a silent conversion to a still would be a surprise at
 *   launch time, after the URI is on-chain.
 * - SVG: refused by the pinning route regardless of size, so it is refused here.
 */
export async function compressImage(file: File, opts: CompressOptions = {}): Promise<CompressResult> {
  const targetBytes = opts.targetBytes ?? COMPRESS_TARGET_BYTES
  const sourceType = file.type as CompressibleType

  if (file.type === 'image/svg+xml') {
    throw new ImageCompressError('SVG artwork is not accepted. Export it as a PNG or WebP.')
  }

  if (file.size > 0 && file.size <= targetBytes) {
    const decoded = await decode(file).catch(() => null)
    const dims = decoded ? { width: decoded.width, height: decoded.height } : { width: 0, height: 0 }
    decoded?.close()
    return {
      blob: file,
      contentType: file.type,
      ...dims,
      originalBytes: file.size,
      bytes: file.size,
      changed: false,
      note: null,
    }
  }

  const decoded = await decode(file)
  try {
    const probe = drawScaled(decoded, DIMENSION_STEPS[0])
    const hasAlpha =
      sourceType === 'image/png' || sourceType === 'image/webp' || sourceType === 'image/gif' ? detectAlpha(probe) : false
    const webpSupported = opts.encoder ? true : await canEncodeWebp()
    const attempts = planAttempts({ sourceType, hasAlpha, webpSupported })

    const canvases = new Map<number, HTMLCanvasElement>([[DIMENSION_STEPS[0], probe]])
    const canvasEncoder: Encoder = async (attempt) => {
      let canvas = canvases.get(attempt.maxDimension)
      if (!canvas) {
        canvas = drawScaled(decoded, attempt.maxDimension)
        canvases.set(attempt.maxDimension, canvas)
      }
      const blob = await toBlob(canvas, attempt.type, attempt.quality)
      // A browser that cannot encode the type substitutes PNG; treat that as "no".
      if (!blob || blob.type !== attempt.type) return null
      return { blob, width: canvas.width, height: canvas.height }
    }

    const out = await compressWithEncoder(attempts, opts.encoder ?? canvasEncoder, targetBytes)
    return {
      blob: out.blob,
      contentType: out.contentType,
      width: out.width,
      height: out.height,
      originalBytes: file.size,
      bytes: out.blob.size,
      changed: true,
      note: sourceType === 'image/gif' ? 'Animated GIFs are compressed to their first frame; the animation is dropped.' : null,
    }
  } finally {
    decoded.close()
  }
}

/** "4.2 MB", "612 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
