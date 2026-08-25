# What the web app reads from `../api`

The client lives in `src/lib/launchpad-api.ts`; the types there are the
contract. This file lists what the app consumes **beyond** the endpoints that
were specified up front, and the exact field names it expects on the ones that
were. Everything monetary is a decimal string of base units (`Money`), never a
JSON number. `*Usd` fields are whole USD and may carry decimals.

## Specified endpoints — field names the app relies on

`GET /api/tokens?status=graduated|live&sort=recent_buys|newest|oldest|market_cap|volume&window=all|24h|7d&page&limit&q`
→ `{ items: TokenSummary[], total, page, limit, counts: { graduated, launched } }`

- `page` is **1-based**.
- `q` matches name, symbol or address (case-insensitive substring). Used by the
  ⌘K search with `limit=8`.
- `TokenSummary.image`: an API-relative path (`/api/tokens/:address/image`) or
  `null`. The app never loads images from any other origin (CSP).
- `counts` should be for the whole factory, not the filtered set — both section
  badges read from whichever response arrives.

`GET /api/tokens/:address` → `TokenDetail` (extends `TokenSummary`) with:
`curve, description, x, telegram, metadataURI, status: 'live'|'graduated',
raised, target, price, totalSupply, volumeAll, volume24h, tradeCount,
holderCount, fees: { tradeFeeBps, creatorShareBps, lpCreatorShareBps|null },
lpTokenId|null, graduatedAt|null, risk: { creatorSharePct|null, priorLaunches,
priorGraduations, hasConfusableSymbol, flags[] }`.

- `price` is quote base units per **whole** token (6-decimal USDG × 1e18 /
  1e18 token), i.e. what `BondingCurve.spotPrice` yields.
- `lpTokenId` is the pointer the pool-fees card needs; everything else about
  the locked position is read on-chain.
- 404 with `{ error }` for an unknown address — the page distinguishes that
  from a transport failure.

`GET /api/tokens/:address/trades?page&limit` and `/holders?page&limit`
→ `{ items, total, page, limit }` (1-based). Trade rows need `venue:
'curve'|'pool'` and `finalized`. Holder rows need `sharePct` (string, 2 dp)
and `isCreator`.

`GET /api/tokens/:address/candles?interval=5m|1h|6h|1d|all`
→ `{ interval, candles: [{ t (unix seconds), o, h, l, c, v }] }`, ascending.
The app draws `c`. An empty array is the correct answer for a token with no
trades.

`GET /api/profile/:address` → `{ address, holdings, launches, claimable, activity }`

- `holdings: [{ token: TokenSummary, balance, valueQuote|null, costBasisQuote|null, pnlQuote|null }]`
- `launches: TokenSummary[]`
- `claimable: [{ token: TokenSummary, curve, amount }]` — `amount` is
  `creatorFeesAccrued − creatorFeesClaimed` on the curve; the navbar badge
  counts entries with a non-zero amount and the Claim button calls
  `curve.claimCreatorFees()` directly.
- `activity: [{ kind: 'buy'|'sell'|'launch', token: TokenSummary, quoteAmount, tokenAmount, txHash|null, at|null }]`,
  newest first, capped at ~100.

## Additional endpoints the app calls

| Endpoint | Used by | Notes |
|---|---|---|
| `GET /health` → `{ status, chainId, indexedBlock? }` | offline banner | a fetch failure (not a non-2xx) is what shows "API unreachable" |
| `GET /api/config` → `LaunchpadConfig` | launch form | `{ factoryAddress|null, quoteSymbol, quoteAddress, quoteDecimals, chainId, pinningEnabled, terms|null }`; `terms` is the factory's immutables (see `LaunchTerms` in the client). `terms: null` makes the form refuse to submit. |
| `POST /api/metadata` → `{ uri, imageUri|null }` | launch form | body `{ name, symbol, description?, x?, telegram?, image?: { contentType, data (base64) } }`; pins to IPFS. Errors as `{ error, code }` with codes `pinning_unavailable`, `link_rejected`, `image_size`, `image_type`, `pinning_failed`. The app sends `credentials: 'include'`; if this is session-gated the API must also expose that session flow (the old SIWE routes were dropped from the web app — an unauthenticated 4xx here simply shows the message). |
| `GET /api/tokens/:address/image` | every avatar | re-served artwork with `content-type` and `nosniff`; 404 falls back to the initials tile |
| `POST /api/tokens/:address/links` → `{ x, telegram }` | creator "Edit links" | body `{ x|null, telegram|null }` (bare handles). Needs a creator check; same session caveat as `/api/metadata`. |

## CORS

The web origin is `https://launchpad.hoodium.app` (and `http://localhost:5173`
in dev). Requests carry `credentials: 'include'`, so
`Access-Control-Allow-Origin` must echo the origin and
`Access-Control-Allow-Credentials: true`.

## Not needed

Token chat, SIWE session routes, ENS resolution, DexScreener/GeckoTerminal
links — all removed from the web app.
