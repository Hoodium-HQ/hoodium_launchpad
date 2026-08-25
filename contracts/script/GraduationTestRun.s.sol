// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {INonfungiblePositionManager, IUniswapV3Factory, IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";

/**
 * @title GraduationTestRun
 * @notice Step 2 of 2 — buy out the throwaway curve from
 *         `GraduationTestDeploy.s.sol`, then prove every post-graduation
 *         invariant on the real chain.
 *
 * The completing buy graduates inside the same transaction (AUDIT H2), so under
 * normal conditions `graduate()` is never called here. It is called only for the
 * one shape that can complete without graduating — a curve whose target was
 * reached by a launch-time dev buy — so that a run against a curve someone
 * finished by another route still ends in a graduated state rather than a
 * confusing failure.
 *
 *   forge script script/GraduationTestRun.s.sol --rpc-url $RPC_URL --broadcast
 *
 * ── Two modes ────────────────────────────────────────────────────────────────
 * Assertions in a broadcasting `forge script` run read the *simulated* post-state
 * that forge built while assembling the transactions — correct, but assembled
 * before those transactions were actually mined. So after a `--broadcast` run,
 * run it again with `VERIFY_ONLY=true` and no `--broadcast`: it skips every
 * write and re-asserts the same list against what is really on chain. A test that
 * only ever checks its own simulation is not a proof.
 *
 * ── Failure is safe ──────────────────────────────────────────────────────────
 * Graduation is atomic (LP-4.2): any revert anywhere in the chain reverts the
 * whole transaction including `graduated = true`, and the curve is left exactly
 * as tradeable as it was. A run that dies halfway leaves USDG in the curve's
 * reserve, which the buyer can sell back out at the curve price for as long as
 * the target has not been reached. Nothing is ever stuck in a contract with no
 * exit.
 */
contract GraduationTestRun is Script {
    uint256 internal constant BPS = 10_000;
    int24 internal constant MAX_TICK = 887272;

    /// Per-accrual rounding gives at most 1 wei to the platform (LP-3.4); this
    /// is the slack the 70/30 assertion allows across an unknown number of buys.
    uint256 internal constant FEE_SPLIT_TOLERANCE_WEI = 16;

    uint256 private _checks;
    uint256 private _failures;

    struct Ctx {
        BondingCurve curve;
        IERC20 token;
        IERC20 usdg;
        GraduationManager manager;
        LPLocker locker;
        INonfungiblePositionManager positionManager;
        IUniswapV3Factory uniswapFactory;
        address creator;
        uint24 poolFee;
        int24 tickSpacing;
    }

    struct Result {
        uint256 usdgSpent;
        uint256 tokensBought;
        uint256 buys;
        bool graduatedHere;
        bool calledGraduate;
    }

    function run() external {
        Ctx memory ctx = _load();
        bool verifyOnly = vm.envOr("VERIFY_ONLY", false);

        Result memory r;
        if (!verifyOnly) {
            r = _buyOut(ctx);
        } else {
            console2.log("VERIFY_ONLY=true - no transactions, asserting against chain state only.");
            console2.log("");
        }

        _assertGraduated(ctx);
        _assertPool(ctx);
        _assertPosition(ctx);
        _assertFees(ctx, r, verifyOnly);
        _assertDust(ctx);
        _assertSellRefused(ctx);
        _summary(ctx, r, verifyOnly);

        console2.log("");
        console2.log("checks run: %s   failures: %s", _checks, _failures);
        require(_failures == 0, "GRADUATION TEST FAILED - see FAIL lines above");
        console2.log("GRADUATION TEST PASSED");
    }

    // ── Setup ────────────────────────────────────────────────────────────────

    function _load() internal view returns (Ctx memory ctx) {
        address curveAddress = vm.envAddress("TEST_CURVE");
        require(curveAddress.code.length > 0, "TEST_CURVE has no code on this chain");
        ctx.curve = BondingCurve(curveAddress);
        ctx.token = ctx.curve.token();
        ctx.usdg = ctx.curve.usdg();
        ctx.creator = ctx.curve.creator();
        ctx.manager = GraduationManager(address(ctx.curve.graduationManager()));
        ctx.locker = ctx.manager.locker();
        ctx.positionManager = ctx.manager.positionManager();
        ctx.uniswapFactory = ctx.manager.uniswapFactory();
        ctx.poolFee = ctx.manager.poolFee();
        ctx.tickSpacing = ctx.manager.tickSpacing();

        // TEST_TOKEN / TEST_MANAGER / TEST_LOCKER are optional: everything is
        // reachable from the curve. When they are set they are cross-checked,
        // because a mismatch means the pasted block came from a different run.
        address expectToken = vm.envOr("TEST_TOKEN", address(0));
        address expectManager = vm.envOr("TEST_MANAGER", address(0));
        address expectLocker = vm.envOr("TEST_LOCKER", address(0));
        require(expectToken == address(0) || expectToken == address(ctx.token), "TEST_TOKEN does not match TEST_CURVE");
        require(
            expectManager == address(0) || expectManager == address(ctx.manager),
            "TEST_MANAGER does not match TEST_CURVE"
        );
        require(
            expectLocker == address(0) || expectLocker == address(ctx.locker), "TEST_LOCKER does not match TEST_CURVE"
        );
    }

    // ── Step 1: buy the curve out ────────────────────────────────────────────

    function _buyOut(Ctx memory ctx) internal returns (Result memory r) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address buyer = vm.addr(deployerKey);

        if (ctx.curve.graduated()) {
            console2.log("Curve is already graduated - skipping the buy, asserting only.");
            console2.log("");
            return r;
        }

        /*
         * LP-2.5 / AUDIT H1 — cumulative buys per address are capped at 1% of
         * supply for the opening blocks, which is far below what buying out the
         * curve needs. There is no way to work around it from here and no reason
         * to try: waiting a few blocks is the intended behaviour, so say so
         * plainly rather than reverting inside the curve with a cap error.
         */
        uint256 openBlock = ctx.curve.deployBlock() + ctx.curve.snipeBlocks();
        if (block.number < openBlock) {
            console2.log("Anti-snipe window still open. current block %s, tradeable at %s", block.number, openBlock);
            revert("anti-snipe window still open; wait for the block above and re-run");
        }

        uint256 remaining = ctx.curve.remainingToTarget();
        require(remaining > 0, "curve already complete; run with VERIFY_ONLY=true or let it graduate");

        uint256 chunks = vm.envOr("BUY_CHUNKS", uint256(1));
        require(chunks > 0 && chunks <= 32, "BUY_CHUNKS out of range");
        uint256[] memory gross = _planChunks(remaining, ctx.curve.tradeFeeBps(), chunks);

        uint256 total;
        for (uint256 i = 0; i < gross.length; i++) {
            total += gross[i];
        }

        uint256 balance = ctx.usdg.balanceOf(buyer);
        if (balance < total) {
            console2.log("USDG needed %s, held %s", total, balance);
            revert("buyer does not hold enough USDG to complete the curve");
        }

        uint256 tokensBefore = ctx.token.balanceOf(buyer);
        uint256 usdgBefore = balance;
        uint256 deadline = block.timestamp + 1 hours;

        vm.startBroadcast(deployerKey);

        // One approval for the whole run. USDG is a Paxos-style token and some of
        // that family refuse a non-zero -> non-zero approve, so clear first when
        // something is already standing.
        if (ctx.usdg.allowance(buyer, address(ctx.curve)) != 0) {
            ctx.usdg.approve(address(ctx.curve), 0);
        }
        ctx.usdg.approve(address(ctx.curve), total);

        for (uint256 i = 0; i < gross.length; i++) {
            if (ctx.curve.curveComplete()) break;
            ctx.curve.buy(gross[i], 0, deadline);
            r.buys++;
        }

        // Only reachable when the curve completed by a path that does not
        // graduate on its own — a launch-time dev buy. The completing buy above
        // graduates inside its own transaction.
        if (!ctx.curve.graduated() && ctx.curve.curveComplete()) {
            ctx.curve.graduate();
            r.calledGraduate = true;
        }

        // Leave no standing allowance on a contract that is about to be abandoned.
        if (ctx.usdg.allowance(buyer, address(ctx.curve)) != 0) {
            ctx.usdg.approve(address(ctx.curve), 0);
        }

        vm.stopBroadcast();

        r.usdgSpent = usdgBefore - ctx.usdg.balanceOf(buyer);
        r.tokensBought = ctx.token.balanceOf(buyer) - tokensBefore;
        r.graduatedHere = true;

        console2.log("=== buy run ===");
        console2.log("buys           ", r.buys);
        console2.log("USDG spent     ", r.usdgSpent);
        console2.log("tokens bought  ", r.tokensBought);
        console2.log("graduate() call", r.calledGraduate);
        console2.log("");
    }

    /**
     * @dev Split `remaining` net USDG into `chunks` buys and gross each one up by
     *      the trade fee, so the approval can be exact. `remaining` falls by
     *      exactly the net of each buy, so this is arithmetic rather than
     *      simulation — no state is touched.
     */
    function _planChunks(uint256 remaining, uint256 feeBps, uint256 chunks)
        internal
        pure
        returns (uint256[] memory gross)
    {
        gross = new uint256[](chunks);
        uint256 left = remaining;
        for (uint256 i = 0; i < chunks; i++) {
            uint256 net = (i + 1 == chunks) ? left : left / (chunks - i);
            if (net == 0) net = left;
            left -= net;
            gross[i] = net + Math.mulDiv(net, feeBps, BPS - feeBps, Math.Rounding.Ceil);
            if (left == 0) {
                // Shrink to the buys that actually carry money.
                uint256[] memory trimmed = new uint256[](i + 1);
                for (uint256 j = 0; j <= i; j++) {
                    trimmed[j] = gross[j];
                }
                return trimmed;
            }
        }
    }

    // ── Assertions ───────────────────────────────────────────────────────────

    function _assertGraduated(Ctx memory ctx) internal {
        console2.log("=== graduation ===");
        _check(ctx.curve.graduated(), "curve.graduated() is true");
        _check(ctx.curve.pool() != address(0), "curve.pool() is non-zero");
        _check(ctx.curve.lpTokenId() != 0, "curve.lpTokenId() is non-zero");
        _check(ctx.curve.reserveUsdg() == 0, "curve reserve was emptied into the pool");
    }

    function _assertPool(Ctx memory ctx) internal {
        console2.log("=== pool ===");
        address pool = ctx.curve.pool();
        address registered = ctx.uniswapFactory.getPool(address(ctx.token), address(ctx.usdg), ctx.poolFee);
        _check(pool != address(0) && pool.code.length > 0, "pool has code");
        _check(registered == pool, "uniswapFactory.getPool(token, USDG, poolFee) == curve.pool()");
        _check(ctx.poolFee == 10_000, "pool is the 1% fee tier");

        (address t0, address t1) = address(ctx.token) < address(ctx.usdg)
            ? (address(ctx.token), address(ctx.usdg))
            : (address(ctx.usdg), address(ctx.token));
        _check(IUniswapV3Pool(pool).token0() == t0 && IUniswapV3Pool(pool).token1() == t1, "pool pairs token with USDG");

        // The manager recomputes the closing price from the curve's own final
        // state, so for an untraded fresh pool this should be exact; the band is
        // what `migrate` itself would have accepted (AUDIT C1, rule 2).
        (uint160 current,,,,,,) = IUniswapV3Pool(pool).slot0();
        uint160 target = ctx.manager.targetSqrtPriceX96(address(ctx.curve));
        _check(current != 0, "pool is initialised");
        _check(ctx.manager.isWithinBand(current, target), "pool price is within the manager's band of the close");
        console2.log("  slot0.sqrtPriceX96  ", current);
        console2.log("  closing sqrtPriceX96", target);
        if (current == target) console2.log("  (exact match)");

        // "A swap is possible" — in-range liquidity plus both sides actually held.
        _check(IUniswapV3Pool(pool).liquidity() > 0, "pool has in-range liquidity");
        _check(ctx.token.balanceOf(pool) > 0, "pool holds the launched token");
        _check(ctx.usdg.balanceOf(pool) > 0, "pool holds USDG");
        uint256 usdgForLp = ctx.curve.graduationTarget() - ctx.curve.graduationFee();
        _check(
            ctx.usdg.balanceOf(pool) >= Math.mulDiv(usdgForLp, 9_900, BPS),
            "pool received at least 99% of the raise (MIN_FILL_BPS)"
        );
    }

    function _assertPosition(Ctx memory ctx) internal {
        console2.log("=== locked position ===");
        uint256 id = ctx.curve.lpTokenId();
        (,,,,, int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = ctx.positionManager.positions(id);

        // Full range means the largest multiple of the spacing inside MAX_TICK.
        // forge-lint: disable-next-line(divide-before-multiply)
        int24 maxUsable = (MAX_TICK / ctx.tickSpacing) * ctx.tickSpacing;
        _check(ctx.tickSpacing == 200, "tick spacing is 200");
        _check(tickLower == -maxUsable && tickUpper == maxUsable, "position is full range for the spacing");
        _check(liquidity > 0, "position has liquidity");
        _check(ctx.positionManager.ownerOf(id) == address(ctx.locker), "positionManager.ownerOf(id) == locker");
        _check(ctx.locker.beneficiaryOf(id) == ctx.creator, "locker.beneficiaryOf(id) == creator");
        _check(ctx.locker.tokenOf(id) == address(ctx.token), "locker.tokenOf(id) == token");
        console2.log("  tickLower           ", vm.toString(int256(tickLower)));
        console2.log("  tickUpper           ", vm.toString(int256(tickUpper)));
        console2.log("  liquidity           ", uint256(liquidity));
    }

    function _assertFees(Ctx memory ctx, Result memory r, bool verifyOnly) internal {
        console2.log("=== fee accounting ===");
        uint256 creatorAccrued = ctx.curve.creatorFeesAccrued();
        uint256 platformAccrued = ctx.curve.platformFeesAccrued();
        uint256 totalFees = creatorAccrued + platformAccrued;
        uint256 shareBps = ctx.curve.creatorFeeShareBps();

        _check(totalFees > 0, "trade fees were accrued");

        // LP-3.4 — the platform share is the remainder of the creator share, so
        // the split can neither create nor destroy a wei. Each accrual rounds the
        // creator down, so the creator can be a few wei under the ideal split and
        // never over.
        uint256 idealCreator = Math.mulDiv(totalFees, shareBps, BPS);
        _check(creatorAccrued <= idealCreator, "creator share never rounds up");
        _check(creatorAccrued + FEE_SPLIT_TOLERANCE_WEI >= idealCreator, "creator share is 70% of fees (bar rounding)");
        _check(platformAccrued == totalFees - creatorAccrued, "platform share is the exact remainder");

        // The curve must hold precisely the fees it still owes and nothing else:
        // the reserve went to the pool, the tokens went to buyers and the pool.
        uint256 owed = (creatorAccrued - ctx.curve.creatorFeesClaimed()) + (platformAccrued - ctx.curve.platformFeesClaimed());
        _check(ctx.usdg.balanceOf(address(ctx.curve)) == owed, "curve holds exactly the unclaimed fees, no more");
        _check(ctx.token.balanceOf(address(ctx.curve)) == 0, "curve holds no leftover launch tokens");

        if (!verifyOnly && r.graduatedHere) {
            // The only place the raise and the fee can be reconciled against real
            // money leaving the wallet.
            _check(
                r.usdgSpent == ctx.curve.graduationTarget() + totalFees - ctx.curve.graduationFee()
                    || r.usdgSpent == ctx.curve.graduationTarget() + totalFees,
                "USDG spent == target + fees"
            );
        }

        console2.log("  total trade fees    ", totalFees);
        console2.log("  creator accrued     ", creatorAccrued);
        console2.log("  platform accrued    ", platformAccrued);
        console2.log("  creator share (bps) ", totalFees == 0 ? 0 : Math.mulDiv(creatorAccrued, BPS, totalFees));
    }

    function _assertDust(Ctx memory ctx) internal {
        console2.log("=== dust (pull-based, AUDIT M2) ===");
        uint256 dustUsdg = ctx.manager.dustOf(address(ctx.usdg), ctx.creator);
        uint256 dustToken = ctx.manager.dustOf(address(ctx.token), ctx.creator);

        // Nothing is pushed during graduation, so whatever the mint left behind is
        // sitting on the manager credited to the creator and nowhere else. On a
        // fresh throwaway manager its balance IS the dust.
        _check(ctx.usdg.balanceOf(address(ctx.manager)) == dustUsdg, "manager USDG balance == credited USDG dust");
        _check(ctx.token.balanceOf(address(ctx.manager)) == dustToken, "manager token balance == credited token dust");
        _check(
            ctx.usdg.allowance(address(ctx.manager), address(ctx.positionManager)) == 0,
            "manager left no standing approval"
        );
        _check(
            ctx.usdg.allowance(address(ctx.curve), address(ctx.manager)) == 0, "curve left no standing approval"
        );
        console2.log("  USDG dust owed to creator ", dustUsdg);
        console2.log("  token dust owed to creator", dustToken);
        if (dustUsdg == 0 && dustToken == 0) {
            console2.log("  (zero dust - the mint consumed both sides exactly; not a failure)");
        } else {
            console2.log("  pull with: manager.pullDust(asset) from the creator address");
        }
    }

    function _assertSellRefused(Ctx memory ctx) internal {
        console2.log("=== post-graduation trading ===");
        // Simulated locally, never broadcast: this is a probe, not a transaction.
        try ctx.curve.sell(1, 0, block.timestamp + 1) returns (uint256) {
            _check(false, "sell() reverts after graduation");
        } catch (bytes memory err) {
            bytes4 sig = err.length >= 4 ? bytes4(err) : bytes4(0);
            // `sell` tests `graduated` before `curveComplete()`, so a graduated
            // curve answers AlreadyGraduated; CurveComplete is what a curve that
            // hit the target but has not migrated yet answers.
            _check(
                sig == BondingCurve.AlreadyGraduated.selector || sig == BondingCurve.CurveComplete.selector,
                "sell() reverts with AlreadyGraduated / CurveComplete"
            );
            console2.log("  sell() revert selector", vm.toString(abi.encodePacked(sig)));
        }
        try ctx.curve.buy(1, 0, block.timestamp + 1) returns (uint256) {
            _check(false, "buy() reverts after graduation");
        } catch (bytes memory err) {
            bytes4 sig = err.length >= 4 ? bytes4(err) : bytes4(0);
            _check(sig == BondingCurve.AlreadyGraduated.selector, "buy() reverts with AlreadyGraduated");
        }
    }

    // ── Output ───────────────────────────────────────────────────────────────

    function _summary(Ctx memory ctx, Result memory r, bool verifyOnly) internal view {
        console2.log("");
        console2.log("==================== SUMMARY ====================");
        console2.log(" token                 ", address(ctx.token));
        console2.log(" curve                 ", address(ctx.curve));
        console2.log(" creator               ", ctx.creator);
        console2.log(" pool                  ", ctx.curve.pool());
        console2.log(" LP tokenId            ", ctx.curve.lpTokenId());
        console2.log(" LP held by            ", address(ctx.locker));
        if (!verifyOnly) {
            console2.log(" USDG spent (raw)      ", r.usdgSpent);
            console2.log(" tokens bought (wei)   ", r.tokensBought);
            console2.log(" buys                  ", r.buys);
        }
        console2.log(" raise into pool (raw) ", ctx.curve.graduationTarget() - ctx.curve.graduationFee());
        console2.log(" fee to creator (raw)  ", ctx.curve.creatorFeesAccrued() - ctx.curve.creatorFeesClaimed());
        console2.log(" fee to vault (raw)    ", ctx.curve.platformFeesAccrued() - ctx.curve.platformFeesClaimed());
        console2.log(" USDG dust owed (raw)  ", ctx.manager.dustOf(address(ctx.usdg), ctx.creator));
        console2.log(" token dust owed (wei) ", ctx.manager.dustOf(address(ctx.token), ctx.creator));
        console2.log("=================================================");
        console2.log("");
        console2.log("What is left to pull, all optional:");
        console2.log("  curve.claimCreatorFees()        creator only, USDG trade fees");
        console2.log("  curve.claimPlatformFees()       anyone, pays the throwaway vault");
        console2.log("  manager.pullDust(asset)         creator only, the mint leftovers");
        console2.log("  locker.collectFees(tokenId)     creator only, pool fees as they accrue");
    }

    function _check(bool ok, string memory what) internal {
        _checks++;
        if (ok) {
            console2.log("  PASS  %s", what);
        } else {
            _failures++;
            console2.log("  FAIL  %s", what);
        }
    }
}
