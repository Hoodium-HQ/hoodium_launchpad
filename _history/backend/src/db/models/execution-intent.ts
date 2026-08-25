/**
 * Execution intents — T4.1 / design section 2, section 3.
 *
 * An intent is the Evaluator's output and the Executor's input. It exists so the
 * two can be tested apart: "decisions are testable without a chain, execution is
 * testable without business logic" (design section 1).
 *
 * `idempotencyKey` carries a unique index, and that index is the whole of AL-N5:
 *
 *   idempotencyKey = sha256(positionKey | action | triggerBlockNumber | thresholdVersion)
 *
 * The same trigger condition at the same block always derives the same key, so a
 * process that dies between deciding and broadcasting cannot decide twice — the
 * second insert is rejected by the database rather than by a lock someone has to
 * remember to take.
 *
 * ── Deviation from design section 2, deliberate ─────────────────────────────────────
 * The design names the money fields `estimatedCostUsd` / `expectedBenefitUsd`.
 * They are stored here in **quote-token units** and named accordingly. There is
 * no USD oracle in this system and AL-2.2 forbids inventing one; the quote token
 * is what every other figure (`valueQuote` on snapshots) is already denominated
 * in, and it is configurable (`QUOTE_TOKEN_SYMBOL`). Calling quote units "Usd"
 * would be a rounding error today and a wrong number the day someone points
 * `QUOTE_TOKEN_ADDRESS` at something that is not a dollar.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, blockNumber, chainId, hash32 } from '../fields.js'
import { money } from '../../lib/money.js'

export const INTENT_ACTIONS = ['exit', 'rebalance', 'collect', 'redeploy'] as const

/**
 * design section 3. `SKIPPED` is absent on purpose: a refused decision never becomes an
 * intent document, it becomes a `shadow_actions` row. An intent existing at all
 * means the cost guard approved it.
 */
export const INTENT_STATES = [
  'INTENT_CREATED',
  'SHADOW_LOGGED',
  'BUILDING',
  'SIGNING',
  'BROADCAST',
  'CONFIRMED',
  'RETRYING',
  'FAILED_FINAL',
] as const

export type IntentState = (typeof INTENT_STATES)[number]

/** States from which nothing further will happen. */
export const TERMINAL_INTENT_STATES: readonly IntentState[] = ['SHADOW_LOGGED', 'CONFIRMED', 'FAILED_FINAL']

/** The replacement range the Executor is expected to open (design section 6, R6). */
const PlanSchema = new Schema(
  {
    tickLower: { type: Number, required: true },
    tickUpper: { type: Number, required: true },
    /** Exposure the replacement opens at, 0–100 — the target the benefit is measured against. */
    targetExposurePct: money({ required: true }),
    dropPct: money({ required: true }),
    offsetPct: money({ required: true }),
    inRangeAtOpen: { type: Boolean, required: true },
  },
  { _id: false },
)

const ExecutionIntentSchema = new Schema(
  {
    chainId,
    /** Denormalised from the position so intents can be listed per wallet. */
    ownerAddress: address({ required: true }),
    /** `positionKey()` — chainId:positionManager:tokenId (design section 2). */
    positionKey: { type: String, required: true },

    idempotencyKey: { type: String, required: true },
    action: { type: String, enum: INTENT_ACTIONS, required: true },
    /** Machine-readable trigger, e.g. `threshold_breached`. */
    reason: { type: String, required: true },

    state: { type: String, enum: INTENT_STATES, default: 'INTENT_CREATED', required: true },

    /** The block the decision was taken against — half of the idempotency key. */
    triggerBlockNumber: blockNumber({ required: true }),
    exposurePct: money({ required: true }),
    positionValueQuote: money({ required: true }),
    estimatedCostQuote: money({ required: true }),
    expectedBenefitQuote: money({ required: true }),

    plan: { type: PlanSchema, required: true },

    /** AL-4.4 — 5 attempts, exponential backoff from 15 minutes. Phase 5 writes these. */
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },

    // Explicitly null until something broadcasts, rather than absent: "no
    // transaction was sent" is a fact about this intent, not a missing field.
    txHash: { ...hash32(), default: null },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'execution_intents' },
)

// AL-4.3 / AL-N5 — the constraint the whole no-duplicate-transaction story rests on.
ExecutionIntentSchema.index({ idempotencyKey: 1 }, { unique: true })
// The Executor's work queue (design section 2).
ExecutionIntentSchema.index({ state: 1, nextAttemptAt: 1 })
ExecutionIntentSchema.index({ ownerAddress: 1, createdAt: -1 })
ExecutionIntentSchema.index({ positionKey: 1, createdAt: -1 })

export type ExecutionIntent = InferSchemaType<typeof ExecutionIntentSchema>
export type ExecutionIntentDoc = HydratedDocument<ExecutionIntent>
export const ExecutionIntentModel = model('ExecutionIntent', ExecutionIntentSchema)
