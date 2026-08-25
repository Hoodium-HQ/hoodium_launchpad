#!/usr/bin/env node
/**
 * A stand-in for `../api` so the web app can be run and screenshotted without
 * the contracts. Serves the shapes in `src/lib/api-types.ts` (a verbatim copy
 * of `../api/src/types.ts`) from generated fixtures. `MOCK_EMPTY=1` serves an
 * empty launchpad — the state the real API is in before the factory deploys.
 *
 *   node scripts/mock-api.mjs            # http://127.0.0.1:8080
 *   MOCK_EMPTY=1 node scripts/mock-api.mjs
 *
 * Conventions, as in the real thing: exact amounts are decimal strings of base
 * units; every `…Usd` field is a JS number; addresses are lowercase; dates are
 * ISO strings; chart `t` values are unix seconds. Writes accept the signed
 * envelope by shape only — nothing here verifies a signature.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const EMPTY = process.env.MOCK_EMPTY === '1'
const CHAIN_ID = Number(process.env.MOCK_CHAIN_ID ?? 31337)

const NAMES = ['Hood Cat', 'Robin Pepe', 'Green Candle', 'Chartreuse', 'Moon Owl', 'Diamond Paws', 'Ledger Lad', 'Curve Frog', 'Gas Goblin', 'Quiet Whale', 'Tick Spacing', 'Vault Dog', 'Slippage', 'Lock Lizard', 'Basis Point', 'Pool Party', 'Fee Vault', 'Wen Lambo', 'Sniper Cap', 'Dev Buy']
const SYMBOLS = ['HCAT', 'RPEPE', 'CANDLE', 'CHART', 'MOWL', 'PAWS', 'LEDGER', 'FROG', 'GAS', 'WHALE', 'TICK', 'VDOG', 'SLIP', 'LIZ', 'BPS', 'POOL', 'FEEV', 'LAMBO', 'SNIPE', 'DEVB']

const seeded = (n) => () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const rand = seeded(42)
const hex = (len) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('')
const addr = () => `0x${hex(40)}`
/*
 * Per-row generators for the paged feeds. The global `rand` advances on every
 * request, so a re-poll of the same page used to return *different* trades —
 * new txHashes, traders and amounts — which re-keyed every row in the app and
 * replayed its entry fade on each 4s refetch. Rows are seeded from the token
 * and their ordinal instead, so a page reads the same on every request, as it
 * would from the real indexer.
 */
const rowRand = (t, n) => seeded((Number.parseInt(t.address.slice(2, 10), 16) ^ (n * 2654435761)) & 0x7fffffff)
const hexWith = (r, len) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('')
const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
const usd = (baseUnits, decimals = 6) => Number(baseUnits) / 10 ** decimals

const CREATOR = '0x0a9c2f1d3e4b5a6c7d8e9f0a1b2c3d4e5f6a7b69'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const FACTORY = '0xfac70123456789abcdef0123456789abcdef0123'
const TARGET = 20_000n * 10n ** 6n
const SUPPLY = 10n ** 27n
const CURVE_ALLOCATION = (SUPPLY * 80n) / 100n
const VIRTUAL_USDG = 5_000n * 10n ** 6n
const VIRTUAL_TOKENS = (CURVE_ALLOCATION * VIRTUAL_USDG) / TARGET

const TERMS = {
  factoryAddress: FACTORY,
  usdgAddress: USDG,
  feeVault: addr(),
  graduationManager: addr(),
  locker: addr(),
  positionManager: addr(),
  totalSupply: SUPPLY.toString(),
  curveAllocation: CURVE_ALLOCATION.toString(),
  lpAllocation: (SUPPLY - CURVE_ALLOCATION).toString(),
  tokenDecimals: 18,
  virtualUsdg: VIRTUAL_USDG.toString(),
  virtualTokens: VIRTUAL_TOKENS.toString(),
  creationFee: '0',
  graduationTarget: TARGET.toString(),
  graduationFee: '0',
  devBuyCapTokens: ((SUPPLY * 500n) / 10_000n).toString(),
  devBuyMaxBps: 500,
  tradeFeeBps: 100,
  creatorFeeShareBps: 7_000,
  protocolFeeShareBps: 3_000,
  snipeBlocks: 3,
  snipeMaxBps: 100,
}

function makeToken(i) {
  const graduated = i < 6
  const progressBps = graduated ? 10_000 : Math.floor(rand() * 9_500) + 200
  const raised = graduated ? TARGET : (TARGET * BigInt(progressBps)) / 10_000n
  const tokensSold = (CURVE_ALLOCATION * BigInt(progressBps)) / 10_000n
  // Spot price in quote base units per whole token: (vU + raised) / (vT + C - sold) × 1e18.
  const price = ((VIRTUAL_USDG + raised) * 10n ** 18n) / (VIRTUAL_TOKENS + CURVE_ALLOCATION - tokensSold)
  const priceUsd = usd(price)
  const supplyUnits = usd(SUPPLY, 18)
  const marketCapUsd = priceUsd * usd(tokensSold, 18) * (graduated ? 40 : 1)
  const fdvUsd = priceUsd * supplyUnits * (graduated ? 40 : 1)
  const createdAgo = graduated ? 42 * 86_400 + i * 86_400 : Math.floor(rand() * 3 * 86_400) + i * 7
  const volumeAll = raised * 3n
  const volume24h = raised / 2n
  const tradeCount = 40 + i * 13
  const address = addr()
  return {
    address,
    curve: addr(),
    name: NAMES[i % NAMES.length],
    symbol: SYMBOLS[i % SYMBOLS.length],
    image: null,
    description: 'A meme coin of a cat waiting for his food. No utility, no roadmap, no promises.',
    creator: i % 3 === 0 ? CREATOR : addr(),
    createdAt: ago(createdAgo),
    createdBlock: 8_000_000 + i * 1_000,
    status: graduated ? 'graduated' : 'curve',
    graduated,
    pool: graduated ? addr() : null,
    graduatedAt: graduated ? ago(createdAgo - 86_400) : null,
    progressBps,
    priceUsd,
    marketCapUsd,
    fdvUsd,
    volumeUsd: usd(volumeAll),
    volumeUsd24h: usd(volume24h),
    volumeUsdAll: usd(volumeAll),
    tradeCount,
    tradeCountAll: tradeCount,
    holderCount: 12 + i * 5,
    lastTradeAt: ago(Math.floor(rand() * 600)),
    lastBuyAt: ago(Math.floor(rand() * 900)),
    risk: {
      creatorSharePct: i % 4 === 0 ? '23.4' : '4.1',
      priorLaunches: i % 3,
      priorGraduations: 0,
      hasConfusableSymbol: false,
      flags: i % 4 === 0 ? ['creator_concentration'] : [],
      computedAt: ago(60),
    },
    // Detail-only, kept on the same object for simplicity.
    _detail: {
      metadataURI: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      x: i % 2 ? 'hoodium' : null,
      telegram: null,
      website: null,
      curveState: {
        raised: raised.toString(),
        raisedUsd: usd(raised),
        target: TARGET.toString(),
        targetUsd: usd(TARGET),
        remaining: (TARGET - raised).toString(),
        remainingUsd: usd(TARGET - raised),
        progressBps,
        price: price.toString(),
        priceUsd,
        tokensSold: tokensSold.toString(),
        curveAllocation: CURVE_ALLOCATION.toString(),
        totalSupply: SUPPLY.toString(),
        virtualUsdg: VIRTUAL_USDG.toString(),
        virtualTokens: VIRTUAL_TOKENS.toString(),
        tradeFeeBps: TERMS.tradeFeeBps,
        creatorFeeShareBps: TERMS.creatorFeeShareBps,
        platformFeeShareBps: 10_000 - TERMS.creatorFeeShareBps,
        lpProtocolFeeShareBps: TERMS.protocolFeeShareBps,
        complete: graduated,
      },
      devBuyUsdg: i % 3 === 0 ? (250n * 10n ** 6n).toString() : '0',
      devBuyTokens: i % 3 === 0 ? (40_000_000n * 10n ** 18n).toString() : '0',
      buyCount: Math.ceil((tradeCount * 2) / 3),
      sellCount: Math.floor(tradeCount / 3),
      volumeUsdg: volumeAll.toString(),
      feesUsdg: (volumeAll / 100n).toString(),
      creatorFeesClaimedUsdg: (volumeAll / 400n).toString(),
      volumeUsd7d: usd(volumeAll),
      lpTokenId: graduated ? String(1000 + i) : null,
      graduationTxHash: graduated ? `0x${hex(64)}` : null,
      graduationUsdgIn: graduated ? TARGET.toString() : '0',
      graduationTokensIn: graduated ? (SUPPLY - CURVE_ALLOCATION).toString() : '0',
      athPriceUsd: priceUsd * 1.3,
      athMarketCapUsd: fdvUsd * 1.3,
      createdTxHash: `0x${hex(64)}`,
    },
  }
}

const TOKENS = EMPTY ? [] : Array.from({ length: 47 }, (_, i) => makeToken(i))

const item = ({ _detail, ...t }) => t
const detail = ({ _detail, ...t }) => ({ ...t, ..._detail })

function paged(items, total, page, limit) {
  return { items, page, limit, total, hasMore: page * limit < total }
}

function trades(t, page, limit) {
  const total = t.tradeCount
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => {
    const n = (page - 1) * limit + i
    const r = rowRand(t, n)
    const side = n % 3 === 0 ? 'sell' : 'buy'
    const usdgAmount = BigInt(Math.floor(r() * 400 + 5)) * 10n ** 6n
    return {
      side,
      trader: n % 5 === 0 ? t.creator : `0x${hexWith(r, 40)}`,
      usdgAmount: usdgAmount.toString(),
      usdValue: usd(usdgAmount),
      tokenAmount: (BigInt(Math.floor(r() * 900_000 + 1_000)) * 10n ** 18n).toString(),
      feeUsdg: (usdgAmount / 100n).toString(),
      priceUsdg: t._detail.curveState.price,
      priceUsd: t.priceUsd,
      blockNumber: 9_000_000 - n * 3,
      txHash: `0x${hexWith(r, 64)}`,
      logIndex: n % 7,
      at: ago(n * 97 + 8),
      finalized: n > 1,
    }
  })
  return paged(items, total, page, limit)
}

function holders(t, page, limit) {
  const total = t.holderCount
  const sold = BigInt(t._detail.curveState.tokensSold)
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => {
    const n = (page - 1) * limit + i
    const balance = BigInt(Math.floor(40_000_000 / (n + 1))) * 10n ** 18n
    return {
      holder: n === 0 ? t.creator : `0x${hexWith(rowRand(t, n), 40)}`,
      balance: balance.toString(),
      balanceUnits: usd(balance, 18),
      sharePct: sold > 0n ? Number((balance * 10_000n) / sold) / 100 : null,
      isCreator: n === 0,
      isCurve: false,
      firstSeenAt: ago(n * 3_600 + 600),
      lastTradeAt: ago(n * 97 + 8),
    }
  })
  return { ...paged(items, total, page, limit), basis: 'curve_trades', tokensSold: sold.toString() }
}

const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3_600, '6h': 21_600, '1d': 86_400 }

function candles(t, requested) {
  const interval = requested === 'all' ? '6h' : (INTERVALS[requested] ? requested : '5m')
  const step = INTERVALS[interval]
  const n = 60
  const to = Math.floor(Date.now() / 1000)
  const from = to - n * step
  let level = t.priceUsd * 0.6
  const out = []
  for (let i = n; i > 0; i--) {
    const o = level
    level = level * (1 + (rand() - 0.45) * 0.06)
    const c = level
    const buys = Math.floor(rand() * 6)
    const sells = Math.floor(rand() * 3)
    out.push({ t: to - i * step, o, h: Math.max(o, c) * 1.02, l: Math.min(o, c) * 0.98, c, v: Math.floor(rand() * 5000), buys, sells })
  }
  return { interval, from, to, candles: out }
}

function priceSeries(t, window) {
  const hours = { '1h': 1, '6h': 6, '1d': 24, '7d': 168, '30d': 720, all: 720 }[window] ?? 24
  const now = Math.floor(Date.now() / 1000)
  const points = Array.from({ length: 120 }, (_, i) => ({
    t: now - hours * 3600 + Math.floor((i * hours * 3600) / 120),
    priceUsd: t.priceUsd * (0.6 + (i / 120) * 0.4),
  }))
  return { window, points }
}

function launchOf(t) {
  const accrued = BigInt(t._detail.feesUsdg) * 7n / 10n
  const claimed = BigInt(t._detail.creatorFeesClaimedUsdg)
  const claimable = accrued > claimed ? accrued - claimed : 0n
  return {
    address: t.address,
    curve: t.curve,
    name: t.name,
    symbol: t.symbol,
    image: t.image,
    status: t.status,
    graduated: t.graduated,
    pool: t.pool,
    lpTokenId: t._detail.lpTokenId,
    createdAt: t.createdAt,
    marketCapUsd: t.marketCapUsd,
    progressBps: t.progressBps,
    volumeUsd: t.volumeUsdAll,
    holderCount: t.holderCount,
    creatorFeesAccrued: accrued.toString(),
    creatorFeesClaimed: claimed.toString(),
    creatorFeesClaimable: claimable.toString(),
    creatorFeesClaimableUsd: usd(claimable),
  }
}

function holdingOf(t, i) {
  const balance = 2_500_000n * 10n ** 18n
  const value = (balance * BigInt(t._detail.curveState.price)) / 10n ** 18n
  const cost = (value * 2n) / 3n
  const withheld = i === 3
  return {
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    image: t.image,
    status: t.status,
    graduated: t.graduated,
    balance: balance.toString(),
    balanceUnits: usd(balance, 18),
    onChainBalance: withheld ? (balance * 2n).toString() : balance.toString(),
    costBasis: cost.toString(),
    costBasisUsd: usd(cost),
    value: value.toString(),
    valueUsd: usd(value),
    entryPrice: ((BigInt(t._detail.curveState.price) * 2n) / 3n).toString(),
    currentPrice: t._detail.curveState.price,
    currentPriceUsd: t.priceUsd,
    entryMarketCapUsd: t.marketCapUsd * 0.66,
    currentMarketCapUsd: t.marketCapUsd,
    unrealizedPnl: withheld ? null : (value - cost).toString(),
    unrealizedPnlUsd: withheld ? null : usd(value - cost),
    realizedPnl: '0',
    realizedPnlUsd: 0,
    pnlPct: withheld ? null : 50,
    pnlWithheldReason: withheld ? 'balance_mismatch' : null,
    tradeCount: 3 + i,
    firstTradeAt: ago(86_400 * (i + 1)),
    lastTradeAt: t.lastTradeAt,
  }
}

function profile(address) {
  const launches = TOKENS.filter((t) => t.creator === address).map(launchOf)
  const holdings = TOKENS.slice(3, 8).map(holdingOf)
  const withheld = holdings.some((h) => h.unrealizedPnlUsd === null)
  return {
    address,
    holdings,
    closed: [],
    launches,
    totals: {
      valueUsd: holdings.reduce((s, h) => s + h.valueUsd, 0),
      unrealizedPnlUsd: withheld ? null : holdings.reduce((s, h) => s + h.unrealizedPnlUsd, 0),
      realizedPnlUsd: 0,
      claimableCreatorFeesUsd: launches.reduce((s, l) => s + l.creatorFeesClaimableUsd, 0),
      tokensHeld: holdings.length,
      tokensLaunched: launches.length,
      tokensGraduated: launches.filter((l) => l.graduated).length,
      tradeCount: holdings.reduce((s, h) => s + h.tradeCount, 0),
    },
  }
}

function activity(address) {
  const held = TOKENS.slice(3, 8)
  const usdgAmount = 50n * 10n ** 6n
  return {
    entries: held.map((t, i) => ({
      kind: i === 0 && t.creator === address ? 'launch' : i % 2 ? 'buy' : 'sell',
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      usdgAmount: usdgAmount.toString(),
      usdValue: usd(usdgAmount),
      tokenAmount: (900_000n * 10n ** 18n).toString(),
      txHash: `0x${hex(64)}`,
      at: ago(i * 3600),
      finalized: i > 0,
    })),
  }
}

const HEALTH = () => ({
  ok: true,
  service: 'hoodium-launchpad-api',
  chainId: CHAIN_ID,
  factoryConfigured: !EMPTY,
  db: 'up',
  indexer: {
    enabled: !EMPTY,
    running: !EMPTY,
    lastProcessedBlock: EMPTY ? null : 9_000_000,
    chainHeadBlock: EMPTY ? null : 9_000_004,
    lag: EMPTY ? null : 4,
    lastRunAt: EMPTY ? null : ago(2),
    lastError: null,
  },
  uptimeSec: Math.floor(process.uptime()),
})

const CONFIG = {
  chainId: CHAIN_ID,
  factoryAddress: EMPTY ? null : FACTORY,
  usdgAddress: USDG,
  usdgDecimals: 6,
  tokenDecimals: 18,
  appOrigin: 'http://localhost:5173',
  pinningEnabled: false,
  terms: EMPTY ? null : TERMS,
}

const SORT_KEY = {
  recent_buys: (t) => -Date.parse(t.lastBuyAt),
  recent: (t) => -Date.parse(t.lastTradeAt),
  newest: (t) => -Date.parse(t.createdAt),
  oldest: (t) => Date.parse(t.createdAt),
  market_cap: (t) => -t.marketCapUsd,
  progress: (t) => -t.progressBps,
  volume: (t) => -t.volumeUsdAll,
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'))
      } catch {
        resolve(null)
      }
    })
  })
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const q = url.searchParams
  const send = (body, status = 200) => {
    // Mirrors the real CORS reply: origin echoed, no credentials.
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') return send({}, 204)
  const p = url.pathname

  if (p === '/health') return send(HEALTH())
  if (p === '/api/config') return send(CONFIG)

  if (p === '/api/tokens') {
    const status = q.get('status') ?? 'all'
    const sort = SORT_KEY[q.get('sort')] ? q.get('sort') : 'recent_buys'
    const window = ['all', '24h', '7d'].includes(q.get('window')) ? q.get('window') : 'all'
    const page = Math.max(1, Number(q.get('page') ?? 1))
    const limit = Math.min(100, Math.max(1, Number(q.get('limit') ?? 24)))
    const search = (q.get('q') ?? '').toLowerCase()
    const creator = (q.get('creator') ?? '').toLowerCase()

    let list = TOKENS.filter((t) => (status === 'graduated' ? t.graduated : status === 'live' ? !t.graduated : true))
    if (creator) list = list.filter((t) => t.creator === creator)
    if (search) list = list.filter((t) => t.name.toLowerCase().includes(search) || t.symbol.toLowerCase().includes(search) || t.address.includes(search) || t.creator.includes(search))
    const key = SORT_KEY[sort]
    list = [...list].sort((a, b) => key(a) - key(b))

    const items = list.slice((page - 1) * limit, page * limit).map((t) => ({
      ...item(t),
      volumeUsd: window === '24h' ? t.volumeUsd24h : t.volumeUsdAll,
      tradeCount: window === '24h' ? Math.floor(t.tradeCountAll / 4) : t.tradeCountAll,
    }))
    const graduated = TOKENS.filter((t) => t.graduated).length
    return send({
      ...paged(items, list.length, page, limit),
      sort,
      window,
      status,
      counts: { launched: TOKENS.length, graduated, live: TOKENS.length - graduated, matched: list.length },
    })
  }

  const m = p.match(/^\/api\/tokens\/(0x[0-9a-fA-F]{40})(?:\/(trades|holders|candles|price-series|image|links|messages))?$/)
  if (m) {
    const t = TOKENS.find((x) => x.address === m[1].toLowerCase())
    if (!t) return send({ error: 'token not found', code: 'not_found' }, 404)
    const page = Math.max(1, Number(q.get('page') ?? 1))
    const limit = Math.min(200, Math.max(1, Number(q.get('limit') ?? 50)))
    if (!m[2]) return send({ token: detail(t) })
    if (m[2] === 'trades') return send(trades(t, page, limit))
    if (m[2] === 'holders') return send(holders(t, page, limit))
    if (m[2] === 'candles') return send(candles(t, q.get('interval') ?? '5m'))
    if (m[2] === 'price-series') return send(priceSeries(t, q.get('window') ?? '1d'))
    if (m[2] === 'messages') return send({ items: [], hasMore: false })
    if (m[2] === 'links') {
      if (req.method !== 'POST') return send({ error: 'not found' }, 404)
      const body = await readBody(req)
      if (!body || typeof body.signature !== 'string' || typeof body.address !== 'string' || !Number.isFinite(body.issuedAt)) {
        return send({ error: 'invalid body' }, 400)
      }
      if (body.address.toLowerCase() !== t.creator) return send({ error: 'only the creator can edit these links', code: 'forbidden' }, 403)
      const links = { x: body.x ?? null, telegram: body.telegram ?? null, website: body.website ?? null }
      Object.assign(t._detail, links)
      return send(links)
    }
    return send({ error: 'no artwork for this token' }, 404)
  }

  if (p === '/api/metadata' && req.method === 'POST') {
    return send({ error: 'metadata pinning is not configured on this deployment', code: 'pinning_unavailable' }, 503)
  }

  const pm = p.match(/^\/api\/profile\/(0x[0-9a-fA-F]{40})(\/activity)?$/)
  if (pm) {
    const address = pm[1].toLowerCase()
    if (pm[2]) return send(EMPTY ? { entries: [] } : activity(address))
    if (EMPTY) {
      return send({
        address,
        holdings: [],
        closed: [],
        launches: [],
        totals: { valueUsd: 0, unrealizedPnlUsd: 0, realizedPnlUsd: 0, claimableCreatorFeesUsd: 0, tokensHeld: 0, tokensLaunched: 0, tokensGraduated: 0, tradeCount: 0 },
      })
    }
    return send(profile(address))
  }

  send({ error: 'not found' }, 404)
}).listen(PORT, () => console.log(`mock launchpad api on http://127.0.0.1:${PORT}${EMPTY ? ' (empty)' : ''}`))
