/**
 * Notification store — T3.7 / AL-3.5, AL-3.6.
 *
 * In-app is the primary channel; Telegram is an additional delivery of the same
 * record. AL-3.6 constrains the *ordering*, not the channel list: this row is
 * written and durable before any external send is attempted, so a Telegram
 * outage costs reach and never the alert itself.
 *
 * `delivery` records what happened on the external leg. It is diagnostic — the
 * alert is already delivered by the time anything is written to it.
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'
import { address, chainId } from '../fields.js'

export const NOTIFICATION_CHANNELS = ['in_app', 'telegram'] as const

/**
 * `no_link` and `muted` are not failures. The first means the user never linked
 * Telegram, the second that they turned this alert type off (WA-6.5); both are
 * the system working as configured, and neither should read as an error.
 */
export const DELIVERY_STATES = [
  'not_attempted',
  'sent',
  'no_link',
  'muted',
  'failed',
] as const

const NotificationSchema = new Schema(
  {
    chainId,
    ownerAddress: address({ required: true }),
    alertId: { type: Schema.Types.ObjectId, ref: 'Alert', default: null },
    positionKey: { type: String, default: null },

    type: { type: String, required: true },
    severity: { type: String, default: 'info' },
    title: { type: String, required: true },
    body: { type: String, required: true },
    /** Arbitrary render payload for the web app; money values arrive as strings. */
    data: { type: Schema.Types.Mixed, default: {} },

    readAt: { type: Date, default: null },

    delivery: {
      state: { type: String, enum: DELIVERY_STATES, default: 'not_attempted' },
      attemptedAt: { type: Date, default: null },
      deliveredCount: { type: Number, default: 0 },
      error: { type: String, default: null },
    },
  },
  { timestamps: true, collection: 'notifications' },
)

// The web app's inbox query.
NotificationSchema.index({ ownerAddress: 1, createdAt: -1 })
NotificationSchema.index({ ownerAddress: 1, readAt: 1, createdAt: -1 })

export type Notification = InferSchemaType<typeof NotificationSchema>
export type NotificationDoc = HydratedDocument<Notification>
export const NotificationModel = model('Notification', NotificationSchema)
