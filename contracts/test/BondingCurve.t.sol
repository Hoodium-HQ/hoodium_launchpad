// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";

/**
 * T2.1, T2.2, T2.3, T2.8, T2.9.
 *
 * design.md section 7: "Fuzz testing the curve is the single highest-value test
 * in this spec. Every historically drained bonding curve was drained through
 * rounding, not through a dramatic exploit."
 */
contract BondingCurveTest is BaseTest {
    HoodiumToken internal token;
    BondingCurve internal curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _launch();
        _skipSnipeWindow();
    }

    // ── T2.1 — k never decreases (LP-N4) ─────────────────────────────────────

    function test_initialK_matchesReserves() public view {
        assertEq(curve.currentK(), curve.initialK(), "k at deployment");
        assertEq(curve.reserveX(), VIRTUAL_USDG);
        assertEq(curve.reserveY(), VIRTUAL_USDG * CURVE_ALLOCATION / GRADUATION_TARGET + CURVE_ALLOCATION);
    }

    function testFuzz_k_neverDecreasesOnBuy(uint96 usdgIn) public {
        usdgIn = uint96(bound(usdgIn, 1, 200_000 * USDG_UNIT));
        uint256 kBefore = curve.currentK();

        _fund(alice, usdgIn);
        vm.startPrank(alice);
        usdg.approve(address(curve), usdgIn);
        try curve.buy(usdgIn, 0, block.timestamp) {
            // A completing buy graduates and zeroes the reserve; k is then
            // meaningless, and the curve refuses every further trade.
            if (!curve.graduated()) assertGe(curve.currentK(), kBefore, "k decreased on buy");
        } catch {
            assertEq(curve.currentK(), kBefore, "k moved on a reverted buy");
        }
        vm.stopPrank();
    }

    function testFuzz_k_neverDecreasesAcrossTradeSequence(uint96[8] memory amounts, bool[8] memory isBuy) public {
        uint256 kBefore = curve.currentK();

        for (uint256 i = 0; i < amounts.length; i++) {
            if (isBuy[i]) {
                uint256 amount = bound(amounts[i], 1, 20_000 * USDG_UNIT);
                _fund(alice, amount);
                vm.startPrank(alice);
                usdg.approve(address(curve), amount);
                try curve.buy(amount, 0, block.timestamp) {} catch {}
                vm.stopPrank();
            } else {
                uint256 held = token.balanceOf(alice);
                if (held == 0) continue;
                uint256 amount = bound(amounts[i], 1, held);
                vm.startPrank(alice);
                token.approve(address(curve), amount);
                try curve.sell(amount, 0, block.timestamp) {} catch {}
                vm.stopPrank();
            }

            if (curve.graduated()) break;
            uint256 kNow = curve.currentK();
            assertGe(kNow, kBefore, "k decreased across the sequence");
            kBefore = kNow;
        }
    }

    // ── T2.2 — a round trip never profits the caller (LP-N4, LP-N8) ──────────

    function testFuzz_roundTrip_neverProfits(uint96 usdgIn) public {
        usdgIn = uint96(bound(usdgIn, 1 * USDG_UNIT, 50_000 * USDG_UNIT));

        _fund(alice, usdgIn);
        vm.startPrank(alice);
        usdg.approve(address(curve), usdgIn);
        uint256 spent = usdg.balanceOf(alice);
        uint256 tokensOut = curve.buy(usdgIn, 0, block.timestamp);
        spent -= usdg.balanceOf(alice);

        vm.assume(tokensOut > 0);

        token.approve(address(curve), tokensOut);
        uint256 received = curve.sell(tokensOut, 0, block.timestamp);
        vm.stopPrank();

        assertLe(received, spent, "round trip returned more than it cost");
    }

    function testFuzz_roundTrip_afterOtherTrades_neverProfits(uint96 seed, uint96 usdgIn) public {
        // Someone else moves the price first, so the round trip is not against a
        // pristine curve.
        _buy(curve, bob, bound(seed, 1 * USDG_UNIT, 30_000 * USDG_UNIT));

        usdgIn = uint96(bound(usdgIn, 1 * USDG_UNIT, 20_000 * USDG_UNIT));
        _fund(alice, usdgIn);
        vm.startPrank(alice);
        usdg.approve(address(curve), usdgIn);
        uint256 before = usdg.balanceOf(alice);
        uint256 tokensOut = curve.buy(usdgIn, 0, block.timestamp);
        uint256 spent = before - usdg.balanceOf(alice);
        vm.assume(tokensOut > 0);

        token.approve(address(curve), tokensOut);
        uint256 received = curve.sell(tokensOut, 0, block.timestamp);
        vm.stopPrank();

        assertLe(received, spent, "round trip profited after other trades");
    }

    /// The dust attack: many tiny round trips must not extract value either.
    function test_dustRoundTrips_neverDrain() public {
        _buy(curve, bob, 5_000 * USDG_UNIT); // give the curve a real reserve

        uint256 reserveBefore = curve.reserveUsdg();

        for (uint256 i = 0; i < 100; i++) {
            _fund(alice, 1);
            vm.startPrank(alice);
            usdg.approve(address(curve), 1);
            try curve.buy(1, 0, block.timestamp) returns (uint256 out) {
                if (out > 0) {
                    token.approve(address(curve), out);
                    try curve.sell(out, 0, block.timestamp) {} catch {}
                }
            } catch {}
            vm.stopPrank();
        }

        assertGe(curve.reserveUsdg(), reserveBefore, "dust trades drained the reserve");
        assertGe(curve.currentK(), curve.initialK(), "dust trades broke the invariant");
    }

    // ── T2.3 — edge cases ────────────────────────────────────────────────────

    function test_buy_oneWei_revertsRatherThanMintingNothing() public {
        _fund(alice, 1);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1);
        // A 1-unit buy is entirely consumed by the ceil-rounded fee, so there is
        // no net input and nothing to mint. Reverting is correct — the
        // alternative is taking the wei and giving back zero tokens.
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buy(1, 0, block.timestamp);
        vm.stopPrank();
    }

    function test_buy_zero_reverts() public {
        vm.prank(alice);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buy(0, 0, block.timestamp);
    }

    function test_sell_moreThanSold_reverts() public {
        _buy(curve, alice, 1_000 * USDG_UNIT);
        uint256 held = token.balanceOf(alice);

        vm.startPrank(alice);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.ExceedsSold.selector);
        curve.sell(held + CURVE_ALLOCATION, 0, block.timestamp);
        vm.stopPrank();
    }

    /// LP-2.6 — a buy that overshoots is clamped and the excess is left behind.
    function test_overshoot_clampsAtTargetAndRefunds() public {
        uint256 huge = 500_000 * USDG_UNIT;
        _fund(alice, huge);

        vm.startPrank(alice);
        usdg.approve(address(curve), huge);
        uint256 before = usdg.balanceOf(alice);
        curve.buy(huge, 0, block.timestamp);
        uint256 spent = before - usdg.balanceOf(alice);
        vm.stopPrank();

        // The completing buy graduates in the same call (AUDIT H2), so the
        // reserve has already moved to the pool; what was taken is what the
        // curve could absorb plus the fee on it, and not a unit more.
        uint256 expectedFee = (GRADUATION_TARGET * TRADE_FEE_BPS + (10_000 - TRADE_FEE_BPS) - 1) / (10_000 - TRADE_FEE_BPS);
        assertEq(spent, GRADUATION_TARGET + expectedFee, "took more than target + fee");
        assertLt(spent, huge, "excess should not have been taken");
        assertTrue(curve.graduated(), "completing buy should graduate");
        assertEq(curve.reserveUsdg(), 0, "reserve migrated");
    }

    function test_exactTargetBuy_completesWithoutRefund() public {
        // Gross input whose net lands exactly on the target.
        uint256 net = GRADUATION_TARGET;
        uint256 gross = (net * 10_000) / (10_000 - TRADE_FEE_BPS) + 1;

        _fund(alice, gross);
        vm.startPrank(alice);
        usdg.approve(address(curve), gross);
        uint256 before = usdg.balanceOf(alice);
        curve.buy(gross, 0, block.timestamp);
        vm.stopPrank();

        assertTrue(curve.graduated());
        assertLe(before - usdg.balanceOf(alice), gross);
    }

    function test_buysAfterCompletion_revert() public {
        _buy(curve, alice, 200_000 * USDG_UNIT);
        assertTrue(curve.graduated());

        _fund(bob, 1_000 * USDG_UNIT);
        vm.startPrank(bob);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.buy(1_000 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
    }

    // ── Deadlines (AUDIT L5) ─────────────────────────────────────────────────

    function test_buy_pastDeadline_reverts() public {
        _fund(alice, 1_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.Expired.selector, block.timestamp - 1));
        curve.buy(1_000 * USDG_UNIT, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_sell_pastDeadline_reverts() public {
        _buy(curve, alice, 1_000 * USDG_UNIT);
        uint256 held = token.balanceOf(alice);
        vm.startPrank(alice);
        token.approve(address(curve), held);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.Expired.selector, block.timestamp - 1));
        curve.sell(held, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_deadlineAtCurrentTimestamp_isAccepted() public {
        _fund(alice, 1_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        assertGt(curve.buy(1_000 * USDG_UNIT, 0, block.timestamp), 0);
        vm.stopPrank();
    }

    // ── Slippage (LP-2.4, T1.3) ──────────────────────────────────────────────

    function test_buy_respectsMinimumOut() public {
        _fund(alice, 1_000 * USDG_UNIT);
        (uint256 quoted,,,) = curve.quoteBuy(1_000 * USDG_UNIT);

        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.SlippageExceeded.selector, quoted, quoted + 1));
        curve.buy(1_000 * USDG_UNIT, quoted + 1, block.timestamp);
        vm.stopPrank();
    }

    function test_sell_respectsMinimumOut() public {
        _buy(curve, alice, 1_000 * USDG_UNIT);
        uint256 held = token.balanceOf(alice);
        (uint256 quoted,,) = curve.quoteSell(held);

        vm.startPrank(alice);
        token.approve(address(curve), held);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.SlippageExceeded.selector, quoted, quoted + 1));
        curve.sell(held, quoted + 1, block.timestamp);
        vm.stopPrank();
    }

    function testFuzz_quoteMatchesExecution(uint96 usdgIn) public {
        usdgIn = uint96(bound(usdgIn, 1_000, 40_000 * USDG_UNIT));
        (uint256 quoted,,,) = curve.quoteBuy(usdgIn);
        vm.assume(quoted > 0);

        uint256 actual = _buy(curve, alice, usdgIn);
        assertEq(actual, quoted, "quote diverged from execution");
    }

    // ── T2.8 — anti-snipe (LP-2.5) ───────────────────────────────────────────

    function test_antiSnipe_oversizedFirstBlockBuyReverts() public {
        (, BondingCurve fresh) = _launch(); // deployed at the current block

        uint256 cap = TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000;
        uint256 big = 40_000 * USDG_UNIT;
        (uint256 quoted,,,) = fresh.quoteBuy(big);
        assertGt(quoted, cap, "fixture should exceed the cap");

        _fund(alice, big);
        vm.startPrank(alice);
        usdg.approve(address(fresh), big);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.AntiSnipeCapExceeded.selector, quoted, cap));
        fresh.buy(big, 0, block.timestamp);
        vm.stopPrank();
    }

    /// AUDIT H1 — the cap is cumulative per address, not per call.
    function test_antiSnipe_cumulativeBuysPerAddressAreCapped() public {
        (, BondingCurve fresh) = _launch();
        uint256 cap = TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000;

        // Each call alone is well under the cap; together they exceed it.
        uint256 perCall = 100 * USDG_UNIT;
        uint256 total;
        uint256 calls;
        while (true) {
            (uint256 quoted,,,) = fresh.quoteBuy(perCall);
            if (total + quoted > cap) break;
            total += _buy(fresh, alice, perCall);
            calls++;
        }
        assertGt(calls, 1, "fixture: cap should take several calls to reach");
        assertEq(fresh.boughtInWindow(alice), total);

        (uint256 next,,,) = fresh.quoteBuy(perCall);
        _fund(alice, perCall);
        vm.startPrank(alice);
        usdg.approve(address(fresh), perCall);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.AntiSnipeCapExceeded.selector, total + next, cap));
        fresh.buy(perCall, 0, block.timestamp);
        vm.stopPrank();

        // Another address has its own allowance.
        assertGt(_buy(fresh, bob, perCall), 0);
    }

    function test_antiSnipe_windowCounterIsNotConsultedAfterTheWindow() public {
        (, BondingCurve fresh) = _launch();
        uint256 cap = TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000;
        _buy(fresh, alice, 100 * USDG_UNIT);
        uint256 inWindow = fresh.boughtInWindow(alice);
        assertGt(inWindow, 0);

        vm.roll(block.number + SNIPE_BLOCKS);
        uint256 out = _buy(fresh, alice, 40_000 * USDG_UNIT);
        assertGt(out, cap, "cap should no longer apply");
        assertEq(fresh.boughtInWindow(alice), inWindow, "counter should not move outside the window");
    }

    function test_antiSnipe_smallBuyInFirstBlockSucceeds() public {
        (, BondingCurve fresh) = _launch();
        uint256 tokensOut = _buy(fresh, alice, 100 * USDG_UNIT);
        assertGt(tokensOut, 0);
    }

    function test_antiSnipe_liftsAfterWindow() public {
        (, BondingCurve fresh) = _launch();
        vm.roll(block.number + SNIPE_BLOCKS);

        uint256 tokensOut = _buy(fresh, alice, 40_000 * USDG_UNIT);
        assertGt(tokensOut, TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000, "cap should no longer apply");
    }

    // ── T2.9 — fee accounting creates and destroys nothing (LP-3.4) ──────────

    function test_feeAccounting_balancesExactlyAcrossManyTrades() public {
        uint256 trades = 60;

        for (uint256 i = 0; i < trades; i++) {
            uint256 amount = ((i * 7919) % 500 + 1) * USDG_UNIT;
            _buy(curve, alice, amount);

            if (i % 3 == 0) {
                uint256 held = token.balanceOf(alice);
                if (held > 0) _sell(curve, token, alice, held / 2);
            }
        }

        uint256 accrued = curve.creatorFeesAccrued() + curve.platformFeesAccrued();
        uint256 claimed = curve.creatorFeesClaimed() + curve.platformFeesClaimed();
        uint256 owed = accrued - claimed;

        // Everything the curve holds is either reserve or unclaimed fees. Not one
        // wei more, not one wei less.
        assertEq(usdg.balanceOf(address(curve)), curve.reserveUsdg() + owed, "curve balance != reserve + fees owed");
    }

    function testFuzz_feeSplit_neverCreatesOrDestroysValue(uint96 usdgIn) public {
        usdgIn = uint96(bound(usdgIn, 1_000, 40_000 * USDG_UNIT));

        uint256 creatorBefore = curve.creatorFeesAccrued();
        uint256 platformBefore = curve.platformFeesAccrued();

        (, uint256 expectedFee,,) = curve.quoteBuy(usdgIn);
        vm.assume(expectedFee > 0);

        _buy(curve, alice, usdgIn);

        uint256 creatorDelta = curve.creatorFeesAccrued() - creatorBefore;
        uint256 platformDelta = curve.platformFeesAccrued() - platformBefore;

        assertEq(creatorDelta + platformDelta, expectedFee, "split lost or invented value");
    }

    function test_creatorFees_claimableOnlyByCreator() public {
        _buy(curve, alice, 5_000 * USDG_UNIT);
        assertGt(curve.creatorFeesAccrued(), 0);

        vm.prank(alice);
        vm.expectRevert(BondingCurve.NotCreator.selector);
        curve.claimCreatorFees();

        uint256 before = usdg.balanceOf(creator);
        vm.prank(creator);
        uint256 claimed = curve.claimCreatorFees();
        assertEq(usdg.balanceOf(creator) - before, claimed);
        assertGt(claimed, 0);
    }

    /// LP-3.2 — the platform cannot withdraw the creator's share.
    function test_platformSweep_cannotTakeCreatorShare() public {
        _buy(curve, alice, 5_000 * USDG_UNIT);

        uint256 creatorOwed = curve.creatorFeesAccrued();
        vm.prank(bob); // permissionless, but it can only pay the vault
        curve.claimPlatformFees();

        // The vault also holds the creation fee this launch paid it (LP-1.5).
        assertEq(usdg.balanceOf(address(vault)), CREATION_FEE + curve.platformFeesAccrued());
        // The creator's share is untouched and still claimable.
        vm.prank(creator);
        assertEq(curve.claimCreatorFees(), creatorOwed);
    }

    function test_doubleClaim_reverts() public {
        _buy(curve, alice, 5_000 * USDG_UNIT);
        vm.prank(creator);
        curve.claimCreatorFees();
        vm.prank(creator);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.claimCreatorFees();
    }

    // ── Reserve solvency ─────────────────────────────────────────────────────

    /// The property that matters most: the curve can always pay what it owes.
    function testFuzz_curveStaysSolvent(uint96[6] memory amounts) public {
        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amount = bound(amounts[i], 1 * USDG_UNIT, 15_000 * USDG_UNIT);
            _fund(alice, amount);
            vm.startPrank(alice);
            usdg.approve(address(curve), amount);
            try curve.buy(amount, 0, block.timestamp) {} catch {}
            vm.stopPrank();

            uint256 owed = (curve.creatorFeesAccrued() + curve.platformFeesAccrued())
                - (curve.creatorFeesClaimed() + curve.platformFeesClaimed());
            assertGe(usdg.balanceOf(address(curve)), curve.reserveUsdg() + owed, "curve is insolvent");
        }
    }
}
