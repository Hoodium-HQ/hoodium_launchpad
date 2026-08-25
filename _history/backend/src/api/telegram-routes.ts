/**
 * Telegram link lifecycle + bot webhook — T3.10 / AL-3.7, AL-3.8, AL-3.9.
 *
 * ── Access control ───────────────────────────────────────────────────────────
 * Every route that touches a link carries `requireSession`, and the address is
 * always taken from the session, never from the request. AL-3.8 requires proof of
 * control before a link is made: an address in the body would be the caller's to
 * choose, and choosing someone else's would redirect their position alerts.
 *
 * ── The webhook is not an API ────────────────────────────────────────────────
 * `/api/telegram/webhook` is public by necessity — Telegram calls it — and is
 * therefore the one unauthenticated write in this file. Three things contain it:
 *
 *   1. a secret header agreed with Telegram at registration, compared in
 *      constant time;
 *   2. it reads exactly one field of one update type (`/start` payloads) and
 *      drops everything else unread, which is AL-3.7 enforced at the door;
 *   3. the payload it acts on is a 256-bit single-use token that the caller must
 *      already possess.
 */
import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { componentLogger } from '../lib/logger.js'
import { requireSession } from './guard.js'
import {
  getTelegramLinkStatus,
  isTelegramConfigured,
  redeemTelegramLink,
  replyToChat,
  revokeTelegramLink,
  sendTelegramTest,
  setTelegramAlertType,
  startTelegramLink,
  telegramBotUsername,
} from '../notify/telegram.js'
import { renderQrDataUri } from '../lib/qr.js'
import type { Env } from '../config/env.js'

/**
 * Alert types the settings screen can mute (WA-6.5). Constrained to a known set
 * so the mute list cannot be used as unbounded user-controlled storage.
 */
const MUTABLE_TYPES = ['out_of_range', 'range_proximity', 'monitoring_degraded'] as const

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  // `timingSafeEqual` throws on a length mismatch, which would itself leak length.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export async function registerTelegramRoutes(app: FastifyInstance, deps: { env: Env }): Promise<void> {
  const { env } = deps
  const log = componentLogger('telegram-api')

  // ── Link lifecycle ─────────────────────────────────────────────────────────

  app.get('/api/telegram/status', { preHandler: requireSession }, async (request) => {
    const status = await getTelegramLinkStatus(request.session!.address)
    return {
      ...status,
      configured: isTelegramConfigured(),
      botUsername: telegramBotUsername(),
    }
  })

  /**
   * Mint a link token and return everything the dialog needs to render.
   *
   * The QR is rendered server-side and returned as a `data:` URI. The token is
   * already in this response, so drawing it here adds no exposure — and it keeps
   * a QR library out of the bundle that renders the trading surfaces.
   */
  app.post('/api/telegram/link', { preHandler: requireSession }, async (request, reply) => {
    if (!isTelegramConfigured()) {
      return reply.status(503).send({ error: 'telegram delivery is not configured' })
    }

    const result = await startTelegramLink({
      chainId: env.CHAIN_ID,
      ownerAddress: request.session!.address,
    })
    if (!result) return reply.status(503).send({ error: 'telegram delivery is not configured' })

    return {
      deepLink: result.deepLink,
      qrDataUri: await renderQrDataUri(result.deepLink),
      expiresAt: result.expiresAt.toISOString(),
    }
  })

  app.delete('/api/telegram/link', { preHandler: requireSession }, async (request) => {
    const revoked = await revokeTelegramLink(request.session!.address)
    return { linked: false, revoked }
  })

  app.post('/api/telegram/test', { preHandler: requireSession }, async (request, reply) => {
    const result = await sendTelegramTest(request.session!.address)
    if (result.state === 'no_link') return reply.status(409).send({ error: 'no telegram link', code: 'no_link' })
    if (result.state === 'sent') return { sent: true }
    return reply.status(502).send({ error: 'telegram did not accept the message', code: result.state })
  })

  app.post('/api/telegram/preferences', { preHandler: requireSession }, async (request, reply) => {
    const body = z
      .object({ type: z.enum(MUTABLE_TYPES), enabled: z.boolean() })
      .safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues })

    await setTelegramAlertType({
      ownerAddress: request.session!.address,
      type: body.data.type,
      enabled: body.data.enabled,
    })
    const status = await getTelegramLinkStatus(request.session!.address)
    return { mutedTypes: status.mutedTypes }
  })

  // ── Bot webhook ────────────────────────────────────────────────────────────

  /**
   * Only `message.text` matching `/start <token>` is read. Everything else —
   * commands, plain messages, edits, callbacks, channel posts — is acknowledged
   * and discarded, because AL-3.7 makes delivery one-way and a bot that answers
   * anything has become a second product surface.
   *
   * `.passthrough()` is deliberate: Telegram adds update fields over time, and a
   * strict schema would reject the whole update over a field we never read.
   */
  const UpdateSchema = z
    .object({
      message: z
        .object({
          text: z.string().optional(),
          chat: z.object({ id: z.union([z.number(), z.string()]) }).passthrough(),
          from: z.object({ username: z.string().optional() }).passthrough().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()

  app.post('/api/telegram/webhook', async (request, reply) => {
    if (!env.TELEGRAM_WEBHOOK_SECRET) return reply.status(404).send({ error: 'not found' })

    const presented = request.headers['x-telegram-bot-api-secret-token']
    if (typeof presented !== 'string' || !safeEqual(presented, env.TELEGRAM_WEBHOOK_SECRET)) {
      log.warn('rejected telegram webhook with a bad secret token')
      return reply.status(401).send({ error: 'unauthorized' })
    }

    const update = UpdateSchema.safeParse(request.body)
    // Always 200 to Telegram. A non-2xx makes it redeliver the same update on a
    // backoff, and an update we will never act on would retry indefinitely.
    if (!update.success) return { ok: true }

    const text = update.data.message?.text
    const chat = update.data.message?.chat
    if (!text || !chat) return { ok: true }

    const match = /^\/start\s+(\S{1,64})$/.exec(text.trim())
    const token = match?.[1]
    if (!token) {
      // Includes a bare `/start`. Someone who found the bot without a link has
      // nothing to do here, and telling them so is cheaper than silence.
      if (text.trim() === '/start') {
        void replyToChat(
          String(chat.id),
          'This bot only delivers Hoodium alerts. Connect it from Settings in the Hoodium web app.',
        )
      }
      return { ok: true }
    }

    const result = await redeemTelegramLink({
      token,
      chatId: String(chat.id),
      username: update.data.message?.from?.username ?? null,
    })

    if (result.ok) {
      void replyToChat(
        String(chat.id),
        '<b>Connected.</b>\n\nHoodium alerts will arrive here. You can disconnect at any time from ' +
          'Settings in the web app, or by blocking this bot.',
      )
      log.info('telegram link established')
      return { ok: true }
    }

    const message =
      result.reason === 'expired'
        ? 'That link code has expired. Open Settings in the Hoodium web app and start again.'
        : result.reason === 'already_used'
          ? 'That link code was already used. Open Settings in the Hoodium web app to generate a new one.'
          : 'That link code is not valid. Open Settings in the Hoodium web app to generate a new one.'

    void replyToChat(String(chat.id), message)
    return { ok: true }
  })
}
