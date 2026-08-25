# Hoodium Launchpad

Fixed-supply token launches on Robinhood Chain, priced in USDG on a bonding
curve, graduating into a Uniswap v3 pool whose liquidity is locked forever.

Live at **https://launchpad.hoodium.app** (web) and
**https://launchpad-api.hoodium.app** (API + indexer).

| Package | What | Runs on |
|---|---|---|
| [`contracts/`](contracts/) | Foundry: `HoodiumFactory`, `BondingCurve`, `GraduationManager`, `LPLocker`, `FeeVault`, `HoodiumToken` + `GraduationHelper` periphery | Deployed by the owner from their machine |
| [`api/`](api/) | Fastify API + the event indexer, Mongo-backed | Coolify (`hoodium-launchpad-api`) |
| [`web/`](web/) | Vite/React app | Render static site |

## Where this came from

Hoodium built a launchpad in July 2026 (spec 002), then deleted it on
2026-08-02 to keep the LP-management product lean. This repo revives that code
from the history of `hoodium_contracts`, `hoodium_backend`, `hoodium_worker`,
`hoodium_core`, `hoodium_shared` and `hoodium_frontend` into one standalone
product. `_history/` holds verbatim copies of the deleted sources for reference
and is not built.

## Mechanics (short)

- Quote token is **USDG** (6 decimals). Constant-product curve over virtual
  reserves derived from the allocations and target (23,000 USDG with the
  defaults) so the pool opens at the curve's closing price; 1B supply, 800M
  sold on the curve, 200M reserved for the pool.
- 1% fee on every curve trade, 70% creator / 30% platform (`FeeVault`). Trades
  carry a deadline.
- The buy that reaches the graduation target closes the curve and seeds a
  full-range Uniswap v3 pool in the same transaction, held by `LPLocker`, which
  has no withdrawal path. Locked-LP fees are shared 70/30 creator / protocol;
  anyone can sweep the protocol's share. Fees and leftovers are pull-based.
- Anti-snipe: for the first three blocks each address may buy at most 1% of
  supply in total.

## Status

Contracts pass their test suite but have **not** been externally audited and
are **not yet deployed**. The web and API run against an empty factory until
they are. See `contracts/README.md` for the deploy runbook.
