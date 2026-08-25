/**
 * Rolling aggregates the explore page sorts on.
 *
 * `volumeUsd24h`, `volumeUsd7d`, `trades24h`, `trades7d` are windows that move
 * with the clock, so they cannot be maintained incrementally at index time the
 * way lifetime totals are. They are recomputed here from the trades collection
 * on a timer: one aggregation over the last 7 days grouped by token, then a
 * write per token whose numbers changed. Tokens that fell out of the window are
 * zeroed in one `updateMany`.
 */
import { TokenModel, TradeModel } from '../db/models.js'
import { componentLogger } from '../lib/logger.js'

const log = componentLogger('stats')

const DAY_MS = 24 * 60 * 60 * 1000

export async function refreshRollingStats(chainId: number, now: Date = new Date()): Promise<number> {
  const since7d = new Date(now.getTime() - 7 * DAY_MS)
  const since24h = new Date(now.getTime() - DAY_MS)

  const rows = await TradeModel.aggregate<{
    _id: string
    volumeUsd7d: number
    trades7d: number
    volumeUsd24h: number
    trades24h: number
  }>([
    { $match: { chainId, at: { $gte: since7d } } },
    {
      $group: {
        _id: '$tokenAddress',
        volumeUsd7d: { $sum: '$usdValue' },
        trades7d: { $sum: 1 },
        volumeUsd24h: { $sum: { $cond: [{ $gte: ['$at', since24h] }, '$usdValue', 0] } },
        trades24h: { $sum: { $cond: [{ $gte: ['$at', since24h] }, 1, 0] } },
      },
    },
  ])

  const active = rows.map((r) => r._id)

  if (rows.length > 0) {
    await TokenModel.bulkWrite(
      rows.map((r) => ({
        updateOne: {
          filter: { chainId, tokenAddress: r._id },
          update: {
            $set: {
              volumeUsd7d: r.volumeUsd7d,
              trades7d: r.trades7d,
              volumeUsd24h: r.volumeUsd24h,
              trades24h: r.trades24h,
              statsRefreshedAt: now,
            },
          },
        },
      })),
      { ordered: false },
    )
  }

  // Anything with a stale non-zero window that no longer trades.
  const zeroed = await TokenModel.updateMany(
    {
      chainId,
      tokenAddress: { $nin: active },
      $or: [{ volumeUsd7d: { $ne: 0 } }, { volumeUsd24h: { $ne: 0 } }, { trades7d: { $ne: 0 } }, { trades24h: { $ne: 0 } }],
    },
    { $set: { volumeUsd7d: 0, volumeUsd24h: 0, trades7d: 0, trades24h: 0, statsRefreshedAt: now } },
  )

  log.debug({ active: rows.length, zeroed: zeroed.modifiedCount }, 'rolling stats refreshed')
  return rows.length
}
