// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationHelper} from "../src/GraduationHelper.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";
import {MockUniswapPool} from "./mocks/MockUniswap.sol";

/**
 * GraduationHelper against the price-aware mocks: the AUDIT "Medium (liveness)"
 * residual — a dust full-range position at a hostile price bricks every plain
 * completing buy — and the atomic fix-then-buy that closes it.
 */
contract GraduationHelperTest is BaseTest {
    GraduationHelper helper;

    function setUp() public override {
        super.setUp();
        helper = new GraduationHelper();
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    /// Launch until the token lands on the requested side of USDG, then leave
    /// the anti-snipe window.
    function _launchOrdered(bool tokenIsToken0) internal returns (HoodiumToken token, BondingCurve curve) {
        for (uint256 i = 0; i < 32; i++) {
            (token, curve) = _launch();
            if ((address(token) < address(usdg)) == tokenIsToken0) {
                _skipSnipeWindow();
                return (token, curve);
            }
        }
        revert("fixture: ordering");
    }

    /// The attacker's griefing position: a dollar of tokens and 1000 wei of
    /// USDG, full range, at whatever price the pool was primed at.
    function _dustPosition(HoodiumToken token, address pool, uint256 tokenAmt, uint256 usdgAmt) internal {
        (address t0, address t1, bool usdgIsToken1) = _order(address(token));
        _fund(attacker, usdgAmt);
        vm.startPrank(attacker);
        usdg.approve(address(pm), type(uint256).max);
        token.approve(address(pm), type(uint256).max);
        pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: usdgIsToken1 ? tokenAmt : usdgAmt,
                amount1Desired: usdgIsToken1 ? usdgAmt : tokenAmt,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(MockUniswapPool(pool).liquidity(), 0, "fixture: position has no liquidity");
    }

    /// Prime + dust-mint so the token is `cheap` (or expensive) by 100x on the
    /// square root, i.e. 10,000x on the price. Returns the pool.
    function _grief(HoodiumToken token, BondingCurve curve, bool cheap) internal returns (address pool, uint160 fair) {
        uint256 attackerTokens = _buy(curve, attacker, 1 * USDG_UNIT);
        _fillAlmost(curve, alice);
        fair = _fairSqrtP(curve);
        bool tokenIsToken0 = address(token) < address(usdg);
        // sqrtPrice = sqrt(token1 / token0): a low number means token0 is cheap.
        uint160 hostile = (cheap == tokenIsToken0) ? fair / 100 : fair * 100;
        pool = _primePool(attacker, address(token), hostile);
        _dustPosition(token, pool, attackerTokens, 1_000);
    }

    function _expectPlainBuyReverts(BondingCurve curve, bytes4 selector) internal {
        _fund(alice, 500 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 500 * USDG_UNIT);
        vm.expectPartialRevert(selector);
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());
    }

    function _fixAndBuy(BondingCurve curve, address who, uint256 usdgIn, uint256 maxFix, uint256 minOut)
        internal
        returns (uint256 out)
    {
        _fund(who, usdgIn + maxFix);
        vm.startPrank(who);
        usdg.approve(address(helper), usdgIn + maxFix);
        out = helper.fixAndBuy(address(curve), usdgIn, minOut, block.timestamp, maxFix);
        vm.stopPrank();
    }

    function _assertHelperEmpty(HoodiumToken token) internal view {
        assertEq(usdg.balanceOf(address(helper)), 0, "helper holds USDG");
        assertEq(token.balanceOf(address(helper)), 0, "helper holds tokens");
    }

    // ── the residual, both directions ────────────────────────────────────────

    function test_dustPosition_tokenCheap_plainBuyBricked_fixAndBuyGraduates() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        (address pool, uint160 fair) = _grief(token, curve, true);
        _expectPlainBuyReverts(curve, GraduationManager.PoolPriceManipulated.selector);

        (,, uint160 target, bool needed) = helper.status(address(curve));
        assertEq(target, fair);
        assertTrue(needed);

        _assertCheapDirectionFixAndBuy(token, curve, pool);
    }

    function _assertCheapDirectionFixAndBuy(HoodiumToken token, BondingCurve curve, address pool) internal {
        uint256 usdgIn = 500 * USDG_UNIT;
        uint256 maxFix = usdgIn / 100;
        (uint256 quoted,, uint256 refund,) = curve.quoteBuy(usdgIn);
        uint256 usdgBefore = usdg.balanceOf(alice);
        uint256 tokensBefore = token.balanceOf(alice);

        uint256 out = _fixAndBuy(curve, alice, usdgIn, maxFix, quoted);

        assertTrue(curve.graduated(), "fix+buy graduates");
        assertEq(curve.pool(), pool);
        assertEq(out, quoted, "the buy itself is the quoted buy");
        // The fix bought cheap tokens out of the attacker's position: the caller
        // receives those on top of the buy, and keeps whatever USDG it did not need.
        assertGt(token.balanceOf(alice) - tokensBefore, quoted, "arbitrage tokens go to the caller");
        uint256 spent = usdgBefore + usdgIn + maxFix - usdg.balanceOf(alice);
        assertLe(spent, usdgIn + maxFix, "never more than usdgIn + maxFixUsdg");
        // The buy overshoots the target, so it takes usdgIn - refund; the rest is the fix.
        uint256 fixCost = spent - (usdgIn - refund);
        assertLt(fixCost, maxFix, "a dust position costs less than the budget to fix");
        assertGt(fixCost, 0, "the fix did buy something out of the attacker's position");
        _assertHelperEmpty(token);
        assertEq(pm.ownerOf(curve.lpTokenId()), address(locker));
    }

    function test_dustPosition_tokenExpensive_fixSellsCurveTokensIntoThePool() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        (address pool,) = _grief(token, curve, false);
        _expectPlainBuyReverts(curve, GraduationManager.PoolPriceManipulated.selector);

        uint256 usdgIn = 500 * USDG_UNIT;
        uint256 maxFix = usdgIn / 100;
        uint256 usdgBefore = usdg.balanceOf(alice);
        uint256 attackerUsdgInPool = usdg.balanceOf(pool);
        (uint256 quoted,, uint256 refund,) = curve.quoteBuy(usdgIn);

        uint256 out = _fixAndBuy(curve, alice, usdgIn, maxFix, 0);

        assertTrue(curve.graduated(), "fix+buy graduates");
        assertEq(curve.pool(), pool);
        // The fix bought tokens from the curve at the fair price, inside the
        // pool's callback, and sold them into the over-priced pool: the
        // attacker's USDG comes out and lands with the caller.
        int256 spent = int256(usdgBefore + usdgIn + maxFix) - int256(usdg.balanceOf(alice));
        assertLe(spent, int256(usdgIn + maxFix), "never more than usdgIn + maxFixUsdg");
        // Tokens bought at the fair price and sold 10,000x above it: the fix
        // pays for itself out of the attacker's USDG.
        int256 fixCost = spent - int256(usdgIn - refund);
        assertLt(fixCost, 0, "the arbitrage more than covers the fix");
        assertGe(fixCost, -int256(attackerUsdgInPool), "proceeds are bounded by what the attacker put in");
        // The completing buy sells what is left on the curve: the fix's own
        // purchase came out of the same allocation, so `out` is below the quote.
        assertLt(out, quoted, "the fix's curve buy came off the same allocation");
        assertGt(token.balanceOf(alice), 0);
        _assertHelperEmpty(token);
    }

    /// The other token ordering, both directions: the direction logic must not
    /// depend on USDG being token1.
    function test_dustPosition_usdgIsToken0_bothDirections() public {
        for (uint256 i = 0; i < 2; i++) {
            (HoodiumToken token, BondingCurve curve) = _launchOrdered(false);
            _grief(token, curve, i == 0);
            _expectPlainBuyReverts(curve, GraduationManager.PoolPriceManipulated.selector);
            _fixAndBuy(curve, alice, 500 * USDG_UNIT, 5 * USDG_UNIT, 0);
            assertTrue(curve.graduated());
            _assertHelperEmpty(token);
        }
    }

    // ── budget ───────────────────────────────────────────────────────────────

    function test_maxFixUsdg_isRespected_wholeCallReverts() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        // Real liquidity this time: 200 USDG worth at a 2x-on-sqrt hostile price.
        _buy(curve, attacker, 500 * USDG_UNIT);
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        address pool = _primePool(attacker, address(token), fair / 2);
        _dustPosition(token, pool, token.balanceOf(attacker), 200 * USDG_UNIT);
        _expectPlainBuyReverts(curve, GraduationManager.PoolPriceManipulated.selector);

        uint256 usdgIn = 500 * USDG_UNIT;
        _fund(alice, usdgIn + 1 * USDG_UNIT);
        uint256 before = usdg.balanceOf(alice);
        vm.startPrank(alice);
        usdg.approve(address(helper), usdgIn + 1 * USDG_UNIT);
        // 1 USDG is consumed whole and the price stops short of the band.
        vm.expectPartialRevert(GraduationHelper.FixBudgetInsufficient.selector);
        helper.fixAndBuy(address(curve), usdgIn, 0, block.timestamp, 1 * USDG_UNIT);
        // No budget at all: the pool asks for its first wei and is refused.
        vm.expectPartialRevert(GraduationHelper.FixBudgetExhausted.selector);
        helper.fixAndBuy(address(curve), usdgIn, 0, block.timestamp, 0);
        vm.stopPrank();
        assertFalse(curve.graduated());
        assertEq(usdg.balanceOf(alice), before, "nothing spent on a failed fix");

        // A budget that does reach the target works, and the arbitrage pays.
        before = usdg.balanceOf(alice) + 1_000 * USDG_UNIT;
        _fund(alice, 1_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(helper), usdgIn + 1_000 * USDG_UNIT);
        helper.fixAndBuy(address(curve), usdgIn, 0, block.timestamp, 1_000 * USDG_UNIT);
        vm.stopPrank();
        assertTrue(curve.graduated());
        assertGt(token.balanceOf(alice), 0);
        assertLe(before - usdg.balanceOf(alice), usdgIn + 1_000 * USDG_UNIT);
        _assertHelperEmpty(token);
    }

    // ── nothing to fix ───────────────────────────────────────────────────────

    function test_fix_revertsOnFreshPool_andOnUncreatedPool() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _fillAlmost(curve, alice);
        (address pool,,, bool needed) = helper.status(address(curve));
        assertEq(pool, address(0));
        assertFalse(needed);
        vm.expectRevert(GraduationHelper.NothingToFix.selector);
        helper.fix(address(curve), 1 * USDG_UNIT);

        // Created but not initialised: nothing to move yet.
        (address t0, address t1,) = _order(address(token));
        uniFactory.createPool(t0, t1, POOL_FEE);
        vm.expectRevert(GraduationHelper.NothingToFix.selector);
        helper.fix(address(curve), 1 * USDG_UNIT);

        // fixAndBuy still works as a plain buy when there is nothing to fix,
        // and never draws the fix budget.
        uint256 usdgIn = 500 * USDG_UNIT;
        (,, uint256 refund,) = curve.quoteBuy(usdgIn);
        uint256 before = usdg.balanceOf(alice) + usdgIn + 5 * USDG_UNIT;
        _fixAndBuy(curve, alice, usdgIn, 5 * USDG_UNIT, 0);
        assertTrue(curve.graduated());
        assertEq(usdg.balanceOf(alice), before - usdgIn + refund, "only usdgIn drawn; the overshoot comes back");
        _assertHelperEmpty(token);
    }

    function test_fix_revertsWhenThePoolIsFine() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _buy(curve, attacker, 500 * USDG_UNIT);
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        address pool = _primePool(attacker, address(token), fair);
        _dustPosition(token, pool, token.balanceOf(attacker), 200 * USDG_UNIT);

        (,,, bool needed) = helper.status(address(curve));
        assertFalse(needed, "liquid pool at the fair price needs nothing");
        vm.expectRevert(GraduationHelper.NothingToFix.selector);
        helper.fix(address(curve), 1 * USDG_UNIT);

        _fixAndBuy(curve, alice, 500 * USDG_UNIT, 5 * USDG_UNIT, 0);
        assertTrue(curve.graduated());
        _assertHelperEmpty(token);
    }

    /// An initialised, empty pool off the target: the manager would walk it
    /// for free, and so does the helper — no budget is spent.
    function test_fix_emptyPoolOffTarget_isWalkedForFree() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        address pool = _primePool(attacker, address(token), fair * 50);
        (,,, bool needed) = helper.status(address(curve));
        assertTrue(needed);

        _fund(bob, 1 * USDG_UNIT);
        vm.startPrank(bob);
        usdg.approve(address(helper), 1 * USDG_UNIT);
        helper.fix(address(curve), 1 * USDG_UNIT);
        vm.stopPrank();
        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair);
        assertEq(usdg.balanceOf(bob), 1 * USDG_UNIT, "free walk spends nothing");
        assertEq(token.balanceOf(bob), 0);
        _assertHelperEmpty(token);

        (,,, needed) = helper.status(address(curve));
        assertFalse(needed);
    }

    // ── keeper path pays the keeper ──────────────────────────────────────────

    function test_fix_alone_repricesAndPaysTheKeeper_thenPlainBuyWorks() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        (address pool, uint160 fair) = _grief(token, curve, true);

        _fund(bob, 5 * USDG_UNIT);
        vm.startPrank(bob);
        usdg.approve(address(helper), 5 * USDG_UNIT);
        helper.fix(address(curve), 5 * USDG_UNIT);
        vm.stopPrank();

        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair, "lands exactly on the target");
        assertGt(token.balanceOf(bob), 0, "keeper keeps the arbitrage tokens");
        assertLt(5 * USDG_UNIT - usdg.balanceOf(bob), 1 * USDG_UNIT, "dust costs wei to fix");
        _assertHelperEmpty(token);

        _complete(curve, alice);
    }

    // ── guards ───────────────────────────────────────────────────────────────

    function test_fixAndBuy_refusesInsideTheSnipeWindow() public {
        (, BondingCurve curve) = _launch();
        _fund(alice, 10 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(helper), 10 * USDG_UNIT);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationHelper.SnipeWindowOpen.selector, curve.deployBlock() + curve.snipeBlocks())
        );
        helper.fixAndBuy(address(curve), 10 * USDG_UNIT, 0, block.timestamp, 0);
        vm.stopPrank();
    }

    function test_fixAndBuy_zeroUsdgIn_reverts() public {
        (, BondingCurve curve) = _launchOrdered(true);
        vm.expectRevert(GraduationHelper.ZeroAmount.selector);
        helper.fixAndBuy(address(curve), 0, 0, block.timestamp, 0);
    }

    function test_callback_rejectsStrangersAtRest() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        (address pool,) = _grief(token, curve, true);
        bytes memory data = abi.encode(pool, false, address(curve), block.timestamp);
        // Even the real pool is refused outside a fix: the guard is the "in progress" bit.
        vm.prank(pool);
        vm.expectRevert(GraduationHelper.UnexpectedSwapCallback.selector);
        helper.uniswapV3SwapCallback(1, 0, data);
        vm.prank(attacker);
        vm.expectRevert(GraduationHelper.UnexpectedSwapCallback.selector);
        helper.uniswapV3SwapCallback(1, 0, abi.encode(attacker, false, address(curve), block.timestamp));
    }

    /// The buy's own floor is still enforced end to end.
    function test_fixAndBuy_honoursMinTokensOut() public {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _grief(token, curve, true);
        uint256 usdgIn = 500 * USDG_UNIT;
        (uint256 quoted,,,) = curve.quoteBuy(usdgIn);
        _fund(alice, usdgIn + 5 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(helper), usdgIn + 5 * USDG_UNIT);
        vm.expectPartialRevert(BondingCurve.SlippageExceeded.selector);
        helper.fixAndBuy(address(curve), usdgIn, quoted + 1, block.timestamp, 5 * USDG_UNIT);
        vm.stopPrank();
    }
}
