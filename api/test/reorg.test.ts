/**
 * T2.2 · AL-N6 — reorg rewind logic.
 *
 * The Anvil forced-reorg test named in design section 8 covers the wiring end to end.
 * These cover the decision the wiring depends on: given a buffer and a chain that
 * disagrees with it, how far back do we rewind?
 */
import { describe, expect, it, vi } from 'vitest'
import {
  appendBlock,
  bufferHead,
  extendsBuffer,
  finalizedThrough,
  findCommonAncestor,
  ReorgTooDeepError,
  truncateBuffer,
  type BlockRef,
} from '../src/indexer/reorg.js'

const h = (n: number, suffix = 'a') => `0x${n.toString(16).padStart(8, '0')}${suffix.repeat(56)}`

/** A canonical chain of headers, each pointing at the previous one. */
function chain(from: number, to: number, suffix = 'a'): BlockRef[] {
  const blocks: BlockRef[] = []
  for (let n = from; n <= to; n++) {
    blocks.push({ number: n, hash: h(n, suffix), parentHash: h(n - 1, suffix) })
  }
  return blocks
}

describe('appendBlock', () => {
  it('keeps the buffer bounded, dropping the oldest', () => {
    let buffer: BlockRef[] = []
    for (const block of chain(1, 100)) buffer = appendBlock(buffer, block, 64)

    expect(buffer).toHaveLength(64)
    expect(buffer[0]!.number).toBe(37)
    expect(bufferHead(buffer)!.number).toBe(100)
  })

  it('replaces entries at or above the incoming height — the reorg case', () => {
    let buffer = chain(1, 10)
    buffer = appendBlock(buffer, { number: 8, hash: h(8, 'b'), parentHash: h(7) }, 64)

    expect(bufferHead(buffer)!.number).toBe(8)
    expect(bufferHead(buffer)!.hash).toBe(h(8, 'b'))
    expect(buffer.filter((b) => b.number > 8)).toHaveLength(0)
  })
})

describe('extendsBuffer', () => {
  const buffer = chain(1, 10)

  it('accepts a block whose parent matches', () => {
    expect(extendsBuffer(buffer, { number: 11, hash: h(11), parentHash: h(10) })).toBe(true)
  })

  it('rejects a block whose parent does not match', () => {
    expect(extendsBuffer(buffer, { number: 11, hash: h(11, 'b'), parentHash: h(10, 'b') })).toBe(false)
  })

  it('has no opinion when the parent is outside the buffer', () => {
    expect(extendsBuffer(buffer, { number: 500, hash: h(500), parentHash: h(499) })).toBeNull()
  })
})

describe('findCommonAncestor', () => {
  it('returns the tip when nothing changed', async () => {
    const buffer = chain(1, 64)
    const fetch = vi.fn(async (n: number) => h(n))
    await expect(findCommonAncestor(buffer, fetch)).resolves.toBe(64)
    // Only the tip needs checking when the tip still agrees.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('finds the fork point of a 5-block reorg', async () => {
    const buffer = chain(1, 64)
    // The chain re-mined everything above block 59 with different hashes.
    const fetch = async (n: number) => (n > 59 ? h(n, 'b') : h(n, 'a'))
    await expect(findCommonAncestor(buffer, fetch)).resolves.toBe(59)
  })

  it('handles a 32-block reorg — the depth AL-N6 requires tolerating', async () => {
    const buffer = chain(1, 100)
    const fetch = async (n: number) => (n > 68 ? h(n, 'b') : h(n, 'a'))
    await expect(findCommonAncestor(buffer, fetch)).resolves.toBe(68)
  })

  it('treats a vanished block as reorged rather than as agreement', async () => {
    const buffer = chain(1, 64)
    const fetch = async (n: number) => (n > 60 ? null : h(n))
    await expect(findCommonAncestor(buffer, fetch)).resolves.toBe(60)
  })

  it('is case-insensitive about hash hex', async () => {
    const buffer = chain(1, 10)
    const fetch = async (n: number) => h(n).toUpperCase()
    await expect(findCommonAncestor(buffer, fetch)).resolves.toBe(10)
  })

  it('refuses to guess when the reorg is deeper than the buffer', async () => {
    const buffer = chain(37, 100)
    const fetch = async (n: number) => h(n, 'b')
    await expect(findCommonAncestor(buffer, fetch)).rejects.toBeInstanceOf(ReorgTooDeepError)
  })
})

describe('truncateBuffer', () => {
  it('drops everything above the rewind point', () => {
    const truncated = truncateBuffer(chain(1, 100), 68)
    expect(bufferHead(truncated)!.number).toBe(68)
    expect(truncated.some((b) => b.number > 68)).toBe(false)
  })
})

describe('finalizedThrough — AL-N6', () => {
  it('holds events back by the confirmation depth', () => {
    expect(finalizedThrough(1000, 32)).toBe(968)
  })

  it('never goes negative on a young chain', () => {
    expect(finalizedThrough(10, 32)).toBe(0)
  })
})
