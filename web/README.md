# Hoodium Launchpad — web

The web app for **https://launchpad.hoodium.app**: explore, launch and trade
fixed-supply tokens on Robinhood Chain. Tokens are priced in USDG on a bonding
curve and graduate into a Uniswap v3 pool whose liquidity is locked forever.

Your wallet submits every transaction. The app reads the chain directly for
anything that moves money — quotes, balances, buys, sells, claims — and reads
`../api` for the feed, charts, history and profiles. If the API is down,
trading still works.

## Routes

| Path | What |
|---|---|
| `/` | Explore — search (⌘K), Graduated section, then every token still on the curve with sort / window / pagination |
| `/t/:address` | Token page — about, fee terms, curve progress, risk flags, buy/sell, price + chart, trades / holders, creator + pool fee cards |
| `/create` | Launch form — name, symbol, description, artwork (pinned via the API), links, optional dev buy, confirm dialog with every term read from the factory |
| `/profile` · `/profile/:address` | Holdings, launches, activity; the wallet's own profile also lists claimable creator fees |
| `/launchpad`, `/launchpad/new`, `/launchpad/:address` | Redirects from the launchpad's first life inside hoodium.app |

The navbar wallet pill carries a badge with the number of tokens whose creator
fees are ready; the menu lists them with a Claim button each.

## Stack

Vite · React 18 · TypeScript · Tailwind · wagmi / viem · Reown AppKit ·
react-router 7 · TanStack Query · zustand · lightweight-charts · Geist (bundled).

`src/lib/curve.ts`, `src/lib/money.ts` and `src/lib/launchpad-abi.ts` are
vendored from the retired `@hoodium/shared` package and checked against
`../contracts/src`. Money is `string | bigint` end to end; an ESLint rule
(`eslint-rules/no-number-on-money.js`) rejects `Number()` on anything that
looks like an amount.

## Configuration

Copy `.env.example` to `.env`. Everything is `VITE_`-prefixed and public.

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | `../api` origin |
| `VITE_SITE_URL` | canonical origin, for share links |
| `VITE_CHAIN_ID` · `VITE_CHAIN_NAME` · `VITE_RPC_URL` · `VITE_EXPLORER_URL` | chain identity; the app refuses to act on any other chain |
| `VITE_QUOTE_SYMBOL` · `VITE_QUOTE_DECIMALS` · `VITE_QUOTE_ADDRESS` | USDG |
| `VITE_LAUNCHPAD_FACTORY` | `HoodiumFactory`; empty disables `/create` with an explanation |
| `VITE_LOCKER` | optional `LPLocker` shortcut (else discovered from the factory) |
| `VITE_FEE_VAULT` | `FeeVault`, shown only |
| `VITE_GRADUATION_HELPER` | optional `GraduationHelper`; enables "Fix the pool and buy" when a primed pool blocks the completing buy |
| `VITE_REOWN_PROJECT_ID` | required by AppKit |

No chain-identifying value has a default: a build that does not state its
chain does not build.

## Development

There is no Node on the Hoodium server; everything runs in Docker with the
same absolute path mounted:

```sh
sudo docker run --rm -v "$PWD":"$PWD" -w "$PWD" node:22 bash -c \
  "npm install && npm run typecheck && npm run lint && npm test && npm run build"
```

Check the real exit code — `tsc -b` typechecks `test/` too, and a `| tail`
reports tail's status.

To run the UI without the API or the contracts:

```sh
npm run mock-api            # fixtures on http://127.0.0.1:8080
MOCK_EMPTY=1 npm run mock-api   # an empty launchpad — every empty state
npm run dev                 # http://localhost:5173
```

`scripts/mock-api.mjs` serves the shapes in `src/lib/api-types.ts`.

## The API contract

`src/lib/api-types.ts` is a **verbatim copy** of `../api/src/types.ts` — the
API is the source of truth and the web declares no response shape of its own.
When the API's types change, copy the file over again (`cp ../api/src/types.ts
src/lib/api-types.ts`) and let `tsc` find every consumer. `src/lib/auth.ts`
carries the same relationship to `../api/src/auth.ts`: `buildAuthMessage` must
stay byte-identical or every signed write is a 401.

Two conventions from that file shape every call site:

- exact on-chain amounts are decimal strings of base units (`Money`);
- every `…Usd` field is a JS number for display and sorting; `usdToMoney` in
  `src/lib/money.ts` is the one place it becomes `Money` again.

Writes that need the creator's identity — editing a token's links — carry the
EIP-191 envelope from `src/lib/auth.ts`, signed with the wallet (`useSaveLinks`).
There are no cookies or sessions; requests are sent without credentials, which
is also what the API's CORS reply allows.

### Contract surface (post security fix pass, 2026-08-25)

`src/lib/launchpad-abi.ts` holds human-readable fragments regenerated from
`../contracts/abi/*.json`. What the app relies on:

- `buy(usdgIn, minTokensOut, deadline)` / `sell(tokensIn, minUsdgOut, deadline)`
  — the deadline is `now + 10 minutes`, one constant in `src/lib/deadline.ts`.
  `Expired` and `CurveComplete` reverts are translated in `TxStatus`.
- The buy that reaches the target graduates the curve in the same transaction
  (creates and seeds the pool, so more gas); the trade panel warns when the
  quoted buy would complete the curve. A pool primed with liquidity at a
  hostile price makes that buy revert `PoolPriceManipulated` /
  `UnexpectedSwapPayment` / `RepriceFailed` until the price is arbitraged
  back. When `VITE_GRADUATION_HELPER` is set the panel then offers **Fix the
  pool and buy**: it approves USDG to the helper for `usdgIn + maxFix`
  (`maxFix` defaults to 1% of the buy and is editable) and calls
  `GraduationHelper.fixAndBuy(curve, usdgIn, minTokensOut, deadline, maxFix)`,
  which re-prices the pool through the attacker's own liquidity and completes
  the curve in one transaction; the bought tokens, any arbitrage proceeds and
  the unspent budget all come back to the wallet. Without the helper the copy
  says "try again later". Gas is never hard-coded — the completing buy costs
  several times a normal one and the wallet estimates it. The routing
  decision lives in `src/lib/graduation-fix.ts` (tested). Once
  `curveState.complete`, the Sell side is withdrawn and the panel offers the
  permissionless `graduate()` only for the dev-buy-completion edge.
- `PoolFeesCard`: `collectFees` for the creator; `sweepProtocolFees` for
  anyone (protocol share to the vault, creator share held in
  `creatorOwed0/1`, shown on the card).
- `LeftoverCard`: for the creator of a graduated token, `dustOf(USDG|token,
  creator)` on the graduation manager with a "Pull leftover" action.
- Learn: `virtualUsdg` is derived by the factory (23,000 USDG with the deploy
  defaults) and read from `GET /api/config` when the factory is live; the
  anti-snipe cap is cumulative per address in the window.

### API gaps

What the app would show if the API served it. None of these blocks a release.

- **Pool trades after graduation.** Only bonding-curve trades are indexed, so a
  graduated token's trade list, price, market cap and chart stop at the curve's
  close. Every trade row is therefore labelled "Bonding curve".
- **Holder balances** are reconstructed from curve trades (`basis:
  'curve_trades'`); an ERC-20 transfer is invisible, which the holders tab says.
- **Fee terms** on a token page come from `curveState`, which is `null`-valued
  when the factory cannot be read. The page then says "terms unavailable"
  rather than guessing.
- **Website links**: the API stores and serves `website`, but the app renders
  only the `x` and `telegram` handles and never sends a website when saving
  links (the API normalises URLs before hashing them into the signed payload,
  which the client cannot reproduce byte-for-byte).
- **Closed positions** (`profile.closed`) and the profile `totals` beyond
  `tradeCount` are served but not yet rendered.

## Deploy — Render static site

- Build command: `npm install; npm run build`
- Publish directory: `dist`
- Rewrite rule: `/*` → `/index.html` (SPA)
- Environment: every `VITE_*` above, with `VITE_SITE_URL=https://launchpad.hoodium.app`
- Custom domain: `launchpad.hoodium.app`

Serve the CSP in `index.html` as a response header too (a meta CSP cannot
express `frame-ancestors`). `public/robots.txt` and `public/sitemap.xml`
already point at the production origin.

## What is deliberately not here

- No analytics, no third-party scripts, no font or image host other than our
  own — a page where people sign transactions is a supply-chain surface.
- No token chat, no SIWE sessions, no ENS: dropped with the split from
  hoodium.app. Edit-links is a per-request wallet signature; metadata pinning
  is unauthenticated and rate-limited on the API.
- Nothing is promoted. Every ordering is a plain sort on a measured column and
  there is no field anywhere to boost a token.
