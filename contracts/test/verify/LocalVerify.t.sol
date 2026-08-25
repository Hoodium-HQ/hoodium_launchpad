// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MockUniswapPool} from "../mocks/MockUniswap.sol";

/// Adversarial checks on the fix pass that do not need the real chain.
contract LocalVerifyTest is BaseTest {
    // ── Q4: boughtInWindow keying ────────────────────────────────────────────

    /// Buy → sell → buy inside the window: the counter never decrements, so the
    /// cap is cumulative on gross buys, not net holdings.
    function test_verify_windowCounter_doesNotDecrementOnSell() public {
        (HoodiumToken token, BondingCurve curve) = _launch();
        uint256 cap = curve.snipeMaxTokens();
        // Quote enough USDG for ~0.6% of supply.
        uint256 usdgIn = 0;
        for (uint256 g = 1 * USDG_UNIT; g < 100_000 * USDG_UNIT; g += 5 * USDG_UNIT) {
            (uint256 q,,,) = curve.quoteBuy(g);
            if (q > cap * 6 / 10) {
                usdgIn = g;
                break;
            }
        }
        uint256 got = _buy(curve, alice, usdgIn);
        assertLe(got, cap);
        _sell(curve, token, alice, got);
        assertEq(curve.boughtInWindow(alice), got, "counter must not be reduced by the sell");
        _fund(alice, usdgIn);
        vm.startPrank(alice);
        usdg.approve(address(curve), usdgIn);
        vm.expectPartialRevert(BondingCurve.AntiSnipeCapExceeded.selector);
        curve.buy(usdgIn, 0, block.timestamp);
        vm.stopPrank();
    }

    /// The dev buy is keyed on the creator, not on the factory (the payer).
    function test_verify_devBuy_keyedOnCreatorNotFactory() public {
        (, BondingCurve curve) = _launchWithDevBuy(500 * USDG_UNIT);
        assertGt(curve.boughtInWindow(creator), 0);
        assertEq(curve.boughtInWindow(address(factory)), 0);
    }

    // ── Q5: derived virtual reserves ─────────────────────────────────────────

    /// With a non-zero graduation fee the curve's closing marginal price equals
    /// the pool's opening price to within the continuity tolerance, and the
    /// curve never sells more than curveAllocation.
    function testFuzz_verify_continuityAndAllocationBound(uint256 curveShareBps, uint256 targetK, uint256 feeBps)
        public
    {
        curveShareBps = bound(curveShareBps, 5_100, 9_900);
        targetK = bound(targetK, 1, 10_000); // 1k .. 10M USDG
        feeBps = bound(feeBps, 0, 5_000); // fee up to 50% of target
        Terms memory t = _defaultTerms();
        t.curveAllocation = Math.mulDiv(TOTAL_SUPPLY, curveShareBps, 10_000);
        t.graduationTarget = targetK * 1_000 * USDG_UNIT;
        t.graduationFee = Math.mulDiv(t.graduationTarget, feeBps, 10_000);
        t.creationFee = 0;

        // Some corners legitimately cannot ship (continuity impossible); skip those.
        uint256 usdgForLp = t.graduationTarget - t.graduationFee;
        uint256 lp = TOTAL_SUPPLY - t.curveAllocation;
        vm.assume(t.curveAllocation * usdgForLp > lp * t.graduationTarget);

        _deployStack(address(usdg), t);
        (, BondingCurve curve) = _launch();
        _skipSnipeWindow();

        // Closing marginal price from the reserves at the instant before completion.
        uint256 x = curve.virtualUsdg() + t.graduationTarget;
        (uint256 stillToSell,,,) = curve.quoteBuy(type(uint128).max);
        uint256 soldAtTarget = stillToSell;
        assertLe(soldAtTarget, t.curveAllocation, "curve oversold");
        uint256 y = curve.virtualTokens() + t.curveAllocation - soldAtTarget;
        uint256 tokensForLp = lp + t.curveAllocation - soldAtTarget;
        // price = x/y vs usdgForLp/tokensForLp  =>  x*tokensForLp ~= usdgForLp*y
        uint256 lhs = x * tokensForLp;
        uint256 rhs = usdgForLp * y;
        assertApproxEqRel(lhs, rhs, 0.006e18, "pool opens off the curve's closing price");

        _buy(curve, alice, t.graduationTarget * 2);
        assertTrue(curve.graduated());
        assertLe(curve.tokensSold(), t.curveAllocation);
    }

    /// LP allocation of 1 wei: the derivation underflows to zero and the factory refuses.
    function test_verify_degenerateLpAllocation_refused() public {
        vm.expectRevert(bytes("virtual usdg underflow"));
        new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: TOTAL_SUPPLY,
                curveAllocation: TOTAL_SUPPLY - 1,
                graduationTarget: GRADUATION_TARGET,
                graduationFee: 0,
                tradeFeeBps: TRADE_FEE_BPS,
                creatorFeeShareBps: CREATOR_SHARE_BPS,
                creationFee: 0,
                devBuyMaxBps: DEV_BUY_MAX_BPS,
                snipeBlocks: SNIPE_BLOCKS,
                snipeMaxBps: SNIPE_MAX_BPS
            })
        );
    }

    // ── Q7: pull paths ───────────────────────────────────────────────────────

    function test_verify_pullDust_onlyOnce_onlyOwn() public {
        pm.setDustBps(50); // 0.5% held back on each side
        (HoodiumToken token, BondingCurve curve) = _launch();
        _skipSnipeWindow();
        _fillCurve(curve, alice);
        uint256 owed = manager.dustOf(address(usdg), creator);
        assertGt(owed, 0);
        assertEq(usdg.balanceOf(address(manager)), owed, "manager holds exactly the credited dust");
        vm.prank(attacker);
        vm.expectRevert(GraduationManager.NothingToPull.selector);
        manager.pullDust(address(usdg));
        vm.prank(creator);
        manager.pullDust(address(usdg));
        assertEq(usdg.balanceOf(creator), owed);
        vm.prank(creator);
        vm.expectRevert(GraduationManager.NothingToPull.selector);
        manager.pullDust(address(usdg));
        assertEq(usdg.balanceOf(address(manager)), 0);
        // token side too
        uint256 tOwed = manager.dustOf(address(token), creator);
        if (tOwed > 0) {
            vm.prank(creator);
            manager.pullDust(address(token));
        }
        assertEq(token.balanceOf(address(manager)), 0);
    }

    /// Dust just above the cap is refused; the whole buy reverts and the curve stays live.
    function test_verify_excessiveDust_revertsWholeBuy() public {
        pm.setDustBps(101); // 1.01% held back
        (, BondingCurve curve) = _launch();
        _skipSnipeWindow();
        _fillAlmost(curve, alice);
        _fund(alice, 500 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 500 * USDG_UNIT);
        vm.expectRevert(bytes("Price slippage check"));
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());
        assertFalse(curve.curveComplete());
    }

    function test_verify_sweepThenCollect_conserves_andNoDoublePay() public {
        (HoodiumToken token, BondingCurve curve) = _launch();
        _skipSnipeWindow();
        (, uint256 tokenId) = _fillCurve(curve, alice);
        _creditUsdgFees(address(token), tokenId, 1_000 * USDG_UNIT);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        vm.prank(attacker);
        locker.sweepProtocolFees(tokenId);
        uint256 protocol = usdg.balanceOf(address(vault)) - vaultBefore;
        assertEq(protocol, 300 * USDG_UNIT);
        // Second sweep with nothing accrued: no-op, no double credit.
        vm.prank(attacker);
        locker.sweepProtocolFees(tokenId);
        (,, bool usdgIsToken1) = _order(address(token));
        uint256 owed = usdgIsToken1 ? locker.creatorOwed1(tokenId) : locker.creatorOwed0(tokenId);
        assertEq(owed, 700 * USDG_UNIT);
        vm.prank(attacker);
        vm.expectRevert(LPLocker.NotBeneficiary.selector);
        locker.collectFees(tokenId);
        vm.prank(creator);
        locker.collectFees(tokenId);
        assertEq(usdg.balanceOf(creator), 700 * USDG_UNIT);
        vm.prank(creator);
        locker.collectFees(tokenId);
        assertEq(usdg.balanceOf(creator), 700 * USDG_UNIT, "double pay");
        assertEq(usdg.balanceOf(address(locker)), 0, "locker retains fees");
    }

    function test_verify_vault_revokeAfterExpiry_and_executeAtDeadline() public {
        address s1 = makeAddr("signer1");
        address s2 = makeAddr("signer2");
        usdg.mint(address(vault), 10);
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), alice, 10);
        vm.warp(block.timestamp + 30 days); // exactly the deadline: still open
        vm.prank(s2);
        vault.confirm(id);
        vm.warp(block.timestamp + 1);
        vm.prank(s2);
        vm.expectPartialRevert(FeeVault.ProposalExpired.selector);
        vault.execute(id);
        // revoke on an expired proposal is allowed and cannot underflow
        vm.prank(s2);
        vault.revokeConfirmation(id);
        vm.prank(s1);
        vault.revokeConfirmation(id);
        assertEq(vault.withdrawal(id).confirmations, 0);
        vm.prank(s1);
        vm.expectRevert(FeeVault.NotConfirmed.selector);
        vault.revokeConfirmation(id);
    }

    // ── Q6: pairing ──────────────────────────────────────────────────────────

    function test_verify_managerRefusesLockerBuiltForAnotherManager() public {
        LPLocker other = new LPLocker(address(pm), address(vault), 3_000, makeAddr("someoneElse"));
        vm.expectRevert(bytes("locker/manager mismatch"));
        new GraduationManager(
            address(uniFactory), address(pm), address(other), address(usdg), POOL_FEE, TICK_SPACING, makeAddr("f")
        );
    }

    // ── Q1 on the mock: callback at rest ─────────────────────────────────────

    function test_verify_callbackAtRest_rejectsEvenZeroDeltas() public {
        vm.expectRevert(GraduationManager.UnexpectedSwapCallback.selector);
        manager.uniswapV3SwapCallback(0, 0, "");
    }
}
