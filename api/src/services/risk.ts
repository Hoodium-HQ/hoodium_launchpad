/**
 * Creator risk flags — LP-5.4.
 *
 * Facts about the chain, never opinions (LP-5.5): "creator holds 41% of the
 * circulating supply" is a measurement; "risky token" would be a judgement.
 */
import { HolderModel, TokenModel } from '../db/models.js'
import { toBigInt } from '../lib/amounts.js'
import type { RiskFlag } from '../types.js'

/** Concentration above this is worth telling a buyer about. */
const CONCENTRATION_FLAG_PCT = 20

/** Cyrillic, Greek and fullwidth Latin lookalikes. */
const CONFUSABLES = /[Ѐ-ӿͰ-Ͽ！-～]/

export interface RiskAssessment {
  creatorSharePct: string
  creatorPriorLaunches: number
  creatorPriorGraduations: number
  hasConfusableSymbol: boolean
  flags: RiskFlag[]
}

export function assessConfusable(symbol: string, name: string): boolean {
  return CONFUSABLES.test(symbol) || CONFUSABLES.test(name)
}

/** Share of `sold` held by `balance`, as a percent string with 4 decimals. */
export function sharePct(balance: bigint, sold: bigint): string {
  if (sold <= 0n || balance <= 0n) return '0'
  const scaled = (balance * 1_000_000n) / sold // pct * 10^4
  const whole = scaled / 10_000n
  const frac = (scaled % 10_000n).toString().padStart(4, '0').replace(/0+$/, '')
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString()
}

export function buildFlags(input: {
  creatorSharePct: string
  priorLaunches: number
  priorGraduations: number
  hasConfusableSymbol: boolean
}): RiskFlag[] {
  const flags: RiskFlag[] = []

  if (Number(input.creatorSharePct) >= CONCENTRATION_FLAG_PCT) flags.push('creator_concentration')

  // "Previously launched tokens that failed" — stated as a count, not a verdict.
  const failed = input.priorLaunches - input.priorGraduations
  if (input.priorLaunches >= 3 && failed === input.priorLaunches) flags.push('creator_no_prior_graduations')

  if (input.hasConfusableSymbol) flags.push('confusable_symbol')

  return flags
}

export async function recomputeRisk(chainId: number, tokenAddress: string): Promise<RiskAssessment | null> {
  const token = await TokenModel.findOne({ chainId, tokenAddress: tokenAddress.toLowerCase() })
    .select('tokenAddress creator symbol name tokensSold')
    .lean()
  if (!token) return null

  const [priorLaunches, priorGraduations, creatorHolding] = await Promise.all([
    TokenModel.countDocuments({ chainId, creator: token.creator, tokenAddress: { $ne: token.tokenAddress } }),
    TokenModel.countDocuments({
      chainId,
      creator: token.creator,
      status: 'graduated',
      tokenAddress: { $ne: token.tokenAddress },
    }),
    HolderModel.findOne({ chainId, tokenAddress: token.tokenAddress, holder: token.creator }).select('balance').lean(),
  ])

  // Share of *circulating* supply, not of total — total would never flag anything early.
  const creatorSharePct = sharePct(toBigInt(creatorHolding?.balance ?? '0'), toBigInt(token.tokensSold ?? '0'))
  const hasConfusableSymbol = assessConfusable(token.symbol ?? '', token.name ?? '')
  const flags = buildFlags({ creatorSharePct, priorLaunches, priorGraduations, hasConfusableSymbol })

  await TokenModel.updateOne(
    { chainId, tokenAddress: token.tokenAddress },
    {
      $set: {
        'risk.creatorSharePct': creatorSharePct,
        'risk.creatorPriorLaunches': priorLaunches,
        'risk.creatorPriorGraduations': priorGraduations,
        'risk.hasConfusableSymbol': hasConfusableSymbol,
        'risk.flags': flags,
        'risk.computedAt': new Date(),
      },
    },
  )

  return { creatorSharePct, creatorPriorLaunches: priorLaunches, creatorPriorGraduations: priorGraduations, hasConfusableSymbol, flags }
}
