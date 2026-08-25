# 002 — Launchpad · Tasks

**Traces:** [requirements.md](requirements.md) · [design.md](design.md) · **Stage:** 3 of 3

Contracts are immutable once deployed (`LP-N1`). There is no patch path, so the testing and
audit tasks below are not optional polish — they are the only defense that exists.

---

## Phase 0 — Modelling

- [ ] **T0.1** Model curve parameters against real launch data from an established launchpad;
      validate the section 2
      placeholders · *design section 2* · **blocking for T2.1**
- [ ] **T0.2** Confirm USDG decimals, transfer semantics, and whether any fee-on-transfer or
      blocklist behavior exists · **blocking** — a blocklisted curve address would freeze
      reserves permanently
- [x] **T0.3** Decide Uniswap v3 vs v4 for graduated pools · *design section 8.1*
      — **the chain has both, and v4 is the live one.** Robinhood Chain (id 4663) has a v4
      singleton deployed at `0x8366a39CC670B4001A1121B8F6A443A643e40951` with its
      PositionManager at `0x58daec3116aae6D93017bAAea7749052E8a04fA7`; Uniswap's indexer
      reports 87 v4 pools against 82 v3. The v4 PositionManager exposes
      `getPoolAndPositionInfo`, returning a `poolKey {currency0, currency1, fee, tickSpacing,
      hooks}` — so positions actually held on this chain are v4, while `GraduationManager`
      and all of Auto LP were written against the v3 `NonfungiblePositionManager`.
      **Consequence:** graduated pools stay v3 for now, because the contracts are written and
      tested for it and `LP-N1` makes them immutable once deployed — but Auto LP must read
      and write v4 to manage what users hold. 003 `R7` builds the v4 path first for that
      reason. Revisiting graduation for v4 hooks is a separate decision, not this one.
- [x] **T0.4** Decide who claims fees on locked LP · *design section 3, section 8.3* ·
      **Decided: 70% creator / 30% protocol.** Implemented in `LPLocker`, immutable, capped at
      50% by construction. The UI disclosure it is conditional on ships with it: `PoolFeesCard`
      states the split to every visitor, reads the percentage from the contract rather than
      hard-coding it, and finds the locker on-chain so the claim path survives our API being
      down (`LP-N7`).

## Phase 1 — Contracts

- [x] **T1.1** `HoodiumToken` — ERC-20, fixed supply, no mint, no owner · *LP-1.2*
- [x] **T1.2** `BondingCurve` — buy/sell over virtual reserves, fixed-point, rounds toward
      the contract · *LP-2.1, LP-2.2, LP-N8*
- [x] **T1.3** Slippage bounds on both sides · *LP-2.4*
- [x] **T1.4** Overshoot handling with same-transaction refund · *LP-2.6*
- [x] **T1.5** Anti-snipe cap for the first N blocks · *LP-2.5*
- [x] **T1.6** Fee split, creator-claimable, platform cannot withdraw the creator share ·
      *LP-3.1, LP-3.2*
- [x] **T1.7** `HoodiumFactory` — single-transaction deploy + optional dev buy · *LP-1.1, LP-1.6*
- [x] **T1.8** `GraduationManager` — atomic migration, permissionless · *LP-4.1, LP-4.2, LP-4.6*
- [x] **T1.9** LP lock contract with no withdrawal path for principal · *LP-4.3*
- [x] **T1.10** Curve permanently disabled post-graduation · *LP-4.4*
- [x] **T1.11** Reentrancy guards on every external state-changing function · *LP-N2*
- [x] **T1.12** `FeeVault` multisig · *LP-3.5*

## Phase 2 — Contract testing

> This phase costs more than Phase 1 and matters more. Budget accordingly.

- [x] **T2.1** Foundry fuzz: `k` never decreases across arbitrary trade sequences · *LP-N4*
- [x] **T2.2** Foundry fuzz: buy→sell round trip never profits the caller · *LP-N4, LP-N8*
- [x] **T2.3** Edge cases: 1 wei, max uint, exact-target buy, overshoot · *LP-2.6*
- [ ] **T2.4** Fork test: full graduation against real Uniswap contracts · *LP-4.1* —
      **not done**: needs a fork RPC and Robinhood Chain's Uniswap addresses
      (004 section 10 open question 3). Mocks cover the call sequence, not Uniswap itself
- [x] **T2.5** Atomicity: inject failure at each migration step, assert full revert · *LP-4.2*
- [x] **T2.6** Reentrancy: malicious token attempts reentry on every entry point · *LP-N2*
- [x] **T2.7** Prove locked LP principal is unrecoverable · *LP-4.3*
- [x] **T2.8** Anti-snipe: oversized first-block buy reverts · *LP-2.5*
- [x] **T2.9** Fee accounting: no value created or destroyed across 10k random trades · *LP-3.4*
      — asserted as an exact solvency identity per trade plus fuzzed splits, rather than
      one 10k-trade run; raise the loop before audit if the literal figure is wanted
- [ ] **T2.10** Testnet deploy + 2-week live soak with real launches
- [ ] **T2.11** **External audit** · *LP-N3* · **blocking for mainnet**

## Phase 3 — Backend

- [x] **T3.1** Extend the Auto LP indexer with launchpad events · *design section 5* · reuses
      `001` T2.1/T2.2 — separate cursor, shared reorg helpers
- [x] **T3.2** `launchpad_tokens` and `launchpad_trades` collections + indexes
- [ ] **T3.3** IPFS metadata pinning · *LP-1.7* — needs a pinning service **and** the
      moderation policy design section 8 open question 5 calls for. The URI field is
      recorded on-chain; nothing pins it yet
- [ ] **T3.4** WebSocket feed, unconfirmed broadcast + finality reconciliation · *LP-5.1* —
      4s polling meets the 5s budget but costs a request per client per interval;
      the WebSocket is still the right answer
- [x] **T3.5** Ranking by volume, holders, curve progress · *LP-5.2*
- [x] **T3.6** Creator risk flags: concentration, prior failed launches · *LP-5.4*
- [ ] **T3.7** Graduation notifications to creator and opted-in holders · *LP-4.5* —
      the notifier exists (001 T3.7); the opt-in list and trigger do not
- [ ] **T3.8** Register graduated pools into the Auto LP candidate registry · *LP-6.1, LP-6.3*
      — graduation is indexed and the pool recorded; the candidate registry is 001 T6.1

## Phase 4 — Integration

- [ ] **T4.1** One-click Auto LP enrollment requiring a fresh grant · *LP-6.2, LP-6.4* ·
      *design section 6*
- [ ] **T4.2** End-to-end: launch → trade → graduate → enroll → managed by Auto LP
- [ ] **T4.3** Verify graduation still succeeds with all Hoodium servers stopped · *LP-N7*

---

## Requirement coverage

| Requirement | Tasks |
|---|---|
| R1 Launch | T1.1, T1.2, T1.7, T3.3 |
| R2 Trading | T1.2–T1.5, T2.1–T2.3, T2.8 |
| R3 Fees | T1.6, T1.12, T2.9 |
| R4 Graduation | T1.8–T1.10, T2.4–T2.7, T3.7, T4.3 |
| R5 Discovery | T3.4, T3.5, T3.6 |
| R6 Auto LP handoff | T3.8, T4.1, T4.2 |
| NFRs | T1.11, T2.1–T2.11 |

## Critical path

```
T0.2 (USDG semantics) ──▶ T1.2 (curve) ──▶ T2.1/T2.2 (fuzz) ──▶ T2.11 (audit) ──▶ mainnet
```

Everything else can run in parallel. T0.2 and T2.11 are the two tasks that can silently add
weeks — start T0.2 today and book the audit slot before Phase 1 finishes, not after.
