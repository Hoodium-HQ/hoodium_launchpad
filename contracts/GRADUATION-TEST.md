# Proving graduation on mainnet for three dollars

Graduation is the one path in this system that cannot be un-run. It moves every
reserve at once, creates a pool at a price nothing can correct afterwards, and
locks the resulting position forever. `test/ForkGraduation.t.sol` already runs it
against a fork of the real Uniswap deployment, and `test/Graduation.t.sol` runs it
against mocks — but a fork is a copy of the chain with the cheat codes switched
on, and every launchpad that has ever bricked a graduation had passing tests.

This is the same run with the cheat codes off: real USDG, real gas, real Uniswap,
real irreversibility — on a throwaway factory whose graduation target is **3
USDG** instead of 69,000. Everything the production set will do at 69,000 it does
here at 3, through the same code, in the same order.

- **Cost:** ~3.031 USDG and ~0.0004–0.0008 ETH of gas, all in.
- **Blast radius:** none. The production factory
  `0xA07329b233B2c7437BfcB6ed12a99AC36d69b05b` and everything launched from it are
  not touched, read, or referenced. This deploys its own vault, locker, manager
  and factory and abandons them.

---

## What it proves

Thirty-three assertions, printed one per line as `PASS` / `FAIL`, with the run
reverting at the end if any failed:

| Group | What is checked |
| --- | --- |
| Graduation | `graduated()` is true, `pool()` and `lpTokenId()` are set, the curve's USDG reserve was emptied |
| Pool | the pool exists at the **1% tier** for (token, USDG), is the one `curve.pool()` names, pairs the two tokens in the right order, is initialised, and sits inside the manager's `SQRT_PRICE_BAND_BPS` of the curve's closing price |
| Position | full range for tick spacing 200 (`-887200 … 887200`), non-zero liquidity, `positionManager.ownerOf(id) == locker`, `locker.beneficiaryOf(id) == creator`, `locker.tokenOf(id) == token` |
| Fees | the 1% trade fee split 70/30, the platform share is the exact remainder (no wei created or destroyed), and the curve's USDG balance equals precisely the fees it still owes — nothing more, no leftover launch tokens |
| Dust | the mint's leftover is *credited* on the manager (`dustOf`) and *not pushed* anywhere: the manager's balances equal the credited dust exactly, and no approval was left standing |
| Trading | `sell()` and `buy()` both revert after graduation; the pool has in-range liquidity and holds both sides, having received ≥99% of the raise |

The two things worth understanding before you read the output:

**The completing buy graduates.** There is no separate `graduate()` transaction in
the normal path (AUDIT H2). The buy that brings the reserve to the target creates
the pool, mints the position and locks it, inside the buyer's own transaction.
The script calls `graduate()` only if it finds a curve that completed some other
way — which cannot happen here, because this launch takes no dev buy.

**A post-graduation `sell()` answers `AlreadyGraduated`, not `CurveComplete`.**
`sell` tests `graduated` before it tests `curveComplete()`, so once the migration
has happened the first guard is the one that fires (`0xe6a0d45f`).
`CurveComplete` (`0xd98e1888`) is what a curve that has *reached* the target but
not yet migrated answers — the dev-buy shape. The script accepts either and
prints which it got, because both are correct refusals and which one you see is a
statement about how the curve completed.

**Dust is expected and is not a leak.** Uniswap never consumes both sides of a
mint exactly. Whatever is left is credited to the creator on the GraduationManager
and sits there until they call `pullDust`. It is deliberately not sent: USDG is
freezable, and pushing to a frozen recipient inside `migrate` would make
graduation revert forever (AUDIT M2). A non-zero `dust owed` line is the design
working.

---

## Measured on a fork of Robinhood Chain mainnet

Both scripts were run end to end against an `anvil` fork of block ~45,631,000 —
real USDG, the real position manager `0x73991a25…`, the real v3 factory
`0x1f7d7550…` — broadcasting for real into the fork, then re-asserted in
`VERIFY_ONLY` mode against the mined result. **33 checks, 0 failures**, twice
(once buying in one chunk, once in three).

### Gas

| Transaction | Gas |
| --- | ---: |
| `FeeVault` | 929,660 |
| `LPLocker` | 856,053 |
| `GraduationManager` | 1,945,491 |
| `HoodiumFactory` | 4,235,933 |
| `launch()` (token + curve + registration) | 2,449,552 |
| **Step 1 total** | **10,416,689** |
| `approve()` | 57,976 |
| `buy()` — the completing buy, *including the whole graduation* | 5,632,872 |
| **Step 2 total** | **5,690,848** |
| **Both steps** | **16,107,537** |

The 5.6M-gas buy is the expensive one: it creates a Uniswap pool, initialises it,
mints a full-range position and transfers the NFT into the locker. Robinhood
Chain's block gas limit is effectively unbounded (1.1e15), so it fits in a block
with room to spare.

### ETH

| Gas price | Step 1 | Step 2 | Total |
| --- | ---: | ---: | ---: |
| 0.045 gwei | 0.000469 ETH | 0.000256 ETH | **0.000725 ETH** |
| 0.0226 gwei (base fee observed 2026-08-25) | 0.000235 ETH | 0.000129 ETH | **0.000364 ETH** |

Budget **0.001 ETH** and you cannot be caught short.

### USDG

| | Raw (6 decimals) | USDG |
| --- | ---: | ---: |
| Graduation target | 3,000,000 | 3.000000 |
| 1% trade fee on it | 30,304 | 0.030304 |
| Creation fee | 0 | 0.000000 |
| **Total spent** | **3,030,304** | **3.030304** |

Of that, 3.000000 USDG goes into the pool as permanently locked liquidity,
0.021212 accrues to the creator and 0.009092 to the throwaway vault. The fee is
`net × 100 / 9900` rounded up, not 1% of the gross — the curve grosses the input
up so exactly the target lands in the reserve (LP-2.6).

Buying in more than one chunk costs a wei or two more, because each chunk's fee
rounds up separately: three chunks came to 3,030,306.

**The wallet needs 3.031 USDG and it must be there before step 2**, not before
step 1. Step 1 spends no USDG at all with `CREATION_FEE_USDG=0`.

---

## Runbook

### 0. Environment

```bash
cd hoodium_launchpad/contracts

export RPC_URL=https://rpc.mainnet.chain.robinhood.com
export EXPECTED_CHAIN_ID=4663
export PRIVATE_KEY=0x...                                             # the wallet holding the USDG

export USDG_ADDRESS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
export UNISWAP_POSITION_MANAGER=0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3

# Test-only overrides. These three are the entire difference from production.
export TEST_TARGET_USDG=3
export CREATION_FEE_USDG=0
export TEST_TOKEN_NAME="Graduation Test"
export TEST_TOKEN_SYMBOL=GRAD
```

The Uniswap v3 factory is not set: both scripts read it from
`positionManager.factory()`, so the two can never disagree. Everything else —
allocations, 1% trade fee, 70/30 split, 3-block anti-snipe window, 1% fee tier,
tick spacing 200, 30% protocol share of pool fees — is left at the production
default on purpose, because a test that changes them proves nothing about them.

Forge only via docker on this machine:

```bash
forge() {
  sudo docker run --rm -it \
    -v "$PWD":/w -w /w \
    -e RPC_URL -e EXPECTED_CHAIN_ID -e PRIVATE_KEY \
    -e USDG_ADDRESS -e UNISWAP_POSITION_MANAGER \
    -e TEST_TARGET_USDG -e CREATION_FEE_USDG -e TEST_TOKEN_NAME -e TEST_TOKEN_SYMBOL \
    -e TEST_CURVE -e TEST_TOKEN -e TEST_MANAGER -e TEST_LOCKER -e VERIFY_ONLY -e BUY_CHUNKS \
    ghcr.io/foundry-rs/foundry:latest "forge $*"
}
sudo chown -R ubuntu:ubuntu .        # after any docker forge run
```

### 1. Deploy the throwaway set and launch the token

```bash
forge script script/GraduationTestDeploy.s.sol --rpc-url $RPC_URL --broadcast -vv
```

It prints its parameters and the derived virtual reserves *before* broadcasting —
at a 3 USDG target they are `virtualUsdg = 1,000,000` (1 USDG) and
`virtualTokens = 266,666,666.67`, and the continuity recomputation lands on
199,999,999.999999999999999999 against an LP allocation of 200,000,000. That one
wei of slack is the whole point of checking: the same algebra that gives 23,000
USDG at the production target has to stay well-conditioned three orders of
magnitude down, and if it did not, the factory constructor would refuse to deploy
rather than ship a curve whose pool opens at the wrong price.

Then it prints the block to paste forward:

```
export TEST_FACTORY=0x...
export TEST_TOKEN=0x...
export TEST_CURVE=0x...
export TEST_MANAGER=0x...
export TEST_LOCKER=0x...
export TEST_VAULT=0x...
```

Paste that into the same shell. `TEST_CURVE` is the only one step 2 needs;
the others are cross-checked against it if present, so a block pasted from an
older run fails immediately instead of testing the wrong thing.

### 2. Wait three blocks

Step 1's output names the block: *"tradeable from block N"*. The curve caps
cumulative buys per address at 1% of supply for its first three blocks (LP-2.5 /
AUDIT H1), and buying the curve out means buying ~100% of the curve allocation.
There is no way around the cap and no reason to want one. On Robinhood Chain that
is a few seconds; step 2 refuses to start early and tells you which block to wait
for.

### 3. Buy it out and graduate

```bash
forge script script/GraduationTestRun.s.sol --rpc-url $RPC_URL --broadcast -vv
```

One `approve` for the exact total, then one `buy` that completes the curve and
graduates inside the same transaction. Set `BUY_CHUNKS=3` (or up to 32) to split
the buy — useful if you want to watch the price move on the way up, and it also
exercises the multi-accrual fee-rounding path.

### 4. Re-assert against the mined chain

```bash
VERIFY_ONLY=true forge script script/GraduationTestRun.s.sol --rpc-url $RPC_URL -vv
```

**Do not skip this.** The assertions in step 3 run against the state forge
simulated while building the transactions — before those transactions were mined.
Correct, but self-referential. `VERIFY_ONLY=true` sends nothing, writes nothing,
and re-runs every assertion against what is actually on chain. That is the proof;
step 3 is only the thing being proved.

---

## Reading the output

Every assertion is one line. `PASS` on all of them ends with:

```
checks run: 32   failures: 0
GRADUATION TEST PASSED
```

Any `FAIL` line still lets the rest of the checks run — so you see the whole
picture, not just the first thing that broke — and then the script reverts with
`GRADUATION TEST FAILED - see FAIL lines above`.

The summary block at the end is the receipt:

```
==================== SUMMARY ====================
 token                  0x…       the real mainnet ERC-20
 curve                  0x…
 creator                0x…       your wallet
 pool                   0x…       the new Uniswap v3 1% pool
 LP tokenId             787748    the position, now locked
 LP held by             0x…       the LPLocker — permanently
 USDG spent (raw)       3030304
 tokens bought (wei)    799999999999999999999999999
 buys                   1
 raise into pool (raw)  3000000
 fee to creator (raw)   21212
 fee to vault (raw)     9092
 USDG dust owed (raw)   0
 token dust owed (wei)  8017774727
=================================================
```

`slot0.sqrtPriceX96` and `closing sqrtPriceX96` are printed side by side; on a
pool nobody has traded yet they should read `(exact match)`. A value merely
*inside* the band means someone traded the pool between graduation and your
verification — still a pass, and still correct.

Anything you care to recover afterwards, all optional and all pull-based:

```
curve.claimCreatorFees()      creator only — 0.021212 USDG
curve.claimPlatformFees()     anyone — pays the throwaway vault
manager.pullDust(asset)       creator only — the mint leftovers
locker.collectFees(tokenId)   creator only — pool fees, forever, as they accrue
```

---

## If it fails midway

**Nothing gets stuck.** That is a property of the contracts, not of this script.

- **Graduation is atomic (LP-4.2).** There is no partial-success path and no
  try/catch. If anything in the migration reverts — pool creation, the re-pricing
  swap, the mint, the transfer into the locker — the entire transaction reverts,
  *including* `graduated = true`. The curve is left exactly as tradeable as it was
  a second earlier.
- **A half-bought curve is a normal curve.** If step 2 dies before reaching the
  target, your USDG is sitting in the curve's reserve and you can sell the tokens
  back out at the curve price with `sell()` for as long as the target has not been
  reached. You lose the 1% trade fee in each direction and nothing else.
- **A curve that reached the target but did not graduate** — which should be
  impossible on this path — is graduated by *anyone* calling `graduate()`. It is
  permissionless (LP-4.6) and needs no Hoodium involvement at all.
- **A failed step 1** costs gas and nothing else; re-run it and you get a fresh
  throwaway set at new addresses.

If you decide to walk away mid-test, walk away. The throwaway factory, vault,
locker and manager have no owner, no upgrade path and no claim on anything. They
sit on chain doing nothing, exactly like any other abandoned contract. There is
nothing to shut down and nothing to clean up.

The one thing that is genuinely gone either way: **the 3 USDG that reaches the
pool is permanently locked liquidity.** That is what graduation *is*. You can
collect the pool's trading fees forever through the locker, but the principal is
not recoverable by anyone, including you. Do not run this with money you want
back.

---

## The token will not appear on launchpad.hoodium.app

The API indexes exactly one factory — the address in its `LAUNCHPAD_FACTORY`
environment variable, which is production's
`0xA07329b233B2c7437BfcB6ed12a99AC36d69b05b`. The test token is launched from a
*different* factory, so it emits `TokenLaunched` where nothing is listening. It is
a completely real mainnet ERC-20 with a completely real Uniswap pool, visible on
Blockscout and tradeable by anyone who has the address — it simply has no row in
Hoodium's database and no page on the site.

That is the desired behaviour: a throwaway test token should not sit in the
product's launch feed looking like a launch.

**If you do want to see it in the UI**, point the API at the test factory
temporarily:

```bash
LAUNCHPAD_FACTORY=<TEST_FACTORY>
INDEXER_START_BLOCK=<the block step 1 deployed in>
```

…redeploy the API, and the whole token page renders — curve progress, trades,
graduation banner, the locked-LP fee panel. Set `LAUNCHPAD_FACTORY` back to the
production address and redeploy when you are done. Two caveats:

1. The indexer keeps a cursor. Pointing it at a new factory and back again means
   it has to re-scan; clear the cursor (or set `INDEXER_START_BLOCK` to the prod
   factory's deploy block) when you switch back, or it will resume from the wrong
   height.
2. While it is pointed at the test factory, launchpad.hoodium.app shows **only**
   the test token. Production launches disappear from the site until you switch
   back. They are not lost — nothing on chain changed — but the site is wrong for
   the duration, so do this in a quiet window or not at all.

---

## Decisions left to the owner

- **The throwaway FeeVault is deliberately unspendable.** It defaults to
  `[deployer, 0x…dEaD]` at threshold 2, so the 0.009 USDG of platform fees it can
  receive can never be withdrawn. This is on purpose: a test vault that looks
  spendable is a test vault someone wires into something later. Override with
  `TEST_VAULT_OWNERS` / `TEST_VAULT_THRESHOLD` if you would rather have the nine
  tenths of a cent back.
- **Contract verification** is not done. Add
  `--verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/`
  to either command if you want the throwaway set readable on the explorer — the
  test token's page looks more convincing that way, and it costs nothing but time.
- **`TEST_TARGET_USDG` is capped at 100** so a typo cannot spend real money. Raise
  `TEST_TARGET_MAX_USDG` if you deliberately want a larger rehearsal.
