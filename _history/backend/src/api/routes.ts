/**
 * HTTP surface consumed by the web app (spec 003).
 *
 * Read-only product scope: register a wallet, list its positions, read snapshots
 * and notifications. Nothing here can move funds — there is no signing path in
 * phases 1–3 at all.
 *
 * ── Access control (WA-1.6) ──────────────────────────────────────────────────
 * Every address-scoped read carries `requireAddressOwner`: the caller must hold a
 * session proving control of the address in the route. `POST /api/wallets` is
 * deliberately open — AL-1.1 forbids requiring a credential to *register*, and
 * registration is a public, watch-only act. Retrieval is not.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { PositionModel } from '../db/models/position.js'
import { PositionSnapshotModel } from '../db/models/position-snapshot.js'
import { NotificationModel } from '../db/models/notification.js'
import { WalletModel } from '../db/models/wallet.js'
import { ShadowActionModel } from '../db/models/shadow-action.js'
import { ExecutionIntentModel } from '../db/models/execution-intent.js'
import {
  serializeIntent,
  serializeNotification,
  serializePosition,
  serializeShadowAction,
  serializeSnapshot,
} from './serialize.js'
import { componentLogger } from '../lib/logger.js'
import type { Env } from '../config/env.js'
import type { PositionDiscovery } from '../positions/discovery.js'
import type { ChainClient } from '../chain/rpc.js'
import { killSwitch } from '../lib/kill-switch.js'
import { requireAddressOwner, requireSession } from './guard.js'

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((s) => s.toLowerCase())

export interface RouteDeps {
  env: Env
  chain: ChainClient
  discovery: PositionDiscovery
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { env, chain, discovery } = deps
  const log = componentLogger('api')

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    appEnv: env.APP_ENV,
    chainId: env.CHAIN_ID,
    rpcEndpoint: chain.activeEndpoint(),
    killSwitch: { engaged: killSwitch().isEngaged(), reason: killSwitch().getReason() },
  }))

  // ── Wallets ───────────────────────────────────────────────────────────────

  /**
   * AL-1.1 — register in watch-only mode, request no credential. The body takes
   * an address and an optional label; there is no field here for anything else,
   * and AL-1.6 means there never will be.
   */
  app.post('/api/wallets', async (request, reply) => {
    const body = z.object({ address: addressSchema, label: z.string().max(64).optional() }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues })

    const { address, label } = body.data

    await WalletModel.updateOne(
      { chainId: env.CHAIN_ID, address },
      {
        $set: { disabledAt: null, ...(label ? { label } : {}) },
        $setOnInsert: { mode: 'watch_only', 'backfill.state': 'pending' },
      },
      { upsert: true },
    )

    // AL-1.2 — discovery must complete within 60 seconds. It runs detached so the
    // client gets an immediate 202 and polls `backfill.state`; a 60-second HTTP
    // request would time out in every proxy between here and the browser.
    void discovery.discoverWallet(address).catch((err) => {
      log.error({ err, wallet: address }, 'wallet discovery failed')
    })

    return reply.status(202).send({ address, mode: 'watch_only', discovery: 'running' })
  })

  app.get('/api/wallets/:address', { preHandler: requireAddressOwner }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const wallet = await WalletModel.findOne({ chainId: env.CHAIN_ID, address: params.data.address }).lean()
    if (!wallet) return reply.status(404).send({ error: 'wallet not registered' })

    return {
      address: wallet.address,
      mode: wallet.mode,
      label: wallet.label,
      backfill: wallet.backfill,
      /** Settings renders a switch from this, so it is sent as "appears", not "opted out". */
      leaderboardVisible: !(wallet.leaderboardOptOut ?? false),
      monitoring: {
        lastSuccessAt: wallet.monitoring?.lastSuccessAt ?? null,
        consecutiveFailures: wallet.monitoring?.consecutiveFailures ?? 0,
        // AL-2.5 — the web app shows this so a user is never left believing
        // automation is live while reads are degraded.
        executionSuspended: wallet.monitoring?.executionSuspended ?? false,
        suspendedReason: wallet.monitoring?.suspendedReason ?? null,
      },
    }
  })

  /** Stop monitoring. Not a revocation (AL-1.5) — nothing to revoke in this phase. */
  app.delete('/api/wallets/:address', { preHandler: requireAddressOwner }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    await WalletModel.updateOne(
      { chainId: env.CHAIN_ID, address: params.data.address },
      { $set: { disabledAt: new Date() } },
    )
    return { address: params.data.address, monitoring: false }
  })

  /** Force a re-scan — the manual path behind "my position is missing" (AL-1.2). */
  app.post('/api/wallets/:address/refresh', { preHandler: requireAddressOwner }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    void discovery.discoverWallet(params.data.address).catch((err) => {
      log.error({ err, wallet: params.data.address }, 'wallet refresh failed')
    })
    return reply.status(202).send({ discovery: 'running' })
  })

  // ── Positions ─────────────────────────────────────────────────────────────

  app.get('/api/wallets/:address/positions', { preHandler: requireAddressOwner }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z
      .object({ status: z.enum(['open', 'closed', 'all']).default('open') })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const positions = await PositionModel.find({
      chainId: env.CHAIN_ID,
      ownerAddress: params.data.address,
      ...(query.data.status === 'all' ? {} : { status: query.data.status }),
    })

    return { positions: positions.map(serializePosition) }
  })

  /**
   * Snapshot history for the exposure chart. Bounded by `hours` because the
   * monitor writes one row per position per minute — an unbounded range is a
   * cluster-melting query waiting for its first power user.
   */
  app.get('/api/positions/:positionKey/snapshots', { preHandler: requireSession }, async (request, reply) => {
    const params = z.object({ positionKey: z.string().min(3) }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z.object({ hours: z.coerce.number().min(1).max(24 * 30).default(24) }).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    /*
     * WA-1.6 — this route is keyed by position, not by address, so ownership has
     * to be resolved from the resource. A 404 for both "no such position" and
     * "not yours" keeps it from confirming that a position id exists.
     */
    const [keyChainId, positionManager, tokenId] = params.data.positionKey.split(':')
    const position = await PositionModel.findOne({
      chainId: Number(keyChainId),
      positionManager,
      tokenId,
    })
      .select('ownerAddress')
      .lean()

    if (!position || position.ownerAddress !== request.session!.address) {
      return reply.status(404).send({ error: 'position not found' })
    }

    const since = new Date(Date.now() - query.data.hours * 60 * 60 * 1000)
    const snapshots = await PositionSnapshotModel.find({
      'meta.positionKey': params.data.positionKey,
      at: { $gte: since },
    })
      .sort({ at: 1 })
      .limit(5_000)
      .lean()

    return { snapshots: snapshots.map((s) => serializeSnapshot(s as Record<string, unknown>)) }
  })

  // ── Rebalance decisions (AL-5.5, AL-5.6) ──────────────────────────────────

  /**
   * What the Evaluator decided, and what it refused.
   *
   * Both halves are returned because both are the point. `decisions` is the
   * tally — one row per verdict, with an occurrence count, so a position stuck
   * in its cooldown does not drown out everything else. `intents` is the ledger:
   * one document per approval, which during shadow mode settles at
   * `SHADOW_LOGGED` and moves no funds.
   */
  app.get('/api/wallets/:address/rebalance', { preHandler: requireAddressOwner }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const scope = { chainId: env.CHAIN_ID, ownerAddress: params.data.address }
    const [decisions, intents] = await Promise.all([
      ShadowActionModel.find(scope).sort({ lastAt: -1 }).limit(query.data.limit).lean(),
      ExecutionIntentModel.find(scope).sort({ createdAt: -1 }).limit(query.data.limit).lean(),
    ])

    return {
      // The web app must never present this as live automation (AL-3.4).
      shadowMode: env.SHADOW_MODE,
      automationEnabled: env.AUTOMATION_ENABLED,
      thresholdPct: env.EXPOSURE_THRESHOLD_PCT,
      emergencyThresholdPct: env.EMERGENCY_THRESHOLD_PCT,
      decisions: decisions.map((d) => serializeShadowAction(d as Record<string, unknown>)),
      intents: intents.map((i) => serializeIntent(i as Record<string, unknown>)),
    }
  })

  // ── Notifications (AL-3.5) ────────────────────────────────────────────────

  app.get('/api/wallets/:address/notifications', { preHandler: requireAddressOwner }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z
      .object({ limit: z.coerce.number().min(1).max(100).default(50), unreadOnly: z.coerce.boolean().default(false) })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const notifications = await NotificationModel.find({
      chainId: env.CHAIN_ID,
      ownerAddress: params.data.address,
      ...(query.data.unreadOnly ? { readAt: null } : {}),
    })
      .sort({ createdAt: -1 })
      .limit(query.data.limit)
      .lean()

    const unreadCount = await NotificationModel.countDocuments({
      chainId: env.CHAIN_ID,
      ownerAddress: params.data.address,
      readAt: null,
    })

    return { notifications: notifications.map((n) => serializeNotification(n as Record<string, unknown>)), unreadCount }
  })

  app.post('/api/notifications/:id/read', { preHandler: requireSession }, async (request, reply) => {
    const params = z.object({ id: z.string().length(24) }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    // Ownership is part of the filter rather than a separate check — there is no
    // window between reading the owner and writing the update (WA-1.6).
    const result = await NotificationModel.updateOne(
      { _id: params.data.id, ownerAddress: request.session!.address, readAt: null },
      { $set: { readAt: new Date() } },
    )
    return { updated: result.modifiedCount }
  })

  // Telegram link lifecycle lives in ./telegram-routes.ts — it carries a public
  // webhook and its own access-control story, which does not belong inline here.
}
