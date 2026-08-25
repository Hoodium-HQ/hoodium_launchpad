// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {MockUniswapPool} from "../mocks/MockUniswap.sol";

/*
 * Audit — curve math / rounding / economic attacks lens.
 *
 * F1–F4 were findings that PASSED by demonstrating undesirable behaviour; they
 * are now regressions asserting the behaviour is gone. S1/S2 were sound then
 * and still are.
 */

/// A contract that launches and immediately loops `buy()` inside the deployment
/// transaction. Under the per-call cap each call was fine and the sum was not.
contract LaunchSniper {
    HoodiumFactory immutable factory;
    IERC20 immutable usdg;

    constructor(HoodiumFactory f, IERC20 u) {
        factory = f;
        usdg = u;
    }

    function go(uint256 devBuyUsdg, uint256 perCall, uint256 calls) external returns (address token, address curve) {
        usdg.approve(address(factory), type(uint256).max);
        (token, curve) = factory.launch("Snipe", "SNP", "ipfs://s", devBuyUsdg, 0);
        usdg.approve(curve, type(uint256).max);
        for (uint256 i = 0; i < calls; i++) {
            BondingCurve(curve).buy(perCall, 0, block.timestamp);
        }
    }

    /// Same, but keep going past the first refusal and report how far it got.
    function goUntilBlocked(uint256 devBuyUsdg, uint256 perCall, uint256 calls)
        external
        returns (address token, address curve, uint256 succeeded)
    {
        usdg.approve(address(factory), type(uint256).max);
        (token, curve) = factory.launch("Snipe", "SNP", "ipfs://s", devBuyUsdg, 0);
        usdg.approve(curve, type(uint256).max);
        for (uint256 i = 0; i < calls; i++) {
            try BondingCurve(curve).buy(perCall, 0, block.timestamp) {
                succeeded++;
            } catch {}
        }
    }
}

contract CurveEconomicsAudit is BaseTest {
    HoodiumToken token;
    BondingCurve curve;

    function setUp() public override {
        super.setUp();
        Terms memory t = _defaultTerms();
        t.creationFee = 0;
        _deployStack(address(usdg), t);
        (token, curve) = _launch();
        _skipSnipeWindow();
    }

    // ── F1: a pool pre-initialised at the range boundary is re-priced ────────
    function test_regression_F1_preInitialisedPoolAtBound_isRepricedNotRefunded() public {
        // Creator (or anyone) creates + initialises the pool before graduation at
        // a price at the very edge of the full-range position.
        (,, bool usdgIsToken1) = _order(address(token));
        uint160 edge = usdgIsToken1 ? 4295128739 : 1461446703485210103287273052203988822378723970341;
        address pool = _primePool(creator, address(token), edge);

        _fillAlmost(curve, alice);
        (uint256 usdgForLp,) = _lpAmounts(curve);
        uint160 fair = _fairSqrtP(curve);
        uint256 creatorBefore = usdg.balanceOf(creator);

        _complete(curve, bob);

        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair, "pool left at the edge price");
        assertEq(usdg.balanceOf(creator) - creatorBefore, 0, "creator received USDG");
        assertGt(usdg.balanceOf(pool), usdgForLp * 999 / 1000, "pool got no USDG");
    }

    // ── F2: graduate() was blockable at ~zero cost by a dust sell ─────────────
    function test_regression_F2_dustSellCannotBlockGraduation() public {
        _buy(curve, bob, 100 * USDG_UNIT); // bob holds a few tokens
        _fillAlmost(curve, alice);

        // A sell *before* completion is still an ordinary sell.
        uint256 out = _sell(curve, token, bob, 1 * TOKEN_UNIT);
        assertGt(out, 0);

        // The completing buy graduates in the same transaction: there is no
        // state in which the curve is complete and a sell can reopen it.
        _complete(curve, alice);
        assertTrue(curve.graduated());
        vm.startPrank(bob);
        token.approve(address(curve), 1 * TOKEN_UNIT);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.sell(1 * TOKEN_UNIT, 0, block.timestamp);
        vm.stopPrank();
    }

    /// The one path to "complete but not graduated" — a dev buy — refuses sells.
    function test_regression_F2_completedCurveRefusesSells() public {
        Terms memory t = _defaultTerms();
        t.devBuyMaxBps = 10_000;
        t.graduationTarget = 500 * USDG_UNIT;
        t.creationFee = 0;
        _deployStack(address(usdg), t);
        (HoodiumToken tk, BondingCurve c) = _launchWithDevBuy(1_000 * USDG_UNIT);
        assertTrue(c.curveComplete());
        assertFalse(c.graduated());

        vm.startPrank(creator);
        tk.approve(address(c), 1 * TOKEN_UNIT);
        vm.expectRevert(BondingCurve.CurveComplete.selector);
        c.sell(1 * TOKEN_UNIT, 0, block.timestamp);
        vm.stopPrank();

        vm.prank(bob);
        c.graduate();
        assertTrue(c.graduated());
    }

    // ── F3: caps were per-call; a contract loop captured 47% in the deploy tx ─
    function test_regression_F3_contractLoopIsCappedPerAddressInTheWindow() public {
        LaunchSniper sniper = new LaunchSniper(factory, IERC20(address(usdg)));
        usdg.mint(address(sniper), 100_000 * USDG_UNIT);

        // With a dev buy above the 1% window cap, the very first loop buy is
        // refused: the dev buy consumed the creator's allowance.
        vm.expectPartialRevert(BondingCurve.AntiSnipeCapExceeded.selector);
        sniper.go(650 * USDG_UNIT, 100 * USDG_UNIT, 120);
    }

    function test_regression_F3_loopWithoutDevBuy_stopsAtOnePercent() public {
        LaunchSniper sniper = new LaunchSniper(factory, IERC20(address(usdg)));
        usdg.mint(address(sniper), 100_000 * USDG_UNIT);
        uint256 snipeCap = TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000;

        (address t,, uint256 succeeded) = sniper.goUntilBlocked(0, 50 * USDG_UNIT, 120);
        uint256 held = HoodiumToken(t).balanceOf(address(sniper));
        console2.log("loop buys that succeeded :", succeeded);
        console2.log("sniper holds (tokens)    :", held);
        console2.log("snipe cap (tokens)       :", snipeCap);

        assertLt(succeeded, 120, "no buy was refused");
        assertGt(succeeded, 1, "fixture: cap should take more than one call to reach");
        assertLe(held, snipeCap, "sniper exceeded the window cap");
    }

    // ── F4: the pool used to open ~41% below the curve's closing price ────────
    function test_regression_F4_poolOpensAtCurveClosingPrice() public {
        _fillAlmost(curve, alice, 1000);

        // Marginal curve price at the end, from the sell side: sell 1000 tokens.
        (,, uint256 grossOut) = curve.quoteSell(1000 * TOKEN_UNIT);
        uint256 curvePriceE18 = grossOut * TOKEN_UNIT / (1000 * TOKEN_UNIT);

        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        uint256 poolPriceE18 = usdgForLp * TOKEN_UNIT / tokensForLp;

        console2.log("curve closing price (USDG units per token, x1e18):", curvePriceE18);
        console2.log("pool opening price  (USDG units per token, x1e18):", poolPriceE18);
        console2.log("pool/curve price ratio (bps):", poolPriceE18 * 10_000 / curvePriceE18);
        uint256 ratioBps = poolPriceE18 * 10_000 / curvePriceE18;
        assertGe(ratioBps, 9_900, "pool opens >1% below the curve's last price");
        assertLe(ratioBps, 10_100, "pool opens >1% above the curve's last price");
    }

    // ── S1 (sound): dust buys near the opening price cannot drift the reserve ─
    function test_audit_S1_dustBuySellNearOpening_noDrift() public {
        uint256 kBefore = curve.currentK();
        uint256 balBefore = usdg.balanceOf(address(curve));
        for (uint256 i = 0; i < 200; i++) {
            uint256 amount = 2 + (i % 5);
            uint256 out = _buy(curve, alice, amount);
            if (out > 0) _sell(curve, token, alice, out);
        }
        uint256 owed = curve.creatorFeesAccrued() + curve.platformFeesAccrued();
        assertGe(curve.currentK(), kBefore);
        assertEq(usdg.balanceOf(address(curve)), curve.reserveUsdg() + owed);
        assertGe(usdg.balanceOf(address(curve)), balBefore);
    }

    // ── S2 (sound): tokensSold never exceeds curveAllocation, reserve never
    // exceeds target, even through many sell/buy cycles ──────────────────────
    function testFuzz_audit_S2_boundsHold(uint96[10] memory amts, bool[10] memory sells) public {
        for (uint256 i = 0; i < 10; i++) {
            if (curve.graduated()) break;
            if (sells[i]) {
                uint256 held = token.balanceOf(alice);
                if (held == 0) continue;
                _sell(curve, token, alice, bound(amts[i], 1, held));
            } else {
                _buy(curve, alice, bound(amts[i], 2, 80_000 * USDG_UNIT));
            }
            assertLe(curve.tokensSold(), CURVE_ALLOCATION);
            assertLe(curve.reserveUsdg(), GRADUATION_TARGET);
            if (!curve.graduated()) assertGe(curve.currentK(), curve.initialK());
        }
    }
}
