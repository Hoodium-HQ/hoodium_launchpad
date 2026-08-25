#!/usr/bin/env node
/**
 * A stand-in for `../api` so the web app can be run and screenshotted before
 * the contracts are deployed. Serves the shapes in `src/lib/launchpad-api.ts`
 * from generated fixtures. `MOCK_EMPTY=1` serves an empty launchpad.
 *
 *   node scripts/mock-api.mjs            # http://127.0.0.1:8080
 *   MOCK_EMPTY=1 node scripts/mock-api.mjs
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const EMPTY = process.env.MOCK_EMPTY === '1'

const NAMES = ['Hood Cat', 'Robin Pepe', 'Green Candle', 'Chartreuse', 'Moon Owl', 'Diamond Paws', 'Ledger Lad', 'Curve Frog', 'Gas Goblin', 'Quiet Whale', 'Tick Spacing', 'Vault Dog', 'Slippage', 'Lock Lizard', 'Basis Point', 'Pool Party', 'Fee Vault', 'Wen Lambo', 'Sniper Cap', 'Dev Buy']
const SYMBOLS = ['HCAT', 'RPEPE', 'CANDLE', 'CHART', 'MOWL', 'PAWS', 'LEDGER', 'FROG', 'GAS', 'WHALE', 'TICK', 'VDOG', 'SLIP', 'LIZ', 'BPS', 'POOL', 'FEEV', 'LAMBO', 'SNIPE', 'DEVB']

const seeded = (n) => () => ((n = (n * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const rand = seeded(42)
const hex = (len) => Array.from({ length: len }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('')
const addr = () => `0x${hex(40)}`
const ago = (s) => new Date(Date.now() - s * 1000).toISOString()

const CREATOR = '0x0a9c2f1d3e4b5a6c7d8e9f0a1b2c3d4e5f6a7b69'
const TARGET = 20_000n * 10n ** 6n
const SUPPLY = 10n ** 27n

function makeToken(i) {
  const graduated = i < 6
  const progressBps = graduated ? 10_000 : Math.floor(rand() * 9_500) + 200
  const raised = graduated ? TARGET : (TARGET * BigInt(progressBps)) / 10_000n
  const price = 5_000n * 10n ** 6n * 10n ** 18n / (8n * 10n ** 26n + 2n * 10n ** 26n - (8n * 10n ** 26n * BigInt(progressBps)) / 10_000n / 2n)
  const mc = (price * SUPPLY) / 10n ** 18n
  const createdAgo = graduated ? 42 * 86_400 + i * 86_400 : Math.floor(rand() * 3 * 86_400) + i * 7
  return {
    address: addr(),
    curve: addr(),
    name: NAMES[i % NAMES.length],
    symbol: SYMBOLS[i % SYMBOLS.length],
    image: null,
    creator: i % 3 === 0 ? CREATOR : addr(),
    createdAt: ago(createdAgo),
    marketCapUsd: (Number(mc) / 1e6 * (graduated ? 40 : 1)).toFixed(2),
    fdvUsd: (Number(mc) / 1e6 * (graduated ? 56 : 1)).toFixed(2),
    progressBps,
    volume: String(raised * 3n),
    lastTradeAt: ago(Math.floor(rand() * 600)),
    graduated,
    pool: graduated ? addr() : null,
    description: 'A meme coin of a cat waiting for his food. No utility, no roadmap, no promises.',
    x: i % 2 ? 'hoodium' : null,
    telegram: null,
    metadataURI: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    status: graduated ? 'graduated' : 'live',
    raised: String(raised),
    target: String(TARGET),
    price: String(price),
    totalSupply: String(SUPPLY),
    volumeAll: String(raised * 3n),
    volume24h: String(raised / 2n),
    tradeCount: 40 + i * 13,
    holderCount: 12 + i * 5,
    fees: { tradeFeeBps: 100, creatorShareBps: 7_000, lpCreatorShareBps: 7_000 },
    lpTokenId: graduated ? String(1000 + i) : null,
    graduatedAt: graduated ? ago(createdAgo - 86_400) : null,
    risk: {
      creatorSharePct: i % 4 === 0 ? '23.4' : '4.1',
      priorLaunches: i % 3,
      priorGraduations: 0,
      hasConfusableSymbol: false,
      flags: i % 4 === 0 ? ['creator_concentration'] : [],
    },
  }
}

const TOKENS = EMPTY ? [] : Array.from({ length: 47 }, (_, i) => makeToken(i))

const summary = (t) => ({
  address: t.address, name: t.name, symbol: t.symbol, image: t.image, creator: t.creator, createdAt: t.createdAt,
  marketCapUsd: t.marketCapUsd, fdvUsd: t.fdvUsd, progressBps: t.progressBps, volume: t.volume,
  lastTradeAt: t.lastTradeAt, graduated: t.graduated, pool: t.pool,
})

function trades(t, page, limit) {
  const total = t.tradeCount
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => {
    const n = (page - 1) * limit + i
    const side = n % 3 === 0 ? 'sell' : 'buy'
    return {
      side, trader: n % 5 === 0 ? CREATOR : addr(),
      quoteAmount: String(BigInt(Math.floor(rand() * 400 + 5)) * 10n ** 6n),
      tokenAmount: String(BigInt(Math.floor(rand() * 900_000 + 1_000)) * 10n ** 18n),
      price: t.price, venue: t.graduated && n < 10 ? 'pool' : 'curve',
      txHash: `0x${hex(64)}`, blockNumber: 9_000_000 - n * 3, at: ago(n * 97 + 8), finalized: n > 1,
    }
  })
  return { items, total, page, limit }
}

function holders(t, page, limit) {
  const total = t.holderCount
  const items = Array.from({ length: Math.max(0, Math.min(limit, total - (page - 1) * limit)) }, (_, i) => {
    const n = (page - 1) * limit + i
    return {
      address: n === 0 ? t.creator : addr(),
      balance: String(BigInt(Math.floor(40_000_000 / (n + 1))) * 10n ** 18n),
      sharePct: (12 / (n + 1)).toFixed(2), isCreator: n === 0,
    }
  })
  return { items, total, page, limit }
}

function candles(t, interval) {
  const step = { '5m': 300, '1h': 3600, '6h': 21600, '1d': 86400, all: 86400 }[interval] ?? 3600
  const n = 60
  let level = Number(t.price) * 0.6
  const out = []
  for (let i = n; i > 0; i--) {
    const o = level
    level = level * (1 + (rand() - 0.45) * 0.06)
    const c = level
    out.push({ t: Math.floor(Date.now() / 1000) - i * step, o: Math.floor(o).toString(), h: Math.floor(Math.max(o, c) * 1.02).toString(), l: Math.floor(Math.min(o, c) * 0.98).toString(), c: Math.floor(c).toString(), v: String(BigInt(Math.floor(rand() * 5000)) * 10n ** 6n) })
  }
  return { interval, candles: out }
}

function profile(address) {
  const launches = TOKENS.filter((t) => t.creator.toLowerCase() === address.toLowerCase()).map(summary)
  const held = TOKENS.slice(3, 8)
  return {
    address,
    holdings: held.map((t) => ({ token: summary(t), balance: String(2_500_000n * 10n ** 18n), valueQuote: String(180n * 10n ** 6n), costBasisQuote: String(120n * 10n ** 6n), pnlQuote: String(60n * 10n ** 6n) })),
    launches,
    claimable: launches.slice(0, 2).map((s) => ({ token: s, curve: TOKENS.find((t) => t.address === s.address).curve, amount: String(37_500_000n) })),
    activity: held.map((t, i) => ({ kind: i === 0 ? 'launch' : i % 2 ? 'buy' : 'sell', token: summary(t), quoteAmount: String(50n * 10n ** 6n), tokenAmount: String(900_000n * 10n ** 18n), txHash: `0x${hex(64)}`, at: ago(i * 3600) })),
  }
}

const CONFIG = {
  factoryAddress: null, quoteSymbol: 'USDG', quoteAddress: '', quoteDecimals: 6, chainId: 31337, pinningEnabled: false,
  terms: null,
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const q = url.searchParams
  const send = (body, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') return send({})
  const p = url.pathname

  if (p === '/health') return send({ status: 'ok', chainId: 31337, indexedBlock: 9_000_000 })
  if (p === '/api/config') return send(CONFIG)

  if (p === '/api/tokens') {
    const status = q.get('status'), sort = q.get('sort') ?? 'recent_buys', page = Number(q.get('page') ?? 1), limit = Number(q.get('limit') ?? 20), search = (q.get('q') ?? '').toLowerCase()
    let list = TOKENS.filter((t) => (status === 'graduated' ? t.graduated : status === 'live' ? !t.graduated : true))
    if (search) list = list.filter((t) => t.name.toLowerCase().includes(search) || t.symbol.toLowerCase().includes(search) || t.address.includes(search))
    const key = { recent_buys: (t) => -Date.parse(t.lastTradeAt), newest: (t) => -Date.parse(t.createdAt), oldest: (t) => Date.parse(t.createdAt), market_cap: (t) => -Number(t.marketCapUsd), volume: (t) => -Number(t.volume) }[sort]
    list = [...list].sort((a, b) => key(a) - key(b))
    return send({ items: list.slice((page - 1) * limit, page * limit).map(summary), total: list.length, page, limit, counts: { graduated: TOKENS.filter((t) => t.graduated).length, launched: TOKENS.filter((t) => !t.graduated).length } })
  }

  const m = p.match(/^\/api\/tokens\/(0x[0-9a-fA-F]{40})(?:\/(trades|holders|candles|image))?$/)
  if (m) {
    const t = TOKENS.find((x) => x.address.toLowerCase() === m[1].toLowerCase())
    if (!t) return send({ error: 'token not found' }, 404)
    if (!m[2]) return send(t)
    if (m[2] === 'trades') return send(trades(t, Number(q.get('page') ?? 1), Number(q.get('limit') ?? 25)))
    if (m[2] === 'holders') return send(holders(t, Number(q.get('page') ?? 1), Number(q.get('limit') ?? 25)))
    if (m[2] === 'candles') return send(candles(t, q.get('interval') ?? '1h'))
    return send({ error: 'no artwork' }, 404)
  }

  const pm = p.match(/^\/api\/profile\/(0x[0-9a-fA-F]{40})$/)
  if (pm) return send(EMPTY ? { address: pm[1], holdings: [], launches: [], claimable: [], activity: [] } : profile(pm[1]))

  send({ error: 'not found' }, 404)
}).listen(PORT, () => console.log(`mock launchpad api on http://127.0.0.1:${PORT}${EMPTY ? ' (empty)' : ''}`))
