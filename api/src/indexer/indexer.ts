/**
 * Launchpad indexer — factory launches, curve trades, graduations, fee claims.
 *
 * One cursor in Mongo (`indexer_cursors`, name `launchpad`). Each cycle:
 *
 *   1. Verify the newest buffered block hash is still canonical; if not, walk
 *      back to the common ancestor, delete everything above it, rebuild the
 *      affected tokens from their surviving trades, and rewind the cursor.
 *   2. Fetch factory logs for [cursor+1, cursor+GETLOGS_MAX_RANGE] — launches
 *      first, because a curve must be known before its trades can be attributed
 *      and both can land in the same block.
 *   3. Fetch curve logs by *topic* across all addresses in the same range and
 *      keep only those emitted by a known curve. Filtering by address list would
 *      mean a `getLogs` whose address array grows with every launch.
 *   4. Buffer the block headers inside the reorg window, advance the cursor,
 *      mark trades below the finality frontier as finalized.
 *
 * Amounts are exact strings; the USD floats written alongside them exist only
 * for the explore page's sort keys and the candle aggregation.
 */
import type { Address, Log } from 'viem'
import { curveEvents, factoryEvents } from '../chain/abi.js'
import type { ChainClient } from '../chain/client.js'
import type { Env } from '../config/env.js'
import { spotPrice, type CurveState as CurveMathState } from '../curve/index.js'
import { CursorModel, HolderModel, TokenModel, TradeModel, type CursorDoc } from '../db/models.js'
import { bps, pricePerToken, toBigInt, toUnits, valueOf } from '../lib/amounts.js'
import { componentLogger } from '../lib/logger.js'
import { fetchTokenMetadata } from '../services/ipfs.js'
import { recomputeRisk } from '../services/risk.js'
import { loadLaunchTerms } from '../services/terms.js'
import type { LaunchTerms } from '../types.js'
import { appendBlock, bufferHead, findCommonAncestor, finalizedThrough, truncateBuffer, ReorgTooDeepError, type BlockRef } from './reorg.js'
import { refreshRollingStats } from './stats.js'

export const CURSOR_NAME = 'launchpad'

type DecodedLog = Log & { eventName?: string; args?: Record<string, unknown> }

export interface IndexerStatus {
  enabled: boolean
  running: boolean
  lastProcessedBlock: number | null
  chainHeadBlock: number | null
  lastRunAt: Date | null
  lastError: string | null
}

export class LaunchpadIndexer {
  private readonly log = componentLogger('indexer')
  private timer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private running = false
  private stopped = true
  private lastError: string | null = null
  private lastProcessed: number | null = null
  private head: number | null = null
  private lastRunAt: Date | null = null

  /** Known curves, so topic-filtered logs can be attributed. */
  private curveIndex = new Map<string, { token: string; curve: string }>()
  private blockTimeCache = new Map<number, Date>()

  constructor(
    private readonly env: Env,
    private readonly chain: ChainClient,
  ) {}

  get factory(): string | null {
    return this.env.LAUNCHPAD_FACTORY
  }

  status(): IndexerStatus {
    return {
      enabled: this.env.INDEXER_ENABLED && this.factory !== null,
      running: !this.stopped,
      lastProcessedBlock: this.lastProcessed,
      chainHeadBlock: this.head,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    }
  }

  async start(): Promise<void> {
    if (!this.env.INDEXER_ENABLED) {
      this.log.info('INDEXER_ENABLED=false — indexer idle')
      return
    }
    if (!this.factory) {
      this.log.info('LAUNCHPAD_FACTORY not set — indexer idle until the contracts are deployed')
      return
    }
    this.stopped = false
    await this.loadCurveIndex()
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.env.INDEXER_POLL_MS)
    this.timer.unref()
    this.statsTimer = setInterval(() => void this.refreshStats(), this.env.STATS_REFRESH_MS)
    this.statsTimer.unref()
    this.log.info({ factory: this.factory, pollMs: this.env.INDEXER_POLL_MS }, 'indexer started')
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.timer = null
    this.statsTimer = null
  }

  async loadCurveIndex(): Promise<void> {
    const tokens = await TokenModel.find({ chainId: this.env.CHAIN_ID }).select('tokenAddress curveAddress').lean()
    this.curveIndex = new Map(tokens.map((t) => [t.curveAddress, { token: t.tokenAddress, curve: t.curveAddress }]))
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      // Catch up in bounded bursts so a cold start does not hold one cycle for hours.
      for (let i = 0; i < 25; i++) {
        const result = await this.runOnce()
        if (result.caughtUp || this.stopped) break
      }
      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.log.error({ err }, 'indexer cycle failed')
      await CursorModel.updateOne(
        { chainId: this.env.CHAIN_ID, name: CURSOR_NAME },
        { $set: { lastError: this.lastError, lastErrorAt: new Date() } },
      ).catch(() => undefined)
    } finally {
      this.running = false
    }
  }

  private async refreshStats(): Promise<void> {
    try {
      await refreshRollingStats(this.env.CHAIN_ID)
    } catch (err) {
      this.log.warn({ err }, 'rolling stats refresh failed')
    }
  }

  async runOnce(): Promise<{ caughtUp: boolean; launches: number; curveEvents: number }> {
    const cursor = await this.loadCursor()
    const head = Number(await this.chain.getBlockNumber())
    this.head = head

    if (await this.rewindIfReorged(cursor)) {
      return { caughtUp: false, launches: 0, curveEvents: 0 }
    }

    const fromBlock = cursor.lastProcessedBlock + 1
    if (fromBlock > head) {
      await this.advance(cursor, cursor.lastProcessedBlock, head, [])
      return { caughtUp: true, launches: 0, curveEvents: 0 }
    }

    const toBlock = Math.min(fromBlock + this.env.GETLOGS_MAX_RANGE - 1, head)

    const launches = await this.indexLaunches(fromBlock, toBlock)
    const events = await this.indexCurveEvents(fromBlock, toBlock)

    const windowStart = Math.max(fromBlock, head - this.env.INDEXER_REORG_BUFFER_BLOCKS + 1)
    const headers: BlockRef[] = []
    if (toBlock >= windowStart) {
      for (let n = windowStart; n <= toBlock; n++) headers.push(await this.fetchHeader(n))
    }

    await this.advance(cursor, toBlock, head, headers)
    // Trim the timestamp cache to the recent window.
    for (const n of this.blockTimeCache.keys()) if (n < toBlock - 5000) this.blockTimeCache.delete(n)

    return { caughtUp: toBlock >= head, launches, curveEvents: events }
  }

  // ── Launches ──────────────────────────────────────────────────────────────

  private async indexLaunches(fromBlock: number, toBlock: number): Promise<number> {
    const logs = (await this.chain.call('getLogs:factory', (client) =>
      client.getLogs({
        address: this.factory as Address,
        events: factoryEvents,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      }),
    )) as DecodedLog[]

    const terms = await loadLaunchTerms(this.chain, this.factory, this.env.CHAIN_ID)
    let count = 0

    for (const raw of logs) {
      if (raw.eventName !== 'TokenLaunched') continue
      const args = raw.args as {
        token?: string
        curve?: string
        creator?: string
        name?: string
        symbol?: string
        metadataURI?: string
        devBuyUsdg?: bigint
        devBuyTokens?: bigint
      }
      if (!args?.token || !args.curve || !args.creator || raw.blockNumber === null) continue

      const tokenAddress = args.token.toLowerCase()
      const curveAddress = args.curve.toLowerCase()
      const at = await this.blockTime(Number(raw.blockNumber))
      const name = (args.name ?? '').slice(0, 128)
      const symbol = (args.symbol ?? '').slice(0, 32)

      const target = terms ? toBigInt(terms.graduationTarget) : 0n
      const openingPrice = terms ? this.priceFromCurve(terms, 0n, 0n) : 0n

      await TokenModel.updateOne(
        { chainId: this.env.CHAIN_ID, tokenAddress },
        {
          $set: {
            curveAddress,
            creator: args.creator.toLowerCase(),
            name,
            symbol,
            nameLower: name.toLowerCase(),
            symbolLower: symbol.toLowerCase(),
            metadataURI: args.metadataURI ?? null,
            createdBlock: Number(raw.blockNumber),
            createdTxHash: raw.transactionHash ?? null,
            createdAtChain: at,
            devBuyUsdg: (args.devBuyUsdg ?? 0n).toString(),
            devBuyTokens: (args.devBuyTokens ?? 0n).toString(),
          },
          $setOnInsert: {
            status: 'curve',
            graduationTarget: target.toString(),
            lastPrice: openingPrice.toString(),
            priceUsd: toUnits(openingPrice, this.env.USDG_DECIMALS),
            marketCapUsd: terms ? this.usd(valueOf(openingPrice, toBigInt(terms.totalSupply), terms.tokenDecimals)) : 0,
            fdvUsd: terms ? this.usd(valueOf(openingPrice, toBigInt(terms.totalSupply), terms.tokenDecimals)) : 0,
          },
        },
        { upsert: true },
      )

      this.curveIndex.set(curveAddress, { token: tokenAddress, curve: curveAddress })
      count++

      await recomputeRisk(this.env.CHAIN_ID, tokenAddress).catch((err) =>
        this.log.warn({ err, tokenAddress }, 'risk recompute failed'),
      )
      void this.resolveMetadata(tokenAddress, args.metadataURI ?? null)
    }

    if (count > 0) this.log.info({ count, fromBlock, toBlock }, 'indexed launches')
    return count
  }

  async resolveMetadata(tokenAddress: string, metadataURI: string | null): Promise<boolean> {
    if (!metadataURI) return false
    try {
      const metadata = await fetchTokenMetadata(this.env.IPFS_GATEWAY_URL, metadataURI)
      if (!metadata) return false
      await TokenModel.updateOne(
        { chainId: this.env.CHAIN_ID, tokenAddress },
        {
          $set: {
            'metadata.description': metadata.description,
            'metadata.image': metadata.image,
            'metadata.x': metadata.x,
            'metadata.telegram': metadata.telegram,
            'metadata.website': metadata.website,
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

  // ── Curve events ──────────────────────────────────────────────────────────

  private async indexCurveEvents(fromBlock: number, toBlock: number): Promise<number> {
    if (this.curveIndex.size === 0) return 0

    const logs = (await this.chain.call('getLogs:curves', (client) =>
      client.getLogs({ events: curveEvents, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) }),
    )) as DecodedLog[]

    // Deterministic order: block, then log index. getLogs already returns this,
    // but the holder ledger depends on it, so it is not left to the endpoint.
    logs.sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || (a.logIndex ?? 0) - (b.logIndex ?? 0))

    let count = 0
    for (const raw of logs) {
      const emitter = raw.address?.toLowerCase()
      if (!emitter) continue
      const known = this.curveIndex.get(emitter)
      if (!known) continue

      switch (raw.eventName) {
        case 'Bought':
        case 'Sold':
          await this.applyTrade(known.token, known.curve, raw)
          count++
          break
        case 'Graduated':
          await this.applyGraduation(known.token, raw)
          count++
          break
        case 'CreatorFeesClaimed':
          await this.applyCreatorClaim(known.token, raw)
          count++
          break
        default:
          break
      }
    }
    return count
  }

  private priceFromCurve(terms: LaunchTerms, reserveUsdg: bigint, tokensSold: bigint): bigint {
    const state: CurveMathState = {
      virtualUsdg: toBigInt(terms.virtualUsdg),
      virtualTokens: toBigInt(terms.virtualTokens),
      curveAllocation: toBigInt(terms.curveAllocation),
      reserveUsdg,
      tokensSold,
      graduationTarget: toBigInt(terms.graduationTarget),
      tradeFeeBps: BigInt(terms.tradeFeeBps),
    }
    return spotPrice(state, terms.tokenDecimals)
  }

  private usd(quote: bigint): number {
    return toUnits(quote, this.env.USDG_DECIMALS)
  }

  private async applyTrade(tokenAddress: string, curveAddress: string, raw: DecodedLog): Promise<void> {
    const args = (raw.args ?? {}) as Record<string, bigint | string | undefined>
    const isBuy = raw.eventName === 'Bought'
    if (raw.blockNumber === null || !raw.transactionHash || raw.logIndex === null) return

    const usdgAmount = toBigInt(isBuy ? args.usdgIn : args.usdgOut)
    const tokenAmount = toBigInt(isBuy ? args.tokensOut : args.tokensIn)
    const reserveAfter = toBigInt(args.reserveAfter)
    const tokensSoldAfter = toBigInt(args.tokensSoldAfter)
    const fee = toBigInt(args.fee)
    const refund = isBuy ? toBigInt(args.refund) : 0n
    const trader = String(isBuy ? args.buyer : args.seller).toLowerCase()
    const at = await this.blockTime(Number(raw.blockNumber))

    const terms = await loadLaunchTerms(this.chain, this.factory, this.env.CHAIN_ID)
    // Spot price after the trade from the curve state; fall back to the trade's
    // own average price when the terms are unreadable.
    const price = terms
      ? this.priceFromCurve(terms, reserveAfter, tokensSoldAfter)
      : pricePerToken(usdgAmount, tokenAmount, this.env.TOKEN_DECIMALS)
    const tokenDecimals = terms?.tokenDecimals ?? this.env.TOKEN_DECIMALS

    const inserted = await TradeModel.updateOne(
      { chainId: this.env.CHAIN_ID, txHash: raw.transactionHash, logIndex: raw.logIndex },
      {
        $setOnInsert: {
          chainId: this.env.CHAIN_ID,
          tokenAddress,
          curveAddress,
          trader,
          side: isBuy ? 'buy' : 'sell',
          usdgAmount: usdgAmount.toString(),
          tokenAmount: tokenAmount.toString(),
          feeUsdg: fee.toString(),
          refundUsdg: refund.toString(),
          reserveAfter: reserveAfter.toString(),
          tokensSoldAfter: tokensSoldAfter.toString(),
          priceUsdg: price.toString(),
          priceUsd: this.usd(price),
          usdValue: this.usd(usdgAmount),
          blockNumber: Number(raw.blockNumber),
          txHash: raw.transactionHash,
          logIndex: raw.logIndex,
          at,
          finalized: false,
        },
      },
      { upsert: true },
    )
    // Aggregates only move on a genuinely new trade — a re-scan after a rewind
    // must not double-count volume.
    if (inserted.upsertedCount === 0) return

    const holderCount = await this.applyHolderDelta(tokenAddress, trader, isBuy ? tokenAmount : -tokenAmount, usdgAmount, isBuy, at)

    const token = await TokenModel.findOne({ chainId: this.env.CHAIN_ID, tokenAddress })
      .select('graduationTarget volumeUsdg buyVolumeUsdg sellVolumeUsdg feesUsdg status')
      .lean()
    if (!token) return

    let target = toBigInt(token.graduationTarget ?? '0')
    if (target === 0n && terms) target = toBigInt(terms.graduationTarget)
    const volume = toBigInt(token.volumeUsdg ?? '0') + usdgAmount
    const supply = terms ? toBigInt(terms.totalSupply) : null
    const mcap = supply ? this.usd(valueOf(price, supply, tokenDecimals)) : 0

    await TokenModel.updateOne(
      { chainId: this.env.CHAIN_ID, tokenAddress },
      {
        $set: {
          reserveUsdg: reserveAfter.toString(),
          tokensSold: tokensSoldAfter.toString(),
          graduationTarget: target.toString(),
          lastPrice: price.toString(),
          priceUsd: this.usd(price),
          marketCapUsd: mcap,
          fdvUsd: mcap,
          progressBps: token.status === 'graduated' ? 10_000 : bps(reserveAfter, target),
          volumeUsdg: volume.toString(),
          volumeUsdAll: this.usd(volume),
          buyVolumeUsdg: (toBigInt(token.buyVolumeUsdg ?? '0') + (isBuy ? usdgAmount : 0n)).toString(),
          sellVolumeUsdg: (toBigInt(token.sellVolumeUsdg ?? '0') + (isBuy ? 0n : usdgAmount)).toString(),
          feesUsdg: (toBigInt(token.feesUsdg ?? '0') + fee).toString(),
          lastTradeAt: at,
          ...(isBuy ? { lastBuyAt: at } : {}),
          holderCount,
        },
        $inc: { tradeCount: 1, buyCount: isBuy ? 1 : 0, sellCount: isBuy ? 0 : 1 },
      },
    )

    if (trader === (await this.creatorOf(tokenAddress))) {
      await recomputeRisk(this.env.CHAIN_ID, tokenAddress).catch(() => undefined)
    }
  }

  private creatorCache = new Map<string, string>()
  private async creatorOf(tokenAddress: string): Promise<string | null> {
    const cached = this.creatorCache.get(tokenAddress)
    if (cached) return cached
    const t = await TokenModel.findOne({ chainId: this.env.CHAIN_ID, tokenAddress }).select('creator').lean()
    if (!t) return null
    this.creatorCache.set(tokenAddress, t.creator)
    return t.creator
  }

  /**
   * Move one holder's balance and return the resulting holder count. Balances
   * are reconstructed from curve trades only — a plain ERC-20 `transfer` is
   * invisible here, and everything derived from them says so.
   */
  private async applyHolderDelta(
    tokenAddress: string,
    holder: string,
    delta: bigint,
    usdg: bigint,
    isBuy: boolean,
    at: Date,
  ): Promise<number> {
    const scope = { chainId: this.env.CHAIN_ID, tokenAddress }
    if (holder && delta !== 0n) {
      const existing = await HolderModel.findOne({ ...scope, holder }).select('balance boughtUsdg soldUsdg').lean()
      let next = toBigInt(existing?.balance ?? '0') + delta
      // A negative balance cannot exist; clamp rather than store one.
      if (next < 0n) next = 0n
      await HolderModel.updateOne(
        { ...scope, holder },
        {
          $set: {
            balance: next.toString(),
            balanceUnits: toUnits(next, this.env.TOKEN_DECIMALS),
            boughtUsdg: (toBigInt(existing?.boughtUsdg ?? '0') + (isBuy ? usdg : 0n)).toString(),
            soldUsdg: (toBigInt(existing?.soldUsdg ?? '0') + (isBuy ? 0n : usdg)).toString(),
            lastTradeAt: at,
          },
          $setOnInsert: { firstSeenAt: at },
        },
        { upsert: true },
      )
    }
    return HolderModel.countDocuments({ ...scope, balance: { $ne: '0' } })
  }

  private async applyGraduation(tokenAddress: string, raw: DecodedLog): Promise<void> {
    const args = (raw.args ?? {}) as Record<string, bigint | string | undefined>
    const pool = String(args.pool ?? '').toLowerCase()
    const lpTokenId = args.tokenId === undefined ? null : String(args.tokenId)
    const at = await this.blockTime(Number(raw.blockNumber))

    await TokenModel.updateOne(
      { chainId: this.env.CHAIN_ID, tokenAddress },
      {
        $set: {
          status: 'graduated',
          poolAddress: pool || null,
          graduatedAt: at,
          graduatedBlock: Number(raw.blockNumber),
          graduationTxHash: raw.transactionHash,
          progressBps: 10_000,
          lpTokenId,
          graduationUsdgIn: toBigInt(args.usdgIn).toString(),
          graduationTokensIn: toBigInt(args.tokensIn).toString(),
        },
      },
    )
    this.log.info({ tokenAddress, pool, lpTokenId }, 'token graduated')

    // Graduation changes the creator's prior-graduations count on every sibling launch.
    const creator = await this.creatorOf(tokenAddress)
    if (creator) {
      const siblings = await TokenModel.find({ chainId: this.env.CHAIN_ID, creator }).select('tokenAddress').lean()
      for (const s of siblings) await recomputeRisk(this.env.CHAIN_ID, s.tokenAddress).catch(() => undefined)
    }
  }

  private async applyCreatorClaim(tokenAddress: string, raw: DecodedLog): Promise<void> {
    const args = (raw.args ?? {}) as Record<string, bigint | undefined>
    const amount = toBigInt(args.amount)
    const token = await TokenModel.findOne({ chainId: this.env.CHAIN_ID, tokenAddress }).select('creatorFeesClaimedUsdg').lean()
    if (!token) return
    await TokenModel.updateOne(
      { chainId: this.env.CHAIN_ID, tokenAddress },
      { $set: { creatorFeesClaimedUsdg: (toBigInt(token.creatorFeesClaimedUsdg ?? '0') + amount).toString() } },
    )
  }

  // ── Reorg / cursor plumbing ───────────────────────────────────────────────

  private async rewindIfReorged(cursor: CursorDoc): Promise<boolean> {
    const buffer = cursor.blockBuffer as unknown as BlockRef[]
    const tip = bufferHead(buffer)
    if (!tip) return false

    const canonical = await this.fetchCanonicalHash(tip.number)
    if (canonical && canonical.toLowerCase() === tip.hash.toLowerCase()) return false

    let ancestor: number
    try {
      ancestor = await findCommonAncestor(buffer, (n) => this.fetchCanonicalHash(n))
    } catch (err) {
      if (err instanceof ReorgTooDeepError) {
        // Deeper than the buffer: rewind to the oldest header we have and re-scan.
        ancestor = Math.max(this.env.INDEXER_START_BLOCK - 1, (buffer[0]?.number ?? 1) - 1)
        this.log.error({ err }, 'reorg deeper than the buffer — rewinding to the buffer floor')
      } else throw err
    }

    await this.rewindTo(ancestor)

    cursor.set('blockBuffer', truncateBuffer(buffer, ancestor))
    cursor.set('lastProcessedBlock', ancestor)
    cursor.set('reorgCount', (cursor.reorgCount ?? 0) + 1)
    cursor.set('lastReorgAt', new Date())
    cursor.set('lastReorgDepth', tip.number - ancestor)
    await cursor.save()
    this.lastProcessed = ancestor

    this.log.warn({ ancestor, depth: tip.number - ancestor }, 'rewound after reorg')
    return true
  }

  /** Undo everything above `ancestor` and rebuild the affected tokens from what survives. */
  async rewindTo(ancestor: number): Promise<void> {
    const chainId = this.env.CHAIN_ID
    const affected = await TradeModel.distinct('tokenAddress', { chainId, blockNumber: { $gt: ancestor } })
    await TradeModel.deleteMany({ chainId, blockNumber: { $gt: ancestor } })

    // Launches above the ancestor never happened.
    const orphaned = await TokenModel.find({ chainId, createdBlock: { $gt: ancestor } }).select('tokenAddress curveAddress').lean()
    for (const t of orphaned) {
      await HolderModel.deleteMany({ chainId, tokenAddress: t.tokenAddress })
      await TokenModel.deleteOne({ chainId, tokenAddress: t.tokenAddress })
      this.curveIndex.delete(t.curveAddress)
    }
    // Graduations above the ancestor are reverted to curve status.
    await TokenModel.updateMany(
      { chainId, status: 'graduated', graduatedBlock: { $gt: ancestor } },
      {
        $set: {
          status: 'curve',
          poolAddress: null,
          graduatedAt: null,
          graduatedBlock: null,
          graduationTxHash: null,
          lpTokenId: null,
          graduationUsdgIn: '0',
          graduationTokensIn: '0',
        },
      },
    )

    const terms = await loadLaunchTerms(this.chain, this.factory, this.env.CHAIN_ID)
    for (const tokenAddress of affected as string[]) {
      await this.rebuildToken(tokenAddress, terms)
    }
  }

  /** Recompute a token's aggregates and holder ledger from its surviving trades. */
  async rebuildToken(tokenAddress: string, terms: LaunchTerms | null): Promise<void> {
    const chainId = this.env.CHAIN_ID
    const token = await TokenModel.findOne({ chainId, tokenAddress }).lean()
    if (!token) return

    const trades = await TradeModel.find({ chainId, tokenAddress }).sort({ blockNumber: 1, logIndex: 1 }).lean()
    const balances = new Map<string, { balance: bigint; bought: bigint; sold: bigint; first: Date; last: Date }>()
    let volume = 0n
    let buyVolume = 0n
    let sellVolume = 0n
    let fees = 0n
    let buys = 0
    let sells = 0
    let lastTradeAt: Date | null = null
    let lastBuyAt: Date | null = null
    let reserve = 0n
    let sold = 0n
    let price = terms ? this.priceFromCurve(terms, 0n, 0n) : 0n

    for (const t of trades) {
      const usdg = toBigInt(t.usdgAmount)
      const tokens = toBigInt(t.tokenAmount)
      const isBuy = t.side === 'buy'
      volume += usdg
      fees += toBigInt(t.feeUsdg ?? '0')
      if (isBuy) {
        buyVolume += usdg
        buys++
        lastBuyAt = t.at
      } else {
        sellVolume += usdg
        sells++
      }
      lastTradeAt = t.at
      reserve = toBigInt(t.reserveAfter ?? '0')
      sold = toBigInt(t.tokensSoldAfter ?? '0')
      price = toBigInt(t.priceUsdg ?? '0')

      const h = balances.get(t.trader) ?? { balance: 0n, bought: 0n, sold: 0n, first: t.at, last: t.at }
      h.balance += isBuy ? tokens : -tokens
      if (h.balance < 0n) h.balance = 0n
      if (isBuy) h.bought += usdg
      else h.sold += usdg
      h.last = t.at
      balances.set(t.trader, h)
    }

    await HolderModel.deleteMany({ chainId, tokenAddress })
    if (balances.size > 0) {
      await HolderModel.insertMany(
        [...balances.entries()].map(([holder, h]) => ({
          chainId,
          tokenAddress,
          holder,
          balance: h.balance.toString(),
          balanceUnits: toUnits(h.balance, this.env.TOKEN_DECIMALS),
          boughtUsdg: h.bought.toString(),
          soldUsdg: h.sold.toString(),
          firstSeenAt: h.first,
          lastTradeAt: h.last,
        })),
      )
    }

    const target = toBigInt(token.graduationTarget ?? '0') || (terms ? toBigInt(terms.graduationTarget) : 0n)
    const supply = terms ? toBigInt(terms.totalSupply) : null
    const tokenDecimals = terms?.tokenDecimals ?? this.env.TOKEN_DECIMALS
    const mcap = supply ? this.usd(valueOf(price, supply, tokenDecimals)) : 0
    const holderCount = [...balances.values()].filter((h) => h.balance > 0n).length

    await TokenModel.updateOne(
      { chainId, tokenAddress },
      {
        $set: {
          reserveUsdg: reserve.toString(),
          tokensSold: sold.toString(),
          lastPrice: price.toString(),
          priceUsd: this.usd(price),
          marketCapUsd: mcap,
          fdvUsd: mcap,
          progressBps: token.status === 'graduated' ? 10_000 : bps(reserve, target),
          volumeUsdg: volume.toString(),
          volumeUsdAll: this.usd(volume),
          buyVolumeUsdg: buyVolume.toString(),
          sellVolumeUsdg: sellVolume.toString(),
          feesUsdg: fees.toString(),
          tradeCount: trades.length,
          buyCount: buys,
          sellCount: sells,
          holderCount,
          lastTradeAt,
          lastBuyAt,
        },
      },
    )
    await recomputeRisk(chainId, tokenAddress).catch(() => undefined)
  }

  private async advance(cursor: CursorDoc, lastProcessedBlock: number, head: number, headers: BlockRef[]): Promise<void> {
    let buffer = cursor.blockBuffer as unknown as BlockRef[]
    for (const h of headers) buffer = appendBlock(buffer, h, this.env.INDEXER_REORG_BUFFER_BLOCKS)

    const finalized = finalizedThrough(head, this.env.INDEXER_CONFIRMATIONS)
    const now = new Date()

    cursor.set('lastProcessedBlock', lastProcessedBlock)
    cursor.set('chainHeadBlock', head)
    cursor.set('finalizedThroughBlock', finalized)
    cursor.set('blockBuffer', buffer)
    cursor.set('lastRunAt', now)
    await cursor.save()
    this.lastProcessed = lastProcessedBlock
    this.lastRunAt = now

    if (finalized > 0) {
      await TradeModel.updateMany(
        { chainId: this.env.CHAIN_ID, finalized: false, blockNumber: { $lte: finalized } },
        { $set: { finalized: true } },
      )
    }
  }

  private async fetchHeader(blockNumber: number): Promise<BlockRef> {
    const block = await this.chain.call('getBlock', (c) => c.getBlock({ blockNumber: BigInt(blockNumber) }))
    this.blockTimeCache.set(blockNumber, new Date(Number(block.timestamp) * 1000))
    return { number: Number(block.number), hash: block.hash, parentHash: block.parentHash }
  }

  private async fetchCanonicalHash(blockNumber: number): Promise<string | null> {
    try {
      const block = await this.chain.call('getBlock', (c) => c.getBlock({ blockNumber: BigInt(blockNumber) }))
      return block.hash ?? null
    } catch {
      return null
    }
  }

  private async blockTime(blockNumber: number): Promise<Date> {
    const cached = this.blockTimeCache.get(blockNumber)
    if (cached) return cached
    const block = await this.chain.call('getBlock:time', (c) => c.getBlock({ blockNumber: BigInt(blockNumber) }))
    const at = new Date(Number(block.timestamp) * 1000)
    this.blockTimeCache.set(blockNumber, at)
    return at
  }

  private async loadCursor(): Promise<CursorDoc> {
    const existing = await CursorModel.findOne({ chainId: this.env.CHAIN_ID, name: CURSOR_NAME })
    if (existing) return existing
    return CursorModel.create({
      chainId: this.env.CHAIN_ID,
      name: CURSOR_NAME,
      lastProcessedBlock: Math.max(0, this.env.INDEXER_START_BLOCK - 1),
      blockBuffer: [],
    })
  }
}
