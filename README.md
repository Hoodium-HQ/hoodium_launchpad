# Hoodium Launchpad

Fixed-supply token launches on Robinhood Chain, priced in USDG on a bonding
curve, graduating into a Uniswap v3 pool whose liquidity is locked forever.

Live at **https://launchpad.hoodium.app** (web) and
**https://launchpad-api.hoodium.app** (API + indexer).

| Package | What | Runs on |
|---|---|---|
| [`contracts/`](contracts/) | Foundry: `HoodiumFactory`, `BondingCurve`, `GraduationManager`, `LPLocker`, `FeeVault`, `HoodiumToken` | Deployed by the owner from their machine |
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
  reserves; 1B supply, 800M sold on the curve, 200M reserved for the pool.
- 1% fee on every curve trade, 70% creator / 30% platform (`FeeVault`).
- At the graduation target the curve closes atomically and seeds a full-range
  Uniswap v3 pool held by `LPLocker`, which has no withdrawal path. Locked-LP
  fees are shared 70/30 creator / protocol.
- Anti-snipe: the first three blocks cap a buy at 1% of supply.

## Status

Contracts pass their test suite but have **not** been externally audited and
are **not yet deployed**. The web and API run against an empty factory until
they are. See `contracts/README.md` for the deploy runbook.
