/**
 * API serialisation. Money leaves the process as a string, never a JSON number
 * (AL-N4) — `JSON.parse` would turn it into a double and undo the whole point of
 * storing Decimal128.
 */
import { Types } from 'mongoose'
import { moneyToJson } from '../lib/money.js'
import type { PositionDoc } from '../db/models/position.js'

function m(value: Types.Decimal128 | null | undefined): string | null {
  return moneyToJson(value ?? null)
}

export function serializePosition(p: PositionDoc) {
  return {
    positionKey: `${p.chainId}:${p.positionManager}:${p.tokenId}`,
    chainId: p.chainId,
    tokenId: p.tokenId,
    owner: p.ownerAddress,
    pool: p.poolAddress,
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: p.liquidity,
    quoteIsToken0: p.quoteIsToken0,
    quoteSupported: p.quoteSupported,
    status: p.status,
    lastSnapshotAt: p.lastSnapshotAt,
  }
}

export function serializeSnapshot(s: Record<string, unknown>) {
  const meta = (s.meta ?? {}) as { positionKey?: string }
  return {
    at: s.at,
    positionKey: meta.positionKey ?? null,
    blockNumber: s.blockNumber,
    tickCurrent: s.tickCurrent,
    liquidity: s.liquidity,
    amount0: s.amount0,
    amount1: s.amount1,
    exposurePct: m(s.exposurePct as Types.Decimal128),
    valueQuote: m(s.valueQuote as Types.Decimal128),
    price: m(s.price as Types.Decimal128),
    inRange: s.inRange,
    distanceToLowerPct: m(s.distanceToLowerPct as Types.Decimal128),
    distanceToUpperPct: m(s.distanceToUpperPct as Types.Decimal128),
  }
}

/**
 * A recorded decision (AL-5.5). The web app shows these to make the shadow
 * period legible — including the refusals, which are what design section 6 says prove the
 * guard is worth having.
 */
export function serializeShadowAction(s: Record<string, unknown>) {
  const plan = (s.plan ?? {}) as Record<string, unknown>
  return {
    id: String(s._id),
    positionKey: s.positionKey,
    action: s.action,
    decision: s.decision,
    reason: s.reason,
    exposurePct: m(s.exposurePct as Types.Decimal128),
    thresholdPct: m(s.thresholdPct as Types.Decimal128),
    positionValueQuote: m(s.positionValueQuote as Types.Decimal128),
    estimatedCostQuote: m(s.estimatedCostQuote as Types.Decimal128),
    expectedBenefitQuote: m(s.expectedBenefitQuote as Types.Decimal128),
    plan: {
      tickLower: plan.tickLower ?? null,
      tickUpper: plan.tickUpper ?? null,
      targetExposurePct: m(plan.targetExposurePct as Types.Decimal128),
      inRangeAtOpen: plan.inRangeAtOpen ?? null,
    },
    occurrences: s.occurrences,
    firstAt: s.firstAt,
    lastAt: s.lastAt,
  }
}

export function serializeIntent(i: Record<string, unknown>) {
  const plan = (i.plan ?? {}) as Record<string, unknown>
  return {
    id: String(i._id),
    positionKey: i.positionKey,
    action: i.action,
    reason: i.reason,
    state: i.state,
    triggerBlockNumber: i.triggerBlockNumber,
    exposurePct: m(i.exposurePct as Types.Decimal128),
    positionValueQuote: m(i.positionValueQuote as Types.Decimal128),
    estimatedCostQuote: m(i.estimatedCostQuote as Types.Decimal128),
    expectedBenefitQuote: m(i.expectedBenefitQuote as Types.Decimal128),
    plan: {
      tickLower: plan.tickLower ?? null,
      tickUpper: plan.tickUpper ?? null,
      targetExposurePct: m(plan.targetExposurePct as Types.Decimal128),
      dropPct: m(plan.dropPct as Types.Decimal128),
      offsetPct: m(plan.offsetPct as Types.Decimal128),
      inRangeAtOpen: plan.inRangeAtOpen ?? null,
    },
    txHash: i.txHash ?? null,
    createdAt: i.createdAt,
    settledAt: i.settledAt ?? null,
  }
}

export function serializeNotification(n: Record<string, unknown>) {
  const delivery = (n.delivery ?? {}) as { state?: string }
  return {
    id: String(n._id),
    type: n.type,
    severity: n.severity,
    title: n.title,
    body: n.body,
    data: n.data,
    positionKey: n.positionKey,
    readAt: n.readAt,
    createdAt: n.createdAt,
    deliveryState: delivery.state ?? 'not_attempted',
  }
}
