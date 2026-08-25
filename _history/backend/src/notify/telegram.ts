/**
 * Telegram delivery — T3.9, T3.10 / AL-3.5, AL-3.7, AL-3.8, AL-3.9.
 *
 * The external leg of alert delivery, and the only third party in the alert path.
 * Three rules from the spec shape everything here:
 *
 *   AL-3.7  one-way. Nothing in this module reads a user message, dispatches a
 *           command, or answers a query. `/start` is handled solely to redeem a
 *           link token, and every other update is dropped unread.
 *   AL-3.9  a recipient Telegram reports as unreachable is deactivated, not
 *           retried. Retrying a blocked chat on every alert forever is how a bot
 *           earns a platform-level rate penalty.
 *   AL-3.6  nothing here may fail an alert. The notification row is already
 *           durable before this module is called; every path returns a state
 *           rather than throwing.
 *
 * The bot token is a server-side credential with no public half — unlike the
 * VAPID keypair this replaces, there is nothing here that may reach the browser.
 */
import { componentLogger } from '../lib/logger.js'
import {
  TelegramLinkModel,
  TelegramLinkTokenModel,
  generateLinkToken,
  hashLinkToken,
} from '../db/models/telegram-link.js'

const API_BASE = 'https://api.telegram.org'

/** Single-use, and short: a link token redirects alerts if it leaks (AL-3.8). */
const TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * Telegram tolerates roughly 30 messages/second across a bot and one per second
 * to any single chat. Both are pace limits, not quotas — exceeding them yields a
 * `429` with `retry_after` rather than a ban.
 *
 * We aim at 25/s to leave headroom for the link-flow calls that share the budget.
 */
const GLOBAL_MIN_GAP_MS = 1000 / 25
const PER_CHAT_MIN_GAP_MS = 1000
/** One retry. A second `429` means we are structurally over budget, not unlucky. */
const MAX_RETRY_AFTER_MS = 30_000

interface TelegramConfig {
  botToken?: string
  botUsername?: string
  appOrigin: string
}

let config: TelegramConfig | null = null

export function initTelegram(cfg: TelegramConfig): void {
  const log = componentLogger('telegram')
  if (!cfg.botToken || !cfg.botUsername) {
    // Config validation requires both in staging/production (004 section 9), so
    // this branch is local-only. Alerts stay in-app, which is the guaranteed
    // channel anyway (AL-3.5).
    log.warn('bot token absent — Telegram delivery disabled, alerts remain in-app (AL-3.5)')
    config = null
    return
  }
  config = cfg
  log.info({ bot: cfg.botUsername }, 'telegram delivery configured')
}

export function isTelegramConfigured(): boolean {
  return config !== null
}

export function telegramBotUsername(): string | null {
  return config?.botUsername ?? null
}

/**
 * The origin alert links point at (WA-6.4). Read from here rather than threaded
 * through every caller of the notifier: `APP_ORIGIN` is already a security
 * parameter fixed at boot, and two places deriving it independently is how they
 * come to disagree.
 */
export function telegramAppOrigin(): string {
  return config?.appOrigin ?? ''
}

/** Test seam — installs a config without a real token. */
export function setTelegramConfigForTesting(cfg: TelegramConfig | null): void {
  config = cfg
}

// ── Pacing ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * Sends are serialised through one promise chain. That makes both pace limits
 * trivially correct — there is no window in which two sends race on the same
 * counter — at the cost of a per-chat wait briefly stalling other chats.
 *
 * That cost is acceptable at this volume: dedupe (AL-3.3) keeps repeat alerts to
 * one per key per six hours, so consecutive sends to the same chat are rare. If
 * alert volume ever makes it visible, the fix is a per-chat queue rather than a
 * bigger global one.
 */
let queueTail: Promise<unknown> = Promise.resolve()
let nextGlobalSlot = 0
const nextChatSlot = new Map<string, number>()

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn, fn)
  // Swallow on the tail only. The caller still sees its own rejection.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function waitForSlot(chatId: string): Promise<void> {
  const now = Date.now()
  const readyAt = Math.max(now, nextGlobalSlot, nextChatSlot.get(chatId) ?? 0)
  if (readyAt > now) await sleep(readyAt - now)

  const sentAt = Math.max(Date.now(), readyAt)
  nextGlobalSlot = sentAt + GLOBAL_MIN_GAP_MS
  nextChatSlot.set(chatId, sentAt + PER_CHAT_MIN_GAP_MS)

  // The map would otherwise grow once per chat forever. Anything already past
  // its slot cannot constrain a future send.
  if (nextChatSlot.size > 5_000) {
    const cutoff = Date.now()
    for (const [id, slot] of nextChatSlot) if (slot <= cutoff) nextChatSlot.delete(id)
  }
}

// ── Bot API ──────────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

async function callApi<T>(method: string, body: unknown): Promise<ApiResponse<T>> {
  if (!config?.botToken) return { ok: false, error_code: 0, description: 'telegram not configured' }

  const response = await fetch(`${API_BASE}/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })

  // Telegram reports application errors in the body with a non-2xx status. A
  // body that will not parse is a gateway or proxy failure, not an API answer.
  try {
    return (await response.json()) as ApiResponse<T>
  } catch {
    return { ok: false, error_code: response.status, description: 'unparseable response from telegram' }
  }
}

/**
 * `403` means the recipient is gone for good: blocked, deactivated, or the chat
 * deleted. `400 chat not found` is the same condition reported differently.
 *
 * Distinguished from transient failures because these are the only ones that
 * deactivate a link (AL-3.9) — treating a timeout that way would silently
 * unsubscribe users over a network blip.
 */
export function terminalReason(res: {
  error_code?: number
  description?: string
}): 'blocked' | 'chat_deleted' | null {
  const description = (res.description ?? '').toLowerCase()
  if (res.error_code === 403) {
    if (description.includes('deactivated')) return 'chat_deleted'
    return 'blocked'
  }
  if (res.error_code === 400 && description.includes('chat not found')) return 'chat_deleted'
  return null
}

/** HTML escaping. Token symbols come off-chain and are attacker-chosen strings. */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export interface TelegramMessage {
  /** Already-escaped HTML. Use `escapeHtml` on anything interpolated. */
  html: string
  /** WA-6.4 — the alert links back to what it concerns. */
  link?: { text: string; url: string } | null
}

interface SendOutcome {
  ok: boolean
  terminal: 'blocked' | 'chat_deleted' | null
  error?: string
}

async function sendToChat(chatId: string, message: TelegramMessage): Promise<SendOutcome> {
  const payload = {
    chat_id: chatId,
    text: message.html,
    parse_mode: 'HTML',
    // The link is a button; a second inline preview of the same URL is noise.
    link_preview_options: { is_disabled: true },
    ...(message.link
      ? { reply_markup: { inline_keyboard: [[{ text: message.link.text, url: message.link.url }]] } }
      : {}),
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForSlot(chatId)

    let res: ApiResponse<unknown>
    try {
      res = await callApi('sendMessage', payload)
    } catch (err) {
      // Network or timeout. Transient by definition — never deactivates a link.
      return { ok: false, terminal: null, error: err instanceof Error ? err.message : 'network error' }
    }

    if (res.ok) return { ok: true, terminal: null }

    const terminal = terminalReason(res)
    if (terminal) return { ok: false, terminal, error: res.description }

    const retryAfterMs = (res.parameters?.retry_after ?? 0) * 1000
    if (retryAfterMs > 0 && attempt === 0) {
      if (retryAfterMs > MAX_RETRY_AFTER_MS) {
        return { ok: false, terminal: null, error: `rate limited for ${retryAfterMs}ms — giving up` }
      }
      // Hold the whole queue, not just this chat: a 429 is a statement about the
      // bot's global budget, so letting other sends through would deepen it.
      nextGlobalSlot = Date.now() + retryAfterMs
      continue
    }

    return { ok: false, terminal: null, error: res.description ?? `error ${res.error_code}` }
  }

  return { ok: false, terminal: null, error: 'retry exhausted' }
}

async function deactivate(
  linkId: unknown,
  reason: 'blocked' | 'chat_deleted' | 'revoked',
): Promise<void> {
  await TelegramLinkModel.updateOne(
    { _id: linkId },
    { $set: { inactiveAt: new Date(), inactiveReason: reason } },
  )
}

export interface DeliveryResult {
  state: 'sent' | 'no_link' | 'muted' | 'failed' | 'not_attempted'
  delivered: number
  error?: string
}

/**
 * Deliver one alert to every active link for an address.
 *
 * Never throws: the caller has already delivered the alert in-app, and an
 * exception escaping here would turn a reach problem into a lost alert (AL-3.6).
 */
export async function sendTelegramAlert(input: {
  ownerAddress: string
  /** Alert type, checked against each link's mute list (WA-6.5). */
  type?: string
  message: TelegramMessage
}): Promise<DeliveryResult> {
  const log = componentLogger('telegram')
  if (!config) return { state: 'not_attempted', delivered: 0 }

  const links = await TelegramLinkModel.find({
    ownerAddress: input.ownerAddress.toLowerCase(),
    inactiveAt: null,
  })
  if (links.length === 0) return { state: 'no_link', delivered: 0 }

  const wanted = input.type
    ? links.filter((link) => !link.mutedTypes.includes(input.type as string))
    : links
  // Every link muted this type. Reported distinctly from a failure — the system
  // did exactly what the user configured.
  if (wanted.length === 0) return { state: 'muted', delivered: 0 }

  let delivered = 0
  let lastError: string | undefined

  for (const link of wanted) {
    const outcome = await enqueue(() => sendToChat(link.chatId, input.message))

    if (outcome.ok) {
      delivered++
      await TelegramLinkModel.updateOne(
        { _id: link._id },
        { $set: { lastSuccessAt: new Date(), failureCount: 0 } },
      )
      continue
    }

    lastError = outcome.error

    if (outcome.terminal) {
      await deactivate(link._id, outcome.terminal)
      log.info({ reason: outcome.terminal }, 'telegram link deactivated — recipient unreachable (AL-3.9)')
    } else {
      await TelegramLinkModel.updateOne(
        { _id: link._id },
        { $set: { lastFailureAt: new Date() }, $inc: { failureCount: 1 } },
      )
      log.warn({ error: outcome.error }, 'telegram delivery failed')
    }
  }

  if (delivered > 0) return { state: 'sent', delivered }
  return { state: 'failed', delivered: 0, error: lastError }
}

/** The "Send test" button in settings. Same path as a real alert, by design. */
export async function sendTelegramTest(ownerAddress: string): Promise<DeliveryResult> {
  return sendTelegramAlert({
    ownerAddress,
    message: {
      html:
        '<b>Test alert</b>\n\nTelegram delivery is working. Real alerts look like this and ' +
        'link straight to the position they concern.',
      link: config ? { text: 'Open Hoodium', url: config.appOrigin } : null,
    },
  })
}

// ── Link lifecycle (AL-3.8) ──────────────────────────────────────────────────

export interface LinkStartResult {
  token: string
  deepLink: string
  expiresAt: Date
}

/**
 * Mint a single-use link token for an address whose control is already proven.
 *
 * Any earlier unconsumed token for the address is dropped: a user who reopens
 * the dialog expects the previous QR code to stop working, and leaving a trail of
 * live tokens multiplies the window in which one can be stolen.
 */
export async function startTelegramLink(input: {
  chainId: number
  ownerAddress: string
}): Promise<LinkStartResult | null> {
  if (!config?.botUsername) return null

  const owner = input.ownerAddress.toLowerCase()
  await TelegramLinkTokenModel.deleteMany({ ownerAddress: owner, consumedAt: null })

  const token = generateLinkToken()
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS)

  await TelegramLinkTokenModel.create({
    chainId: input.chainId,
    ownerAddress: owner,
    tokenHash: hashLinkToken(token),
    expiresAt,
  })

  return {
    token,
    deepLink: `https://t.me/${config.botUsername}?start=${token}`,
    expiresAt,
  }
}

export type RedeemResult =
  | { ok: true; ownerAddress: string }
  | { ok: false; reason: 'unknown_token' | 'expired' | 'already_used' }

/**
 * Redeem a token presented through `/start`. Called only from the bot webhook.
 *
 * The consume is a conditional update rather than a read-then-write: two `/start`
 * taps arriving together would otherwise both pass the check and create two
 * links. `modifiedCount` is the arbiter — exactly one caller sees 1.
 */
export async function redeemTelegramLink(input: {
  token: string
  chatId: string
  username?: string | null
}): Promise<RedeemResult> {
  const tokenHash = hashLinkToken(input.token)
  const now = new Date()

  const claim = await TelegramLinkTokenModel.updateOne(
    { tokenHash, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now, consumedByChatId: input.chatId } },
  )

  if (claim.modifiedCount !== 1) {
    // Distinguish the cases for the message the user sees, but only from the
    // token row — never reveal whether an unknown token merely expired.
    const existing = await TelegramLinkTokenModel.findOne({ tokenHash })
    if (!existing) return { ok: false, reason: 'unknown_token' }
    if (existing.consumedAt) return { ok: false, reason: 'already_used' }
    return { ok: false, reason: 'expired' }
  }

  const record = await TelegramLinkTokenModel.findOne({ tokenHash })
  if (!record) return { ok: false, reason: 'unknown_token' }

  /*
   * Alert preferences are the user's, not the link's — a relink must not
   * resurrect a type they turned off. The upsert below writes a fresh row when
   * the previous link was revoked or blocked, so the previous choice is carried
   * across explicitly rather than being silently reset to "everything on".
   */
  const previous = await TelegramLinkModel.findOne({
    chainId: record.chainId,
    ownerAddress: record.ownerAddress,
  }).sort({ updatedAt: -1 })

  /*
   * Upsert against the partial unique index on active links. Relinking after a
   * block must revive the row rather than collide with it, so the inactive
   * fields are explicitly cleared here.
   *
   * `mutedTypes` goes in `$setOnInsert`: an existing active link keeps the
   * preferences it already has, and only a newly created row inherits them.
   */
  await TelegramLinkModel.findOneAndUpdate(
    { chainId: record.chainId, ownerAddress: record.ownerAddress, inactiveAt: null },
    {
      $set: {
        chatId: input.chatId,
        username: input.username ?? null,
        linkedAt: now,
        inactiveAt: null,
        inactiveReason: null,
        failureCount: 0,
      },
      $setOnInsert: { mutedTypes: previous?.mutedTypes ?? [] },
    },
    { upsert: true, new: true },
  )

  return { ok: true, ownerAddress: record.ownerAddress }
}

export interface LinkStatus {
  linked: boolean
  username: string | null
  linkedAt: Date | null
  lastSuccessAt: Date | null
  inactiveReason: string | null
  mutedTypes: string[]
}

/**
 * Status for the settings screen and the linking dialog's poll.
 *
 * When there is no active link, the most recent inactive one is returned so the
 * app can say *why* delivery stopped (WA-6.9) rather than showing a bare
 * "not connected" to someone who did connect and was then blocked.
 */
export async function getTelegramLinkStatus(ownerAddress: string): Promise<LinkStatus> {
  const owner = ownerAddress.toLowerCase()

  const active = await TelegramLinkModel.findOne({ ownerAddress: owner, inactiveAt: null })
  if (active) {
    return {
      linked: true,
      username: active.username ?? null,
      linkedAt: active.linkedAt ?? null,
      lastSuccessAt: active.lastSuccessAt ?? null,
      inactiveReason: null,
      mutedTypes: active.mutedTypes ?? [],
    }
  }

  const lapsed = await TelegramLinkModel.findOne({ ownerAddress: owner, inactiveAt: { $ne: null } }).sort({
    inactiveAt: -1,
  })

  return {
    linked: false,
    username: lapsed?.username ?? null,
    linkedAt: lapsed?.linkedAt ?? null,
    lastSuccessAt: lapsed?.lastSuccessAt ?? null,
    // A revoked link is a completed user intent, not a fault worth reporting back.
    inactiveReason: lapsed && lapsed.inactiveReason !== 'revoked' ? (lapsed.inactiveReason ?? null) : null,
    // Preferences survive a lapse, so relinking does not silently re-enable
    // alert types the user had turned off.
    mutedTypes: lapsed?.mutedTypes ?? [],
  }
}

/** User-initiated disconnect. Scoped by owner so one user cannot revoke another's. */
export async function revokeTelegramLink(ownerAddress: string): Promise<boolean> {
  const result = await TelegramLinkModel.updateOne(
    { ownerAddress: ownerAddress.toLowerCase(), inactiveAt: null },
    { $set: { inactiveAt: new Date(), inactiveReason: 'revoked' } },
  )
  return result.modifiedCount > 0
}

/**
 * WA-6.5 — turn one alert type on or off for an address's links.
 *
 * Applied to inactive rows too: preferences are the user's, not the link's, and
 * a relink should not resurrect a type they had muted.
 */
export async function setTelegramAlertType(input: {
  ownerAddress: string
  type: string
  enabled: boolean
}): Promise<void> {
  const filter = { ownerAddress: input.ownerAddress.toLowerCase() }
  await TelegramLinkModel.updateMany(
    filter,
    input.enabled ? { $pull: { mutedTypes: input.type } } : { $addToSet: { mutedTypes: input.type } },
  )
}

/**
 * Reply to `/start`, so a user who scans an expired QR is told why nothing
 * happened. Best-effort and unawaited by the caller: the link already exists or
 * does not, and this changes neither.
 */
export async function replyToChat(chatId: string, html: string): Promise<void> {
  try {
    await enqueue(() => sendToChat(chatId, { html }))
  } catch {
    // A failed confirmation is not worth surfacing; the web app polls the real state.
  }
}
