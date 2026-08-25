/**
 * Notifier — T3.7 / AL-3.5, AL-3.6.
 *
 * "Alerts SHALL be delivered in-app; IF the user has linked a Telegram account
 *  THEN they SHALL also be delivered to it."
 * "In-app delivery SHALL NOT depend on any third-party messaging platform: the
 *  notification record SHALL be persisted before any external send is attempted,
 *  and an external failure SHALL NOT fail or delay the alert."
 *
 * That ordering is the whole design. The row is written first and durably; the
 * Telegram send is a best-effort echo whose outcome is recorded *on* the row.
 * A Telegram outage costs reach, never the alert.
 */
import type { Types } from 'mongoose'
import { componentLogger } from '../lib/logger.js'
import { NotificationModel } from '../db/models/notification.js'
import {
  escapeHtml,
  sendTelegramAlert,
  telegramAppOrigin,
  type TelegramMessage,
} from './telegram.js'

export interface DispatchInput {
  chainId: number
  ownerAddress: string
  alertId?: Types.ObjectId | null
  positionKey: string | null
  type: string
  severity: string
  title: string
  body: string
  data?: Record<string, unknown>
}

/**
 * Severity as a glyph. In a Telegram chat list an alert is one line of preview
 * text among dozens of conversations, and this is the only part of it that reads
 * at a glance — the equivalent of the icon the notification tray used to draw.
 */
const SEVERITY_MARK: Record<string, string> = {
  critical: '🔴',
  warning: '🟠',
  info: '🔵',
}

export function formatTelegramAlert(input: {
  severity: string
  title: string
  body: string
  positionKey: string | null
  /** Defaults to the configured origin; a parameter so the format is testable. */
  appOrigin?: string
}): TelegramMessage {
  const mark = SEVERITY_MARK[input.severity] ?? SEVERITY_MARK.info

  // Everything interpolated is escaped. Titles and bodies carry token symbols,
  // which are chosen by whoever deployed the token — `parse_mode: HTML` would
  // otherwise let a symbol like `<b>` reshape the message.
  const html = `${mark} <b>${escapeHtml(input.title)}</b>\n\n${escapeHtml(input.body)}`

  const origin = (input.appOrigin ?? telegramAppOrigin()).replace(/\/$/, '')
  const link = input.positionKey
    ? { text: 'Open position', url: `${origin}/positions/${encodeURIComponent(input.positionKey)}` }
    : { text: 'Open Hoodium', url: origin }

  return { html, link }
}

export async function dispatchNotification(input: DispatchInput): Promise<Types.ObjectId> {
  const log = componentLogger('notifier')

  // 1. In-app, always, and durably before anything external is attempted.
  const notification = await NotificationModel.create({
    chainId: input.chainId,
    ownerAddress: input.ownerAddress,
    alertId: input.alertId ?? null,
    positionKey: input.positionKey,
    type: input.type,
    severity: input.severity,
    title: input.title,
    body: input.body,
    data: input.data ?? {},
  })

  // 2. Telegram, where the user linked an account and did not mute this type.
  //    Failure here is recorded on the notification and never propagates — the
  //    alert is already delivered.
  try {
    const result = await sendTelegramAlert({
      ownerAddress: input.ownerAddress,
      type: input.type,
      message: formatTelegramAlert({
        severity: input.severity,
        title: input.title,
        body: input.body,
        positionKey: input.positionKey,
      }),
    })

    await NotificationModel.updateOne(
      { _id: notification._id },
      {
        $set: {
          'delivery.state': result.state,
          'delivery.attemptedAt': new Date(),
          'delivery.deliveredCount': result.delivered,
          'delivery.error': result.error ?? null,
        },
      },
    )
  } catch (err) {
    log.error({ err, notificationId: notification._id.toString() }, 'telegram dispatch failed')
    await NotificationModel.updateOne(
      { _id: notification._id },
      { $set: { 'delivery.state': 'failed', 'delivery.attemptedAt': new Date(), 'delivery.error': String(err) } },
    )
  }

  return notification._id
}
