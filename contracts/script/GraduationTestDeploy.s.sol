// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {LPLocker} from "../src/LPLocker.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IPositionManagerFactory {
    function factory() external view returns (address);
}

/**
 * @title GraduationTestDeploy
 * @notice Step 1 of 2 — stand up a THROWAWAY launchpad set with a tiny
 *         graduation target and launch one token on it, so graduation can be
 *         proven end to end on mainnet for a few cents.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 * This is not the production deployment. `Deploy.s.sol` is. Nothing here touches
 * the prod factory, the prod vault or any token already launched: this script
 * deploys its own FeeVault / LPLocker / GraduationManager / HoodiumFactory,
 * unconnected to anything, and abandons them once the test is done. The only
 * shared objects are the chain's real USDG and the real Uniswap v3 deployment —
 * which is the entire point, because those are what the rehearsal is meant to
 * exercise.
 *
 * ── Why two scripts ──────────────────────────────────────────────────────────
 * `snipeBlocks` caps cumulative buys per address for the first blocks of a
 * curve's life (LP-2.5 / AUDIT H1), and the cap is 1% of supply — far below the
 * ~100% of the curve allocation this test has to buy. A single script that
 * launched and then immediately bought would be refused by the curve's own
 * anti-snipe guard. So step 1 launches, step 2 runs after the window closes.
 * `GraduationTestRun.s.sol` refuses to start until it has.
 *
 * ── Parameters ───────────────────────────────────────────────────────────────
 * Everything is prod-identical except three things, and each is deliberate:
 *
 *   TEST_TARGET_USDG    3        instead of 69,000 — the cost of the whole test
 *   CREATION_FEE_USDG   0        instead of 1 — the fee only moves USDG to a
 *                                throwaway vault, so charging it just burns money
 *   VAULT_OWNERS        throwaway signers, because the real vault must never
 *                                receive test dust
 *
 * The allocations are left alone (1B supply, 800M curve) so the factory's own
 * price-continuity check (AUDIT H3) has to pass at the test target exactly as it
 * does at the prod one. At a 3 USDG target that derives virtualUsdg = 1 USDG and
 * virtualTokens = 266,666,666.67 — and the continuity recomputation lands on
 * 200,000,000 to the wei. If the continuity algebra were only well conditioned at
 * 69,000, this script would fail in the factory constructor rather than mislead.
 *
 *   forge script script/GraduationTestDeploy.s.sol --rpc-url $RPC_URL --broadcast
 *
 * See GRADUATION-TEST.md for the runbook.
 */
contract GraduationTestDeploy is Script {
    uint256 internal constant BPS = 10_000;

    /// A test target above this is almost certainly a typo, and a typo here
    /// spends real money. Overridable, but not by accident.
    uint256 internal constant SANE_TEST_TARGET_USDG = 100;

    struct Params {
        address usdg;
        uint8 usdgDecimals;
        uint256 usdgUnit;
        address uniswapFactory;
        address positionManager;
        address[] vaultOwners;
        uint256 vaultThreshold;
        uint256 lpProtocolFeeShareBps;
        uint24 poolFee;
        int24 tickSpacing;
        uint256 totalSupply;
        uint256 curveAllocation;
        uint256 graduationTarget;
        uint256 graduationFee;
        uint256 tradeFeeBps;
        uint256 creatorFeeShareBps;
        uint256 creationFee;
        uint256 devBuyMaxBps;
        uint256 snipeBlocks;
        uint256 snipeMaxBps;
        string tokenName;
        string tokenSymbol;
        string metadataURI;
    }

    // The deployed set, kept on the script rather than in locals: `run` was one
    // stack slot from Stack-too-deep, and reaching for `via_ir` to print a
    // summary would change the bytecode this repo ships.
    FeeVault internal _vault;
    LPLocker internal _locker;
    GraduationManager internal _manager;
    HoodiumFactory internal _factory;
    address internal _token;
    address internal _curve;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        Params memory p = _load(deployer);

        // AUDIT L6 — a wrong RPC_URL with the right key is the likeliest way to
        // put immutable contracts on the wrong network. Defaults to Robinhood
        // Chain but still checked.
        require(
            block.chainid == vm.envOr("EXPECTED_CHAIN_ID", uint256(4663)),
            "chain id mismatch: check RPC_URL / EXPECTED_CHAIN_ID"
        );

        _print(p, deployer);
        _deploy(p, deployerKey, deployer);

        require(_factory.curveOf(_token) == _curve, "factory did not register the curve");
        _report();
    }

    function _deploy(Params memory p, uint256 deployerKey, address deployer) internal {
        // Forward references, exactly as Deploy.s.sol: the locker names the
        // manager and the manager names the factory, but each is deployed first.
        // Nothing else may be broadcast from this key in between.
        uint64 nonce = vm.getNonce(deployer);
        address predictedManager = vm.computeCreateAddress(deployer, nonce + 2);
        address predictedFactory = vm.computeCreateAddress(deployer, nonce + 3);

        vm.startBroadcast(deployerKey);

        _vault = new FeeVault(p.vaultOwners, p.vaultThreshold);
        _locker = new LPLocker(p.positionManager, address(_vault), p.lpProtocolFeeShareBps, predictedManager);
        _manager = new GraduationManager(
            p.uniswapFactory, p.positionManager, address(_locker), p.usdg, p.poolFee, p.tickSpacing, predictedFactory
        );
        require(address(_manager) == predictedManager, "manager address drifted from prediction");

        _factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: p.usdg,
                feeVault: address(_vault),
                graduationManager: address(_manager),
                tokenDecimals: 18,
                totalSupply: p.totalSupply,
                curveAllocation: p.curveAllocation,
                graduationTarget: p.graduationTarget,
                graduationFee: p.graduationFee,
                tradeFeeBps: p.tradeFeeBps,
                creatorFeeShareBps: p.creatorFeeShareBps,
                creationFee: p.creationFee,
                devBuyMaxBps: p.devBuyMaxBps,
                snipeBlocks: p.snipeBlocks,
                snipeMaxBps: p.snipeMaxBps
            })
        );
        require(address(_factory) == predictedFactory, "factory address drifted from prediction");

        // No dev buy. A dev buy is capped at 5% of supply and would only add a
        // second code path (`graduate()` rather than the completing buy) to a run
        // whose whole purpose is to exercise the ordinary one.
        (_token, _curve) = _factory.launch(p.tokenName, p.tokenSymbol, p.metadataURI, 0, 0);

        vm.stopBroadcast();
    }

    // ── Parameters ───────────────────────────────────────────────────────────

    function _load(address deployer) internal view returns (Params memory p) {
        p.usdg = vm.envAddress("USDG_ADDRESS");
        p.positionManager = vm.envAddress("UNISWAP_POSITION_MANAGER");
        require(p.usdg.code.length > 0, "USDG_ADDRESS has no code on this chain");
        require(p.positionManager.code.length > 0, "UNISWAP_POSITION_MANAGER has no code on this chain");

        p.uniswapFactory = vm.envOr("UNISWAP_V3_FACTORY", address(0));
        if (p.uniswapFactory == address(0)) {
            p.uniswapFactory = IPositionManagerFactory(p.positionManager).factory();
        }
        require(p.uniswapFactory.code.length > 0, "Uniswap factory has no code on this chain");

        uint256 dec = vm.envOr("USDG_DECIMALS", uint256(0));
        if (dec == 0) dec = IERC20Decimals(p.usdg).decimals();
        require(dec > 0 && dec <= 18, "USDG_DECIMALS out of range");
        p.usdgDecimals = uint8(dec);
        p.usdgUnit = 10 ** dec;

        /*
         * The throwaway vault. It exists because FeeVault is a constructor
         * argument of every other contract here, not because this test needs a
         * vault — the platform's share of a 3 USDG raise is under a cent, and it
         * is expected to be abandoned along with the rest of the set.
         *
         * Defaults to the deployer plus 0x…dEaD at threshold 2, which is
         * deliberately a vault that can never pay out: the point is that the real
         * vault must not appear anywhere in this deployment, and a test vault that
         * looks spendable invites someone to wire it into something later.
         */
        address[] memory defaultOwners = new address[](2);
        defaultOwners[0] = deployer;
        defaultOwners[1] = 0x000000000000000000000000000000000000dEaD;
        p.vaultOwners = vm.envOr("TEST_VAULT_OWNERS", ",", defaultOwners);
        p.vaultThreshold = vm.envOr("TEST_VAULT_THRESHOLD", uint256(2));
        require(p.vaultOwners.length >= 2, "TEST_VAULT_OWNERS needs at least two signers");
        require(p.vaultThreshold >= 2 && p.vaultThreshold <= p.vaultOwners.length, "TEST_VAULT_THRESHOLD out of range");

        // Prod values, untouched.
        p.lpProtocolFeeShareBps = vm.envOr("LP_PROTOCOL_FEE_SHARE_BPS", uint256(3_000));
        p.poolFee = uint24(vm.envOr("POOL_FEE", uint256(10_000)));
        p.tickSpacing = int24(int256(vm.envOr("POOL_TICK_SPACING", uint256(200))));
        p.totalSupply = vm.envOr("TOTAL_SUPPLY", uint256(1_000_000_000)) * 1e18;
        p.curveAllocation = vm.envOr("CURVE_ALLOCATION", uint256(800_000_000)) * 1e18;
        p.graduationFee = vm.envOr("GRADUATION_FEE_USDG", uint256(0)) * p.usdgUnit;
        p.tradeFeeBps = vm.envOr("TRADE_FEE_BPS", uint256(100));
        p.creatorFeeShareBps = vm.envOr("CREATOR_FEE_SHARE_BPS", uint256(7_000));
        p.devBuyMaxBps = vm.envOr("DEV_BUY_MAX_BPS", uint256(500));
        p.snipeBlocks = vm.envOr("SNIPE_BLOCKS", uint256(3));
        p.snipeMaxBps = vm.envOr("SNIPE_MAX_BPS", uint256(100));

        // The two test-only overrides.
        uint256 targetWhole = vm.envOr("TEST_TARGET_USDG", uint256(3));
        require(targetWhole > 0, "TEST_TARGET_USDG must be positive");
        require(
            targetWhole <= vm.envOr("TEST_TARGET_MAX_USDG", SANE_TEST_TARGET_USDG),
            "TEST_TARGET_USDG looks like a typo; raise TEST_TARGET_MAX_USDG if you meant it"
        );
        p.graduationTarget = targetWhole * p.usdgUnit;
        p.creationFee = vm.envOr("CREATION_FEE_USDG", uint256(0)) * p.usdgUnit;

        p.tokenName = vm.envOr("TEST_TOKEN_NAME", string("Graduation Test"));
        p.tokenSymbol = vm.envOr("TEST_TOKEN_SYMBOL", string("GRAD"));
        p.metadataURI = vm.envOr("TEST_METADATA_URI", string(""));

        require(p.curveAllocation < p.totalSupply, "CURVE_ALLOCATION must leave an LP allocation");
        require(p.curveAllocation > p.totalSupply / 2, "CURVE_ALLOCATION must exceed the LP allocation");
        require(p.graduationTarget > p.graduationFee, "TEST_TARGET_USDG must exceed the graduation fee");
    }

    /**
     * @dev The factory derives both virtual reserves and refuses a set that
     *      breaks price continuity (AUDIT H3). Recomputed here purely so the
     *      numbers are on screen *before* anything is broadcast: at a target this
     *      small a rounding surprise is the one thing that could make the test set
     *      behave unlike the prod set, and it is free to catch here.
     */
    function _previewReserves(Params memory p)
        internal
        pure
        returns (uint256 virtualUsdg, uint256 virtualTokens, uint256 continuity)
    {
        uint256 lpAllocation = p.totalSupply - p.curveAllocation;
        uint256 usdgForLp = p.graduationTarget - p.graduationFee;
        uint256 lpTimesTarget = lpAllocation * p.graduationTarget;
        require(p.curveAllocation * usdgForLp > lpTimesTarget, "lp allocation too large for continuity");
        virtualUsdg = Math.mulDiv(lpTimesTarget, p.graduationTarget, p.curveAllocation * usdgForLp - lpTimesTarget);
        virtualTokens = Math.mulDiv(p.curveAllocation, virtualUsdg, p.graduationTarget);
        continuity = Math.mulDiv(virtualTokens, usdgForLp, virtualUsdg + p.graduationTarget);
    }

    /// @dev Gross USDG a buyer must hand over to move `net` past the fee (LP-2.6).
    function _grossFor(uint256 net, uint256 feeBps) internal pure returns (uint256) {
        return net + Math.mulDiv(net, feeBps, BPS - feeBps, Math.Rounding.Ceil);
    }

    function _print(Params memory p, address deployer) internal view {
        (uint256 vU, uint256 vT, uint256 continuity) = _previewReserves(p);
        uint256 lpAllocation = p.totalSupply - p.curveAllocation;
        uint256 needed = _grossFor(p.graduationTarget - p.graduationFee, p.tradeFeeBps) + p.creationFee;
        uint256 have = IERC20(p.usdg).balanceOf(deployer);

        console2.log("=== THROWAWAY GRADUATION TEST SET (chain %s) ===", block.chainid);
        console2.log("This is NOT the production deployment. Use Deploy.s.sol for that.");
        console2.log("");
        console2.log("deployer / creator      ", deployer);
        console2.log("USDG                    ", p.usdg);
        console2.log("USDG decimals           ", uint256(p.usdgDecimals));
        console2.log("Uniswap v3 factory      ", p.uniswapFactory);
        console2.log("Position manager        ", p.positionManager);
        for (uint256 i = 0; i < p.vaultOwners.length; i++) {
            console2.log("Test vault owner        ", p.vaultOwners[i]);
        }
        console2.log("Test vault threshold    ", p.vaultThreshold);
        console2.log("Pool fee / tick spacing ", uint256(p.poolFee), uint256(int256(p.tickSpacing)));
        console2.log("Total supply (wei)      ", p.totalSupply);
        console2.log("Curve allocation (wei)  ", p.curveAllocation);
        console2.log("LP allocation (wei)     ", lpAllocation);
        console2.log("Graduation target (raw) ", p.graduationTarget);
        console2.log("Graduation fee (raw)    ", p.graduationFee);
        console2.log("Creation fee (raw)      ", p.creationFee);
        console2.log("Trade fee (bps)         ", p.tradeFeeBps);
        console2.log("Creator fee share (bps) ", p.creatorFeeShareBps);
        console2.log("Snipe blocks / max bps  ", p.snipeBlocks, p.snipeMaxBps);
        console2.log("");
        console2.log("--- derived reserves (the factory recomputes these) ---");
        console2.log("virtualUsdg (raw)       ", vU);
        console2.log("virtualTokens (wei)     ", vT);
        console2.log("continuity lpAlloc (wei)", continuity);
        console2.log("target  lpAlloc (wei)   ", lpAllocation);
        console2.log("");
        console2.log("--- money ---");
        console2.log("USDG needed by step 2   ", needed);
        console2.log("USDG held by deployer   ", have);
        if (have < needed) {
            console2.log("!! deployer is short of USDG for step 2; step 1 will still succeed");
        }
        console2.log("");
    }

    function _report() internal view {
        BondingCurve c = BondingCurve(_curve);
        uint256 needed = _grossFor(c.graduationTarget() - c.graduationFee(), c.tradeFeeBps());

        console2.log("=== deployed ===");
        console2.log("FeeVault (throwaway)    ", address(_vault));
        console2.log("LPLocker (throwaway)    ", address(_locker));
        console2.log("GraduationManager       ", address(_manager));
        console2.log("HoodiumFactory          ", address(_factory));
        console2.log("virtualUsdg             ", _factory.virtualUsdg());
        console2.log("virtualTokens           ", _factory.virtualTokens());
        console2.log("");
        console2.log("=== launched ===");
        console2.log("token                   ", _token);
        console2.log("curve                   ", _curve);
        console2.log("creator                 ", c.creator());
        console2.log("deployBlock             ", c.deployBlock());
        console2.log("tradeable from block    ", c.deployBlock() + c.snipeBlocks());
        console2.log("current block           ", block.number);
        console2.log("");
        console2.log("=== paste this before running step 2 ===");
        console2.log("export TEST_FACTORY=%s", address(_factory));
        console2.log("export TEST_TOKEN=%s", _token);
        console2.log("export TEST_CURVE=%s", _curve);
        console2.log("export TEST_MANAGER=%s", address(_manager));
        console2.log("export TEST_LOCKER=%s", address(_locker));
        console2.log("export TEST_VAULT=%s", address(_vault));
        console2.log("");
        console2.log("Step 2 will spend %s raw USDG (target + 1%% trade fee).", needed);
        console2.log("Wait until block %s, then:", c.deployBlock() + c.snipeBlocks());
        console2.log("  forge script script/GraduationTestRun.s.sol --rpc-url $RPC_URL --broadcast");
        console2.log("");
        console2.log("The token above is a real mainnet token on a THROWAWAY factory.");
        console2.log("launchpad.hoodium.app indexes only the prod factory, so it will not appear there.");
    }
}
