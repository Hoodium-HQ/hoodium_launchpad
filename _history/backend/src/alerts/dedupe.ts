/**
 * Alert dedupe — T3.6 / AL-3.3.
 *
 * "The system SHALL NOT send an alert with the same `dedupeKey` more than once
 *  per 6 hours."
 *
 * Enforced by the database, not by a read-then-write. A conditional upsert whose
 * filter requires `lastSentAt` to be *older* than the window either:
 *
 *   - matches an aged-out document        → update it, send
 *   - matches nothing and the key is new  → insert, send
 *   - matches nothing because the key was sent recently → Mongo attempts an
 *     insert, the unique index on `dedupeKey` rejects it with E11000, and we
 *     treat that rejection as "already sent" — suppress
 *
 * The third case is the one that matters: two monitor workers racing on the same
 * position cannot both win, because the winner is decided by a unique index
 * rather than by a gap between a read and a write.
 */
import type { Types } from 'mongoose'
import { componentLogger } from '../lib/logger.js'
import { AlertModel, type Alert } from '../db/models/alert.js'
import { dispatchNotification } from '../notify/notifier.js'

const DUPLICATE_KEY = 11000

export interface RaiseAlertInput {
  chainId: number
  ownerAddress: string
  positionKey: string | null
  type: Alert['type']
  severity: Alert['severity']
  dedupeKey: string
  title: string
  body: string
  /** Money values arrive as strings; Decimal128 conversion happens in the model. */
  context: Record<string, unknown>
  dedupeHours: number
}

export interface RaiseAlertResult {
  sent: boolean
  suppressed: boolean
  alertId: Types.ObjectId | null
}

export async function raiseAlert(input: RaiseAlertInput): Promise<RaiseAlertResult> {
  const log = componentLogger('alerts')
  const now = new Date()
  const cutoff = new Date(now.getTime() - input.dedupeHours * 60 * 60 * 1000)

  try {
    const alert = await AlertModel.findOneAndUpdate(
      { dedupeKey: input.dedupeKey, lastSentAt: { $lte: cutoff } },
      {
        $set: {
          chainId: input.chainId,
          ownerAddress: input.ownerAddress,
          positionKey: input.positionKey,
          type: input.type,
          severity: input.severity,
          title: input.title,
          body: input.body,
          context: input.context,
          lastSentAt: now,
        },
        $setOnInsert: { firstSentAt: now },
        $inc: { sendCount: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )

    await dispatchNotification({
      chainId: input.chainId,
      ownerAddress: input.ownerAddress,
      alertId: alert._id,
      positionKey: input.positionKey,
      type: input.type,
      severity: input.severity,
      title: input.title,
      body: input.body,
      data: input.context,
    })

    log.info(
      { dedupeKey: input.dedupeKey, type: input.type, wallet: input.ownerAddress, sendCount: alert.sendCount },
      'alert raised',
    )
    return { sent: true, suppressed: false, alertId: alert._id }
  } catch (err) {
    if (isDuplicateKey(err)) {
      log.debug({ dedupeKey: input.dedupeKey }, 'alert suppressed — within the dedupe window (AL-3.3)')
      return { sent: false, suppressed: true, alertId: null }
    }
    throw err
  }
}

function isDuplicateKey(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; cause?: { code?: number }; codeName?: string }
  return e.code === DUPLICATE_KEY || e.cause?.code === DUPLICATE_KEY || e.codeName === 'DuplicateKey'
}
