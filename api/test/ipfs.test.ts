import { describe, expect, it } from 'vitest'
import { parseIpfsPath, website } from '../src/services/ipfs.js'
import { MAX_IMAGE_UPLOAD_BYTES, sniffImageType } from '../src/services/pinata.js'
import { buildFlags, sharePct } from '../src/services/risk.js'
import { bps, pricePerToken, toUnits, valueOf } from '../src/lib/amounts.js'

const CIDv0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'
const CIDv1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

describe('parseIpfsPath', () => {
  it('accepts CIDv0/CIDv1 with or without the scheme', () => {
    expect(parseIpfsPath(CIDv0)).toBe(CIDv0)
    expect(parseIpfsPath(`ipfs://${CIDv0}`)).toBe(CIDv0)
    expect(parseIpfsPath(`ipfs://ipfs/${CIDv1}`)).toBe(CIDv1)
    expect(parseIpfsPath(`ipfs://${CIDv1}/image.png`)).toBe(`${CIDv1}/image.png`)
  })

  it('refuses URLs and traversal — the property that makes this not fetch-what-you-are-told', () => {
    expect(parseIpfsPath('https://evil.example/payload.json')).toBeNull()
    expect(parseIpfsPath('http://169.254.169.254/latest/meta-data')).toBeNull()
    expect(parseIpfsPath(`ipfs://${CIDv1}/../etc`)).toBeNull()
    expect(parseIpfsPath(`ipfs://${CIDv1}/a/b`)).toBeNull()
    expect(parseIpfsPath('')).toBeNull()
    expect(parseIpfsPath(null)).toBeNull()
  })
})

describe('website', () => {
  it('accepts plain http(s) URLs only', () => {
    expect(website('https://hoodium.app/x?y=1')).toBe('https://hoodium.app/x?y=1')
    expect(website('javascript:alert(1)')).toBeNull()
    expect(website('https://user:pw@example.com')).toBeNull()
    expect(website('example.com')).toBeNull()
    expect(website('http://localhost')).toBeNull()
  })
})

describe('sniffImageType', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
  it('matches magic bytes to the declared type', () => {
    expect(sniffImageType(png, 'image/png')).toBe('image/png')
    expect(sniffImageType(png, 'image/jpeg')).toBeNull()
    expect(sniffImageType(Buffer.from('<html>hello world</html>'), 'image/png')).toBeNull()
    expect(sniffImageType(png, 'image/svg+xml')).toBeNull()
  })
  it('accepts WebP — the format the launch form compresses to', () => {
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(8)])
    expect(sniffImageType(webp, 'image/webp')).toBe('image/webp')
    expect(sniffImageType(webp, 'image/png')).toBeNull()
  })
  it('the pin ceiling is at least the 1 MB the form compresses down to', () => {
    expect(MAX_IMAGE_UPLOAD_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
  })
})

describe('risk', () => {
  it('computes the creator share of circulating supply', () => {
    expect(sharePct(25n, 100n)).toBe('25')
    expect(sharePct(1n, 3n)).toBe('33.3333')
    expect(sharePct(0n, 0n)).toBe('0')
  })
  it('flags concentration, serial non-graduators and confusables', () => {
    expect(buildFlags({ creatorSharePct: '20', priorLaunches: 0, priorGraduations: 0, hasConfusableSymbol: false })).toEqual([
      'creator_concentration',
    ])
    expect(buildFlags({ creatorSharePct: '1', priorLaunches: 3, priorGraduations: 0, hasConfusableSymbol: false })).toEqual([
      'creator_no_prior_graduations',
    ])
    expect(buildFlags({ creatorSharePct: '1', priorLaunches: 3, priorGraduations: 1, hasConfusableSymbol: true })).toEqual([
      'confusable_symbol',
    ])
  })
})

describe('amounts', () => {
  it('converts base units to floats without losing the low digits first', () => {
    expect(toUnits(1_500_000n, 6)).toBe(1.5)
    expect(toUnits('123456789012345678901234567890', 18)).toBeCloseTo(123456789012.34568, 3)
  })
  it('prices per whole token and values a supply', () => {
    const price = pricePerToken(2_000_000n, 4n * 10n ** 18n, 18) // 2 USDG for 4 tokens
    expect(price).toBe(500_000n)
    expect(valueOf(price, 10n * 10n ** 18n, 18)).toBe(5_000_000n)
  })
  it('clamps bps', () => {
    expect(bps(50n, 100n)).toBe(5000)
    expect(bps(200n, 100n)).toBe(10_000)
    expect(bps(1n, 0n)).toBe(0)
  })
})
