// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/**
 * AUDIT M1 / H2 / L1 — factory → curve → manager → locker trust boundaries, the
 * sell-before-graduate griefing, and the dev-buy refund path. All of these were
 * proofs of concept; all are regressions now.
 */
contract TrustBoundariesAuditTest is BaseTest {
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

    // ── GraduationManager.migrate only serves the factory's curves ───────────

    /// A stranger with a token they made up gets nothing from the real manager.
    function test_regression_migrate_rejectsAnyCallerWithAnyToken() public {
        MockUSDG fake = new MockUSDG();
        fake.mint(attacker, 1_000 * TOKEN_UNIT);
        usdg.mint(attacker, 10 * USDG_UNIT);

        vm.startPrank(attacker);
        fake.approve(address(manager), type(uint256).max);
        usdg.approve(address(manager), type(uint256).max);
        vm.expectRevert(GraduationManager.NotACurve.selector);
        manager.migrate(address(fake), 1_000 * TOKEN_UNIT, 10 * USDG_UNIT, attacker);
        vm.stopPrank();

        assertEq(locker.lockedCount(), 0);
    }

    /// With the REAL launched token, before the curve graduates: still refused,
    /// so the pool cannot be created and priced through the manager, and the
    /// locker never sees a position for a token that has not graduated.
    function test_regression_migrate_rejectsRealTokenFromANonCurve() public {
        _buy(curve, attacker, 1_000 * USDG_UNIT);
        uint256 have = token.balanceOf(attacker);
        usdg.mint(attacker, 1);

        vm.startPrank(attacker);
        token.approve(address(manager), have);
        usdg.approve(address(manager), 1);
        vm.expectRevert(GraduationManager.NotACurve.selector);
        manager.migrate(address(token), have, 1, attacker);
        vm.stopPrank();

        (address t0, address t1,) = _order(address(token));
        assertEq(uniFactory.getPool(t0, t1, POOL_FEE), address(0), "pool was created");
        assertEq(locker.lockedCount(), 0);
        assertFalse(curve.graduated());
    }

    // ── A curve not deployed by the factory ──────────────────────────────────

    /// Anyone can deploy a BondingCurve directly, pointing at the real vault +
    /// manager. It can trade, but it cannot graduate through the real manager:
    /// its completing buy reverts, so it never emits `Graduated` either.
    function test_regression_rogueCurve_cannotReachRealManager() public {
        MockUSDG fakeToken = new MockUSDG();
        vm.startPrank(attacker);
        BondingCurve rogue = new BondingCurve(
            BondingCurve.CurveConfig({
                usdg: address(usdg),
                token: address(fakeToken),
                creator: attacker,
                feeVault: address(vault),
                graduationManager: address(manager),
                virtualUsdg: 1 * USDG_UNIT,
                virtualTokens: TOKEN_UNIT / 2, // = C * vU / target, as the factory derives it
                curveAllocation: 1 * TOKEN_UNIT,
                lpAllocation: 1 * TOKEN_UNIT,
                graduationTarget: 2 * USDG_UNIT,
                graduationFee: 0,
                tradeFeeBps: 0,
                creatorFeeShareBps: 0,
                snipeBlocks: 0,
                snipeMaxTokens: 0
            })
        );
        vm.stopPrank();
        assertEq(rogue.factory(), attacker);
        fakeToken.mint(address(rogue), 2 * TOKEN_UNIT);
        usdg.mint(attacker, 10 * USDG_UNIT);

        vm.startPrank(attacker);
        usdg.approve(address(rogue), type(uint256).max);
        // Completing buy → _graduate → migrate → NotACurve; the buy reverts whole.
        vm.expectRevert(GraduationManager.NotACurve.selector);
        rogue.buy(5 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();

        assertFalse(rogue.graduated());
        assertEq(factory.curveOf(address(fakeToken)), address(0), "factory does not know it");
        assertEq(locker.lockedCount(), 0);
    }

    // ── Completion is sticky: no sell can reopen a completed curve ───────────

    function test_regression_graduate_notFrontRunnableByTinySell() public {
        _fillAlmost(curve, alice);
        // The completing buy and the graduation are one transaction.
        _complete(curve, alice);
        assertTrue(curve.graduated());

        vm.startPrank(alice);
        token.approve(address(curve), 1 * TOKEN_UNIT);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.sell(1 * TOKEN_UNIT, 0, block.timestamp);
        vm.stopPrank();
    }

    // ── Dev-buy overshoot is refunded, not stranded ──────────────────────────

    /// If the dev-buy quote clamps at the target, `_devBuy` pulls the full
    /// `devBuyUsdg`, the curve takes only what it can, and the factory forwards
    /// the remainder to the creator in the same transaction.
    function test_regression_devBuyRefund_returnedToCreator() public {
        Terms memory t = _defaultTerms();
        t.devBuyMaxBps = 10_000; // the shipped 5% cap can never complete a curve
        t.graduationTarget = 1_000 * USDG_UNIT;
        t.creationFee = 0;
        _deployStack(address(usdg), t);

        uint256 devBuy = 200_000 * USDG_UNIT;
        usdg.mint(creator, devBuy);
        vm.startPrank(creator);
        usdg.approve(address(factory), devBuy);
        (, address c) = factory.launch("Small", "SML", "ipfs://x", devBuy, 0);
        vm.stopPrank();

        BondingCurve small = BondingCurve(c);
        assertTrue(small.curveComplete());
        assertEq(usdg.balanceOf(address(factory)), 0, "refund left in the factory");
        uint256 refunded = usdg.balanceOf(creator);
        emit log_named_uint("usdg refunded to creator", refunded);
        assertGt(refunded, devBuy - 1_100 * USDG_UNIT, "creator was not refunded the overshoot");
        assertEq(usdg.balanceOf(address(small)), devBuy - refunded, "curve balance != what was spent");
    }
}
