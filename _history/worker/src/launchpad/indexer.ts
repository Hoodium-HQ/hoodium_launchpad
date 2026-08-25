/**
 * Launchpad indexer — T3.1 / design.md section 5.
 *
 * "Reuses the Auto LP indexer — same `getLogs` + cursor mechanism, same
 *  32-confirmation finality, same reorg rewind."
 *
 * It runs on its own cursor rather than inside the Auto LP indexer because the
 * two watch different address sets: Auto LP watches one fixed position manager,
 * the launchpad watches a set that grows every time somebody launches a token.
 *
 * Curve events are fetched by **topic across all addresses** and then filtered
 * against known curves. Filtering by address list would mean a `getLogs` call
 * whose address array grows without bound as launches accumulate — thousands of
 * addresses per request on a chain that produces 12k tokens a day.
 */
import type { Address, Log } from 'viem'
import { componentLogger } from '@hoodium/core/lib'
import { IndexerCursorModel, type IndexerCursorDoc } from '@hoodium/core/db'
import { LaunchpadHolderModel, LaunchpadTokenModel, LaunchpadTradeModel } from '@hoodium/core/db'
import { curveAbi, launchpadFactoryAbi } from '@hoodium/core/chain'
import type { ChainClient } from '@hoodium/core/chain'
import type { Env } from '@hoodium/core/config'
import { appendBlock, bufferHead, finalizedThrough, findCommonAncestor, truncateBuffer, type BlockRef } from '../indexer/reorg.js'
import { Decimal } from '@hoodium/core/lib'
import { fetchTokenMetadata } from '@hoodium/core/launchpad'
import { recomputeRisk } from '@hoodium/core/launchpad'

const CURSOR_NAME = 'launchpad'

const factoryEventAbi = launchpadFactoryAbi.filter(
  (i): i is Extract<(typeof launchpadFactoryAbi)[number], { type: 'event' }> => i.type === 'event',
)
const curveEventAbi = curveAbi.filter(
  (i): i is Extract<(typeof curveAbi)[number], { type: 'event' }> => i.type === 'event',
)

type DecodedLog = Log & { eventName?: string; args?: Record<string, unknown> }

export class LaunchpadIndexer {
  private readonly log = componentLogger('launchpad-indexer')
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false

  /** Known curve addresses, so topic-filtered logs can be attributed. */
  private curveIndex = new Map<string, { token: string; curve: string }>()

  constructor(
    private readonly env: Env,
    private readonly chain: ChainClient,
  ) {}

  async start(): Promise<void> {
    if (!this.env.LAUNCHPAD_FACTORY_ADDRESS) {
      this.log.info('LAUNCHPAD_FACTORY_ADDRESS not set — launchpad indexing disabled')
      return
    }
    this.stopped = false
    await this.loadCurveIndex()
    await this.tick()
    this.timer = setInterval(() => void this.tick(), this.env.INDEXER_POLL_MS)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async loadCurveIndex(): Promise<void> {
    const tokens = await LaunchpadTokenModel.find({ chainId: this.env.CHAIN_ID })
      .select('tokenAddress curveAddress')
      .lean()
    this.curveIndex = new Map(
      tokens.map((t) => [t.curveAddress, { token: t.tokenAddress, curve: t.curveAddress }]),
    )
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      for (let i = 0; i < 25; i++) {
        const result = await this.runOnce()
        if (result.caughtUp || this.stopped) break
      }
    } catch (err) {
      this.log.error({ err }, 'launchpad indexer cycle failed')
    } finally {
      this.running = false
    }
  }

  async runOnce(): Promise<{ caughtUp: boolean; launches: number; trades: number }> {
    const cursor = await this.loadCursor()
    const head = Number(await this.chain.getBlockNumber())

    if (await this.rewindIfReorged(cursor)) {
      return { caughtUp: false, launches: 0, trades: 0 }
    }

    const fromBlock = cursor.lastProcessedBlock + 1
    if (fromBlock > head) {
      await this.advance(cursor, cursor.lastProcessedBlock, head, [])
      return { caughtUp: true, launches: 0, trades: 0 }
    }

    const toBlock = Math.min(fromBlock + this.env.INDEXER_LOG_RANGE - 1, head)

    // Launches first: a curve must be known before its trades can be attributed,
    // and both can land in the same block.
    const launches = await this.indexLaunches(fromBlock, toBlock)
    const trades = await this.indexCurveEvents(fromBlock, toBlock)

    const windowStart = Math.max(fromBlock, head - this.env.INDEXER_REORG_BUFFER_BLOCKS + 1)
    const headers: BlockRef[] = []
    if (toBlock >= windowStart) {
      for (let n = windowStart; n <= toBlock; n++) headers.push(await this.fetchHeader(n))
    }

    await this.advance(cursor, toBlock, head, headers)
    return { caughtUp: toBlock >= head, launches, trades }
  }

  // ── LP-1.1 — new tokens ──────────────────────────────────────────────────

  private async indexLaunches(fromBlock: number, toBlock: number): Promise<number> {
    const logs = await this.chain.call('getLogs:launches', (client) =>
      client.getLogs({
        address: this.env.LAUNCHPAD_FACTORY_ADDRESS as Address,
        events: factoryEventAbi,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      }),
    )

    let count = 0
    for (const raw of logs as DecodedLog[]) {
      const args = raw.args as
        | { token?: string; curve?: string; creator?: string; name?: string; symbol?: string; metadataURI?: string }
        | undefined
      if (!args?.token || !args.curve || !args.creator) continue

      const tokenAddress = args.token.toLowerCase()
      const curveAddress = args.curve.toLowerCase()

      await LaunchpadTokenModel.updateOne(
        { chainId: this.env.CHAIN_ID, tokenAddress },
        {
          $set: {
            curveAddress,
            creator: args.creator.toLowerCase(),
            // Stored verbatim. Sanitisation is a render-time concern (WA-N3);
            // rewriting it here would make our copy disagree with the chain.
            name: (args.name ?? '').slice(0, 128),
            symbol: (args.symbol ?? '').slice(0, 32),
            metadataURI: args.metadataURI ?? null,
            createdBlock: Number(raw.blockNumber),
            createdAtChain: new Date(),
          },
          $setOnInsert: { status: 'curve' },
        },
        { upsert: true },
      )

      this.curveIndex.set(curveAddress, { token: tokenAddress, curve: curveAddress })
      count++

      // LP-5.4 — flags depend on the creator's history, so recompute on launch.
      await recomputeRisk(this.env.CHAIN_ID, tokenAddress).catch((err) =>
        this.log.warn({ err, tokenAddress }, 'risk recompute failed'),
      )

      // LP-1.7 — resolve the pinned document once, here, rather than on every
      // page view. A gateway that is slow or down must not hold up indexing, so
      // this is detached and simply leaves `resolvedAt: null` on failure.
      void this.resolveMetadata(tokenAddress, args.metadataURI ?? null)
    }

    if (count > 0) this.log.info({ count, fromBlock, toBlock }, 'indexed launches')
    return count
  }

  /**
   * Read the metadata document and cache it on the token (LP-1.7).
   *
   * Public so a backfill script can re-run it for tokens indexed before this
   * existed, and for the case where a gateway was down at launch.
   */
  async resolveMetadata(tokenAddress: string, metadataURI: string | null): Promise<boolean> {
    if (!metadataURI) return false

    try {
      const metadata = await fetchTokenMetadata(this.env.IPFS_GATEWAY_URL, metadataURI)
      if (!metadata) return false

      await LaunchpadTokenModel.updateOne(
        { chainId: this.env.CHAIN_ID, tokenAddress },
        {
          $set: {
            'metadata.description': metadata.description,
            'metadata.image': metadata.image,
            'metadata.x': metadata.x,
            'metadata.telegram': metadata.telegram,
            'metadata.resolvedAt': new Date(),
          },
        },
      )
      return true
    } catch (err) {
      this.log.warn({ err, tokenAddress }, 'metadata resolve failed')
      return false
    }
  }

  // ── LP-2.1, LP-2.2, LP-4.5 — trades and graduation ───────────────────────

  private async indexCurveEvents(fromBlock: number, toBlock: number): Promise<number> {
    if (this.curveIndex.size === 0) return 0

    const logs = await this.chain.call('getLogs:curves', (client) =>
      client.getLogs({
        events: curveEventAbi,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      }),
    )

    let count = 0
    for (const raw of logs as DecodedLog[]) {
      const emitter = raw.address?.toLowerCase()
      if (!emitter) continue

      // Topic-filtered logs come from every contract on the chain. Anything not
      // in our curve index is some other contract that happens to share an event
      // signature, and must not be attributed to a launch.
      const known = this.curveIndex.get(emitter)
      if (!known) continue

      if (raw.eventName === 'Graduated') {
        await this.applyGraduation(known.token, raw)
        count++
        continue
      }
      if (raw.eventName === 'Bought' || raw.eventName === 'Sold') {
        await this.applyTrade(known.token, known.curve, raw)
        count++
      }
    }

    return count
  }

  private async applyTrade(tokenAddress: string, curveAddress: string, raw: DecodedLog): Promise<void> {
    const args = (raw.args ?? {}) as Record<string, bigint | string>
    const isBuy = raw.eventName === 'Bought'

    const usdgAmount = String(isBuy ? (args.usdgIn ?? 0n) : (args.usdgOut ?? 0n))
    const tokenAmount = String(isBuy ? (args.tokensOut ?? 0n) : (args.tokensIn ?? 0n))
    const reserveAfter = String(args.reserveAfter ?? 0n)
    const trader = String(isBuy ? (args.buyer ?? '') : (args.seller ?? '')).toLowerCase()

    // Price in USDG per whole token, exact-string throughout (LP-N8, AL-N4).
    const price =
      tokenAmount === '0'
        ? '0'
        : new Decimal(usdgAmount).mul(new Decimal(10).pow(18)).div(new Decimal(tokenAmount)).toFixed(0)

    const inserted = await LaunchpadTradeModel.updateOne(
      { chainId: this.env.CHAIN_ID, txHash: raw.transactionHash, logIndex: raw.logIndex },
      {
        $setOnInsert: {
          chainId: this.env.CHAIN_ID,
          tokenAddress,
          curveAddress,
          trader,
          side: isBuy ? 'buy' : 'sell',
          usdgAmount,
          tokenAmount,
          feeUsdg: String(args.fee ?? 0n),
          reserveAfter,
          priceUsdg: price,
          blockNumber: Number(raw.blockNumber),
          txHash: raw.transactionHash,
          logIndex: raw.logIndex,
          at: new Date(),
          finalized: false,
        },
      },
      { upsert: true },
    )

    // Aggregates only move on a genuinely new trade — re-indexing after a rewind
    // must not double-count volume.
    if (inserted.upsertedCount === 0) return

    const holderCount = await this.applyHolderDelta(tokenAddress, trader, isBuy ? tokenAmount : `-${tokenAmount}`)

    const token = await LaunchpadTokenModel.findOne({ chainId: this.env.CHAIN_ID, tokenAddress })
    if (!token) return

    const target = token.graduationTarget ? new Decimal(token.graduationTarget.toString()) : new Decimal(0)
    const reserve = new Decimal(reserveAfter)
    const progressBps = target.isZero()
      ? 0
      : Math.min(10_000, Number(reserve.mul(10_000).div(target).toFixed(0)))

    const volume = new Decimal(token.volumeUsdg?.toString() ?? '0').plus(usdgAmount)

    await LaunchpadTokenModel.updateOne(
      { _id: token._id },
      {
        $set: {
          reserveUsdg: reserveAfter,
          tokensSold: String(args.tokensSoldAfter ?? token.tokensSold ?? '0'),
          progressBps,
          volumeUsdg: volume.toFixed(),
          lastTradeAt: new Date(),
          holderCount,
        },
        $inc: { tradeCount: 1 },
      },
    )
  }

  /**
   * Move one holder's balance and return the resulting holder count (LP-5.2).
   *
   * ── What this is, and what it is not ──────────────────────────────────────
   * These balances are reconstructed from **curve trades only**. The token is a
   * plain ERC-20, so a wallet-to-wallet `transfer` moves real balance and is
   * invisible here. That is a deliberate limit, not an oversight: indexing
   * `Transfer` across every launched token is a second log stream at a different
   * cardinality, and the launchpad's own numbers do not need it.
   *
   * It does mean a holder row can disagree with `balanceOf`. Everything derived
   * from these balances says so — the profile withholds PnL outright when the
   * two do not reconcile, rather than reporting a figure it cannot stand behind.
   */
  private async applyHolderDelta(tokenAddress: string, holder: string, delta: string): Promise<number> {
    if (!holder || holder === '0x' || delta === '0') {
      return LaunchpadHolderModel.countDocuments({
        chainId: this.env.CHAIN_ID,
        tokenAddress,
        balance: { $ne: '0' },
      })
    }

    const existing = await LaunchpadHolderModel.findOne({
      chainId: this.env.CHAIN_ID,
      tokenAddress,
      holder,
    })
      .select('balance')
      .lean()

    // Exact integer arithmetic on base units. A `Number` here would lose the low
    // digits of an 18-decimal balance outright (LP-N8).
    const next = new Decimal(existing?.balance?.toString() ?? '0').plus(delta)
    // A sell can only ever be of tokens the seller holds, so a negative result
    // means our reconstruction is behind the chain — clamp rather than store a
    // balance that cannot exist.
    const clamped = next.isNegative() ? new Decimal(0) : next

    const now = new Date()
    await LaunchpadHolderModel.updateOne(
      { chainId: this.env.CHAIN_ID, tokenAddress, holder },
      { $set: { balance: clamped.toFixed(0), lastTradeAt: now }, $setOnInsert: { firstSeenAt: now } },
      { upsert: true },
    )

    return LaunchpadHolderModel.countDocuments({
      chainId: this.env.CHAIN_ID,
      tokenAddress,
      balance: { $ne: '0' },
    })
  }

  private async applyGraduation(tokenAddress: string, raw: DecodedLog): Promise<void> {
    const args = (raw.args ?? {}) as Record<string, string>
    const pool = String(args.pool ?? '').toLowerCase()
    // uint256, kept as a string end to end (AL-N4 in spirit: a Number rounds
    // above 2^53, and an NFT id that rounds points at somebody else's position).
    const lpTokenId = args.tokenId === undefined ? null : String(args.tokenId)

    await LaunchpadTokenModel.updateOne(
      { chainId: this.env.CHAIN_ID, tokenAddress },
      {
        $set: {
          status: 'graduated',
          poolAddress: pool,
          graduatedAt: new Date(),
          graduationTxHash: raw.transactionHash,
          progressBps: 10_000,
          lpTokenId,
        },
      },
    )

    // LP-6.1 / design.md section 6 — the single seam between the two specs. The
    // pool becomes Auto LP inventory; it grants Hoodium no authority over anyone's
    // funds. Enrollment (LP-6.2) stays a separate, explicit user action.
    this.log.info({ tokenAddress, pool }, 'token graduated — registered as an Auto LP candidate')
  }

  // ── Cursor plumbing, shared with the Auto LP indexer (AL-N6) ─────────────

  private async rewindIfReorged(cursor: IndexerCursorDoc): Promise<boolean> {
    const buffer = cursor.blockBuffer as unknown as BlockRef[]
    const tip = bufferHead(buffer)
    if (!tip) return false

    const canonical = await this.fetchCanonicalHash(tip.number)
    if (canonical && canonical.toLowerCase() === tip.hash.toLowerCase()) return false

    const ancestor = await findCommonAncestor(buffer, (n) => this.fetchCanonicalHash(n))
    const removed = await LaunchpadTradeModel.deleteMany({
      chainId: this.env.CHAIN_ID,
      blockNumber: { $gt: ancestor },
    })

    cursor.set('blockBuffer', truncateBuffer(buffer, ancestor))
    cursor.set('lastProcessedBlock', ancestor)
    cursor.set('reorgCount', (cursor.reorgCount ?? 0) + 1)
    cursor.set('lastReorgAt', new Date())
    cursor.set('lastReorgDepth', tip.number - ancestor)
    await cursor.save()

    this.log.warn(
      { ancestor, depth: tip.number - ancestor, removedTrades: removed.deletedCount },
      'launchpad rewound after reorg',
    )
    return true
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
    await cursor.save()

    if (finalized > 0) {
      await LaunchpadTradeModel.updateMany(
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
