# 002 — Launchpad · Requirements

**Status:** draft · **Depends on:** nothing · **Related:** [001 Auto LP](../001-auto-lp/) · [003 Web App](../003-web-app/)

## Summary

Let anyone launch a token on Robinhood Chain with no code: buyers trade against a USDG
bonding curve, and once the curve fills, the token graduates into a real Uniswap pool with
permanently locked liquidity.

USDG denomination is the deliberate difference from the launchpads on other chains, which
price launches in a volatile gas token. On a chain whose
reason for existing is a regulated stablecoin, pricing launches in USDG rather than a
volatile gas token means a creator's market cap does not move because ETH moved.

## Glossary

| Term | Definition |
|---|---|
| **Bonding curve** | Deterministic pricing function; price rises as supply is bought |
| **Virtual reserves** | Synthetic starting reserves that set the opening price without seed capital |
| **Graduation** | Curve reaches its target; liquidity migrates to a Uniswap pool |
| **Migration** | The atomic act of moving curve reserves into a pool |
| **Creator** | The address that deployed the token |
| **Dev buy** | The creator's own purchase at launch |

---

## R1 — Launching a token

**User story:** As a creator, I want to launch a token in under a minute without writing
code or providing initial capital.

| ID | Criterion |
|---|---|
| LP-1.1 | WHEN a creator submits name, symbol, and image THEN the system SHALL deploy an ERC-20 and its bonding curve in a single transaction |
| LP-1.2 | The deployed token SHALL have a fixed supply, no mint function, and no owner privileges after deployment |
| LP-1.3 | The creator SHALL NOT be required to provide initial liquidity |
| LP-1.4 | WHEN deployment succeeds THEN the system SHALL return a shareable token page URL within 5 seconds |
| LP-1.5 | The system SHALL charge a creation fee (default ~$1 in USDG, configurable) |
| LP-1.6 | IF a creator makes a dev buy THEN it SHALL execute in the same transaction as deployment, at curve price, capped at a configurable percentage of supply (default 5%) |
| LP-1.7 | Token metadata SHALL be stored on IPFS with the hash recorded on-chain |

## R2 — Trading the curve

**User story:** As a buyer, I want to buy and sell on the curve instantly with predictable
pricing.

| ID | Criterion |
|---|---|
| LP-2.1 | WHEN a buyer sends USDG THEN the contract SHALL mint tokens per the curve formula and transfer them in the same transaction |
| LP-2.2 | WHEN a seller returns tokens THEN the contract SHALL return USDG per the same formula |
| LP-2.3 | The contract SHALL charge a 1% fee on every buy and sell (configurable) |
| LP-2.4 | The contract SHALL enforce a caller-supplied minimum output; IF the result is worse THEN the transaction SHALL revert |
| LP-2.5 | For the first N blocks after deployment (default 3) the contract SHALL cap per-transaction buy size (default 1% of supply) |
| LP-2.6 | The contract SHALL reject a buy that would push the curve past its graduation target; the excess SHALL be refunded in the same transaction |
| LP-2.7 | Curve parameters SHALL be immutable after deployment |

## R3 — Fees

**User story:** As the platform, I need revenue that arrives whether or not a token succeeds.

> Basis: on the category-leading launchpad, only 1–1.4% of tokens graduate. A model that
> depends on graduation is a
> model that collects almost nothing.

**Priced against the incumbent (Aug 2026).** Pons — the launchpad running over half of this
chain's transactions — charges 1% and keeps 30% of it, takes ~0.0005 ETH at launch, and
charges nothing at graduation. Noxa, the runner-up, collected ~$12M and then moved to 0%,
routing everything to creators. The terms below match Pons line for line:

| | Pons | Here |
|---|---|---|
| Trade fee | 1% | 1% (`LP-2.3`) |
| — creator share | 70% | 70% (`creatorFeeShareBps: 7_000`) |
| — platform share | 30% | 30% |
| Creation fee | ~0.0005 ETH | ~$1, charged in USDG (`LP-1.5`) |
| Graduation fee | none | 0 (`LP-3.3`) |
| Locked-LP fees | 70/30 | 70/30 (`LPLocker`) |

Two deliberate divergences. The creation fee is denominated in USDG rather than the native
token — the factory never touches ETH, and a dollar fee stays a dollar. And there is still a
bonding curve, which Pons does not have: `R6` is why. The curve is what produces a graduated
pool for Auto LP to manage, and that handoff is the reason both products live in one company.

The cost of this is not small and should be stated rather than discovered: the platform's
take falls from 0.9% of curve volume to **0.3%**, a third of what the previous terms would
have collected. It is spent entirely on the creator side, which is the side that chooses the
venue.

| ID | Criterion |
|---|---|
| LP-3.1 | Trading fees SHALL be split between the platform vault and the creator per an immutable ratio set at deployment |
| LP-3.2 | The creator share SHALL be claimable by the creator at any time, and SHALL NOT be withdrawable by the platform |
| LP-3.3 | WHEN a token graduates THEN the contract SHALL transfer a graduation fee to the platform vault (default 0 — the mechanism stays, the charge does not) |
| LP-3.4 | Fee accounting SHALL be exact; no rounding may create or destroy value |
| LP-3.5 | The platform vault SHALL be a multisig, never an EOA |

## R4 — Graduation

**User story:** As a holder, I want a graduated token to trade on a real DEX with liquidity
that cannot be pulled.

| ID | Criterion |
|---|---|
| LP-4.1 | WHEN the curve reaches its target THEN the contract SHALL create a Uniswap USDG/TOKEN pool and deposit all remaining reserves |
| LP-4.2 | Migration SHALL be atomic; IF any step fails THEN the whole transaction SHALL revert and the curve SHALL stay tradeable |
| LP-4.3 | LP tokens from migration SHALL be permanently locked — burned or sent to an address provably without a withdrawal path |
| LP-4.4 | AFTER graduation the curve SHALL permanently refuse new buys and sells |
| LP-4.5 | WHEN graduation completes THEN the system SHALL emit an event carrying the pool address and notify the creator and all holders who opted in |
| LP-4.6 | Graduation SHALL be callable by anyone; it SHALL NOT depend on platform infrastructure being online |

## R5 — Discovery

**User story:** As a trader, I want to find new launches before they are obvious.

| ID | Criterion |
|---|---|
| LP-5.1 | The system SHALL show a live feed of new launches, updating within 5 seconds |
| LP-5.2 | The system SHALL rank tokens by volume, holder count, and curve progress |
| LP-5.3 | Each token page SHALL show curve progress, holders, volume, and full trade history |
| LP-5.4 | The system SHALL flag tokens whose creator holds an outsized share, or has previously launched tokens that failed |
| LP-5.5 | The system SHALL NOT editorially promote, endorse, or rank-boost any token for payment |

## R6 — Auto LP handoff

**User story:** As a creator, I want the pool my token graduates into to be managed properly,
so it doesn't die from thin liquidity.

> This is the flywheel described in [`specs/README.md`](../README.md). It is the reason both
> features exist in one product.

| ID | Criterion |
|---|---|
| LP-6.1 | WHEN a token graduates THEN the system SHALL register the new pool as an Auto LP candidate |
| LP-6.2 | The system SHALL offer the creator one-click Auto LP enrollment for their own position |
| LP-6.3 | Graduated pools SHALL be visible in Auto LP's candidate ranking (`AL-6.2`) with their origin marked |
| LP-6.4 | Enrollment SHALL be opt-in; graduation SHALL NOT automatically grant Hoodium any authority over creator funds |

---

## Non-functional requirements

| ID | Category | Criterion |
|---|---|---|
| LP-N1 | Security | Contracts SHALL be immutable — no proxy, no upgrade path, no admin mint, no pause on user funds |
| LP-N2 | Security | Every state-changing external function SHALL carry reentrancy protection |
| LP-N3 | Security | Contracts SHALL pass an external audit before mainnet. No exceptions for launch timing |
| LP-N4 | Security | Curve math SHALL be fuzz-tested for invariant violations across the full input range |
| LP-N5 | Compliance | Hoodium SHALL NOT issue a token, promise yield, or take payment for promotion |
| LP-N6 | Compliance | The UI SHALL display a risk disclosure before a first purchase |
| LP-N7 | Availability | Trading and graduation SHALL work with Hoodium's servers fully offline (`LP-4.6`) |
| LP-N8 | Precision | Curve math SHALL use fixed-point arithmetic; rounding SHALL always favor the contract, never the caller |

## Out of scope

- A Hoodium platform token
- Presales, allowlists, vesting schedules
- Cross-chain launches
- NFT launches
- Automated moderation of token content beyond the flags in `LP-5.4`
