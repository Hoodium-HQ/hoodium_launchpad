/**
 * Creator risk flags — T3.6 / LP-5.4.
 *
 * "The system SHALL flag tokens whose creator holds an outsized share, or has
 *  previously launched tokens that failed."
 *
 * Two rules bound what this is allowed to be:
 *
 *   LP-5.5 — no editorial promotion, endorsement, or paid rank-boosting. So these
 *   are *facts about the chain*, never opinions. "Creator holds 41% of supply" is
 *   a measurement; "risky token" would be a judgement, and we do not make it.
 *
 *   WA-2.5 — flags are displayed prominently, not hidden behind a tab. That makes
 *   them worth computing accurately: a flag nobody can act on is decoration, and a
 *   wrong flag shown prominently is a defamation of somebody's launch.
 */
import { Decimal } from '../lib/money.js'
import { LaunchpadHolderModel, LaunchpadTokenModel } from '../db/models/launchpad.js'

/** Concentration above this is worth telling a buyer about. */
const CONCENTRATION_FLAG_PCT = 20

/** Cyrillic, Greek and fullwidth Latin lookalikes (design.md section 8). */
const CONFUSABLES = /[Ѐ-ӿͰ-Ͽ！-～]/

export interface RiskAssessment {
  creatorSharePct: string
  creatorPriorLaunches: number
  creatorPriorGraduations: number
  hasConfusableSymbol: boolean
  flags: string[]
}

export function assessConfusable(symbol: string, name: string): boolean {
  return CONFUSABLES.test(symbol) || CONFUSABLES.test(name)
}

/**
 * Compute flags from stored state. Pure enough to test: it reads, it does not
 * fetch from chain.
 */
export function buildFlags(input: {
  creatorSharePct: string
  priorLaunches: number
  priorGraduations: number
  hasConfusableSymbol: boolean
}): string[] {
  const flags: string[] = []

  if (new Decimal(input.creatorSharePct).gte(CONCENTRATION_FLAG_PCT)) {
    flags.push('creator_concentration')
  }

  // "Previously launched tokens that failed" — a launch that never graduated.
  // Stated as a count, not as a verdict: plenty of honest launches never
  // graduate, and 1–1.4% graduating is the industry norm (specs/README.md).
  const failed = input.priorLaunches - input.priorGraduations
  if (input.priorLaunches >= 3 && failed === input.priorLaunches) {
    flags.push('creator_no_prior_graduations')
  }

  if (input.hasConfusableSymbol) flags.push('confusable_symbol')

  return flags
}

export async function recomputeRisk(chainId: number, tokenAddress: string): Promise<RiskAssessment | null> {
  const token = await LaunchpadTokenModel.findOne({ chainId, tokenAddress: tokenAddress.toLowerCase() })
  if (!token) return null

  const [priorLaunches, priorGraduations, creatorHolding] = await Promise.all([
    LaunchpadTokenModel.countDocuments({
      chainId,
      creator: token.creator,
      tokenAddress: { $ne: token.tokenAddress },
    }),
    LaunchpadTokenModel.countDocuments({
      chainId,
      creator: token.creator,
      status: 'graduated',
      tokenAddress: { $ne: token.tokenAddress },
    }),
    LaunchpadHolderModel.findOne({ chainId, tokenAddress: token.tokenAddress, holder: token.creator }).lean(),
  ])

  const sold = new Decimal(token.tokensSold?.toString() ?? '0')
  const creatorBalance = new Decimal(creatorHolding?.balance ?? '0')
  // Share of *circulating* supply, not of total. Measuring against total supply
  // would report a tiny number for every early launch and never flag anything.
  const creatorSharePct = sold.isZero() ? '0' : creatorBalance.div(sold).mul(100).toDecimalPlaces(4).toFixed()

  const hasConfusableSymbol = assessConfusable(token.symbol ?? '', token.name ?? '')

  const flags = buildFlags({
    creatorSharePct,
    priorLaunches,
    priorGraduations,
    hasConfusableSymbol,
  })

  const assessment: RiskAssessment = {
    creatorSharePct,
    creatorPriorLaunches: priorLaunches,
    creatorPriorGraduations: priorGraduations,
    hasConfusableSymbol,
    flags,
  }

  await LaunchpadTokenModel.updateOne(
    { _id: token._id },
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

  return assessment
}
