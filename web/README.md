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

`scripts/mock-api.mjs` serves the shapes in `src/lib/launchpad-api.ts`.
`API_NEEDS.md` is the list of endpoints and fields the app consumes.

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
  hoodium.app. Edit-links and metadata pinning still send cookies, so an API
  that gates them needs its own session flow (see `API_NEEDS.md`).
- Nothing is promoted. Every ordering is a plain sort on a measured column and
  there is no field anywhere to boost a token.
