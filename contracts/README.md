# Hoodium Launchpad — Contracts

Implementation of spec 002 — Launchpad, Phases 1 and 2. USDG-denominated bonding
curve, graduation into a Uniswap v3 pool with permanently locked liquidity.
Target chain: **Robinhood Chain (chain id 4663, Arbitrum Orbit)**.

> Contracts are immutable once deployed (`LP-N1`). There is no patch path, so the
> testing and audit tasks are not optional polish — they are the only defence that
> exists.

## Status

| Phase | Tasks | State |
|---|---|---|
| 0 — Modelling | T0.1–T0.4 | **partly** — see Open items |
| 1 — Contracts | T1.1–T1.12 | done |
| 2 — Testing | T2.1–T2.3, T2.5–T2.9 | done — **168 tests, 10 fuzz properties, all passing** (2026-08-25, forge nightly, solc 0.8.28) |
| 2 — Fork test | T2.4 | done — **19 tests** against the real Robinhood Chain Uniswap v3 (`ForkGraduation.t.sol`, `test/verify/ForkVerify.t.sol`, need `--fork-url`) |
| 2 — Internal review | — | done — see `AUDIT.md`; every Critical/High/Medium finding fixed with a regression test |
| 2 — Testnet soak | T2.10 | **not done** — 2 weeks of real launches |
| 2 — **External audit** | T2.11 | **not done — blocks mainnet absolutely** |

Plainly: the code builds, its suite passes, and an internal four-lens review has
been worked through, but **no external auditor has read it**. The original plan
makes the audit a hard gate before real money. Whether to deploy to Robinhood
Chain ahead of that is the owner's decision, not something this repository can
make for them.

## Layout

```
src/                 the six core contracts + GraduationHelper periphery + interfaces
test/                Foundry suite (mocks for USDG and Uniswap v3)
script/Deploy.s.sol  env-driven mainnet/testnet deploy (no hard-coded addresses)
script/DeployLocal.s.sol  Anvil-only: deploys mock USDG + mock Uniswap first
script/export-abi.sh copies ABIs from out/ into abi/
abi/                 checked-in ABI arrays for the api and web packages
lib/                 vendored deps (forge-std v1.16.2, openzeppelin-contracts v5.1.0)
```

`lib/` is **vendored, not a submodule** — this package lives inside a monorepo.
The versions match `foundry.lock`. To upgrade, clone the tag into `lib/`, delete
its `.git`, and re-run the tests.

## Contracts

```
HoodiumFactory       one-transaction deploy + optional dev buy      LP-1.1, LP-1.6
  ├─ HoodiumToken    ERC-20, fixed supply, no mint, no owner        LP-1.2
  └─ BondingCurve    xy=k over virtual reserves, USDG-denominated   LP-2.x, LP-3.x
        │ the buy that reaches the target graduates in the same call
        ▼
GraduationManager    atomic migration; serves only the factory's curves   LP-4.1, LP-4.2, LP-4.6
  ├─ Uniswap v3 pool created (or re-priced / verified) + seeded full-range
  └─ LPLocker        holds the position; no withdrawal path         LP-4.3
FeeVault             m-of-n multisig, 30-day proposals              LP-3.5
GraduationHelper     periphery: fix a griefed pool price + completing buy, atomically (AUDIT residual)
```

The three trust links point forward — the locker only accepts positions from the
manager, the manager only serves curves of the factory, the factory verifies the
manager was built for it — and each is an immutable checked in the constructor.
The deploy script precomputes the addresses from the deployer's nonce.

## Building and testing

There is no `forge` on the Hoodium server; use the Foundry image. The image's
entrypoint is `/bin/sh -c`, so pass the command as one string:

```bash
IMG=ghcr.io/foundry-rs/foundry:latest
RUN="sudo docker run --rm -e FOUNDRY_DISABLE_NIGHTLY_WARNING=1 -v $PWD:/w -w /w $IMG"

$RUN "forge build"
$RUN "forge test"                          # 168 tests, fuzz at 4096 runs (fork tests skipped)
$RUN "forge test --match-contract 'ForkGraduation|ForkVerify' --fork-url https://rpc.mainnet.chain.robinhood.com -vv"
$RUN "FOUNDRY_PROFILE=ci forge test"       # fuzz at 20000 runs
$RUN "FOUNDRY_PROFILE=deep forge test"     # fuzz at 200000 runs — before audit
$RUN "sh script/export-abi.sh"             # refresh abi/*.json after a source change
```

`test/audit/` holds the internal review's proofs of concept, flipped into
regression tests (`test_regression_*`) once each finding was fixed; the
`test_audit_*` ones documented behaviour that was sound to begin with.

With a local Foundry install, just run the quoted commands directly.

## ABIs

`abi/*.json` holds the bare ABI array (not the full forge artifact) for:
`HoodiumFactory`, `BondingCurve`, `LPLocker`, `FeeVault`, `HoodiumToken`,
`GraduationManager`, `GraduationHelper`. Import them from `../api` and `../web` — e.g. with viem,
`import factoryAbi from '../../contracts/abi/HoodiumFactory.json'` and pass it as
`abi`. Regenerate with `script/export-abi.sh` whenever `src/` changes and commit
the result; the api/web must never be one ABI version behind the deployed bytecode.

## Deploy runbook (Robinhood Chain)

The deploy key lives **only on the owner's machine**. Nothing below runs on the
Hoodium server, and no key is ever placed there.

### 0. Decide the parameters — they are permanent

Nothing in these contracts is upgradeable or owned. Re-deploying creates a new,
unrelated generation; tokens launched from the old factory keep the old terms
forever. Before step 1, settle:

- **FeeVault signers and threshold** (`VAULT_OWNERS`, `VAULT_THRESHOLD`). The
  signer set is immutable; rotating a signer means a new vault and a new factory.
  Threshold must be at least 2 and **should be below the signer count** — with
  every signer required, one lost key locks the vault forever. The script
  refuses that shape unless `ALLOW_FULL_THRESHOLD=true`. Proposals expire after
  30 days and confirmations can be revoked while a proposal is open. Use
  hardware-wallet addresses.
- **Curve parameters** (`TOTAL_SUPPLY`, `CURVE_ALLOCATION`,
  `GRADUATION_TARGET_USDG`, `GRADUATION_FEE_USDG`). The virtual reserves are
  *derived* from these so the pool opens at exactly the price the curve closed
  at (see Decisions); with the defaults `virtualUsdg` comes out at 23,000 USDG,
  ~1,140 USDG buys the 5% dev-buy cap and ~220 USDG buys the 1% anti-snipe
  allowance. `CURVE_ALLOCATION` must exceed half the supply.
- **Fee splits**: `TRADE_FEE_BPS` (default 1%), `CREATOR_FEE_SHARE_BPS` (default
  70% of trade fees to the creator), `LP_PROTOCOL_FEE_SHARE_BPS` (default 30% of
  locked-LP pool fees to the protocol; the contract caps it at 50%).

### 1. Prepare the environment

```bash
cd contracts
cp .env.example .env      # then edit; .env is git-ignored
source .env
```

Required variables:

| Var | Value for Robinhood Chain |
|---|---|
| `PRIVATE_KEY` | deployer EOA (pays gas only; holds no role afterwards) |
| `RPC_URL` | a Robinhood Chain RPC: `https://rpc.mainnet.chain.robinhood.com` |
| `EXPECTED_CHAIN_ID` | `4663` — required; the script refuses to broadcast if the RPC disagrees |
| `USDG_ADDRESS` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) |
| `UNISWAP_POSITION_MANAGER` | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| `VAULT_OWNERS` | comma-separated signer addresses, no spaces |
| `VAULT_THRESHOLD` | `2` or more, below the number of owners (or `ALLOW_FULL_THRESHOLD=true`) |

Everything else is optional with the defaults listed in `.env.example`. The
Uniswap v3 factory is read from `positionManager.factory()` and USDG decimals from
`USDG.decimals()` unless overridden.

The deployer needs a little native ETH on Robinhood Chain: the Anvil rehearsal
estimated ~9M gas for the four core deployments, plus the `GraduationHelper`
deployed after them (no pairing, so it does not enter the nonce arithmetic).
**Send nothing else from the deployer while the script runs**: the locker and manager are constructed with
the *precomputed* addresses of the manager and factory (deployer nonce +2 and
+3), every constructor verifies the pairing, and the script asserts it again —
an intervening transaction shifts the nonces and the run reverts before
anything harmful happens, but it wastes the gas.

### 2. Dry run (no broadcast)

```bash
forge script script/Deploy.s.sol --rpc-url $RPC_URL
```

Read the `=== parameters ===` block. Every number there is what will be burned
into the contracts. USDG amounts are printed in 6-decimal units (69,000 USDG shows
as `69000000000`). The derived `virtualUsdg`/`virtualTokens` are printed after
the deploy; 23,000 USDG is the expected value for the default allocations.

### 3. Broadcast and verify

```bash
forge script script/Deploy.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/
```

Blockscout needs no API key. If verification fails mid-way (it is a separate
step after the broadcast), verify each contract by hand — constructor args are
in `broadcast/Deploy.s.sol/4663/run-latest.json`:

```bash
forge verify-contract --chain-id 4663 --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args $(cast abi-encode "constructor(address[],uint256)" "[0x..,0x..]" 2) \
  <FEEVAULT_ADDRESS> src/FeeVault.sol:FeeVault
# repeat for LPLocker, GraduationManager, HoodiumFactory with their own args;
# GraduationHelper has no constructor args.
```

`HoodiumToken` and `BondingCurve` are deployed per launch by the factory; verify
one instance after the first launch and Blockscout will match the rest by bytecode.

Commit `broadcast/Deploy.s.sol/4663/run-latest.json` — it is the record of what
was deployed with which arguments. Do **not** commit `cache/` (it may hold RPC
URLs with keys) or `.env`.

### 4. Wire the api and web

The script prints two blocks at the end. Paste them into the respective envs
(Coolify for the api, Render for the web) and redeploy — env changes alone do not
restart either service.

api:

```
LAUNCHPAD_FACTORY_ADDRESS=<HoodiumFactory>
QUOTE_TOKEN_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
QUOTE_TOKEN_DECIMALS=6
POSITION_MANAGER_ADDRESS=0x73991a25c818bf1f1128deaab1492d45638de0d3
UNISWAP_V3_FACTORY_ADDRESS=<printed>
```

web:

```
VITE_CHAIN_ID=4663
VITE_LAUNCHPAD_FACTORY=<HoodiumFactory>
VITE_QUOTE_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
VITE_QUOTE_DECIMALS=6
VITE_POSITION_MANAGER=0x73991a25c818bf1f1128deaab1492d45638de0d3
VITE_GRADUATION_HELPER=<GraduationHelper>
VITE_EXPLORER_URL=https://robinhoodchain.blockscout.com
```

`VITE_GRADUATION_HELPER` is optional: without it the trade panel can only say
"try again later" when a primed pool blocks the completing buy; with it, it
offers the atomic fix-and-buy (see Decisions).

(If the api package ends up using shorter names such as `LAUNCHPAD_FACTORY`, the
values are the same; check `api/src/config` for the exact keys.)

`LPLocker`, `FeeVault` and `GraduationManager` addresses are discoverable from the
factory on-chain, but record them in the api env too if the indexer wants to
filter `FeesCollected` events.

### 5. Smoke test on-chain

1. Launch a token with a small dev buy from a wallet you control.
2. Buy and sell a few USDG on the curve; confirm `quoteBuy`/`quoteSell` match
   execution and the creator can `claimFees`.
3. Only after a real graduation has been observed on a throwaway launch should
   the factory be announced. The mocks prove the call sequence, not Uniswap's
   behaviour on this chain (Open item 5).

### Local rehearsal (Anvil)

```bash
anvil
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

`DeployLocal` deploys mock USDG and mock Uniswap first and refuses to run on any
chain but 31337. To rehearse `Deploy.s.sol` itself, point `USDG_ADDRESS`,
`UNISWAP_V3_FACTORY` and `UNISWAP_POSITION_MANAGER` at the mock addresses
`DeployLocal` prints and set `EXPECTED_CHAIN_ID=31337`.

## Decisions worth knowing

**Rounding always favours the contract (LP-N8).** Both quote paths divide `k` and
round the quotient **up**, so the amount the user receives rounds **down**; fees
round up. `test_dustRoundTrips_neverDrain` fires 100 one-unit round trips and
asserts the reserve does not fall — that is the attack that has drained real
curves, not a dramatic exploit.

**The virtual token reserve is derived, not configured.** Setting
`tokensSold(target) = curveAllocation` and solving gives `vT = C × vU / target`.
Deriving it removes a way to misconfigure a launch: a hand-picked `vT` that
disagrees with the target leaves either unsold tokens at graduation or a curve
that runs dry before reaching it.

**A hostile USDG fails loudly, not quietly.** T0.2 is unresolved, so every inbound
transfer asserts the balance delta equals the amount requested. If USDG turns out
to take a transfer fee, launches revert with `UnsupportedTokenBehaviour` on day
one rather than leaving every curve silently under-reserved.

**Atomicity is structural, not defensive.** There is no try/catch and no
partial-success path in graduation. `test_atomicity_*` injects a failure at each
step and asserts the curve is left byte-identical *and still tradeable*.

**The locker's proof is its absence of functions.** No transfer, no
`decreaseLiquidity`, no burn, no owner, no delegatecall. `collect` is the single
outbound call, and Uniswap's `collect` can only move accrued fees. Principal
cannot leave because nothing there is capable of asking for it.

**Both virtual reserves are derived, and the pool opens at the closing price.**
`vT = C·vU/target` sells the curve out exactly at the target;
`lpAllocation = vT·(target−fee)/(vU+target)` makes the pool's opening price
equal the curve's last marginal price. Solving both gives
`vU = lpAllocation·target²/(C·(target−fee) − lpAllocation·target)`, which the
factory computes and then re-checks to 0.5%. Before this the pool opened ~41%
below the curve's last price and every late buyer was instantly underwater
(AUDIT H3).

**The completing buy graduates.** The buy that brings the reserve to the target
calls the migration in the same transaction, and `sell` refuses once the target
is reached. Otherwise a 1-wei sell ahead of every `graduate()` could hold a curve
one wei short forever (AUDIT H2). `graduate()` stays external and permissionless
for the one path that completes without a public buy — a dev buy at launch.

**The anti-snipe window is per address, cumulative.** For the first
`SNIPE_BLOCKS` blocks, `boughtInWindow[address]` may not exceed `SNIPE_MAX_BPS`
of supply. A per-call cap was no cap: a contract could launch and loop `buy` a
hundred times in the deploy transaction (AUDIT H1). Dev buys are exempt from the
*cap* — they are bounded by `devBuyMaxBps` and nothing can precede them — but
they count against the creator's window allowance.

**A pre-made pool is re-priced or refused, never trusted.** Creating and
initialising the Uniswap pool is permissionless, so by graduation it may exist at
any price. If it has no liquidity in range the manager walks its price to the
closing price with a zero-liquidity swap (nothing changes hands; the manager's
swap callback refuses to pay). If it has liquidity, its price must already be
within ~0.5% of the closing price or graduation reverts `PoolPriceManipulated`
— a mispriced liquid pool is an arbitrage anyone can take to unblock it. The
mint then requires 99% of both sides to go in. Before this a primed pool sent
99.99% of the raise to the creator (AUDIT C1).

**A griefed pool is fixed and completed in one transaction.** The band check
above has a liveness residual: a full-range position of ~$1 of tokens and 1000
wei of USDG at a hostile price is enough liquidity to make every plain
completing buy revert `PoolPriceManipulated`, and because re-pricing and
re-blocking both cost wei, fixing it in a separate transaction is a gas war
the buyer can lose. `GraduationHelper` (permissionless, unowned, stateless —
the reentrancy guard is its only storage — and holding nothing between calls)
closes it: `fixAndBuy(curve, usdgIn, minTokensOut, deadline, maxFixUsdg)`
swaps the pool to `GraduationManager.targetSqrtPriceX96(curve)` in whichever
direction is needed, then makes the completing buy, and sends the bought
tokens, all arbitrage proceeds and the unspent budget to the caller. If the
token is too cheap the swap is funded with the caller's USDG (bounded by
`maxFixUsdg`); if too expensive, the tokens the pool asks for are bought from
the curve inside the swap callback — at the fair price, never enough to
complete the curve — and sold into the position. `fix(curve, maxFixUsdg)`
alone serves keepers. `buy` is keyed on `msg.sender`, so the helper refuses to
run inside the anti-snipe window and is meant only for the completing buy.
`GraduationHelperTest` and the `*helper*` tests in `ForkVerify.t.sol` prove it
against the mocks and the real chain (a dust position costs ~0.1 USDG to fix,
or is net profitable, depending on direction).

**Only the factory's curves reach the manager, only the manager reaches the
locker.** `migrate` requires `factory.curveOf(token) == msg.sender`; the locker
requires `from == graduationManager`. Look-alike curves and forged positions
cannot spoof `Migrated`/`PositionLocked` (AUDIT M1).

**Graduation pushes nothing to third parties.** USDG on Robinhood Chain is a
pausable, freezable proxy. The graduation fee accrues to `platformFeesAccrued`
(swept by anyone via `claimPlatformFees`), and mint dust is credited on the
manager for the creator to `pullDust`. A frozen recipient can therefore never
make graduation revert (AUDIT M2).

**The protocol's locked-LP share is sweepable by anyone.** `sweepProtocolFees`
collects, pays the protocol share to the immutable vault, and credits the
creator's share for the beneficiary to pull. A creator with no call path no
longer strands the protocol's 30% with their own 70%; it is still only `collect`,
so the principal proof above is untouched (AUDIT L2).

**Trades carry a deadline; vault proposals expire.** `buy`/`sell` take a
`deadline` timestamp (AUDIT L5). FeeVault proposals die after 30 days and a
confirmation can be revoked while a proposal is open, so a stale confirmation
from a compromised key is not a permanent half-quorum (AUDIT L3).

## Open items

**1. T0.1 — curve parameters are still a product decision.**
The *shape* is now enforced (price continuity, sell-out at target) but the
allocations and target themselves are design.md section 2 placeholders. With
the derived `virtualUsdg = 23,000` against a `69,000` target, a dev buy of
**~1,140 USDG reaches the 5% cap** and ~220 USDG reaches the 1% window
allowance; the first 2,000 USDG buy ~8% of supply. That may be intended, but it
should be a decision rather than a side effect. The tests assert properties, not
specific numbers, so re-parameterising will not invalidate them.

**2. T0.2 — USDG is pausable, freezable and upgradeable.**
Verified on a fork: 6 decimals, no transfer fee, no contract allowlist — but the
token is an ERC1967 proxy with `paused()`, address freezing and `upgradeTo`. The
contracts now never push USDG to a third party inside graduation, so a frozen
creator or vault cannot block it; a frozen *curve* address or a global pause
would still freeze reserves, and no code here can defend against that. It needs
an answer from the USDG issuer.

**3. T0.3 — resolved as Uniswap v3.** design.md section 8: "v4 hooks would let
Auto LP logic live in the pool itself — strategically interesting, materially more
risk. v3 for v1." The Robinhood Chain v3 NonfungiblePositionManager is
`0x73991a25c818bf1f1128deaab1492d45638de0d3`.

**4. T0.4 — locked-LP fees split 70/30, creator/protocol.**
Decided and implemented in `LPLocker`. `protocolFeeShareBps` is public and
immutable, `FeesCollected` breaks out both sides, no deployment can take the
majority (`MAX_PROTOCOL_FEE_SHARE_BPS = 5000`), only the creator can trigger a
collection, rounding favours them, and the web app states the split to every
visitor — read from the contract, not hard-coded. T0.4 remains
blocking-for-audit: the auditor still has to see it.

**5. T2.4 — fork test done; re-run it before deploying.**
`ForkGraduation.t.sol` launches through the factory and graduates against the
real Robinhood Chain v3 factory / position manager (1% tier, tick spacing 200,
both token orderings), and reproduces the pre-initialised-pool attack to assert
it no longer works there. It needs `--fork-url`; re-run it against the block you
deploy at, and still graduate a throwaway token first.

**5b. Residual: graduation can be delayed, not broken — closed by `GraduationHelper`.**
A pool primed *with liquidity* at a hostile price (or an out-of-range position
in the path between the primed price and the fair one) makes the completing buy
revert until the price is back inside the band. Any such liquidity is a
mispriced order against a known fair price — an arbitrage — so it clears as
soon as anyone takes it; the attacker pays for the delay. With dust liquidity
the arbitrage is worth less than gas, so `GraduationHelper.fixAndBuy` takes it
and completes the curve atomically (see Decisions). Documented in
`GraduationManager` and covered by
`test_regression_prePrimedLiquidPool_blocksOnlyUntilArbitraged`,
`GraduationHelperTest` and the fork `*helper*` tests.

**6. T2.11 — no audit. This blocks mainnet absolutely per the original plan.**
tasks.md: *"Book the audit slot before Phase 1 finishes, not after."* Phase 1 is
finished. Nothing here should hold real money until an external auditor has been
through it. Deploying earlier is the owner's risk to accept explicitly.

**7. The multisig is minimal by design.**
`FeeVault` has an immutable owner set and threshold. Rotating signers means
deploying a new vault and pointing new launches at it; existing curves keep paying
the old one. That is a deliberate trade — a vault whose signer set can change is a
vault with a governance attack surface — but it is a constraint an operator needs
to know about before the keys are generated.

**8. Toolchain.** The suite was last run on the Foundry `latest` (nightly) image.
Pin a stable release (`ghcr.io/foundry-rs/foundry:v1.x`) before the audit so the
auditor and CI compile with the same solc/forge pair.
