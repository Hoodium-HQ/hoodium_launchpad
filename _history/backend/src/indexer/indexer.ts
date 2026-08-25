/**
 * Indexer — T2.1, T2.2, T2.4 / AL-2.3, AL-N6.
 *
 * Polls `getLogs` with a block cursor and writes to `events`. It interprets
 * nothing (design section 1) — turning a `Transfer` into "this wallet owns a position"
 * is the reconciler's job (positions/sync.ts).
 *
 * This is also what retires the block-explorer workaround (T2.4): positions the
 * Uniswap `ListPositions` API omits are found here, because we read the chain's
 * own `Transfer` log rather than any per-owner index.
 */
import type { Log } from 'viem'
import { componentLogger } from '../lib/logger.js'
import { EventModel } from '../db/models/event.js'
import { IndexerCursorModel, type IndexerCursorDoc } from '../db/models/indexer-cursor.js'
import { INDEXED_EVENTS, positionManagerAbi } from '../chain/abi.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'
import {
  appendBlock,
  bufferHead,
  findCommonAncestor,
  finalizedThrough,
  truncateBuffer,
  type BlockRef,
} from './reorg.js'

const CURSOR_NAME = 'position-manager'

const indexedEventAbi = positionManagerAbi.filter(
  (item): item is Extract<(typeof positionManagerAbi)[number], { type: 'event' }> =>
    item.type === 'event' && (INDEXED_EVENTS as readonly string[]).includes(item.name),
)

export interface CycleResult {
  fromBlock: number
  toBlock: number
  head: number
  logsSeen: number
  eventsWritten: number
  reorgDepth: number
  caughtUp: boolean
}

/** BigInts are not JSON, and money must not become a Number (AL-N4). */
function serialiseArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v
  }
  return out
}

export class Indexer {
  private readonly log = componentLogger('indexer')
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false

  constructor(
    private readonly env: Env,
    private readonly chain: ChainClient,
  ) {}

  async start(): Promise<void> {
    this.stopped = false
    await this.tick()
    this.timer = setInterval(() => void this.tick(), this.env.INDEXER_POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      // Drain aggressively while behind: one cycle covers at most INDEXER_LOG_RANGE
      // blocks, and a cold start can be thousands behind.
      for (let i = 0; i < 25; i++) {
        const result = await this.runOnce()
        if (result.caughtUp || this.stopped) break
      }
    } catch (err) {
      this.log.error({ err }, 'indexer cycle failed')
      await IndexerCursorModel.updateOne(
        { chainId: this.env.CHAIN_ID, name: CURSOR_NAME },
        { $set: { lastError: String(err), lastRunAt: new Date() } },
      )
    } finally {
      this.running = false
    }
  }

  async runOnce(): Promise<CycleResult> {
    const cursor = await this.loadCursor()
    const head = Number(await this.chain.getBlockNumber())

    const reorgDepth = await this.checkForReorg(cursor, head)
    if (reorgDepth > 0) {
      // The cursor moved backwards; re-index on the next pass rather than racing
      // ahead on state we just invalidated.
      return { fromBlock: 0, toBlock: 0, head, logsSeen: 0, eventsWritten: 0, reorgDepth, caughtUp: false }
    }

    const fromBlock = cursor.lastProcessedBlock + 1
    if (fromBlock > head) {
      await this.advance(cursor, cursor.lastProcessedBlock, head, [])
      return { fromBlock, toBlock: cursor.lastProcessedBlock, head, logsSeen: 0, eventsWritten: 0, reorgDepth: 0, caughtUp: true }
    }

    const toBlock = Math.min(fromBlock + this.env.INDEXER_LOG_RANGE - 1, head)

    const logs = await this.chain.call('getLogs', (client) =>
      client.getLogs({
        address: this.env.POSITION_MANAGER_ADDRESS as `0x${string}`,
        events: indexedEventAbi,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      }),
    )

    const eventsWritten = await this.persistLogs(logs as Log[])

    // Only track headers inside the reorg window. Blocks older than that are
    // final (AL-N6) and buffering them would cost an RPC call per block for
    // nothing during a cold-start catch-up.
    const windowStart = Math.max(fromBlock, head - this.env.INDEXER_REORG_BUFFER_BLOCKS + 1)
    const headers: BlockRef[] = []
    if (toBlock >= windowStart) {
      for (let n = windowStart; n <= toBlock; n++) {
        headers.push(await this.fetchHeader(n))
      }
    }

    await this.advance(cursor, toBlock, head, headers)

    this.log.debug({ fromBlock, toBlock, head, logs: logs.length, eventsWritten }, 'indexed block range')

    return {
      fromBlock,
      toBlock,
      head,
      logsSeen: logs.length,
      eventsWritten,
      reorgDepth: 0,
      caughtUp: toBlock >= head,
    }
  }

  /**
   * @returns rewind depth in blocks; 0 when the chain still extends what we have.
   */
  private async checkForReorg(cursor: IndexerCursorDoc, head: number): Promise<number> {
    const buffer = cursor.blockBuffer as unknown as BlockRef[]
    const tip = bufferHead(buffer)
    if (!tip) return 0

    // One call answers the only question that matters: is our tip still canonical?
    const canonical = await this.fetchCanonicalHash(tip.number)
    if (canonical && canonical.toLowerCase() === tip.hash.toLowerCase()) return 0

    this.log.warn({ tip: tip.number, bufferedHash: tip.hash, canonical, head }, 'reorg detected')

    const ancestor = await findCommonAncestor(buffer, (n) => this.fetchCanonicalHash(n))
    const depth = tip.number - ancestor

    // Anything above the common ancestor never happened on the canonical chain.
    // The unique index on {chainId, txHash, logIndex} then makes the re-index
    // idempotent — deleting and re-inserting cannot double-record (design section 5).
    const orphaned = await EventModel.deleteMany({
      chainId: this.env.CHAIN_ID,
      blockNumber: { $gt: ancestor },
    })

    const deletedFinalized = await EventModel.countDocuments({
      chainId: this.env.CHAIN_ID,
      blockNumber: { $gt: ancestor },
      finalized: true,
    })
    if (deletedFinalized > 0) {
      // A reorg deeper than the confirmation depth. AL-N6 scopes tolerance to 32
      // blocks; anything beyond it is a chain-level event an operator must see.
      this.log.error(
        { depth, confirmations: this.env.INDEXER_CONFIRMATIONS },
        'reorg exceeded the confirmation depth — finalized events were rolled back',
      )
    }

    cursor.set('blockBuffer', truncateBuffer(buffer, ancestor))
    cursor.set('lastProcessedBlock', ancestor)
    cursor.set('reorgCount', (cursor.reorgCount ?? 0) + 1)
    cursor.set('lastReorgAt', new Date())
    cursor.set('lastReorgDepth', depth)
    await cursor.save()

    this.log.warn({ ancestor, depth, orphanedEvents: orphaned.deletedCount }, 'rewound cursor after reorg')
    return depth
  }

  private async persistLogs(logs: Log[]): Promise<number> {
    if (logs.length === 0) return 0

    // A pending log has no block hash, transaction hash or log index yet. It
    // cannot satisfy the exactly-once key, so it is not indexable — and it will
    // arrive again once mined.
    const mined = logs.filter(
      (l) => l.blockHash !== null && l.transactionHash !== null && l.logIndex !== null && l.blockNumber !== null,
    )
    if (mined.length < logs.length) {
      this.log.debug({ skipped: logs.length - mined.length }, 'skipped pending logs')
    }
    if (mined.length === 0) return 0

    const ops = mined.map((log) => {
      const decoded = log as Log & { eventName?: string; args?: Record<string, unknown> }
      const args = serialiseArgs(decoded.args)
      const tokenId = typeof args.tokenId === 'string' ? args.tokenId : undefined
      const to = typeof args.to === 'string' ? args.to.toLowerCase() : undefined

      return {
        updateOne: {
          filter: {
            chainId: this.env.CHAIN_ID,
            txHash: log.transactionHash!,
            logIndex: log.logIndex!,
          },
          update: {
            $setOnInsert: {
              chainId: this.env.CHAIN_ID,
              blockNumber: Number(log.blockNumber),
              blockHash: log.blockHash!,
              txHash: log.transactionHash!,
              logIndex: log.logIndex!,
              address: log.address,
              eventName: decoded.eventName ?? 'unknown',
              args,
              tokenId,
              ownerAddress: decoded.eventName === 'Transfer' ? to : undefined,
              positionKey: tokenId
                ? `${this.env.CHAIN_ID}:${this.env.POSITION_MANAGER_ADDRESS.toLowerCase()}:${tokenId}`
                : undefined,
              finalized: false,
            },
          },
          upsert: true,
        },
      }
    })

    // `ordered: false` so one duplicate does not abort the batch — duplicates are
    // the expected case when re-indexing after a rewind.
    const res = await EventModel.bulkWrite(ops, { ordered: false })
    return res.upsertedCount
  }

  private async advance(
    cursor: IndexerCursorDoc,
    lastProcessedBlock: number,
    head: number,
    headers: BlockRef[],
  ): Promise<void> {
    let buffer = cursor.blockBuffer as unknown as BlockRef[]
    for (const h of headers) buffer = appendBlock(buffer, h, this.env.INDEXER_REORG_BUFFER_BLOCKS)

    const finalized = finalizedThrough(head, this.env.INDEXER_CONFIRMATIONS)

    cursor.set('lastProcessedBlock', lastProcessedBlock)
    cursor.set('chainHeadBlock', head)
    cursor.set('finalizedThroughBlock', finalized)
    cursor.set('blockBuffer', buffer)
    cursor.set('lastRunAt', new Date())
    cursor.set('lastError', null)
    await cursor.save()

    // AL-N6 — promote events past the confirmation depth. Reporting reads only
    // finalized events, so nothing downstream can spend a reorgable figure.
    if (finalized > 0) {
      await EventModel.updateMany(
        { chainId: this.env.CHAIN_ID, finalized: false, blockNumber: { $lte: finalized } },
        { $set: { finalized: true } },
      )
    }
  }

  private async fetchHeader(blockNumber: number): Promise<BlockRef> {
    const block = await this.chain.call('getBlock', (c) =>
      c.getBlock({ blockNumber: BigInt(blockNumber), includeTransactions: false }),
    )
    return { number: Number(block.number), hash: block.hash!, parentHash: block.parentHash }
  }

  private async fetchCanonicalHash(blockNumber: number): Promise<string | null> {
    try {
      const block = await this.chain.call('getBlock', (c) =>
        c.getBlock({ blockNumber: BigInt(blockNumber), includeTransactions: false }),
      )
      return block.hash ?? null
    } catch {
      // A block that no longer exists is itself evidence of the reorg.
      return null
    }
  }

  private async loadCursor(): Promise<IndexerCursorDoc> {
    const existing = await IndexerCursorModel.findOne({ chainId: this.env.CHAIN_ID, name: CURSOR_NAME })
    if (existing) return existing
    return IndexerCursorModel.create({
      chainId: this.env.CHAIN_ID,
      name: CURSOR_NAME,
      lastProcessedBlock: Math.max(0, this.env.INDEXER_START_BLOCK - 1),
      blockBuffer: [],
    })
  }
}
