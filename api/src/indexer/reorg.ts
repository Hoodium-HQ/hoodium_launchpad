/**
 * Reorg handling — T2.2 / AL-N6, design section 5.
 *
 * "The system SHALL tolerate chain reorgs up to 32 blocks deep without
 *  double-recording events."
 *
 * The indexer keeps a rolling buffer of the last 64 block headers. When the next
 * block's `parentHash` does not match the buffered hash for its parent, the chain
 * moved under us: walk back to the deepest block whose canonical hash still
 * matches our buffer, drop everything above it, and re-index.
 *
 * Everything here is pure so the rewind logic can be tested without a chain; the
 * Anvil forced-reorg test (design section 8) then covers the wiring.
 */

export interface BlockRef {
  number: number
  hash: string
  parentHash: string
}

export class ReorgTooDeepError extends Error {
  constructor(
    readonly bufferOldest: number,
    readonly head: number,
  ) {
    super(
      `reorg deeper than the ${head - bufferOldest + 1}-block buffer — cannot find a common ancestor. ` +
        `Increase INDEXER_REORG_BUFFER_BLOCKS or re-index from a known-good block.`,
    )
    this.name = 'ReorgTooDeepError'
  }
}

/** Append a header, keeping the buffer sorted, contiguous and bounded. */
export function appendBlock(buffer: BlockRef[], block: BlockRef, maxSize: number): BlockRef[] {
  const kept = buffer.filter((b) => b.number < block.number)
  kept.push(block)
  return kept.length > maxSize ? kept.slice(kept.length - maxSize) : kept
}

export function bufferHead(buffer: BlockRef[]): BlockRef | null {
  return buffer.length ? (buffer[buffer.length - 1] ?? null) : null
}

/**
 * Does `candidate` extend what we have? A `null` verdict means we have no
 * opinion — the buffer does not reach back far enough to judge.
 */
export function extendsBuffer(buffer: BlockRef[], candidate: BlockRef): boolean | null {
  const parent = buffer.find((b) => b.number === candidate.number - 1)
  if (!parent) return null
  return parent.hash === candidate.parentHash
}

/**
 * Walk backwards through the buffer, asking the chain for the canonical hash at
 * each height, and return the deepest height that still agrees.
 *
 * @param fetchCanonicalHash resolves the current canonical hash at a height
 * @returns the block number to rewind the cursor to
 */
export async function findCommonAncestor(
  buffer: BlockRef[],
  fetchCanonicalHash: (blockNumber: number) => Promise<string | null>,
): Promise<number> {
  if (buffer.length === 0) throw new ReorgTooDeepError(0, 0)

  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i]!
    const canonical = await fetchCanonicalHash(entry.number)
    if (canonical && canonical.toLowerCase() === entry.hash.toLowerCase()) {
      return entry.number
    }
  }

  const oldest = buffer[0]!
  const newest = buffer[buffer.length - 1]!
  throw new ReorgTooDeepError(oldest.number, newest.number)
}

/** Drop every buffered header above the rewind point. */
export function truncateBuffer(buffer: BlockRef[], rewindTo: number): BlockRef[] {
  return buffer.filter((b) => b.number <= rewindTo)
}

/**
 * The finality frontier (AL-N6): events at or below this height have the required
 * confirmations and can be trusted for money purposes.
 */
export function finalizedThrough(head: number, confirmations: number): number {
  return Math.max(0, head - confirmations)
}
