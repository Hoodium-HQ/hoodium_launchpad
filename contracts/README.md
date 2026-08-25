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
| 2 — Testing | T2.1–T2.3, T2.5–T2.9 | done — **68 tests, 7 fuzz properties, all passing** (2026-08-25, forge nightly, solc 0.8.28) |
| 2 — Fork test | T2.4 | **not done** — needs a Robinhood Chain fork RPC |
| 2 — Testnet soak | T2.10 | **not done** — 2 weeks of real launches |
| 2 — **External audit** | T2.11 | **not done — blocks mainnet absolutely** |

Plainly: the code builds and its suite passes, but **no external auditor has read
it**. The original plan makes the audit a hard gate before real money. Whether to
deploy to Robinhood Chain ahead of that is the owner's decision, not something
this repository can make for them.

## Layout

```
src/                 the six contracts + interfaces
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
        │ target reached
        ▼
GraduationManager    atomic migration, permissionless               LP-4.1, LP-4.2, LP-4.6
  ├─ Uniswap v3 pool created + seeded full-range
  └─ LPLocker        holds the position; no withdrawal path         LP-4.3
FeeVault             m-of-n multisig                                LP-3.5
```

## Building and testing

There is no `forge` on the Hoodium server; use the Foundry image. The image's
entrypoint is `/bin/sh -c`, so pass the command as one string:

```bash
IMG=ghcr.io/foundry-rs/foundry:latest
RUN="sudo docker run --rm -e FOUNDRY_DISABLE_NIGHTLY_WARNING=1 -v $PWD:/w -w /w $IMG"

$RUN "forge build"
$RUN "forge test"                          # 68 tests, fuzz at 4096 runs
$RUN "FOUNDRY_PROFILE=ci forge test"       # fuzz at 20000 runs
$RUN "FOUNDRY_PROFILE=deep forge test"     # fuzz at 200000 runs — before audit
$RUN "sh script/export-abi.sh"             # refresh abi/*.json after a source change
```

With a local Foundry install, just run the quoted commands directly.

## ABIs

`abi/*.json` holds the bare ABI array (not the full forge artifact) for:
`HoodiumFactory`, `BondingCurve`, `LPLocker`, `FeeVault`, `HoodiumToken`,
`GraduationManager`. Import them from `../api` and `../web` — e.g. with viem,
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
  Threshold must be at least 2. Use hardware-wallet addresses.
- **Curve parameters** (`VIRTUAL_USDG`, `GRADUATION_TARGET_USDG`, ...). The
  defaults are design.md section 2 placeholders that T0.1 never validated (see
  Open items 1). With the defaults, ~675 USDG buys the 5% dev-buy cap.
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
| `RPC_URL` | a Robinhood Chain RPC, e.g. `https://rpc.robinhoodchain.com` |
| `EXPECTED_CHAIN_ID` | `4663` — the script refuses to broadcast if the RPC disagrees |
| `USDG_ADDRESS` | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals) |
| `UNISWAP_POSITION_MANAGER` | `0x73991a25c818bf1f1128deaab1492d45638de0d3` |
| `VAULT_OWNERS` | comma-separated signer addresses, no spaces |
| `VAULT_THRESHOLD` | `2` or more, at most the number of owners |

Everything else is optional with the defaults listed in `.env.example`. The
Uniswap v3 factory is read from `positionManager.factory()` and USDG decimals from
`USDG.decimals()` unless overridden.

The deployer needs a little native ETH on Robinhood Chain: the Anvil rehearsal
estimated ~8.9M gas for the four deployments.

### 2. Dry run (no broadcast)

```bash
forge script script/Deploy.s.sol --rpc-url $RPC_URL
```

Read the `=== parameters ===` block. Every number there is what will be burned
into the contracts. USDG amounts are printed in 6-decimal units (12,000 USDG shows
as `12000000000`).

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
# repeat for LPLocker, GraduationManager, HoodiumFactory with their own args.
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
VITE_EXPLORER_URL=https://robinhoodchain.blockscout.com
```

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

**Dev buys are exempt from the anti-snipe cap.** They execute inside the
deployment transaction and are bounded separately by `devBuyMaxBps`, so they
cannot front-run anything — no other buy can precede them.

## Open items

**1. T0.1 — curve parameters are unvalidated placeholders.**
design.md section 2 marks them as such. With `virtualUsdg = 12,000` against a
`69,000` target, a dev buy of only **~675 USDG already reaches the 5% cap**, and
~130 USDG reaches 1%. The first few hundred USDG buy a very large share of supply.
That may be intended, but it should be a decision rather than a side effect. The
tests assert properties, not specific numbers, so re-parameterising will not
invalidate them. The deploy script takes all of them from env for exactly this
reason.

**2. T0.2 — USDG semantics on Robinhood Chain still unconfirmed.**
Decimals (6, per the on-chain token), fee-on-transfer, blocklist. A blocklisted
curve address would freeze reserves permanently, and no code here can defend
against that. `FeeOnTransferTest` proves the fee-on-transfer case reverts rather
than corrupts; the blocklist case has no contract-level mitigation and needs an
answer from the USDG issuer.

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

**5. T2.4 — no fork test against real Uniswap.**
The mocks cover the call *sequence* and its failure modes. They do not prove
Uniswap behaves as assumed — in particular that the 1% / tick-spacing-200 fee
tier is enabled on the Robinhood Chain v3 factory. Run
`forge test --fork-url $RPC_URL` against a fork-based test before the first real
launch, or at minimum graduate a throwaway token first.

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
