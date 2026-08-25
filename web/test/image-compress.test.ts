import { describe, expect, it, vi } from 'vitest'
import {
  ImageCompressError,
  compressWithEncoder,
  fitWithin,
  formatBytes,
  planAttempts,
  type EncodeAttempt,
  type Encoder,
} from '@/lib/image-compress'
import { IMAGE_MAX_BYTES, IMAGE_PICK_MAX_BYTES, ImageRejected, readImageFile } from '@/lib/launch-form'

const MB = 1024 * 1024

function fakeBlob(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type })
}

describe('fitWithin', () => {
  it('keeps aspect and never upscales', () => {
    expect(fitWithin(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 })
    expect(fitWithin(3000, 4000, 1024)).toEqual({ width: 768, height: 1024 })
    expect(fitWithin(500, 200, 1024)).toEqual({ width: 500, height: 200 })
    expect(fitWithin(0, 0, 1024)).toEqual({ width: 1, height: 1 })
  })
})

describe('planAttempts', () => {
  it('tries lossless PNG once first for transparent PNG/WebP, then lossy by quality then dimension', () => {
    const plan = planAttempts({ sourceType: 'image/png', hasAlpha: true, webpSupported: true })
    expect(plan[0]).toEqual({ type: 'image/png', maxDimension: 1024 })
    expect(plan.slice(1, 3)).toEqual([
      { type: 'image/webp', maxDimension: 1024, quality: 0.9 },
      { type: 'image/webp', maxDimension: 1024, quality: 0.8 },
    ])
    // 1 PNG + 3 dimensions × 5 qualities
    expect(plan).toHaveLength(16)
    expect(plan.at(-1)).toEqual({ type: 'image/webp', maxDimension: 512, quality: 0.5 })
    // Quality is exhausted before the dimension steps down.
    const firstSmaller = plan.findIndex((a) => a.maxDimension === 768)
    expect(plan[firstSmaller - 1]).toMatchObject({ maxDimension: 1024, quality: 0.5 })
  })

  it('skips the PNG try for opaque images and for JPEG/GIF sources', () => {
    expect(planAttempts({ sourceType: 'image/png', hasAlpha: false, webpSupported: true })[0]?.type).toBe('image/webp')
    expect(planAttempts({ sourceType: 'image/jpeg', hasAlpha: true, webpSupported: true })[0]?.type).toBe('image/webp')
    expect(planAttempts({ sourceType: 'image/gif', hasAlpha: true, webpSupported: true })[0]?.type).toBe('image/webp')
  })

  it('falls back to JPEG where the browser cannot encode WebP', () => {
    const plan = planAttempts({ sourceType: 'image/jpeg', hasAlpha: false, webpSupported: false })
    expect(plan.every((a) => a.type === 'image/jpeg')).toBe(true)
  })
})

describe('compressWithEncoder', () => {
  /** An encoder whose output size is a function of dimension and quality. */
  function sizedEncoder(sizeOf: (a: EncodeAttempt) => number | null): { encode: Encoder; calls: EncodeAttempt[] } {
    const calls: EncodeAttempt[] = []
    const encode: Encoder = async (attempt) => {
      calls.push(attempt)
      const size = sizeOf(attempt)
      if (size === null) return null
      return { blob: fakeBlob(size, attempt.type), width: attempt.maxDimension, height: attempt.maxDimension }
    }
    return { encode, calls }
  }

  it('returns the first attempt that fits and stops there', async () => {
    const plan = planAttempts({ sourceType: 'image/jpeg', hasAlpha: false, webpSupported: true })
    const { encode, calls } = sizedEncoder((a) => Math.round(a.maxDimension * a.maxDimension * (a.quality ?? 1) * 1.5))
    const out = await compressWithEncoder(plan, encode, MB)
    // 1024² × 0.9 × 1.5 ≈ 1.4 MB, × 0.8 ≈ 1.26 MB, × 0.7 ≈ 1.1 MB, × 0.6 ≈ 0.94 MB → fits.
    expect(out.contentType).toBe('image/webp')
    expect(out.width).toBe(1024)
    expect(calls).toHaveLength(4)
    expect(calls.at(-1)).toMatchObject({ quality: 0.6 })
    expect(out.blob.size).toBeLessThanOrEqual(MB)
  })

  it('steps the dimension down when no quality at 1024 fits', async () => {
    const plan = planAttempts({ sourceType: 'image/jpeg', hasAlpha: false, webpSupported: true })
    const { encode } = sizedEncoder((a) => (a.maxDimension >= 1024 ? 2 * MB : a.maxDimension === 768 ? 1.5 * MB : 300_000))
    const out = await compressWithEncoder(plan, encode, MB)
    expect(out.width).toBe(512)
    expect(out.blob.size).toBe(300_000)
  })

  it('keeps PNG when a transparent image fits losslessly', async () => {
    const plan = planAttempts({ sourceType: 'image/png', hasAlpha: true, webpSupported: true })
    const { encode, calls } = sizedEncoder(() => 800_000)
    const out = await compressWithEncoder(plan, encode, MB)
    expect(out.contentType).toBe('image/png')
    expect(calls).toHaveLength(1)
  })

  it('skips attempts the encoder cannot produce', async () => {
    const plan = planAttempts({ sourceType: 'image/png', hasAlpha: true, webpSupported: true })
    const { encode } = sizedEncoder((a) => (a.type === 'image/png' ? null : 100))
    const out = await compressWithEncoder(plan, encode, MB)
    expect(out.contentType).toBe('image/webp')
  })

  it('throws a clear error when nothing fits, and a different one when nothing encodes', async () => {
    const plan = planAttempts({ sourceType: 'image/jpeg', hasAlpha: false, webpSupported: false })
    await expect(compressWithEncoder(plan, sizedEncoder(() => 5 * MB).encode, MB)).rejects.toThrow(
      /could not be made small enough/,
    )
    await expect(compressWithEncoder(plan, sizedEncoder(() => null).encode, MB)).rejects.toThrow(
      /could not re-encode/,
    )
  })
})

describe('readImageFile', () => {
  const file = (size: number, type: string) => new File([new Uint8Array(size)], 'art', { type })
  const originalCreate = URL.createObjectURL

  it('rejects the wrong types, SVG by name, and anything over 10 MB', async () => {
    await expect(readImageFile(file(10, 'text/html'))).rejects.toThrow(ImageRejected)
    await expect(readImageFile(file(10, 'image/svg+xml'))).rejects.toThrow(/SVG artwork is not accepted/)
    await expect(readImageFile(file(IMAGE_PICK_MAX_BYTES + 1, 'image/png'))).rejects.toThrow(/under 10 MB/)
    await expect(readImageFile(file(0, 'image/png'))).rejects.toThrow(/empty/)
  })

  it('passes a small file through untouched and reports a compressed one', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    try {
      const compress = vi.fn(async (f: File) =>
        f.size <= IMAGE_MAX_BYTES
          ? { blob: f, contentType: f.type, width: 64, height: 64, originalBytes: f.size, bytes: f.size, changed: false, note: null }
          : {
              blob: fakeBlob(600_000, 'image/webp'),
              contentType: 'image/webp',
              width: 1024,
              height: 768,
              originalBytes: f.size,
              bytes: 600_000,
              changed: true,
              note: null,
            },
      )

      const small = await readImageFile(file(1000, 'image/png'), { compress })
      expect(small.compressed).toBe(false)
      expect(small.contentType).toBe('image/png')
      expect(small.bytes).toBe(1000)
      expect(small.data).toBe(btoa(String.fromCharCode(...new Uint8Array(1000))))

      const big = await readImageFile(file(4 * MB, 'image/jpeg'), { compress })
      expect(big.compressed).toBe(true)
      expect(big.contentType).toBe('image/webp')
      expect(big.originalBytes).toBe(4 * MB)
      expect(big.bytes).toBe(600_000)
      expect(big).toMatchObject({ width: 1024, height: 768 })
      expect(compress).toHaveBeenLastCalledWith(expect.anything(), { targetBytes: IMAGE_MAX_BYTES })
    } finally {
      URL.createObjectURL = originalCreate
    }
  })

  it('turns a compressor failure into a rejection the form can show', async () => {
    const compress = vi.fn(async () => {
      throw new ImageCompressError('Your browser could not re-encode that image.')
    })
    await expect(readImageFile(file(2 * MB, 'image/png'), { compress })).rejects.toThrow(/could not re-encode/)
    const generic = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(readImageFile(file(2 * MB, 'image/png'), { compress: generic })).rejects.toThrow(/could not be compressed/)
  })
})

describe('formatBytes', () => {
  it('reads like the copy under the preview', () => {
    expect(formatBytes(4.2 * MB)).toBe('4.2 MB')
    expect(formatBytes(600_000)).toBe('586 KB')
  })
})
