/**
 * Shadow actions — T4.4 / AL-5.5.
 *
 * "WHILE shadow mode is active the system SHALL record every decision to
 *  `shadow_actions` without broadcasting a transaction."
 *
 * design section 6 is more specific about *which* decisions matter: "every decision —
 * including refusals — is written to `shadow_actions`. Refusals are the data that
 * proves the guard is worth having, so they matter as much as the executions."
 *
 * ── Why this collection is deduped ───────────────────────────────────────────
 * The Monitor evaluates every open position once a minute (AL-2.1). A position
 * parked above the threshold inside its 4-hour cooldown would otherwise write
 * 1,440 identical "skipped: cooldown" rows a day, and the refusal data that
 * design section 6 wants would be buried in its own repetition.
 *
 * So identical decisions collapse: `dedupeKey` is unique, and a repeat inside the
 * window increments `occurrences` and moves `lastAt` instead of inserting. The
 * record is still complete — how many times a decision was reached and over what
 * span is preserved — it is just not one row per minute. The mechanism is the
 * conditional upsert from `alerts/dedupe.ts`, for the same reason: the race
 * between two workers is settled by a unique index, not by a read-then-write.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId } from '../fields.js'
import { money } from '../../lib/money.js'
import { INTENT_ACTIONS } from './execution-intent.js'

export const SHADOW_DECISIONS = ['execute', 'skip'] as const

/**
 * Every reason the Evaluator can reach, as a closed set — free-text reasons
 * cannot be counted, and counting refusals is the entire point of the collection.
 */
export const SHADOW_REASONS = [
  // decision: 'execute'
  'threshold_breached', // AL-4.1
  'emergency_threshold', // AL-5.3, cooldown overridden
  // decision: 'skip'
  'cost_exceeds_benefit', // AL-5.2
  'cooldown', // AL-5.3
  'no_exposure_reduction', // the replacement range would be no better than the current one
  'kill_switch', // AL-N8
  'execution_suspended', // AL-2.5 — degraded reads
  'unknown_tick_spacing', // cannot align a range without it
  'plan_failed', // range math refused the inputs
] as const

const ShadowActionSchema = new Schema(
  {
    chainId,
    ownerAddress: address({ required: true }),
    positionKey: { type: String, required: true },

    action: { type: String, enum: INTENT_ACTIONS, required: true },
    decision: { type: String, enum: SHADOW_DECISIONS, required: true },
    reason: { type: String, enum: SHADOW_REASONS, required: true },

    /** Identity of "this decision about this position for this reason". */
    dedupeKey: { type: String, required: true },

    triggerBlockNumber: blockNumber({ required: true }),
    exposurePct: money({ required: true }),
    thresholdPct: money({ required: true }),
    positionValueQuote: money({ required: true }),
    estimatedCostQuote: money(),
    expectedBenefitQuote: money(),

    /** Null when the decision was reached before a range could be planned. */
    plan: {
      tickLower: { type: Number, default: null },
      tickUpper: { type: Number, default: null },
      targetExposurePct: money(),
      inRangeAtOpen: { type: Boolean, default: null },
    },

    /** Set only on `execute` — the intent this decision produced. */
    intentId: { type: Schema.Types.ObjectId, ref: 'ExecutionIntent', default: null },

    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
    occurrences: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'shadow_actions' },
)

ShadowActionSchema.index({ dedupeKey: 1 }, { unique: true })
// The comparison report (AL-5.6, T4.6) reads by wallet over a window.
ShadowActionSchema.index({ ownerAddress: 1, lastAt: -1 })
ShadowActionSchema.index({ positionKey: 1, lastAt: -1 })
// "How often did the guard refuse, and why" — the question design section 6 exists to answer.
ShadowActionSchema.index({ chainId: 1, decision: 1, reason: 1, lastAt: -1 })

export type ShadowAction = InferSchemaType<typeof ShadowActionSchema>
export type ShadowActionDoc = HydratedDocument<ShadowAction>
export type ShadowReason = (typeof SHADOW_REASONS)[number]
export type ShadowDecision = (typeof SHADOW_DECISIONS)[number]
export const ShadowActionModel = model('ShadowAction', ShadowActionSchema)
