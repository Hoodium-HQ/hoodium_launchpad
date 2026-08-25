/**
 * Position discovery — T2.3, T2.4 / AL-1.2.
 *
 * "WHEN an address is registered THEN the system SHALL discover all of its LP
 *  positions within 60 seconds, **including** positions the Uniswap
 *  `ListPositions` API omits (per-owner index bug)."
 *
 * We never call `ListPositions`, and we never call `tokenOfOwnerByIndex` — that
 * per-owner enumeration is the buggy path. Instead we scan the position
 * manager's own `Transfer` logs for `to = wallet`, then confirm current ownership
 * with `ownerOf`. A token that reached the wallet is in the log; the chain has no
 * per-owner index to be wrong about.
 *
 * This is what retires the block-explorer workaround (T2.4).
 */
import { getAddress, type Address } from 'viem'
import { componentLogger } from '../lib/logger.js'
import { mapLimit } from '../lib/concurrency.js'
import { erc20Abi, factoryAbi, positionManagerAbi } from '../chain/abi.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'
import { PositionModel } from '../db/models/position.js'
import { WalletModel } from '../db/models/wallet.js'

const TRANSFER_EVENT = positionManagerAbi.find(
  (i): i is Extract<(typeof positionManagerAbi)[number], { type: 'event' }> =>
    i.type === 'event' && i.name === 'Transfer',
)!

interface TokenMeta {
  address: string
  symbol: string
  decimals: number
}

/** Token metadata never changes; one cache per process is enough. */
const tokenMetaCache = new Map<string, TokenMeta>()

export class PositionDiscovery {
  private readonly log = componentLogger('discovery')

  constructor(
    private readonly env: Env,
    private readonly chain: ChainClient,
  ) {}

  /**
   * Full discovery for one wallet. Idempotent — re-running refreshes state and
   * never duplicates, because positions are keyed by their NFT (T1.2).
   */
  async discoverWallet(walletAddress: string): Promise<{ found: number; open: number }> {
    const owner = walletAddress.toLowerCase()
    const started = Date.now()

    await WalletModel.updateOne(
      { chainId: this.env.CHAIN_ID, address: owner },
      { $set: { 'backfill.state': 'running', 'backfill.startedAt': new Date(), 'backfill.error': null } },
    )

    try {
      const head = Number(await this.chain.getBlockNumber())
      const fromBlock = this.env.INDEXER_START_BLOCK
      const tokenIds = await this.scanTransfersTo(owner, fromBlock, head)

      const results = await mapLimit(Array.from(tokenIds), 4, (tokenId) => this.syncToken(tokenId, owner))
      const open = results.filter((r) => r === 'open').length

      await WalletModel.updateOne(
        { chainId: this.env.CHAIN_ID, address: owner },
        {
          $set: {
            'backfill.state': 'complete',
            'backfill.completedAt': new Date(),
            'backfill.fromBlock': fromBlock,
            'backfill.toBlock': head,
          },
        },
      )

      const elapsedMs = Date.now() - started
      this.log.info(
        { wallet: owner, candidates: tokenIds.size, open, elapsedMs, budgetMs: 60_000 },
        elapsedMs > 60_000 ? 'discovery exceeded the AL-1.2 60s budget' : 'discovery complete',
      )
      return { found: tokenIds.size, open }
    } catch (err) {
      await WalletModel.updateOne(
        { chainId: this.env.CHAIN_ID, address: owner },
        { $set: { 'backfill.state': 'failed', 'backfill.error': String(err) } },
      )
      throw err
    }
  }

  /** Every position-manager token that has ever been transferred *to* this wallet. */
  private async scanTransfersTo(owner: string, fromBlock: number, toBlock: number): Promise<Set<string>> {
    const tokenIds = new Set<string>()
    const range = this.env.INDEXER_LOG_RANGE

    for (let start = fromBlock; start <= toBlock; start += range) {
      const end = Math.min(start + range - 1, toBlock)
      const logs = await this.chain.call('getLogs:transfersTo', (client) =>
        client.getLogs({
          address: this.env.POSITION_MANAGER_ADDRESS as Address,
          event: TRANSFER_EVENT,
          args: { to: getAddress(owner) },
          fromBlock: BigInt(start),
          toBlock: BigInt(end),
        }),
      )
      for (const log of logs) {
        const tokenId = (log.args as { tokenId?: bigint }).tokenId
        if (tokenId !== undefined) tokenIds.add(tokenId.toString())
      }
    }

    return tokenIds
  }

  /**
   * Refresh one token's on-chain state into `positions`.
   *
   * @returns `open` if the wallet still owns it with liquidity, `closed` if the
   *          position is empty, `moved` if it now belongs to someone else.
   */
  async syncToken(tokenId: string, expectedOwner?: string): Promise<'open' | 'closed' | 'moved' | 'gone'> {
    const pm = this.env.POSITION_MANAGER_ADDRESS as Address

    let currentOwner: string
    try {
      currentOwner = (
        await this.chain.call('ownerOf', (c) =>
          c.readContract({ address: pm, abi: positionManagerAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
        )
      ).toLowerCase()
    } catch {
      // Burned. Uniswap requires liquidity to be zero before burn, so the
      // position is closed rather than lost.
      await PositionModel.updateOne(
        { chainId: this.env.CHAIN_ID, positionManager: pm.toLowerCase(), tokenId },
        { $set: { status: 'closed', liquidity: '0' } },
      )
      return 'gone'
    }

    if (expectedOwner && currentOwner !== expectedOwner) {
      await PositionModel.updateOne(
        { chainId: this.env.CHAIN_ID, positionManager: pm.toLowerCase(), tokenId },
        { $set: { ownerAddress: currentOwner } },
      )
      return 'moved'
    }

    const p = await this.chain.call('positions', (c) =>
      c.readContract({ address: pm, abi: positionManagerAbi, functionName: 'positions', args: [BigInt(tokenId)] }),
    )
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = p

    const [meta0, meta1, poolAddress] = await Promise.all([
      this.tokenMeta(token0),
      this.tokenMeta(token1),
      this.poolFor(token0, token1, fee),
    ])

    const quote = this.env.QUOTE_TOKEN_ADDRESS.toLowerCase()
    const quoteIsToken0 = token0.toLowerCase() === quote
    const quoteSupported = quoteIsToken0 || token1.toLowerCase() === quote
    const status = liquidity > 0n ? 'open' : 'closed'

    await PositionModel.updateOne(
      { chainId: this.env.CHAIN_ID, positionManager: pm.toLowerCase(), tokenId },
      {
        $set: {
          ownerAddress: currentOwner,
          poolAddress: poolAddress.toLowerCase(),
          token0: meta0,
          token1: meta1,
          fee: Number(fee),
          tickLower: Number(tickLower),
          tickUpper: Number(tickUpper),
          liquidity: liquidity.toString(),
          quoteIsToken0,
          quoteSupported,
          status,
        },
        $setOnInsert: { source: 'index' },
      },
      { upsert: true },
    )

    if (!quoteSupported) {
      this.log.info(
        { tokenId, token0: meta0.symbol, token1: meta1.symbol, quote: this.env.QUOTE_TOKEN_SYMBOL },
        'position is not quote-paired — monitored, but exposure is undefined',
      )
    }

    return status
  }

  private async tokenMeta(addr: string): Promise<TokenMeta> {
    const key = addr.toLowerCase()
    const cached = tokenMetaCache.get(key)
    if (cached) return cached

    const [symbol, decimals] = await Promise.all([
      this.chain
        .call('erc20.symbol', (c) =>
          c.readContract({ address: addr as Address, abi: erc20Abi, functionName: 'symbol' }),
        )
        .catch(() => '???'),
      this.chain.call('erc20.decimals', (c) =>
        c.readContract({ address: addr as Address, abi: erc20Abi, functionName: 'decimals' }),
      ),
    ])

    const meta: TokenMeta = { address: key, symbol, decimals: Number(decimals) }
    tokenMetaCache.set(key, meta)
    return meta
  }

  private async poolFor(token0: string, token1: string, fee: number): Promise<string> {
    return this.chain.call('factory.getPool', (c) =>
      c.readContract({
        address: this.env.UNISWAP_V3_FACTORY_ADDRESS as Address,
        abi: factoryAbi,
        functionName: 'getPool',
        args: [token0 as Address, token1 as Address, fee],
      }),
    )
  }
}
