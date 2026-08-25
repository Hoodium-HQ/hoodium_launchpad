/**
 * Alerts — T3.5, T3.6 / AL-3.1, AL-3.2, AL-3.3.
 *
 * `dedupeKey` carries a unique index. AL-3.3 ("not more than once per 6 hours")
 * is enforced by combining that index with a conditional upsert: the filter only
 * matches a document whose `lastSentAt` is older than the window, so a duplicate
 * inside the window falls through to an insert and is rejected by the index.
 * See alerts/dedupe.ts — the race is resolved by the database, not by a read-then-write.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, chainId } from '../fields.js'
import { money } from '../../lib/money.js'

export const ALERT_TYPES = [
  'range_proximity', // AL-3.1
  'out_of_range', // AL-3.2
  'monitoring_degraded', // AL-2.5
  'rebalance_shadow', // AL-3.4 — what the system would have done
] as const

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const

const AlertSchema = new Schema(
  {
    chainId,
    ownerAddress: address({ required: true }),
    positionKey: { type: String, default: null },

    type: { type: String, enum: ALERT_TYPES, required: true },
    severity: { type: String, enum: ALERT_SEVERITIES, default: 'warning' },

    /** Stable identity of "this alert about this thing" (AL-3.3). */
    dedupeKey: { type: String, required: true },

    title: { type: String, required: true },
    body: { type: String, required: true },

    /** Structured payload the web app renders; % values are Decimal128. */
    context: {
      exposurePct: money(),
      distancePct: money(),
      price: money(),
      tickCurrent: { type: Number, default: null },
      tickLower: { type: Number, default: null },
      tickUpper: { type: Number, default: null },
      boundary: { type: String, enum: ['lower', 'upper', null], default: null },

      /**
       * Set only on `rebalance_shadow` (AL-3.4). The web app renders the range
       * the system would have opened next to the one the position is in, which
       * is the comparison the user is being asked to judge (AL-5.6).
       */
      decision: { type: String, default: null },
      reason: { type: String, default: null },
      targetTickLower: { type: Number, default: null },
      targetTickUpper: { type: Number, default: null },
      targetExposurePct: money(),
      estimatedCostQuote: money(),
      expectedBenefitQuote: money(),
      shadow: { type: Boolean, default: null },
    },

    firstSentAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
    /** How many times this alert has recurred after passing the window. */
    sendCount: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'alerts' },
)

// AL-3.3 — the constraint the dedupe strategy rests on.
AlertSchema.index({ dedupeKey: 1 }, { unique: true })
AlertSchema.index({ ownerAddress: 1, lastSentAt: -1 })
AlertSchema.index({ positionKey: 1, type: 1 })

export type Alert = InferSchemaType<typeof AlertSchema>
export type AlertDoc = HydratedDocument<Alert>
export const AlertModel = model('Alert', AlertSchema)
