# @hoodium/launchpad-api

One deployable service for the Hoodium Launchpad (spec 002): the on-chain event
indexer and the HTTP API the launchpad web app reads, in a single Node process.

- **Indexer** — polls `getLogs` from the `HoodiumFactory` and every
  `BondingCurve` it has seen, keeps one cursor in Mongo, buffers recent block
  headers to detect and rewind reorgs, and maintains per-token aggregates,
  holder balances and the rolling 24h/7d sort keys.
- **API** — Fastify 5: explore list, token page, trades, holders, candles,
  price series, profile/portfolio, creator fees, token chat, creator link
  edits, Pinata metadata pinning, launch terms, health.

No dependency on `@hoodium/core` or `@hoodium/shared`: curve math, ABIs and the
small helpers are vendored under `src/`, so a plain `npm ci` installs it.

## Architecture

```
src/
  index.ts              boot: env → RPC chain-id check → Mongo → listen → indexer
  config/env.ts         zod-validated environment (fails fast)
  chain/client.ts       single-endpoint viem client with a chain-id assertion
  chain/abi.ts          vendored ABIs (factory, curve, locker, manager, erc20)
  curve/index.ts        bonding-curve math, byte-identical to @hoodium/shared/curve
  db/models.ts          tokens, trades, holders, messages, indexer_cursors
  db/connect.ts         mongoose connect + syncIndexes
  indexer/indexer.ts    the polling loop, reorg rewind, token rebuild
  indexer/reorg.ts      pure header-buffer helpers (vendored from the worker)
  indexer/stats.ts      rolling 24h/7d volume/trade-count refresher
  services/terms.ts     launch terms read from the factory (cached for the process)
  services/ipfs.ts      CID-only IPFS reads (never fetches a URL it was handed)
  services/pinata.ts    pinning + magic-byte image sniffing
  services/risk.ts      creator risk flags (LP-5.4)
  services/portfolio.ts average-cost PnL, reconciled against balanceOf
  services/candles.ts   OHLC bucketing from trades
  api/server.ts         fastify + cors + rate-limit + /health + /api/config
  api/routes/tokens.ts  explore + token page reads
  api/routes/profile.ts profile + activity
  api/routes/writes.ts  metadata pin, links, chat
  auth.ts               EIP-191 signed-request envelope for writes
  types.ts              every response shape — dependency-free, copy it into the web app
```

### Data model notes

- Exact on-chain amounts are decimal strings in base units, end to end. Alongside
  them each token carries floating `…Usd` sort keys (`marketCapUsd`,
  `volumeUsd24h`, `volumeUsd7d`, `volumeUsdAll`, `priceUsd`) derived from the
  exact fields so the explore page can sort and paginate in Mongo. USDG is
  treated as $1.
- Holder balances are reconstructed from curve trades only (`basis: 'curve_trades'`);
  an ERC-20 `transfer` is invisible. The profile reconciles every open position
  against the live `balanceOf` and withholds PnL on a mismatch rather than guessing.
- Price after each trade is the curve's spot price (from the launch terms and the
  event's `reserveAfter`/`tokensSoldAfter`), not the trade's average fill.
- `finalized` flips once a trade is `INDEXER_CONFIRMATIONS` blocks deep.

### Indexer cycle

1. Load the cursor (`indexer_cursors`, name `launchpad`). Check the newest buffered
   header is still canonical; if not, walk back to the common ancestor, delete
   trades above it, drop launches/graduations above it, rebuild the affected
   tokens (aggregates + holder ledger) from surviving trades, and rewind.
2. `getLogs` on the factory for `[cursor+1, cursor+GETLOGS_MAX_RANGE]` → upsert
   tokens, recompute risk, resolve IPFS metadata (detached).
3. `getLogs` by curve-event **topics** across all addresses for the same range,
   keeping only emitters in the known-curve index → trades, graduations,
   creator-fee claims.
4. Buffer headers inside the reorg window, advance the cursor, mark finalized trades.
5. Every `STATS_REFRESH_MS`, recompute the 24h/7d rolling keys from `trades`.

When `LAUNCHPAD_FACTORY` is empty or the zero address the indexer idles and the
API serves empty lists and `terms: null` — the contracts are not deployed yet.

### Contract mechanics the indexer relies on (post security fix pass)

- **The completing buy graduates.** The buy that brings the reserve to the
  target calls the migration in the same transaction, so `Bought` and
  `Graduated` arrive from one tx, in that order; the loop applies them in log
  order and the token flips to `graduated` in the same cycle. `sell` reverts
  `CurveComplete` once the target is reached. The external `graduate()` remains
  only for a dev buy that completes the curve at launch.
- **`virtualUsdg` is derived, not configured.** The factory computes both
  virtual reserves from the allocations and target so the pool opens at the
  curve's closing price (23,000 USDG with the deploy defaults). `terms.ts`
  still reads it from `virtualUsdg()` — nothing here assumes a value.
- **Trades carry a `deadline`** (`buy(usdgIn, minTokensOut, deadline)`,
  `sell(tokensIn, minUsdgOut, deadline)`). The indexer decodes events only,
  never calldata, so the extra argument changes nothing here; the fragments in
  `chain/abi.ts` carry it for anyone simulating a trade server-side.
- **Anti-snipe is cumulative per address** (`boughtInWindow`), not per call.
- **Fees and dust are pull-based.** The graduation fee accrues on the curve
  (`claimPlatformFees`, anyone), migration dust is credited on the manager
  (`dustOf` / `pullDust`), and the locker's protocol share can be swept by
  anyone (`sweepProtocolFees`) with the creator's share held in
  `creatorOwed0/1`. None of these is indexed; the web reads them live.
- `pool()` and `lpTokenId()` are now curve getters too; the indexer keeps
  taking both from the `Graduated` event, which always carries them.

### The `terms.ts` bug

The historical `terms.ts` imported a symbol named `factoryAbi`, which in one
revision resolved to the *Uniswap* factory ABI; every terms read then reverted
and the launch form showed "terms unavailable". This service imports
`launchpadFactoryAbi` by its full name and never aliases the two.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | DB + indexer status (`lastProcessedBlock`, `chainHeadBlock`, `lag`, `lastError`) |
| GET | `/api/config` | chain, factory, USDG, `pinningEnabled`, launch `terms` (null if unreadable) |
| GET | `/api/tokens` | `status=live\|graduated\|all`, `sort=recent_buys\|newest\|oldest\|market_cap\|volume\|progress\|recent`, `window=all\|24h\|7d`, `q`, `creator`, `page`, `limit` (≤100). Returns `items`, `total`, `hasMore`, `counts{launched,graduated,live,matched}` |
| GET | `/api/tokens/:address` | token detail + `curveState` (raised/target/price/progress/fee split/locker share) + ATH |
| GET | `/api/tokens/:address/trades` | `page`, `limit` (≤200), `side`, `trader` |
| GET | `/api/tokens/:address/holders` | `page`, `limit` (≤200); `sharePct` of tokens sold, `isCreator` |
| GET | `/api/tokens/:address/candles` | `interval=1m\|5m\|15m\|1h\|6h\|1d\|all`, `from`, `to` (unix s), `fill=0` to skip flat fill |
| GET | `/api/tokens/:address/price-series` | trade-by-trade points, `window=1h\|6h\|1d\|7d\|30d\|all` |
| GET | `/api/tokens/:address/image` | artwork proxied from the IPFS gateway (from our indexed CID only) |
| GET | `/api/tokens/:address/messages` | chat, `limit`, `before` |
| POST | `/api/tokens/:address/messages` | signed; must hold the token (live `balanceOf`) or be the creator; no links |
| POST | `/api/tokens/:address/links` | signed by the creator; `x`, `telegram`, `website` overlay |
| POST | `/api/metadata` | pin image + JSON to Pinata → `{ uri, imageUri }`; 503 without `PINATA_JWT` |
| GET | `/api/profile/:address` | holdings (reconciled PnL), closed positions, launches with claimable creator fees, totals |
| GET | `/api/profile/:address/activity` | buys/sells/launches newest first |

Response shapes live in `src/types.ts`.

### Signed writes

Chat and link edits carry `{ address, issuedAt, signature }` where `signature`
is `personal_sign` over `buildAuthMessage(...)` from `src/auth.ts`:

```
Hoodium Launchpad
action: chat
chain: 4663
address: 0x…
token: 0x…
issued: 1724500000000
payload: 0x<keccak256(body)>          # chat: keccak256(toHex(body))
                                      # links: keccak256(toHex(JSON.stringify({x,telegram,website})))
```

Signatures older than 5 minutes are refused.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `LOG_LEVEL` | `info` | pino level |
| `MONGO_URI` | — (required) | connection string |
| `MONGO_DB_NAME` | `hoodium_launchpad` | database |
| `RPC_URL` | — (required) | JSON-RPC endpoint; must report `CHAIN_ID` or boot fails |
| `RPC_TIMEOUT_MS` | `10000` | per-request timeout |
| `CHAIN_ID` | `4663` | Robinhood Chain |
| `LAUNCHPAD_FACTORY` | empty | factory address; empty/zero = idle |
| `USDG_ADDRESS` | empty | quote token, reported by `/api/config` |
| `USDG_DECIMALS` | `6` | for `…Usd` floats |
| `TOKEN_DECIMALS` | `18` | fallback when the terms are unreadable |
| `INDEXER_ENABLED` | `true` | run the loop in this process |
| `INDEXER_POLL_MS` | `4000` | poll interval |
| `INDEXER_START_BLOCK` | `0` | first block when no cursor exists (set to the factory deploy block) |
| `GETLOGS_MAX_RANGE` | `2000` | widest `getLogs` window the RPC serves |
| `INDEXER_CONFIRMATIONS` | `32` | finality depth |
| `INDEXER_REORG_BUFFER_BLOCKS` | `64` | headers kept for reorg detection |
| `STATS_REFRESH_MS` | `30000` | rolling 24h/7d refresh |
| `PINATA_JWT` | empty | enables `POST /api/metadata` |
| `PINATA_API_URL` | `https://api.pinata.cloud` | |
| `IPFS_GATEWAY_URL` | `https://gateway.pinata.cloud` | reads |
| `CORS_ORIGINS` | `https://launchpad.hoodium.app` | comma list |
| `APP_ORIGIN` | `https://launchpad.hoodium.app` | reported by `/api/config` |

## Run locally

There is no Node on the Hoodium server; run everything through docker mounted at
the same absolute path:

```bash
cd /home/ubuntu/hoodium/hoodium_launchpad/api
D="sudo docker run --rm -v $PWD:$PWD -w $PWD node:22"
$D bash -c "npm ci && npm run typecheck && npm test"      # pure tests
$D bash -c "npm run build"                               # → dist/

# Mongo-backed suite (one file at a time — mongo:8 segfaults under parallel files)
sudo docker run -d --name lp-mongo-test --network host mongo:8 --replSet rs0 --port 27117 --bind_ip_all
sudo docker exec lp-mongo-test mongosh --port 27117 --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27117"}]})'
sudo docker run --rm --network host -e MONGO_TEST_URI='mongodb://127.0.0.1:27117/?directConnection=true' \
  -v $PWD:$PWD -w $PWD node:22 bash -c "npx vitest run test/integration.test.ts"
sudo docker rm -f lp-mongo-test

# Boot it
cp .env.example .env   # edit
sudo docker run --rm --network host --env-file .env -v $PWD:$PWD -w $PWD node:22 node dist/index.js
curl -s localhost:8080/health
```

On a laptop with Node ≥ 20.11: `npm ci && npm run dev`.

## Deploy on Coolify (nixpacks)

- Application type: nixpacks, base directory `api/` of the `hoodium_launchpad`
  repo. Nixpacks detects `package-lock.json` and runs `npm ci` → `npm run build`
  → `npm start` (`node dist/index.js`). No extra config is needed; `engines.node`
  pins ≥ 20.
- Health check: `GET /health` on `PORT` (default 8080).
- Set the environment variables above. Until the contracts are deployed leave
  `LAUNCHPAD_FACTORY` empty; the service boots, serves empty lists, and starts
  indexing the moment the variable is set and the app is redeployed (remember:
  Coolify stores an env PATCH without restarting — redeploy after).
- When the factory goes live set `INDEXER_START_BLOCK` to its deploy block so
  the first sync does not walk the whole chain in 2000-block windows.
- One replica only: the indexer holds the cursor and the reorg buffer, which do
  not survive a second writer. If the API ever needs to scale out, run extra
  replicas with `INDEXER_ENABLED=false`.
- Mongo: point `MONGO_URI` at the existing Coolify Mongo service; the database
  `hoodium_launchpad` is created on first write.

## Tests

```
test/curve.test.ts        curve math invariants (vendored from shared)
test/reorg.test.ts        header-buffer / common-ancestor helpers
test/env.test.ts          env defaults, zero-factory handling, fail-fast
test/auth.test.ts         signed envelope: binding, expiry, bad signer
test/ipfs.test.ts         CID parsing, website URL, image sniffing, risk flags, amounts
test/candles.test.ts      OHLC bucketing and flat fill
test/portfolio.test.ts    average-cost accounting
test/integration.test.ts  (MONGO_TEST_URI) fake chain → indexer → every route; reorg rewind
```

## ABIs

`../contracts/abi/*.json` did not exist when this was written; `src/chain/abi.ts`
transcribes the events and getters from `contracts/src/*.sol` by hand. When the
generated ABIs land, replace the `parseAbi` fragments with JSON imports — the
names used are the contracts' own.
