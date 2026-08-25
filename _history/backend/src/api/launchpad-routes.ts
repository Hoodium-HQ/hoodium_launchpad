/**
 * Launchpad read API — T3.5 / LP-5.1, LP-5.2, LP-5.3.
 *
 * Read-only, and unauthenticated on purpose: a token page is the growth loop
 * (WA-2.7 — a creator shares a link on X and a stranger opens it). Requiring
 * sign-in to *look* would break exactly the thing the launchpad exists to do.
 * WA-1.6's gate applies to a user's own private data, which none of this is.
 *
 * That extends to the trader routes at the bottom. A trader's positions here are
 * derived from `Bought`/`Sold` events — public on-chain data, already served
 * per-token by `/trades`. Gating the same facts behind a session because they are
 * grouped by address would be theatre, and it would break the shareable profile.
 * The Auto LP routes in `routes.ts` are gated, and correctly so: those serve
 * monitoring state and alert history, which exist only because we collected them.
 *
 * The three routes that *write* are gated, each on the narrowest thing that makes
 * sense: pinning needs a session, editing a token's links needs the creator's,
 * and posting to a token's chat needs a balance in it.
 *
 * LP-5.5 — "SHALL NOT editorially promote, endorse, or rank-boost any token for
 * payment." Every ordering below is a plain sort on a measured column. There is
 * no boost field, no promoted flag, and no place to put one.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { erc20Abi } from '@hoodium/shared/abi'
import {
  LaunchpadHolderModel,
  LaunchpadMessageModel,
  LaunchpadTokenModel,
  LaunchpadTradeModel,
} from '../db/models/launchpad.js'
import { Decimal, moneyToJson } from '../lib/money.js'
import { componentLogger } from '../lib/logger.js'
import { fetchIpfsImage, fetchTokenMetadata } from '../launchpad/ipfs.js'
import {
  MAX_IMAGE_UPLOAD_BYTES,
  PinningFailedError,
  PinningUnavailableError,
  isPinningEnabled,
  pinImage,
  pinJson,
  sniffImageType,
} from '../launchpad/pinata.js'
import { buildActivity, buildPortfolio, buildPortfolioSeries } from '../launchpad/portfolio.js'
import { loadLaunchTerms } from '../launchpad/terms.js'
import { requireSession } from './guard.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'

const log = componentLogger('launchpad-api')

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((s) => s.toLowerCase())

const SORTS = ['recent', 'newest', 'oldest', 'progress', 'volume'] as const
type Sort = (typeof SORTS)[number]

const SORT_ORDER: Record<Sort, Record<string, 1 | -1>> = {
  recent: { lastTradeAt: -1 },
  newest: { createdAtChain: -1 },
  oldest: { createdAtChain: 1 },
  progress: { progressBps: -1 },
  volume: { volumeUsdg: -1 },
}

/** Windows the chart and the portfolio series offer, in hours. */
const WINDOWS = { '1h': 1, '6h': 6, '1d': 24, '7d': 24 * 7, '30d': 24 * 30 } as const
type Window = keyof typeof WINDOWS

/**
 * A social handle, validated to the part that will sit inside a fixed prefix.
 * Anything with a scheme, a slash or a query is refused rather than repaired —
 * `foo?next=evil` must not become a link the page vouches for.
 */
const handleSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, ''))
  .refine((s) => s.length === 0 || /^[A-Za-z0-9_]{1,64}$/.test(s), 'letters, numbers and underscores only')
  .transform((s) => (s.length > 0 ? s : null))
  .nullable()

/**
 * LP-N5 in miniature. A chat post carrying a link is an invitation to a phishing
 * page wearing the token's name, and the token page is exactly where a stranger
 * arrives with no context. Refused at the write, not stripped at render: a
 * stripped link leaves a message that reads as if it said something it did not.
 */
const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|me|gg|co|app|link|fun|to)\b)/i

function serializeToken(t: Record<string, any>) {
  const metadata = t.metadata ?? {}
  const links = t.links ?? {}

  return {
    tokenAddress: t.tokenAddress,
    curveAddress: t.curveAddress,
    creator: t.creator,
    // Returned verbatim — creator-supplied and attacker-controlled. The client
    // sanitises at render (WA-N3); doing it here would hide the real on-chain value.
    name: t.name,
    symbol: t.symbol,
    metadataURI: t.metadataURI,
    /**
     * The resolved document. `null` fields mean "we do not have it" — either the
     * creator supplied none or the gateway has not answered yet. An empty string
     * would claim the creator wrote nothing, which is a different statement.
     */
    description: metadata.description ?? null,
    /** Creator-edited socials win; the pinned document is the fallback (LP-1.7). */
    x: links.x ?? metadata.x ?? null,
    telegram: links.telegram ?? metadata.telegram ?? null,
    /** Whether `/tokens/:address/image` will serve anything. */
    hasImage: Boolean(metadata.image),
    status: t.status,
    progressBps: t.progressBps,
    reserveUsdg: moneyToJson(t.reserveUsdg),
    tokensSold: t.tokensSold,
    graduationTarget: moneyToJson(t.graduationTarget),
    volumeUsdg: moneyToJson(t.volumeUsdg),
    tradeCount: t.tradeCount,
    holderCount: t.holderCount,
    poolAddress: t.poolAddress ?? null,
    /** Which locked position backs this token's pool. A pointer, not a figure. */
    lpTokenId: t.lpTokenId ?? null,
    graduatedAt: t.graduatedAt ?? null,
    lastTradeAt: t.lastTradeAt ?? null,
    createdAt: t.createdAtChain ?? t.createdAt,
    risk: {
      creatorSharePct: moneyToJson(t.risk?.creatorSharePct),
      priorLaunches: t.risk?.creatorPriorLaunches ?? 0,
      priorGraduations: t.risk?.creatorPriorGraduations ?? 0,
      hasConfusableSymbol: t.risk?.hasConfusableSymbol ?? false,
      flags: t.risk?.flags ?? [],
    },
  }
}

function serializeTrade(t: Record<string, any>) {
  return {
    side: t.side,
    trader: t.trader,
    usdgAmount: moneyToJson(t.usdgAmount),
    tokenAmount: t.tokenAmount,
    feeUsdg: moneyToJson(t.feeUsdg),
    priceUsdg: moneyToJson(t.priceUsdg),
    blockNumber: t.blockNumber,
    txHash: t.txHash,
    at: t.at,
    // design.md section 5 — the UI renders unconfirmed rows at reduced opacity
    // rather than waiting for finality or retracting them later.
    finalized: t.finalized,
  }
}

export async function registerLaunchpadRoutes(
  app: FastifyInstance,
  deps: { env: Env; chain: ChainClient },
): Promise<void> {
  const { env, chain } = deps

  const terms = () => loadLaunchTerms(chain, env.LAUNCHPAD_FACTORY_ADDRESS, env.CHAIN_ID)

  /** LP-5.1, LP-5.2 — the discovery feed. */
  app.get('/api/launchpad/tokens', async (request, reply) => {
    const query = z
      .object({
        sort: z.enum(SORTS).default('recent'),
        status: z.enum(['curve', 'graduated', 'all']).default('all'),
        limit: z.coerce.number().min(1).max(100).default(50),
        since: z.coerce.number().min(0).optional(),
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const filter: Record<string, unknown> = { chainId: env.CHAIN_ID }
    if (query.data.status !== 'all') filter.status = query.data.status
    if (query.data.since) filter.createdAtChain = { $gte: new Date(query.data.since) }

    /*
     * `total` is the size of the whole filtered set, not of this page.
     *
     * The discovery surface labels each section with a count, and a count that
     * silently meant "however many we happened to return" would read as a claim
     * about the chain while describing our page size. Counted separately for
     * that reason, and cheap: `status` and `chainId` are both indexed.
     */
    const [tokens, total] = await Promise.all([
      LaunchpadTokenModel.find(filter).sort(SORT_ORDER[query.data.sort]).limit(query.data.limit).lean(),
      LaunchpadTokenModel.countDocuments(filter),
    ])

    return { tokens: tokens.map((t) => serializeToken(t as Record<string, any>)), total }
  })

  /** LP-5.3 — the token page. */
  app.get('/api/launchpad/tokens/:address', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const token = await LaunchpadTokenModel.findOne({
      chainId: env.CHAIN_ID,
      tokenAddress: params.data.address,
    }).lean()
    if (!token) return reply.status(404).send({ error: 'token not found' })

    /*
     * Self-healing metadata (LP-1.7).
     *
     * The indexer resolves the document once, at launch. That leaves two gaps: a
     * token indexed before this existed, and one whose gateway was down for the
     * one attempt it got. Rather than a backfill script somebody has to remember
     * to run, the token page fills them in on the first view — the fetch is
     * cached in-process and negatively cached on failure, so a dead pin costs one
     * request every five minutes rather than one per view.
     *
     * Detached: a slow gateway must not hold up the page it is decorating.
     */
    if (token.metadataURI && !token.metadata?.resolvedAt) {
      void fetchTokenMetadata(env.IPFS_GATEWAY_URL, token.metadataURI)
        .then((metadata) => {
          if (!metadata) return
          return LaunchpadTokenModel.updateOne(
            { chainId: env.CHAIN_ID, tokenAddress: params.data.address },
            {
              $set: {
                'metadata.description': metadata.description,
                'metadata.image': metadata.image,
                'metadata.x': metadata.x,
                'metadata.telegram': metadata.telegram,
                'metadata.resolvedAt': new Date(),
              },
            },
          )
        })
        .catch((err) => log.warn({ err, token: params.data.address }, 'lazy metadata resolve failed'))
    }

    return { token: serializeToken(token as Record<string, any>) }
  })

  /** LP-5.3 — full trade history. */
  app.get('/api/launchpad/tokens/:address/trades', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z
      .object({
        limit: z.coerce.number().min(1).max(500).default(100),
        skip: z.coerce.number().min(0).max(10_000).default(0),
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const filter = { chainId: env.CHAIN_ID, tokenAddress: params.data.address }
    const [trades, total] = await Promise.all([
      LaunchpadTradeModel.find(filter)
        .sort({ blockNumber: -1, logIndex: -1 })
        .skip(query.data.skip)
        .limit(query.data.limit)
        .lean(),
      LaunchpadTradeModel.countDocuments(filter),
    ])

    return { trades: trades.map((t) => serializeTrade(t as Record<string, any>)), total }
  })

  /** LP-5.3 — holders. */
  app.get('/api/launchpad/tokens/:address/holders', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z
      .object({
        limit: z.coerce.number().min(1).max(200).default(50),
        skip: z.coerce.number().min(0).max(10_000).default(0),
      })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const token = await LaunchpadTokenModel.findOne({
      chainId: env.CHAIN_ID,
      tokenAddress: params.data.address,
    })
      .select('creator tokensSold')
      .lean()

    const filter = { chainId: env.CHAIN_ID, tokenAddress: params.data.address, balance: { $ne: '0' } }
    const [holders, total] = await Promise.all([
      LaunchpadHolderModel.find(filter)
        .sort({ balance: -1 })
        .skip(query.data.skip)
        .limit(query.data.limit)
        .lean(),
      LaunchpadHolderModel.countDocuments(filter),
    ])

    // The denominator is tokens *sold*, not total supply: the unsold remainder
    // still sits in the curve, and counting it would make every holder look
    // negligible for reasons that have nothing to do with distribution.
    const sold = new Decimal(token?.tokensSold?.toString() ?? '0')

    return {
      total,
      holders: holders.map((h) => ({
        holder: h.holder,
        balance: h.balance,
        sharePct: sold.gt(0) ? new Decimal(h.balance.toString()).mul(100).div(sold).toFixed(2) : null,
        isCreator: token?.creator === h.holder,
        lastTradeAt: h.lastTradeAt,
      })),
      /**
       * These balances are reconstructed from curve trades only, so a plain
       * ERC-20 `transfer` is invisible to them. Said here rather than in a
       * tooltip, because a holder list that quietly omits transfers reads as
       * authoritative and is not.
       */
      basis: 'curve_trades',
    }
  })

  /**
   * Price history and the headline aggregates the token page sits above.
   *
   * Points are trades, not candles: on a bonding curve every trade *is* a price
   * change, so bucketing would throw away the only resolution there is.
   */
  app.get('/api/launchpad/tokens/:address/chart', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z
      .object({ window: z.enum(Object.keys(WINDOWS) as [Window, ...Window[]]).default('1d') })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const since = new Date(Date.now() - WINDOWS[query.data.window] * 60 * 60 * 1000)
    const scope = { chainId: env.CHAIN_ID, tokenAddress: params.data.address }

    const [points, aggregate, launchTerms] = await Promise.all([
      LaunchpadTradeModel.find({ ...scope, at: { $gte: since } })
        .select('priceUsdg at')
        .sort({ blockNumber: 1, logIndex: 1 })
        .limit(2_000)
        .lean(),
      LaunchpadTradeModel.aggregate<{ _id: null; ath: unknown; volume24h: unknown }>([
        { $match: scope },
        {
          $group: {
            _id: null,
            ath: { $max: '$priceUsdg' },
            volume24h: {
              $sum: {
                $cond: [{ $gte: ['$at', new Date(Date.now() - 24 * 60 * 60 * 1000)] }, '$usdgAmount', 0],
              },
            },
          },
        },
      ]),
      terms(),
    ])

    const supply = launchTerms ? new Decimal(launchTerms.totalSupply) : null
    const athPrice = aggregate[0]?.ath ? new Decimal(aggregate[0].ath.toString()) : null

    return {
      window: query.data.window,
      /** Unix seconds and quote base units per whole token. */
      points: points.map((p) => ({
        t: p.at ? Math.floor(new Date(p.at).getTime() / 1000) : 0,
        price: moneyToJson(p.priceUsdg) ?? '0',
      })),
      athPrice: athPrice ? athPrice.toFixed(0) : null,
      athMarketCap: athPrice && supply ? athPrice.div(new Decimal(10).pow(18)).mul(supply).toFixed(0) : null,
      volume24h: aggregate[0]?.volume24h ? new Decimal(aggregate[0].volume24h.toString()).toFixed(0) : '0',
      totalSupply: launchTerms?.totalSupply ?? null,
    }
  })

  /**
   * Token artwork, re-served from our own origin.
   *
   * The caller supplies an address; the IPFS reference is looked up in our own
   * indexed copy. That is the property that makes this not an SSRF endpoint —
   * there is no attacker-supplied URL anywhere in the path (launchpad/ipfs.ts).
   */
  app.get('/api/launchpad/tokens/:address/image', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const token = await LaunchpadTokenModel.findOne({
      chainId: env.CHAIN_ID,
      tokenAddress: params.data.address,
    })
      .select('metadata.image')
      .lean()

    const image = await fetchIpfsImage(env.IPFS_GATEWAY_URL, token?.metadata?.image ?? null)
    if (!image) return reply.status(404).send({ error: 'no artwork for this token' })

    return reply
      .header('content-type', image.contentType)
      // Refuse to let a browser guess at anything other than the type we
      // validated by magic bytes before pinning.
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=86400, immutable')
      .send(image.body)
  })

  /**
   * The addresses and terms the client needs to trade directly against the chain
   * (LP-N7), plus the launch terms the form must state before anyone signs.
   *
   * `terms: null` means the factory could not be read. The form renders that as
   * "we cannot read the terms" and refuses to submit — it does not fill in
   * plausible numbers, because a creator would be agreeing to the wrong ones.
   */
  app.get('/api/launchpad/config', async () => ({
    factoryAddress: env.LAUNCHPAD_FACTORY_ADDRESS ?? null,
    quoteSymbol: env.QUOTE_TOKEN_SYMBOL,
    quoteAddress: env.QUOTE_TOKEN_ADDRESS,
    quoteDecimals: env.QUOTE_TOKEN_DECIMALS,
    chainId: env.CHAIN_ID,
    pinningEnabled: isPinningEnabled({ jwt: env.PINATA_JWT, apiUrl: env.PINATA_API_URL }),
    terms: await terms(),
  }))

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Pin one launch's metadata — LP-1.7.
   *
   * Returns the `ipfs://` URI the browser then passes to `launch()`. Nothing here
   * touches the chain: the creator's wallet submits the transaction, as WA-N5
   * requires, and this is only the upload half.
   *
   * Session-gated because pinning costs money and storage at somebody else's
   * service. It is not an ownership check — there is no token yet to own.
   */
  app.post(
    '/api/launchpad/metadata',
    {
      preHandler: requireSession,
      // The server default is 256 KB, which a 1 MB image in base64 clears twice
      // over. Raised here alone rather than globally.
      bodyLimit: 2 * MAX_IMAGE_UPLOAD_BYTES,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const pinata = { jwt: env.PINATA_JWT, apiUrl: env.PINATA_API_URL }
      if (!isPinningEnabled(pinata)) {
        return reply.status(503).send({
          error: 'metadata pinning is not configured on this deployment',
          code: 'pinning_unavailable',
        })
      }

      const body = z
        .object({
          name: z.string().trim().min(1).max(64),
          symbol: z.string().trim().min(1).max(12),
          description: z.string().trim().max(256).optional(),
          x: handleSchema.optional(),
          telegram: handleSchema.optional(),
          image: z
            .object({
              contentType: z.string(),
              /** base64, no data-URI prefix. */
              data: z.string().min(1),
            })
            .optional(),
        })
        .safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: body.error.issues })

      // LP-1.7's own words are about the hash being recorded, not about links, but
      // a description is rendered on a page a stranger arrives at cold. Same rule
      // as chat.
      if (body.data.description && LINK_RE.test(body.data.description)) {
        return reply.status(400).send({ error: 'the description may not contain links', code: 'link_rejected' })
      }

      let imageUri: string | null = null
      try {
        if (body.data.image) {
          const bytes = Buffer.from(body.data.image.data, 'base64')
          if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
            return reply.status(400).send({ error: 'artwork must be between 1 byte and 1 MB', code: 'image_size' })
          }

          // A declared content type is a claim. This is the check that makes it
          // true — the file is later re-served from our own origin.
          const sniffed = sniffImageType(bytes, body.data.image.contentType)
          if (!sniffed) {
            return reply.status(400).send({
              error: 'artwork must be a PNG, JPEG, WebP or GIF, and must match its declared type',
              code: 'image_type',
            })
          }

          imageUri = await pinImage(pinata, bytes, sniffed)
        }

        const uri = await pinJson(pinata, {
          name: body.data.name,
          symbol: body.data.symbol,
          description: body.data.description ?? null,
          image: imageUri,
          x: body.data.x ?? null,
          telegram: body.data.telegram ?? null,
        })

        return { uri, imageUri }
      } catch (err) {
        if (err instanceof PinningUnavailableError) {
          return reply.status(503).send({ error: 'pinning is not configured', code: 'pinning_unavailable' })
        }
        if (err instanceof PinningFailedError) {
          return reply.status(502).send({ error: err.message, code: 'pinning_failed' })
        }
        throw err
      }
    },
  )

  /**
   * Edit a token's socials.
   *
   * `metadataURI` is immutable once launched — the point of recording it on-chain
   * — so a creator who moves their Telegram has no way to correct the pinned
   * document. These are an off-chain overlay, and the API says so by returning
   * them under the same keys with the override applied.
   */
  app.post('/api/launchpad/tokens/:address/links', { preHandler: requireSession }, async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const body = z.object({ x: handleSchema, telegram: handleSchema }).safeParse(request.body)
    if (!body.success) return reply.status(400).send({ error: body.error.issues })

    const token = await LaunchpadTokenModel.findOne({
      chainId: env.CHAIN_ID,
      tokenAddress: params.data.address,
    })
      .select('creator')
      .lean()
    if (!token) return reply.status(404).send({ error: 'token not found' })

    if (token.creator !== request.session!.address) {
      return reply.status(403).send({ error: 'only the creator can edit these links', code: 'forbidden' })
    }

    await LaunchpadTokenModel.updateOne(
      { chainId: env.CHAIN_ID, tokenAddress: params.data.address },
      { $set: { 'links.x': body.data.x, 'links.telegram': body.data.telegram, 'links.updatedAt': new Date() } },
    )

    return { x: body.data.x, telegram: body.data.telegram }
  })

  // ── Token chat ────────────────────────────────────────────────────────────

  app.get('/api/launchpad/tokens/:address/messages', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z.object({ limit: z.coerce.number().min(1).max(100).default(50) }).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const messages = await LaunchpadMessageModel.find({
      chainId: env.CHAIN_ID,
      tokenAddress: params.data.address,
    })
      .sort({ at: -1 })
      .limit(query.data.limit)
      .lean()

    return {
      messages: messages
        .map((m) => ({
          author: m.author,
          // Verbatim, like every other creator-supplied string here (WA-N3).
          body: m.body,
          authorBalance: m.authorBalance?.toString() ?? '0',
          isCreator: m.isCreator,
          at: m.at,
        }))
        .reverse(),
    }
  })

  /**
   * Post to a token's chat.
   *
   * Gated on holding the token, which is the only moderation lever that costs an
   * attacker anything: a fresh address is free, a position is not. The balance is
   * read from the chain at post time rather than from our holder table — that
   * table is reconstructed from curve trades and would refuse someone who was
   * transferred their tokens.
   */
  app.post(
    '/api/launchpad/tokens/:address/messages',
    { preHandler: requireSession, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z.object({ address: addressSchema }).safeParse(request.params)
      if (!params.success) return reply.status(400).send({ error: params.error.issues })

      const body = z.object({ body: z.string().trim().min(1).max(280) }).safeParse(request.body)
      if (!body.success) return reply.status(400).send({ error: body.error.issues })

      if (LINK_RE.test(body.data.body)) {
        return reply.status(400).send({ error: 'links are not allowed here', code: 'link_rejected' })
      }

      const token = await LaunchpadTokenModel.findOne({
        chainId: env.CHAIN_ID,
        tokenAddress: params.data.address,
      })
        .select('creator')
        .lean()
      if (!token) return reply.status(404).send({ error: 'token not found' })

      const author = request.session!.address

      let balance: bigint
      try {
        balance = await chain.call('balanceOf:chat', (client) =>
          client.readContract({
            address: params.data.address as `0x${string}`,
            // From the shared package, not written out here — WA-N6 forbids a
            // second copy of an ABI fragment however small.
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [author as `0x${string}`],
          }),
        )
      } catch (err) {
        log.warn({ err, token: params.data.address }, 'chat balance check failed')
        // Fail closed. An unreadable chain is not permission to post.
        return reply.status(503).send({ error: 'could not verify your balance right now', code: 'chain_unreadable' })
      }

      if (balance <= 0n && token.creator !== author) {
        return reply.status(403).send({ error: 'only token holders can post here', code: 'not_a_holder' })
      }

      await LaunchpadMessageModel.create({
        chainId: env.CHAIN_ID,
        tokenAddress: params.data.address,
        author,
        body: body.data.body,
        authorBalance: balance.toString(),
        isCreator: token.creator === author,
        at: new Date(),
      })

      return reply.status(201).send({ posted: true })
    },
  )

  // ── Trader profile ────────────────────────────────────────────────────────

  app.get('/api/launchpad/traders/:address/portfolio', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const launchTerms = await terms()
    const portfolio = await buildPortfolio({
      chainId: env.CHAIN_ID,
      address: params.data.address,
      chain,
      totalSupply: launchTerms?.totalSupply ?? null,
    })

    return portfolio
  })

  app.get('/api/launchpad/traders/:address/series', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z
      .object({ window: z.enum(['1d', '7d', '30d']).default('1d') })
      .safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    const points = await buildPortfolioSeries({
      chainId: env.CHAIN_ID,
      address: params.data.address,
      hours: WINDOWS[query.data.window],
    })

    return { window: query.data.window, points }
  })

  app.get('/api/launchpad/traders/:address/activity', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const query = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })

    return {
      entries: await buildActivity({
        chainId: env.CHAIN_ID,
        address: params.data.address,
        limit: query.data.limit,
      }),
    }
  })

  app.get('/api/launchpad/traders/:address/launches', async (request, reply) => {
    const params = z.object({ address: addressSchema }).safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })

    const tokens = await LaunchpadTokenModel.find({ chainId: env.CHAIN_ID, creator: params.data.address })
      .sort({ createdAtChain: -1 })
      .limit(100)
      .lean()

    return { tokens: tokens.map((t) => serializeToken(t as Record<string, any>)) }
  })
}
