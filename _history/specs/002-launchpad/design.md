# 002 — Launchpad · Design

**Traces:** [requirements.md](requirements.md) · **Stage:** 2 of 3

## 1. Contract architecture

```
HoodiumFactory  (immutable, no admin)
   │ deploys, one tx                                  (LP-1.1)
   ├──▶ HoodiumToken     ERC-20, fixed supply, no mint, no owner
   └──▶ BondingCurve     holds USDG reserves + unsold supply
             │
             │ target reached                          (LP-4.1)
             ▼
       GraduationManager
             │ atomic                                  (LP-4.2)
             ├──▶ Uniswap pool created + seeded
             └──▶ LP position permanently locked       (LP-4.3)

       FeeVault (multisig)                             (LP-3.5)
             ▲
             └── trade fees + creation fee + locked-LP share
```

**No proxies anywhere** (`LP-N1`). An upgradeable launchpad is a launchpad whose creator can
change the rules after people have money in it. The cost is that bugs cannot be patched —
which is precisely why `LP-N3` (external audit) is non-negotiable.

## 2. Curve math

Constant product over virtual reserves, denominated in USDG:

```
k = (virtualUSDG + realUSDG) × (virtualTokens + realTokens)

Buy:  tokensOut = vT + rT − k / (vU + rU + usdgIn)
Sell: usdgOut   = vU + rU − k / (vT + rT + tokensIn)
```

Virtual reserves set the opening price without anyone seeding capital (`LP-1.3`).

**Proposed parameters** — placeholders until modelled against real data:

| Parameter | Value | Notes |
|---|---|---|
| Total supply | 1,000,000,000 | Fixed |
| Curve allocation | 800,000,000 | Sold along the curve |
| LP allocation | 200,000,000 | Reserved for graduation |
| Virtual USDG | 12,000 | Sets opening price |
| Graduation target | 69,000 USDG | Matches the category benchmark (README §Launchpad economics) |
| Trade fee | 1% | `LP-2.3` |
| Creator share | 70% of fees | `LP-3.1`, matched to the incumbent — see requirements `R3` |
| Creation fee | ~1 USDG | `LP-1.5` |
| Graduation fee | 0 | `LP-3.3`, the incumbent charges none |

`LP-N8` — every division rounds in the contract's favor. A curve that rounds toward the
caller is a curve that can be drained by repeated dust trades.

## 3. Graduation

The highest-risk path in the system: it moves every reserve at once and is irreversible.

```
1. assert curveComplete && !graduated
2. graduated = true                    ← set BEFORE any external call
3. take graduation fee → FeeVault    ← 0 as configured; the step remains
4. create USDG/TOKEN pool if absent
5. add liquidity: remaining USDG + LP allocation
6. lock the LP position permanently
7. emit Graduated(token, pool, liquidity)
```

Step 2 before step 3 is the reentrancy defense (`LP-N2`) — checks-effects-interactions, with
the whole function additionally guarded.

**Permissionless (`LP-4.6`).** Anyone may call it; the platform is not a dependency. If
Hoodium disappears entirely, tokens still graduate.

**Locking (`LP-4.3`).** Uniswap v3/v4 positions are NFTs, so "burn the LP token" needs care:
burn the position NFT after minting a full-range position, or transfer it to a lock contract
with no withdrawal function. Prefer the lock contract — accrued fees stay claimable to the
creator while principal is provably unrecoverable.

**Decided (`T0.4`).** Fees are **split: 70% creator, 30% protocol.** This is the fourth
revenue line, alongside the curve trade fee and the creation fee — and the only one that
continues after a token has left the curve. (The graduation fee was a fourth until the terms
were matched to the incumbent's; it is now 0, and `R3` records why.)

The condition this decision was always subject to still stands, and is now the thing to hold
the implementation to: *platform-claimable fees on locked LP would be a hidden revenue stream
and must not ship without being stated plainly in the UI.* Concretely that means all of:

| Requirement | Where it is met |
|---|---|
| The split is readable on-chain before a creator commits | `LPLocker.protocolFeeShareBps()`, public and immutable |
| It cannot change after launch | No setter, no owner, no upgrade path |
| Both sides are visible per collection | `FeesCollected` carries creator and protocol amounts separately |
| It is stated in words where the creator claims | Token page, beside the claim button — **required before ship** |
| No deployment can take the majority | `MAX_PROTOCOL_FEE_SHARE_BPS = 5000`, enforced in the constructor |

Two properties are deliberate and should survive any later revision of the percentage:

- **Only the creator can trigger a collection.** The protocol has no sweep of its own; it is
  paid when the creator claims, never instead of them.
- **Rounding favours the creator.** The protocol's cut rounds down. It is a wei either way,
  but when the arithmetic has to give way it gives way against the party that wrote the
  contract.

## 4. Anti-snipe

`LP-2.5`. For the first 3 blocks, per-transaction buys are capped at 1% of supply.

This does not stop a determined sniper — nothing on-chain fully does. It raises the cost of
capturing the entire opening supply in one transaction, which is the difference between a
launch that looks fair and one that visibly is not.

Dev buys (`LP-1.6`) execute in the deployment transaction itself, so the creator cannot
front-run their own launch from a second address before others can trade.

## 5. Indexing & real-time

Reuses the Auto LP indexer (`001/design.md` §1) — same `getLogs` + cursor mechanism, same
32-confirmation finality, same reorg rewind.

Launchpad adds `launchpad_tokens` and `launchpad_trades` collections and a WebSocket
broadcast for the live feed (`LP-5.1`).

The 5-second feed latency budget (`LP-5.1`) is satisfied by broadcasting on **unconfirmed**
events and reconciling at finality. The UI marks unconfirmed rows visually — showing
provisional data as final would be worse than showing it late.

## 6. Auto LP integration point

The single seam between the two specs. Keeping it to one seam is what stops the features from
entangling.

```
GraduationManager emits Graduated(token, pool, liquidity)
        │
        ▼
Indexer writes → launchpad_tokens.poolAddress
        │
        ▼
Auto LP candidate registry picks it up          (LP-6.1, AL-6.2)
        │
        ▼
Creator is offered one-click enrollment         (LP-6.2)
        │
        ▼
Requires a fresh EIP-7702 grant                 (LP-6.4, AL-1.3)
```

Graduation grants Hoodium **no** authority. Enrollment is a separate, explicit user action
with its own signature. Bundling them would turn "I launched a token" into "I handed a bot
permission over my funds," which is exactly the failure mode this product is positioned
against.

## 7. Testing

| Layer | Tool | Target |
|---|---|---|
| Curve invariants | Foundry fuzz | `k` never decreases; round-trip buy→sell never profits the caller · *LP-N4* |
| Curve edge cases | Foundry | 1 wei, max uint, buy that overshoots target · *LP-2.6* |
| Graduation | Foundry fork | Full migration against real Uniswap contracts · *LP-4.1* |
| Atomicity | Foundry | Force a failure at each step; assert full revert · *LP-4.2* |
| Reentrancy | Foundry | Malicious USDG-like token attempting reentry · *LP-N2* |
| Lock | Foundry | Prove no path withdraws locked principal · *LP-4.3* |
| Anti-snipe | Foundry | Oversized buy in block 1 reverts · *LP-2.5* |

Fuzz testing the curve is the single highest-value test in this spec. Every historically
drained bonding curve was drained through rounding, not through a dramatic exploit.

## 8. Open questions

1. **Uniswap v3 or v4** for graduated pools? v4 hooks would let Auto LP logic live in the
   pool itself — strategically interesting, materially more risk. v3 for v1.
2. Graduation target in USDG or indexed to something? Fixed USDG for v1; simple and legible.
3. Who claims fees on locked LP? See §3. **Must be resolved before audit.**
4. Does a 1% fee clear on a chain this young, or is undercutting the right entry move? No
   incumbent exists here to undercut, so start at 1%.
5. Metadata moderation — IPFS pinning means Hoodium chooses what to pin. That is a policy
   decision, not a technical one, and it needs an answer before launch.
