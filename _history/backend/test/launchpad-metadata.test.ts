/**
 * The two checks that stand between a creator-supplied string and our own origin
 * serving bytes on their behalf.
 *
 * `parseIpfsPath` is the reason `launchpad/ipfs.ts` is not an SSRF endpoint: it
 * refuses to turn anything but a well-formed CID into something fetchable, so an
 * attacker-controlled `metadataURI` can never name a host.
 *
 * `sniffImageType` is the reason the artwork proxy cannot be used to serve an
 * HTML document from our origin: the declared content type is a claim, and this
 * is what makes it true.
 */
import { describe, expect, it } from 'vitest'
import { parseIpfsPath } from '../src/launchpad/ipfs.js'
import { sniffImageType } from '../src/launchpad/pinata.js'

const CIDv0 = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o'
const CIDv1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

describe('parseIpfsPath', () => {
  it('accepts a bare CIDv0 and CIDv1, with or without the scheme', () => {
    expect(parseIpfsPath(CIDv0)).toBe(CIDv0)
    expect(parseIpfsPath(`ipfs://${CIDv0}`)).toBe(CIDv0)
    expect(parseIpfsPath(CIDv1)).toBe(CIDv1)
    expect(parseIpfsPath(`ipfs://${CIDv1}`)).toBe(CIDv1)
  })

  it('accepts the ipfs://ipfs/<cid> form some tools emit', () => {
    expect(parseIpfsPath(`ipfs://ipfs/${CIDv0}`)).toBe(CIDv0)
  })

  it('accepts exactly one trailing path segment', () => {
    expect(parseIpfsPath(`ipfs://${CIDv1}/image.png`)).toBe(`${CIDv1}/image.png`)
    expect(parseIpfsPath(`ipfs://${CIDv1}/a/b`)).toBeNull()
  })

  it('refuses HTTP URLs — the property that makes this not fetch-what-you-are-told', () => {
    expect(parseIpfsPath('https://evil.example/payload.json')).toBeNull()
    expect(parseIpfsPath('http://169.254.169.254/latest/meta-data')).toBeNull()
    // Even when the host is dressed up as a gateway path.
    expect(parseIpfsPath(`https://gateway.pinata.cloud/ipfs/${CIDv0}`)).toBeNull()
  })

  it('refuses traversal and injection in the path segment', () => {
    expect(parseIpfsPath(`ipfs://${CIDv1}/../../etc/passwd`)).toBeNull()
    expect(parseIpfsPath(`ipfs://${CIDv1}/a?b=c`)).toBeNull()
    expect(parseIpfsPath(`ipfs://${CIDv1}/a#b`)).toBeNull()
  })

  it('refuses malformed and empty input', () => {
    expect(parseIpfsPath(null)).toBeNull()
    expect(parseIpfsPath(undefined)).toBeNull()
    expect(parseIpfsPath('')).toBeNull()
    expect(parseIpfsPath('ipfs://')).toBeNull()
    expect(parseIpfsPath('ipfs://not-a-cid')).toBeNull()
    // CIDv0 is base58, which excludes 0, O, I and l.
    expect(parseIpfsPath('Qm00zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o')).toBeNull()
  })
})

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16)])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(16),
])

describe('sniffImageType', () => {
  it('accepts each format when the bytes agree with the claim', () => {
    expect(sniffImageType(PNG, 'image/png')).toBe('image/png')
    expect(sniffImageType(JPEG, 'image/jpeg')).toBe('image/jpeg')
    expect(sniffImageType(GIF, 'image/gif')).toBe('image/gif')
    expect(sniffImageType(WEBP, 'image/webp')).toBe('image/webp')
  })

  it('refuses bytes that disagree with the declared type', () => {
    // A real PNG announced as a JPEG is still a lie about what we would serve.
    expect(sniffImageType(PNG, 'image/jpeg')).toBeNull()
    expect(sniffImageType(JPEG, 'image/png')).toBeNull()
  })

  it('refuses a document wearing an image content type', () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1')
    expect(sniffImageType(html, 'image/png')).toBeNull()
  })

  it('refuses SVG outright, however it is labelled', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'latin1')
    expect(sniffImageType(svg, 'image/svg+xml')).toBeNull()
    expect(sniffImageType(svg, 'image/png')).toBeNull()
  })

  it('refuses anything too short to carry a signature', () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50]), 'image/png')).toBeNull()
    expect(sniffImageType(Buffer.alloc(0), 'image/png')).toBeNull()
  })
})
