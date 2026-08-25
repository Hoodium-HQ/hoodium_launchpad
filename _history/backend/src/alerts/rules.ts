/**
 * Alert rules — T3.5 / AL-3.1, AL-3.2.
 *
 *   AL-3.1  price within 10% of a boundary → alert stating the distance as a %
 *   AL-3.2  position leaves range          → notify within 60 seconds
 *
 * The 60-second guarantee in AL-3.2 comes from the monitor's cadence (AL-2.1):
 * this function runs once per snapshot, so the worst case is one interval.
 *
 * There is deliberately no exposure-threshold alert here. Telling the user what
 * the system *would* have done (AL-3.4) is T4.5, which belongs to shadow mode —
 * emitting it now would be a decision made outside the Evaluator, and design section 1
 * puts decisions there.
 */
import type { Env } from '../config/env.js'
import { positionKey, type PositionDoc } from '../db/models/position.js'
import type { ExposureResult } from '../monitor/rangemath.js'
import { raiseAlert, type RaiseAlertResult } from './dedupe.js'

export interface AlertEvaluationInput {
  env: Env
  position: PositionDoc
  pool: { tick: number }
  exposure: ExposureResult
}

/** Pure classification, so the rule table is testable without a database. */
export type AlertVerdict =
  | { kind: 'none' }
  | { kind: 'out_of_range'; boundary: 'lower' | 'upper' }
  | { kind: 'range_proximity'; boundary: 'lower' | 'upper'; distancePct: string }

export function classify(input: {
  tickCurrent: number
  tickLower: number
  tickUpper: number
  exposure: ExposureResult
}): AlertVerdict {
  const { exposure, tickCurrent, tickLower } = input

  if (!exposure.inRange) {
    // Below `tickLower` the position is entirely token0; above `tickUpper`,
    // entirely token1. Which side it exited from is what the user needs told.
    return { kind: 'out_of_range', boundary: tickCurrent < tickLower ? 'lower' : 'upper' }
  }

  if (exposure.nearBoundary) {
    const distance =
      exposure.nearestBoundary === 'lower' ? exposure.distanceToLowerPct : exposure.distanceToUpperPct
    return { kind: 'range_proximity', boundary: exposure.nearestBoundary, distancePct: distance.toFixed(2) }
  }

  return { kind: 'none' }
}

export async function evaluatePositionAlerts(input: AlertEvaluationInput): Promise<RaiseAlertResult | null> {
  const { env, position, pool, exposure } = input

  const verdict = classify({
    tickCurrent: pool.tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    exposure,
  })
  if (verdict.kind === 'none') return null

  const key = positionKey(position)
  const pair = `${position.token0.symbol}/${position.token1.symbol}`
  const baseSymbol = position.quoteIsToken0 ? position.token1.symbol : position.token0.symbol

  const context = {
    exposurePct: exposure.exposurePct.toFixed(),
    distancePct:
      verdict.kind === 'range_proximity'
        ? verdict.distancePct
        : breachedDistance(exposure.distanceToLowerPct.toFixed(), exposure.distanceToUpperPct.toFixed()),
    price: exposure.price.toFixed(),
    tickCurrent: pool.tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    boundary: verdict.boundary,
  }

  if (verdict.kind === 'out_of_range') {
    return raiseAlert({
      chainId: position.chainId,
      ownerAddress: position.ownerAddress,
      positionKey: key,
      type: 'out_of_range',
      severity: 'critical',
      // One alert per position per boundary per window (AL-3.3).
      dedupeKey: `out_of_range:${key}:${verdict.boundary}`,
      title: `${pair} is out of range`,
      body:
        `Price has moved past the ${verdict.boundary} boundary. The position is now fully converted to ` +
        `${verdict.boundary === 'lower' ? position.token0.symbol : position.token1.symbol} and is earning no fees. ` +
        `Exposure to ${baseSymbol} is ${exposure.exposurePct.toFixed(1)}%.`,
      context,
      dedupeHours: env.ALERT_DEDUPE_HOURS,
    })
  }

  return raiseAlert({
    chainId: position.chainId,
    ownerAddress: position.ownerAddress,
    positionKey: key,
    type: 'range_proximity',
    severity: 'warning',
    dedupeKey: `range_proximity:${key}:${verdict.boundary}`,
    title: `${pair} is ${verdict.distancePct}% from its ${verdict.boundary} boundary`,
    // AL-3.1 requires the distance stated as a percentage — it is in the title
    // and the body, because push notifications truncate.
    body:
      `Price is ${verdict.distancePct}% away from the ${verdict.boundary} edge of your range. ` +
      `If it crosses, the position stops earning fees and converts fully to one side. ` +
      `Exposure to ${baseSymbol} is currently ${exposure.exposurePct.toFixed(1)}%.`,
    context,
    dedupeHours: env.ALERT_DEDUPE_HOURS,
  })
}

/** Out of range: the breached side is the one at zero distance. */
function breachedDistance(lower: string, upper: string): string {
  return Number(lower) <= Number(upper) ? lower : upper
}
