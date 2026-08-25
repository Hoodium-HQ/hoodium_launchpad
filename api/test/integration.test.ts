/**
 * Mongo-backed end-to-end: a fake chain feeds the indexer one launch and a
 * handful of trades, then every route is exercised through `app.inject`.
 *
 * Opt-in: set MONGO_TEST_URI (a replica set is not required by this suite, but
 * the throwaway container in the README runs one anyway).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { keccak256, toHex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildServer } from '../src/api/server.js'
import { buildAuthMessage } from '../src/auth.js'
import type { ChainClient } from '../src/chain/client.js'
import { loadEnv } from '../src/config/env.js'
import { deriveVirtualTokens } from '../src/curve/index.js'
import { connectDb, disconnectDb, ensureIndexes } from '../src/db/connect.js'
import { CursorModel, HolderModel, MessageModel, TokenModel, TradeModel } from '../src/db/models.js'
import { CURSOR_NAME, LaunchpadIndexer } from '../src/indexer/indexer.js'
import { refreshRollingStats } from '../src/indexer/stats.js'
import { setLaunchTermsForTesting } from '../src/services/terms.js'
import type { LaunchTerms, TokenDetailResponse, TokenListResponse, ProfileResponse } from '../src/types.js'

const MONGO_TEST_URI = process.env.MONGO_TEST_URI
const describeDb = MONGO_TEST_URI ? describe : describe.skip

const USDG = 10n ** 6n
const TOKEN = 10n ** 18n
const FACTORY = '0xf000000000000000000000000000000000000001'
const TOKEN_ADDR = '0xa000000000000000000000000000000000000001'
const CURVE_ADDR = '0xc000000000000000000000000000000000000001'
const CREATOR = '0xd000000000000000000000000000000000000001'
const trader = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const TRADER = trader.address.toLowerCase()

const terms: LaunchTerms = {
  factoryAddress: FACTORY,
  usdgAddress: '0x' + '9'.repeat(40),
  feeVault: '0x' + '8'.repeat(40),
  graduationManager: '0x' + '7'.repeat(40),
  locker: null,
  positionManager: null,
  totalSupply: (1_000_000_000n * TOKEN).toString(),
  curveAllocation: (800_000_000n * TOKEN).toString(),
  lpAllocation: (200_000_000n * TOKEN).toString(),
  tokenDecimals: 18,
  virtualUsdg: (23_000n * USDG).toString(),
  virtualTokens: deriveVirtualTokens(800_000_000n * TOKEN, 23_000n * USDG, 69_000n * USDG).toString(),
  creationFee: USDG.toString(),
  graduationTarget: (69_000n * USDG).toString(),
  graduationFee: '0',
  devBuyCapTokens: '0',
  devBuyMaxBps: 500,
  tradeFeeBps: 100,
  creatorFeeShareBps: 7000,
  protocolFeeShareBps: 2000,
  snipeBlocks: 3,
  snipeMaxBps: 100,
}

const hashOf = (n: number, fork = 'a') => `0x${n.toString(16).padStart(8, '0')}${fork.repeat(56)}`

/** A fake chain: a block per number, one launch and three trades. */
class FakeChain {
  head = 100
  fork = 'a'
  balances = new Map<string, bigint>()
  readonly chainId = 4663

  logs: Array<Record<string, unknown>> = [
    {
      address: FACTORY,
      eventName: 'TokenLaunched',
      args: { token: TOKEN_ADDR, curve: CURVE_ADDR, creator: CREATOR, name: 'Test Coin', symbol: 'TEST', metadataURI: null, devBuyUsdg: 0n, devBuyTokens: 0n },
      blockNumber: 10n,
      transactionHash: '0x' + '1'.repeat(64),
      logIndex: 0,
    },
    {
      address: CURVE_ADDR,
      eventName: 'Bought',
      args: { buyer: TRADER, usdgIn: 1_000n * USDG, tokensOut: 50_000_000n * TOKEN, fee: 10n * USDG, refund: 0n, reserveAfter: 990n * USDG, tokensSoldAfter: 50_000_000n * TOKEN },
      blockNumber: 11n,
      transactionHash: '0x' + '2'.repeat(64),
      logIndex: 3,
    },
    {
      address: CURVE_ADDR,
      eventName: 'Bought',
      args: { buyer: CREATOR, usdgIn: 500n * USDG, tokensOut: 20_000_000n * TOKEN, fee: 5n * USDG, refund: 0n, reserveAfter: 1_485n * USDG, tokensSoldAfter: 70_000_000n * TOKEN },
      blockNumber: 12n,
      transactionHash: '0x' + '3'.repeat(64),
      logIndex: 0,
    },
    {
      address: CURVE_ADDR,
      eventName: 'Sold',
      args: { seller: TRADER, tokensIn: 10_000_000n * TOKEN, usdgOut: 200n * USDG, fee: 2n * USDG, reserveAfter: 1_283n * USDG, tokensSoldAfter: 60_000_000n * TOKEN },
      blockNumber: 90n,
      transactionHash: '0x' + '4'.repeat(64),
      logIndex: 1,
    },
    // Some other contract emitting the same signature — must be ignored.
    {
      address: '0x' + 'e'.repeat(40),
      eventName: 'Bought',
      args: { buyer: TRADER, usdgIn: 1n, tokensOut: 1n, fee: 0n, refund: 0n, reserveAfter: 1n, tokensSoldAfter: 1n },
      blockNumber: 91n,
      transactionHash: '0x' + '5'.repeat(64),
      logIndex: 0,
    },
  ]

  private readonly client = {
    getLogs: async (p: { address?: string; fromBlock: bigint; toBlock: bigint }) =>
      this.logs.filter((l) => {
        const n = l.blockNumber as bigint
        if (n < p.fromBlock || n > p.toBlock) return false
        return p.address ? l.address === p.address.toLowerCase() : l.address !== FACTORY
      }),
    getBlock: async (p: { blockNumber: bigint }) => {
      const n = Number(p.blockNumber)
      const fork = n >= 90 ? this.fork : 'a'
      return { number: p.blockNumber, hash: hashOf(n, fork), parentHash: hashOf(n - 1, n - 1 >= 90 ? this.fork : 'a'), timestamp: BigInt(1_700_000_000 + n * 12) }
    },
    readContract: async (p: { functionName: string; args?: unknown[] }) => {
      if (p.functionName === 'balanceOf') return this.balances.get(String(p.args?.[0]).toLowerCase()) ?? 0n
      if (p.functionName === 'creatorFeesAccrued') return 10n * USDG
      if (p.functionName === 'creatorFeesClaimed') return 3n * USDG
      throw new Error(`unexpected read ${p.functionName}`)
    },
  }

  async verify(): Promise<void> {}
  async getBlockNumber(): Promise<bigint> {
    return BigInt(this.head)
  }
  async call<T>(_name: string, fn: (c: PublicClient) => Promise<T>): Promise<T> {
    return fn(this.client as unknown as PublicClient)
  }
}

describeDb('launchpad api + indexer (mongo)', () => {
  const env = loadEnv({
    // A well-formed placeholder when skipping: `describe.skip` still collects this body, and an empty URI fails env validation before the skip applies.
    MONGO_URI: MONGO_TEST_URI ?? 'mongodb://127.0.0.1:1/skipped',
    MONGO_DB_NAME: `lp_test_${Date.now()}`,
    RPC_URL: 'http://fake.invalid',
    LAUNCHPAD_FACTORY: FACTORY,
    INDEXER_REORG_BUFFER_BLOCKS: '16',
    INDEXER_CONFIRMATIONS: '32',
    CORS_ORIGINS: 'https://launchpad.hoodium.app',
  })
  const fake = new FakeChain()
  const chain = fake as unknown as ChainClient
  const indexer = new LaunchpadIndexer(env, chain)
  let app: Awaited<ReturnType<typeof buildServer>>

  beforeAll(async () => {
    setLaunchTermsForTesting(terms, `${env.CHAIN_ID}:${FACTORY}`)
    await connectDb(env.MONGO_URI, env.MONGO_DB_NAME)
    await ensureIndexes()
    app = await buildServer({ env, chain, indexerStatus: () => indexer.status(), startedAt: Date.now() })
  })

  afterAll(async () => {
    await app?.close()
    await mongoose.connection.db?.dropDatabase()
    await disconnectDb()
  })

  it('indexes the launch and its trades in bounded ranges', async () => {
    await indexer.loadCurveIndex()
    let r = await indexer.runOnce()
    expect(r.launches).toBe(1)
    expect(r.curveEvents).toBe(3)
    expect(r.caughtUp).toBe(true)
    r = await indexer.runOnce()
    expect(r.caughtUp).toBe(true)

    const token = await TokenModel.findOne({ tokenAddress: TOKEN_ADDR }).lean()
    expect(token).toBeTruthy()
    expect(token!.tradeCount).toBe(3)
    expect(token!.buyCount).toBe(2)
    expect(token!.reserveUsdg).toBe((1_283n * USDG).toString())
    expect(token!.tokensSold).toBe((60_000_000n * TOKEN).toString())
    expect(token!.volumeUsdg).toBe((1_700n * USDG).toString())
    expect(token!.progressBps).toBe(Number((1_283n * 10_000n) / 69_000n))
    expect(token!.holderCount).toBe(2)
    expect(token!.marketCapUsd).toBeGreaterThan(0)
    expect(token!.createdAtChain.getTime()).toBe((1_700_000_000 + 10 * 12) * 1000)

    const trades = await TradeModel.find({ tokenAddress: TOKEN_ADDR }).lean()
    expect(trades).toHaveLength(3)
    // Re-running must not double count.
    await indexer.rebuildToken(TOKEN_ADDR, terms)
    const again = await TokenModel.findOne({ tokenAddress: TOKEN_ADDR }).lean()
    expect(again!.volumeUsdg).toBe(token!.volumeUsdg)

    const holder = await HolderModel.findOne({ tokenAddress: TOKEN_ADDR, holder: TRADER }).lean()
    expect(holder!.balance).toBe((40_000_000n * TOKEN).toString())

    const cursor = await CursorModel.findOne({ name: CURSOR_NAME }).lean()
    expect(cursor!.lastProcessedBlock).toBe(100)
    expect(cursor!.blockBuffer).toHaveLength(16)
    // Finality frontier is head - 32 = 68: the two early trades are final, the sell at 90 is not.
    expect(await TradeModel.countDocuments({ finalized: true })).toBe(2)

    // Creator risk: creator holds 20M of 60M sold = 33% → concentration flag.
    expect(token!.risk?.flags).toContain('creator_concentration')
  })

  it('serves the explore list with counts, sorting and search', async () => {
    // Pretend "now" is 25 hours after the last trade: the 24h window is empty, 7d holds everything.
    const lastTrade = (1_700_000_000 + 90 * 12) * 1000
    await refreshRollingStats(env.CHAIN_ID, new Date(lastTrade + 25 * 3600_000))
    const res = await app.inject({ url: '/api/tokens?sort=market_cap&window=7d' })
    expect(res.statusCode).toBe(200)
    const body = res.json<TokenListResponse>()
    expect(body.counts).toEqual({ launched: 1, graduated: 0, live: 1, matched: 1 })
    expect(body.items[0]).toMatchObject({ address: TOKEN_ADDR, symbol: 'TEST', graduated: false, holderCount: 2 })
    expect(body.items[0]!.volumeUsd).toBe(1700)
    expect(body.items[0]!.volumeUsd24h).toBe(0)
    expect(body.items[0]!.volumeUsdAll).toBe(1700)
    expect(body.items[0]!.tradeCount).toBe(3)

    // Eight days on, the 7d window empties too — stale rows are zeroed, not left behind.
    await refreshRollingStats(env.CHAIN_ID, new Date(lastTrade + 8 * 24 * 3600_000))
    const stale = (await app.inject({ url: '/api/tokens?window=7d' })).json<TokenListResponse>()
    expect(stale.items[0]!.volumeUsd).toBe(0)
    expect(stale.items[0]!.volumeUsdAll).toBe(1700)

    expect((await app.inject({ url: '/api/tokens?q=tes' })).json<TokenListResponse>().items).toHaveLength(1)
    expect((await app.inject({ url: '/api/tokens?q=nope' })).json<TokenListResponse>().items).toHaveLength(0)
    expect((await app.inject({ url: `/api/tokens?q=${TOKEN_ADDR}` })).json<TokenListResponse>().items).toHaveLength(1)
    expect((await app.inject({ url: '/api/tokens?status=graduated' })).json<TokenListResponse>().items).toHaveLength(0)
    expect((await app.inject({ url: '/api/tokens?sort=bogus' })).statusCode).toBe(400)
  })

  it('serves the token page with curve state and ATH', async () => {
    const res = await app.inject({ url: `/api/tokens/${TOKEN_ADDR}` })
    expect(res.statusCode).toBe(200)
    const { token } = res.json<TokenDetailResponse>()
    expect(token.curveState.raised).toBe((1_283n * USDG).toString())
    expect(token.curveState.targetUsd).toBe(69_000)
    expect(token.curveState.creatorFeeShareBps).toBe(7000)
    expect(token.curveState.platformFeeShareBps).toBe(3000)
    expect(token.athPriceUsd).toBeGreaterThan(0)
    expect(token.athMarketCapUsd).toBeGreaterThan(0)
    expect((await app.inject({ url: '/api/tokens/0x' + '0'.repeat(40) })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/tokens/garbage' })).statusCode).toBe(400)
  })

  it('pages trades and holders', async () => {
    const trades = await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/trades?limit=2` })
    const t = trades.json()
    expect(t.total).toBe(3)
    expect(t.items).toHaveLength(2)
    expect(t.hasMore).toBe(true)
    expect(t.items[0].side).toBe('sell')

    const holders = await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/holders` })
    const h = holders.json()
    expect(h.total).toBe(2)
    expect(h.basis).toBe('curve_trades')
    expect(h.items[0].holder).toBe(TRADER)
    expect(h.items[0].sharePct).toBeCloseTo(66.66, 1)
    expect(h.items[1].isCreator).toBe(true)
  })

  it('builds candles and the price series', async () => {
    // Trades at +132s, +144s (same 1m bucket) and +1080s.
    const t0 = 1_700_000_000
    const res = await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/candles?interval=1m&from=${t0}&to=${t0 + 1200}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const traded = body.candles.filter((c: { v: number }) => c.v > 0)
    expect(traded.length).toBe(2)
    const bucket = (t: number) => Math.floor(t / 60) * 60 // absolute-minute aligned
    expect(traded[0]).toMatchObject({ t: bucket(t0 + 132), v: 1500, buys: 2, sells: 0 })
    expect(traded[1]).toMatchObject({ t: bucket(t0 + 1080), v: 200, buys: 0, sells: 1 })
    // Flat fill between them, and nothing fabricated before the first trade.
    expect(body.candles[0].t).toBe(bucket(t0 + 132))
    expect(body.candles.length).toBe((bucket(t0 + 1200) - bucket(t0 + 132)) / 60 + 1)
    expect(body.candles[1]).toMatchObject({ o: traded[0].c, c: traded[0].c, v: 0 })

    // `all` with no bounds spans to now and picks a bucket that keeps the series bounded.
    const all = (await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/candles?interval=all&fill=0` })).json()
    expect(all.interval).toBe('1d')
    expect(all.candles.length).toBe(1)
    const series = await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/price-series?window=all` })
    expect(series.json().points).toHaveLength(3)
    expect((await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/candles?interval=2h` })).statusCode).toBe(400)
  })

  it('builds a profile with reconciled PnL and creator fees', async () => {
    fake.balances.set(TRADER, 40_000_000n * TOKEN)
    const res = await app.inject({ url: `/api/profile/${TRADER}` })
    expect(res.statusCode).toBe(200)
    const p = res.json<ProfileResponse>()
    expect(p.holdings).toHaveLength(1)
    expect(p.holdings[0]!.pnlWithheldReason).toBeNull()
    expect(p.holdings[0]!.balance).toBe((40_000_000n * TOKEN).toString())
    expect(p.holdings[0]!.unrealizedPnlUsd).not.toBeNull()
    expect(p.totals.tradeCount).toBe(2)

    // A transfer we cannot see → balance mismatch → PnL withheld, never guessed.
    fake.balances.set(TRADER, 41_000_000n * TOKEN)
    const withheld = (await app.inject({ url: `/api/profile/${TRADER}` })).json<ProfileResponse>()
    expect(withheld.holdings[0]!.pnlWithheldReason).toBe('balance_mismatch')
    expect(withheld.totals.unrealizedPnlUsd).toBeNull()

    const creator = (await app.inject({ url: `/api/profile/${CREATOR}` })).json<ProfileResponse>()
    expect(creator.launches).toHaveLength(1)
    expect(creator.launches[0]!.creatorFeesClaimable).toBe((7n * USDG).toString())
    expect(creator.totals.claimableCreatorFeesUsd).toBe(7)

    const activity = (await app.inject({ url: `/api/profile/${CREATOR}/activity` })).json()
    expect(activity.entries.map((e: { kind: string }) => e.kind)).toEqual(['buy', 'launch'])
  })

  it('gates chat on a valid signature and a balance', async () => {
    const issuedAt = Date.now()
    const text = 'gm holders'
    const message = buildAuthMessage({ action: 'chat', chainId: env.CHAIN_ID, address: TRADER, token: TOKEN_ADDR, issuedAt, payload: keccak256(toHex(text)) })
    const signature = await trader.signMessage({ message })

    fake.balances.set(TRADER, 0n)
    const noBalance = await app.inject({ method: 'POST', url: `/api/tokens/${TOKEN_ADDR}/messages`, payload: { address: TRADER, issuedAt, signature, body: text } })
    expect(noBalance.statusCode).toBe(403)

    fake.balances.set(TRADER, 1n)
    const ok = await app.inject({ method: 'POST', url: `/api/tokens/${TOKEN_ADDR}/messages`, payload: { address: TRADER, issuedAt, signature, body: text } })
    expect(ok.statusCode).toBe(201)

    const tampered = await app.inject({ method: 'POST', url: `/api/tokens/${TOKEN_ADDR}/messages`, payload: { address: TRADER, issuedAt, signature, body: 'different text' } })
    expect(tampered.statusCode).toBe(401)

    const link = await app.inject({ method: 'POST', url: `/api/tokens/${TOKEN_ADDR}/messages`, payload: { address: TRADER, issuedAt, signature, body: 'visit evil.com now' } })
    expect(link.statusCode).toBe(400)

    const list = (await app.inject({ url: `/api/tokens/${TOKEN_ADDR}/messages` })).json()
    expect(list.items).toHaveLength(1)
    expect(list.items[0].body).toBe(text)
    expect(await MessageModel.countDocuments()).toBe(1)
  })

  it('lets only the creator edit links', async () => {
    const issuedAt = Date.now()
    const payload = keccak256(toHex(JSON.stringify({ x: 'hoodium', telegram: null, website: null })))
    const message = buildAuthMessage({ action: 'links', chainId: env.CHAIN_ID, address: TRADER, token: TOKEN_ADDR, issuedAt, payload })
    const signature = await trader.signMessage({ message })
    const res = await app.inject({ method: 'POST', url: `/api/tokens/${TOKEN_ADDR}/links`, payload: { address: TRADER, issuedAt, signature, x: 'hoodium' } })
    expect(res.statusCode).toBe(403)
  })

  it('refuses pinning without a JWT, and reports health/config', async () => {
    const pin = await app.inject({ method: 'POST', url: '/api/metadata', payload: { name: 'x', symbol: 'X' } })
    expect(pin.statusCode).toBe(503)
    const health = (await app.inject({ url: '/health' })).json()
    expect(health.ok).toBe(true)
    expect(health.indexer.lastProcessedBlock).toBe(100)
    const config = (await app.inject({ url: '/api/config' })).json()
    expect(config.factoryAddress).toBe(FACTORY)
    expect(config.terms.graduationTarget).toBe(terms.graduationTarget)
    expect(config.pinningEnabled).toBe(false)
  })

  it('rewinds after a reorg and rebuilds the token from surviving trades', async () => {
    // Blocks 90+ are now on fork "b": the sell at block 90 never happened.
    fake.fork = 'b'
    fake.logs = fake.logs.filter((l) => (l.blockNumber as bigint) < 90n)
    fake.head = 101

    const r1 = await indexer.runOnce()
    expect(r1.caughtUp).toBe(false) // the rewind cycle
    const cursor = await CursorModel.findOne({ name: CURSOR_NAME }).lean()
    expect(cursor!.reorgCount).toBe(1)
    expect(cursor!.lastProcessedBlock).toBe(89)

    const r2 = await indexer.runOnce()
    expect(r2.caughtUp).toBe(true)
    expect(await TradeModel.countDocuments({ tokenAddress: TOKEN_ADDR })).toBe(2)
    const token = await TokenModel.findOne({ tokenAddress: TOKEN_ADDR }).lean()
    expect(token!.tradeCount).toBe(2)
    expect(token!.reserveUsdg).toBe((1_485n * USDG).toString())
    expect(token!.volumeUsdg).toBe((1_500n * USDG).toString())
    const holder = await HolderModel.findOne({ tokenAddress: TOKEN_ADDR, holder: TRADER }).lean()
    expect(holder!.balance).toBe((50_000_000n * TOKEN).toString())
  })

  it('serves empty lists when nothing is indexed for another chain', async () => {
    const other = loadEnv({ ...process.env, MONGO_URI: env.MONGO_URI, RPC_URL: 'http://fake.invalid', CHAIN_ID: '31337', LAUNCHPAD_FACTORY: '' })
    const idle = new LaunchpadIndexer(other, chain)
    await idle.start() // idles: no factory
    expect(idle.status().enabled).toBe(false)
    const app2 = await buildServer({ env: other, chain, indexerStatus: () => idle.status(), startedAt: Date.now() })
    const body = (await app2.inject({ url: '/api/tokens' })).json<TokenListResponse>()
    expect(body.items).toEqual([])
    expect(body.counts.launched).toBe(0)
    const config = (await app2.inject({ url: '/api/config' })).json()
    expect(config.factoryAddress).toBeNull()
    await app2.close()
  })
})
