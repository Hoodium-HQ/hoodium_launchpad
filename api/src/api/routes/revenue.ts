/**
 * The launchpad's platform revenue, in public — `GET /api/revenue`.
 *
 * Same stance as the pools API's route of the same name: every figure here is
 * an on-chain event (a curve trade's `fee`, the creation fee transfer, the
 * graduation fee kept back from the LP seed), so there is nothing to withhold.
 * token.hoodium.app reads it to show what the HDM buyback will be fed from.
 *
 * Only the platform's share is revenue. A trade fee is split with the creator
 * at `creatorFeeShareBps`, so the platform share of a fee is the remainder;
 * creation and graduation fees go to the vault whole.
 */
import type { FastifyInstance } from 'fastify'
import { TokenModel, TradeModel } from '../../db/models.js'
import { toBigInt } from '../../lib/amounts.js'
import { terms, type AppContext } from '../context.js'

const RECENT_LIMIT = 50
const BPS = 10_000n

export async function registerRevenueRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/revenue', async (_request, reply) => {
    const t = await terms(ctx)
    const chainId = ctx.env.CHAIN_ID
    const platformBps = t ? BPS - BigInt(t.creatorFeeShareBps) : 0n
    const usdgDecimals = ctx.env.USDG_DECIMALS
    const usd = (v: bigint) => Number(v) / 10 ** usdgDecimals

    const [feeAgg, launches, graduated, recentRows] = await Promise.all([
      TradeModel.aggregate<{ fees: string; count: number }>([
        { $match: { chainId } },
        { $group: { _id: null, fees: { $sum: { $toDecimal: '$feeUsdg' } }, count: { $sum: 1 } } },
        { $project: { _id: 0, fees: { $toString: '$fees' }, count: 1 } },
      ]),
      TokenModel.countDocuments({ chainId }),
      TokenModel.countDocuments({ chainId, status: 'graduated' }),
      TradeModel.find({ chainId }).sort({ blockNumber: -1, logIndex: -1 }).limit(RECENT_LIMIT).lean(),
    ])

    const tradeFees = toBigInt(feeAgg[0]?.fees?.split('.')[0] ?? '0')
    const platformTradeFees = (tradeFees * platformBps) / BPS
    const creationFees = t ? BigInt(launches) * toBigInt(t.creationFee) : 0n
    const graduationFees = t ? BigInt(graduated) * toBigInt(t.graduationFee) : 0n
    const revenue = platformTradeFees + creationFees + graduationFees

    const symbols = new Map<string, string>()
    const addrs = [...new Set(recentRows.map((r) => r.tokenAddress))]
    for (const tok of await TokenModel.find({ chainId, tokenAddress: { $in: addrs } }).select('tokenAddress symbol').lean()) {
      symbols.set(tok.tokenAddress, tok.symbol)
    }

    reply.header('cache-control', 'public, max-age=30')
    return {
      chainId,
      quote: { symbol: 'USDG', decimals: usdgDecimals },
      feeVault: t?.feeVault ?? null,
      shares: { tradeFeeBps: t?.tradeFeeBps ?? null, platformShareBps: Number(platformBps) },
      counts: { trades: feeAgg[0]?.count ?? 0, launches, graduated },
      totals: {
        tradeFees: tradeFees.toString(),
        platformTradeFees: platformTradeFees.toString(),
        creationFees: creationFees.toString(),
        graduationFees: graduationFees.toString(),
        revenue: revenue.toString(),
      },
      usdTotals: {
        tradeFees: usd(tradeFees),
        platformTradeFees: usd(platformTradeFees),
        creationFees: usd(creationFees),
        graduationFees: usd(graduationFees),
        revenue: usd(revenue),
      },
      recent: recentRows.map((r) => {
        const fee = toBigInt(r.feeUsdg ?? '0')
        const platformFee = (fee * platformBps) / BPS
        return {
          txHash: r.txHash,
          at: new Date(r.at).toISOString(),
          kind: 'trade',
          side: r.side,
          tokenAddress: r.tokenAddress,
          symbol: symbols.get(r.tokenAddress) ?? null,
          feeUsdg: fee.toString(),
          platformFeeUsdg: platformFee.toString(),
          usd: usd(platformFee),
        }
      }),
      verify: {
        events: ['Bought(...)', 'Sold(...)'],
        note: 'Trade fees are the fee field of each curve event; the platform share is the remainder after creatorFeeShareBps. Creation and graduation fees are counted per launch and per graduation at the factory terms.',
      },
    }
  })
}
