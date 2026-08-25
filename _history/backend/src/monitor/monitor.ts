/**
 * Monitor — T3.2, T3.4 / AL-2.1, AL-2.3, AL-2.5.
 *
 * Computes exposure for every open position at least every 60 seconds and writes
 * a snapshot. It decides nothing and executes nothing (design section 1) — it hands each
 * snapshot to the alert rules and to the Evaluator, and stops there. Whether a
 * rebalance is warranted is not a question asked or answered in this file.
 *
 * AL-2.5: two consecutive failed cycles for a wallet suspend automated execution
 * for that wallet and notify the user. Degraded reads must never produce
 * confident actions.
 */
import type { Address } from 'viem'
import Decimal from 'decimal.js'
import { componentLogger } from '../lib/logger.js'
import { mapLimit } from '../lib/concurrency.js'
import { poolAbi } from '../chain/abi.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'
import { PositionModel, positionKey, type PositionDoc } from '../db/models/position.js'
import { PositionSnapshotModel } from '../db/models/position-snapshot.js'
import { WalletModel, type WalletDoc } from '../db/models/wallet.js'
import { computeExposure, type ExposureResult } from './rangemath.js'
import { evaluatePositionAlerts } from '../alerts/rules.js'
import { evaluateRebalance } from '../rebalance/evaluator.js'

export interface PoolState {
  sqrtPriceX96: bigint
  tick: number
  blockNumber: number
}

export interface MonitorCycleResult {
  walletsChecked: number
  positionsSnapshotted: number
  walletsFailed: number
  durationMs: number
}

export class Monitor {
  private readonly log = componentLogger('monitor')
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly env: Env,
    private readonly chain: ChainClient,
  ) {}

  async start(): Promise<void> {
    await this.runCycle()
    this.timer = setInterval(() => void this.runCycle(), this.env.MONITOR_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runCycle(): Promise<MonitorCycleResult> {
    if (this.running) {
      this.log.warn('previous monitor cycle still running — skipping this tick')
      return { walletsChecked: 0, positionsSnapshotted: 0, walletsFailed: 0, durationMs: 0 }
    }
    this.running = true
    const started = Date.now()

    let positionsSnapshotted = 0
    let walletsFailed = 0

    try {
      const wallets = await WalletModel.find({ chainId: this.env.CHAIN_ID, disabledAt: null })

      // Pool state is shared across every position in that pool, so it is fetched
      // once per cycle rather than once per position.
      const poolCache = new Map<string, PoolState>()

      for (const wallet of wallets) {
        try {
          positionsSnapshotted += await this.runWallet(wallet, poolCache)
          await this.recordSuccess(wallet)
        } catch (err) {
          walletsFailed++
          this.log.error({ err, wallet: wallet.address }, 'monitor cycle failed for wallet')
          await this.recordFailure(wallet, err)
        }
      }

      const durationMs = Date.now() - started
      if (durationMs > this.env.MONITOR_INTERVAL_MS) {
        // AL-2.1 requires a snapshot at least every 60s. A cycle that outlasts its
        // own interval means we are no longer meeting that, and it will not fix
        // itself as wallets are added.
        this.log.warn(
          { durationMs, intervalMs: this.env.MONITOR_INTERVAL_MS, wallets: wallets.length },
          'monitor cycle exceeded its interval — AL-2.1 at risk',
        )
      }

      return { walletsChecked: wallets.length, positionsSnapshotted, walletsFailed, durationMs }
    } finally {
      this.running = false
    }
  }

  private async runWallet(wallet: WalletDoc, poolCache: Map<string, PoolState>): Promise<number> {
    const positions = await PositionModel.find({
      chainId: this.env.CHAIN_ID,
      ownerAddress: wallet.address,
      status: 'open',
    })
    if (positions.length === 0) return 0

    let count = 0
    await mapLimit(positions, 4, async (position) => {
      const pool = await this.poolState(position.poolAddress, poolCache)
      const exposure = this.exposureFor(position, pool)
      await this.writeSnapshot(position, pool, exposure)
      count++

      // Alerts and decisions are only meaningful where exposure is defined.
      if (exposure) {
        await evaluatePositionAlerts({ env: this.env, position, pool, exposure })

        /*
         * The Evaluator (design section 1). The monitor still "decides nothing and executes
         * nothing" — it hands the snapshot on and does not read the verdict.
         *
         * A failing evaluation must not cost the wallet its snapshot cycle: a
         * throw here would count as a monitoring failure and, twice over, would
         * suspend the wallet under AL-2.5. The reads succeeded; only the
         * decision did not.
         */
        await evaluateRebalance({
          env: this.env,
          position,
          pool,
          exposure,
          executionSuspended: wallet.monitoring?.executionSuspended === true,
        }).catch((err) => {
          this.log.error({ err, position: positionKey(position) }, 'rebalance evaluation failed')
        })
      }
    })

    await PositionModel.updateMany(
      { _id: { $in: positions.map((p) => p._id) } },
      { $set: { lastSnapshotAt: new Date(), lastSyncedBlock: 0 } },
    )

    return count
  }

  /** `null` when the pair has no quote side — exposure is undefined (AL-2.2). */
  private exposureFor(position: PositionDoc, pool: PoolState): ExposureResult | null {
    if (!position.quoteSupported) return null
    return computeExposure(
      {
        sqrtPriceX96: pool.sqrtPriceX96,
        tickCurrent: pool.tick,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: BigInt(position.liquidity ?? '0'),
        quoteIsToken0: position.quoteIsToken0,
        decimals0: position.token0.decimals,
        decimals1: position.token1.decimals,
      },
      this.env.RANGE_PROXIMITY_PCT,
    )
  }

  private async writeSnapshot(position: PositionDoc, pool: PoolState, exposure: ExposureResult | null): Promise<void> {
    const zero = new Decimal(0)
    await PositionSnapshotModel.create({
      at: new Date(),
      meta: {
        positionKey: positionKey(position),
        ownerAddress: position.ownerAddress,
        chainId: position.chainId,
      },
      blockNumber: pool.blockNumber,
      tickCurrent: pool.tick,
      sqrtPriceX96: pool.sqrtPriceX96.toString(),
      liquidity: position.liquidity ?? '0',
      amount0: (exposure?.amount0 ?? 0n).toString(),
      amount1: (exposure?.amount1 ?? 0n).toString(),
      exposurePct: (exposure?.exposurePct ?? zero).toFixed(),
      valueQuote: (exposure?.valueQuote ?? zero).toFixed(),
      price: (exposure?.price ?? zero).toFixed(),
      inRange: exposure?.inRange ?? (pool.tick >= position.tickLower && pool.tick < position.tickUpper),
      distanceToLowerPct: (exposure?.distanceToLowerPct ?? zero).toFixed(),
      distanceToUpperPct: (exposure?.distanceToUpperPct ?? zero).toFixed(),
    })
  }

  private async poolState(poolAddress: string, cache: Map<string, PoolState>): Promise<PoolState> {
    const key = poolAddress.toLowerCase()
    const cached = cache.get(key)
    if (cached) return cached

    const [slot0, blockNumber] = await Promise.all([
      this.chain.call('pool.slot0', (c) =>
        c.readContract({ address: key as Address, abi: poolAbi, functionName: 'slot0' }),
      ),
      this.chain.getBlockNumber(),
    ])

    const state: PoolState = {
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
      blockNumber: Number(blockNumber),
    }
    cache.set(key, state)
    return state
  }

  private async recordSuccess(wallet: WalletDoc): Promise<void> {
    const wasSuspended = wallet.monitoring?.executionSuspended === true
    await WalletModel.updateOne(
      { _id: wallet._id },
      {
        $set: {
          'monitoring.consecutiveFailures': 0,
          'monitoring.lastSuccessAt': new Date(),
          'monitoring.executionSuspended': false,
          'monitoring.suspendedReason': null,
        },
      },
    )
    if (wasSuspended) {
      this.log.info({ wallet: wallet.address }, 'reads recovered — execution suspension lifted (AL-2.5)')
    }
  }

  /**
   * AL-2.5 — two consecutive failures suspend execution and notify. Imported
   * lazily to keep the monitor free of a static dependency on the notifier,
   * which in turn depends on the alert layer.
   */
  private async recordFailure(wallet: WalletDoc, err: unknown): Promise<void> {
    const failures = (wallet.monitoring?.consecutiveFailures ?? 0) + 1
    const suspend = failures >= 2

    await WalletModel.updateOne(
      { _id: wallet._id },
      {
        $set: {
          'monitoring.consecutiveFailures': failures,
          'monitoring.lastFailureAt': new Date(),
          ...(suspend
            ? {
                'monitoring.executionSuspended': true,
                'monitoring.suspendedReason': `two consecutive monitoring cycles failed: ${String(err)}`,
              }
            : {}),
        },
      },
    )

    if (suspend) {
      const { raiseAlert } = await import('../alerts/dedupe.js')
      await raiseAlert({
        chainId: this.env.CHAIN_ID,
        ownerAddress: wallet.address,
        positionKey: null,
        type: 'monitoring_degraded',
        severity: 'critical',
        dedupeKey: `monitoring_degraded:${this.env.CHAIN_ID}:${wallet.address}`,
        title: 'Monitoring degraded — automation suspended',
        body:
          'Two consecutive monitoring cycles failed, so automated execution is suspended for this wallet ' +
          'until reads recover. Your funds are untouched; nothing will be executed on stale data.',
        context: {},
        dedupeHours: this.env.ALERT_DEDUPE_HOURS,
      })
    }
  }
}
