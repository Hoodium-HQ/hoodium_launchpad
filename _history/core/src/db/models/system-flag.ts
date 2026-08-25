/**
 * System flags — T1.5 / AL-N8.
 *
 * "A global kill switch SHALL halt execution for all users within 10 seconds."
 *
 * A flag document polled every 5 seconds, chosen over a signal or a restart
 * because it must work without shell access (design section 7).
 */
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose'

export const KILL_SWITCH_KEY = 'kill_switch'

const SystemFlagSchema = new Schema(
  {
    key: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: false },
    reason: { type: String, default: null },
    setBy: { type: String, default: null },
  },
  { timestamps: true, collection: 'system_flags' },
)

SystemFlagSchema.index({ key: 1 }, { unique: true })

export type SystemFlag = InferSchemaType<typeof SystemFlagSchema>
export type SystemFlagDoc = HydratedDocument<SystemFlag>
export const SystemFlagModel = model('SystemFlag', SystemFlagSchema)
