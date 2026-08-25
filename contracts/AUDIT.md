# Internal security review — 2026-08-25

**Verdict: NOT safe to deploy as-is.** One Critical, three High, two Medium
and a handful of Low findings. Every Critical/High has a passing proof-of-concept
test under `test/audit/` (run `forge test --match-path 'test/audit/*'`), and
the Critical was reproduced on a fork of the real Robinhood Chain Uniswap v3
(`test/ForkGraduation.t.sol`, run with `--fork-url`).

This is an internal review by four independent reviewers with different
lenses (curve math/economics; reentrancy/access/state machine; locker, vault and
token; Uniswap integration and deployment), each writing PoCs, followed by a
cross-check. It is **not** an external audit and does not replace one.

## Findings

### C1 — Critical: a pre-initialised pool drains the raise at graduation
`GraduationManager.sol` `_ensurePool` reuses any pool that already exists and
keeps its price; the full-range mint passes `amount0Min = amount1Min = 0`; and
whatever the mint does not consume is swept to the **creator** as "dust".

The token address is public at `TokenLaunched`, and creating + initialising the
USDG/TOKEN 1% pool on Uniswap is permissionless and needs no tokens. So:

- **Creator rug.** The creator initialises the pool at a price where USDG is
  worth ~1e6× more than fair, waits for the curve to fill, calls `graduate()`.
  The mint consumes all tokens and ~0.07 USDG; **68,999.93 of 69,000 USDG is
  transferred to the creator.** Holders own a pool with 0.07 USDG of depth.
  Proved: `PoolPreInitAudit.t.sol`, `CurveEconomics.t.sol` (F1),
  `PoolPrePriming.t.sol`, fork `test_fork_preInitialisedPool_tokenCheap`
  (99.99% of the raise to the creator on the real chain).
- **Third-party theft.** Anyone with ~2,000 USDG of curve tokens initialises
  the pool the other way. The mint consumes all 69,000 USDG and ~40,000 tokens;
  199.96M LP tokens go back to the creator; the attacker sells a few million
  tokens into the near-tokenless pool and takes **~68,300 USDG**. Proved:
  `test_audit_prePrimedPool_thirdPartyDrainsReserve`, fork
  `test_fork_preInitialisedPool_tokenExpensive`.
- The same priming can be done *through the manager itself*:
  `GraduationManager.migrate` accepts any caller and any token (see M1).

The comment in `_ensurePool` acknowledges a hostile pre-made pool and calls it
acceptable. It is the classic launchpad pre-creation attack, and the sweep to
the creator turns it into a first-party rug.

**Fix.** When the pool pre-exists: if it has zero liquidity, re-price it to the
curve's target `sqrtPriceX96` with a zero-liquidity `swap` (no tokens move);
otherwise require `slot0` within a tight band of `_sqrtPriceX96(amount0,
amount1)` and revert. Set `amount0Min/amount1Min` to ≥ 99% of the desired
amounts as defence in depth. Never route "dust" to the creator — send it to the
locker/pool or cap it.

### H1 — High: dev-buy (5%) and anti-snipe (1%) caps are per-call
`BondingCurve.sol` checks the snipe cap per `_buy` call; `HoodiumFactory.launch`
accepts contract callers. A contract calls `launch(devBuy = 650 USDG)` then
loops `curve.buy(100 USDG)` 120× in the same transaction: **47% of supply for
12,650 USDG**, in the deploy block, before anyone else can act. design.md's
"the creator cannot front-run their own launch" is false. Proved:
`test_audit_F3_contractLoopBypassesDevBuyAndSnipeCaps`.

**Fix.** Track tokens bought per address (or globally) during the snipe window,
apply the window cap to the creator too, or gate the window to EOAs.

### H2 — High: `graduate()` can be blocked forever by a dust sell
`sell` has no completion gate and the completing buy does not graduate. At
`reserveUsdg == target`, any holder sells 1 wei of tokens ahead of each
`graduate()` and it reverts `TargetNotReached`. Cost ≈ 6 USDG-units per attempt,
repeatable. Only a contract bundling buy+graduate escapes; the UI path does
not. Proved: `test_audit_F2_dustSellBlocksGraduation`,
`test_audit_graduate_frontRunnableByTinySell`.

**Fix.** Graduate inside the buy that reaches the target, or revert `sell` once
`curveComplete()`.

### H3 — High (design): the pool opens ~41% below the curve's closing price
With defaults, the curve's marginal price at target is 5.82e-4 USDG/token; the
pool is seeded at 69,000 / 200M = 3.45e-4. Every late curve buyer is instantly
41% underwater; rational buyers should refuse the tail of the curve, which
compounds H2. Proved: `test_audit_F4_poolOpensBelowCurveClosingPrice`, fork
`test_fork_tokenIsToken1`.

**Fix.** Size `lpAllocation` for price continuity
(`lpAllocation = vT·(target−fee)/(vU+target)` ≈ 118.5M with defaults) or derive
`virtualUsdg` from `lpAllocation`. This is T0.1 ("parameters unvalidated") made
concrete.

### M1 — Medium: `GraduationManager.migrate` and `LPLocker` trust any caller
`migrate` has no caller/token check; the locker only checks
`msg.sender == positionManager` and trusts caller-supplied `data`. Anyone can
create + price the real token's pool through the trusted manager (C1 vector),
lock any position labelled with any token/creator, and emit
`Migrated`/`PositionLocked` for made-up tokens. Indexer impact is bounded (it
keys off the factory's `TokenLaunched` and the curve's `Graduated`), but any UI
that resolves "the locked position for token X" from the locker is spoofable.
Proved: `TrustBoundaries.t.sol`, `LPLockerAudit.t.sol`.

**Fix.** Restrict `migrate` to curves of the known factory (precompute the
factory address, or verify `BondingCurve(msg.sender).factory()`), and have the
locker require `from == graduationManager`.

### M2 — Medium: USDG is pausable, freezable and upgradeable
On-chain, USDG `0x5fc5…d168` is an ERC1967 proxy (Paxos-style) with
`paused()`, `AddressFrozen`, `ContractPaused`, `upgradeTo`. `graduate()` pushes
USDG dust to the creator and (if `graduationFee > 0`) to the vault; a frozen
creator address makes `graduate()` revert forever for that token. A global pause
freezes everything (unavoidable). T0.2 can otherwise be closed: 6 decimals, no
fee-on-transfer, no contract allowlist (verified on fork).

**Fix.** Never push USDG to third parties inside `graduate`; make dust/fees
pull-based. Guard `safeTransfer(feeVault, 0)` with `if (graduationFee > 0)`.

### Low
- **L1** Dev-buy overshoot is stranded in the factory when the 5% cap exceeds
  what the curve sells before target (not with shipped defaults; any env can
  reach it). Proved: `test_audit_devBuyRefund_strandedInFactory`.
- **L2** `LPLocker` beneficiary is fixed forever; a creator with no call path
  strands 100% of pool fees, including the protocol's 30%. Consider letting
  anyone sweep the protocol share to the immutable vault.
- **L3** `FeeVault` has no confirmation revoke and no proposal expiry: a
  compromised signer's stale confirmation is a permanent half-quorum.
- **L4** `threshold == owners.length` + one lost key locks the vault forever;
  the deploy script allows it. Prefer `threshold < owners.length` or document.
- **L5** No `deadline` on `buy`/`sell` (only min-out bounds).
- **L6** `EXPECTED_CHAIN_ID` guard is opt-in in `Deploy.s.sol`; `.env.example`'s
  RPC host did not answer `eth_chainId` from this box — use
  `https://rpc.mainnet.chain.robinhood.com`.
- **L7** ETH forced into `FeeVault` is unrecoverable (no `receive`, asset check).

### Info
- Tokens/USDG donated directly to a curve are stranded (accounting, not
  balances, drives graduation — which is correct).
- `test_reentry_intoGraduate_isBlocked` in the original suite is vacuous (the
  outer call reverts, so the assertion passes trivially).
- Original atomicity tests injected 3 of ~8 external steps and checked 2
  fields; `GraduationAtomicity.t.sol` now injects all of them with a 17-field
  snapshot — the claim holds.
- Look-alike curves can point at the real vault/manager and emit real-looking
  events; the indexer's address-set filter handles it. Never index curve topics
  globally.

## Checked and found sound
- Curve rounding is against the caller on every path; `k` never decreases;
  200 dust round-trips never lower the reserve; `tokensSold ≤ curveAllocation`
  and `reserveUsdg ≤ target` hold under fuzz; the near-empty-reserve clamp is
  provably unreachable; no overflow at defaults (`k` ≈ 7.6e37, `mulDiv` is
  512-bit).
- Checks-effects-interactions everywhere; `graduated`/`reserveUsdg` are set
  before the first external call; every mutator is `nonReentrant`; no
  `tx.origin`, `delegatecall`, `selfdestruct`, pause, owner, setters or
  initializers anywhere.
- `LPLocker` has no withdrawal path: only `collect` with `recipient = this`,
  never grants operator approval; principal cannot leave. Split rounding
  favours the creator and conserves totals.
- `FeeVault`: dedup'd immutable owners, threshold in [2, n], `executed` set
  before transfer, no arbitrary-call or `approve` surface.
- `HoodiumToken`: plain OZ ERC20, single constructor mint, no burn/permit/
  hooks/owner; no standing allowances after launch.
- Uniswap facts verified on-chain: factory `0x1f7d…2EfA`, fee 10000 → tick
  spacing 200, full range `[-887200, 887200]` accepted, token0/token1 ordering
  and `sqrtPriceX96` correct in both directions (≤ 2^-22 relative error).

## Recommended order
1. Fix C1 + M1 together (they are one trust boundary).
2. H2 and H1 (small, local changes to `BondingCurve`).
3. Re-parameterise for H3 and re-derive the curve tests.
4. M2 pull-based fees; the Lows.
5. Then an external audit — the fixes above touch the exact code an auditor
   would spend most of their time on.
