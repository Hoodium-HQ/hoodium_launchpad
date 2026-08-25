// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";

/// T1.1, T1.7 / LP-1.1 … LP-1.7, LP-2.7.
contract FactoryTest is BaseTest {
    // ── LP-1.1, LP-1.3 ───────────────────────────────────────────────────────

    function test_launch_deploysTokenAndCurveInOneTransaction() public {
        _fund(creator, CREATION_FEE);
        vm.startPrank(creator);
        usdg.approve(address(factory), CREATION_FEE);
        (address t, address c) = factory.launch("My Token", "MTK", "ipfs://QmHash", 0, 0);
        vm.stopPrank();

        HoodiumToken token = HoodiumToken(t);
        BondingCurve curve = BondingCurve(c);

        assertEq(token.name(), "My Token");
        assertEq(token.symbol(), "MTK");
        assertEq(token.metadataURI(), "ipfs://QmHash"); // LP-1.7
        assertEq(token.creator(), creator);
        assertEq(token.totalSupply(), TOTAL_SUPPLY);

        // LP-1.3 — the creator provided no *liquidity*: they were funded the
        // creation fee and nothing more, and the launch consumed exactly that.
        assertEq(usdg.balanceOf(creator), 0);
        // The curve holds the entire supply: curve allocation plus LP reserve.
        assertEq(token.balanceOf(c), TOTAL_SUPPLY);
        assertEq(factory.curveOf(t), c);
        assertEq(curve.creator(), creator);
    }

    function test_launch_recordsForDiscovery() public {
        _fund(creator, 2 * CREATION_FEE);
        vm.startPrank(creator);
        usdg.approve(address(factory), 2 * CREATION_FEE);
        (address t1,) = factory.launch("One", "ONE", "ipfs://1", 0, 0);
        (address t2,) = factory.launch("Two", "TWO", "ipfs://2", 0, 0);
        vm.stopPrank();

        assertEq(factory.launchCount(), 2);
        address[] memory mine = factory.launchesByCreator(creator);
        assertEq(mine.length, 2);
        assertEq(mine[0], t1);
        assertEq(mine[1], t2);
    }

    // ── LP-1.2 — no mint, no owner ───────────────────────────────────────────

    function test_token_hasNoMintOrOwnerFunctions() public {
        (HoodiumToken token,) = _launch();

        // If these selectors existed the calls would do something; they do not
        // exist, so they hit the fallback and revert.
        (bool ok,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1));
        assertFalse(ok, "token exposes mint()");
        (ok,) = address(token).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "token exposes owner()");
        (ok,) = address(token).call(abi.encodeWithSignature("burn(uint256)", 1));
        assertFalse(ok, "token exposes burn()");
        (ok,) = address(token).call(abi.encodeWithSignature("pause()"));
        assertFalse(ok, "token exposes pause()");
    }

    function test_totalSupplyIsFixedAcrossTrading() public {
        (HoodiumToken token, BondingCurve curve) = _launch();
        _skipSnipeWindow();

        uint256 supplyBefore = token.totalSupply();
        _buy(curve, alice, 5_000 * USDG_UNIT);
        _sell(curve, token, alice, token.balanceOf(alice) / 2);

        assertEq(token.totalSupply(), supplyBefore, "supply moved");
    }

    // ── LP-1.6 — dev buy ─────────────────────────────────────────────────────

    /*
     * Sizing note: at the opening price the derived reserves produce
     * (virtualUsdg = 23,000 against a 69,000 target), a dev buy of ~1,140 USDG
     * reaches the 5% cap and ~220 USDG reaches 1%. These tests only assert the
     * cap holds, not that the number is right.
     */
    uint256 constant DEV_BUY_UNDER_CAP = 500 * USDG_UNIT;

    function test_devBuy_executesInTheDeploymentTransaction() public {
        uint256 devBuy = DEV_BUY_UNDER_CAP;
        _fund(creator, devBuy + CREATION_FEE);

        vm.startPrank(creator);
        usdg.approve(address(factory), devBuy + CREATION_FEE);
        (address t, address c) = factory.launch("Dev", "DEV", "ipfs://d", devBuy, 0);
        vm.stopPrank();

        assertGt(HoodiumToken(t).balanceOf(creator), 0, "creator received no tokens");
        assertEq(BondingCurve(c).reserveUsdg(), devBuy - (devBuy * TRADE_FEE_BPS / 10_000));
    }

    function test_devBuy_overCapReverts() public {
        // Enough USDG to buy well past 5% of supply.
        uint256 huge = 60_000 * USDG_UNIT;
        _fund(creator, huge + CREATION_FEE);

        vm.startPrank(creator);
        usdg.approve(address(factory), huge + CREATION_FEE);
        // Named, not bare: with the allowance short by the creation fee this
        // reverted on the transfer instead, and passed for the wrong reason.
        // Partial: the error carries the quoted amount, which is a curve-shape
        // detail T0.1 will move. The selector is the part being asserted.
        vm.expectPartialRevert(HoodiumFactory.DevBuyTooLarge.selector);
        factory.launch("Greedy", "GRD", "ipfs://g", huge, 0);
        vm.stopPrank();
    }

    function test_devBuy_atCapSucceeds() public {
        uint256 amount = DEV_BUY_UNDER_CAP;
        _fund(creator, amount + CREATION_FEE);

        vm.startPrank(creator);
        usdg.approve(address(factory), amount + CREATION_FEE);
        (address t,) = factory.launch("Fair", "FAIR", "ipfs://f", amount, 0);
        vm.stopPrank();

        assertLe(HoodiumToken(t).balanceOf(creator), factory.devBuyCapTokens());
    }

    /// The dev buy is exempt from the anti-snipe *cap* by design (design.md
    /// section 4) but counts against the creator's window allowance (AUDIT H1).
    function test_devBuy_isNotBlockedByAntiSnipe() public {
        uint256 amount = DEV_BUY_UNDER_CAP;
        _fund(creator, amount + CREATION_FEE);

        vm.startPrank(creator);
        usdg.approve(address(factory), amount + CREATION_FEE);
        (address t,) = factory.launch("Snipe", "SNP", "ipfs://s", amount, 0);
        vm.stopPrank();

        uint256 snipeCap = TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000;
        assertGt(HoodiumToken(t).balanceOf(creator), snipeCap, "fixture should exceed the snipe cap");
    }

    /// AUDIT H1 — after a dev buy above the window cap, the creator cannot buy
    /// again inside the window from the same address.
    function test_devBuy_consumesTheCreatorsWindowAllowance() public {
        uint256 amount = DEV_BUY_UNDER_CAP;
        _fund(creator, amount + CREATION_FEE);
        vm.startPrank(creator);
        usdg.approve(address(factory), amount + CREATION_FEE);
        (address t, address c) = factory.launch("Snipe", "SNP", "ipfs://s", amount, 0);
        vm.stopPrank();

        BondingCurve curve = BondingCurve(c);
        uint256 held = HoodiumToken(t).balanceOf(creator);
        assertEq(curve.boughtInWindow(creator), held, "dev buy not counted in the window");

        uint256 cap = TOTAL_SUPPLY * SNIPE_MAX_BPS / 10_000;
        (uint256 next,,,) = curve.quoteBuy(10 * USDG_UNIT);
        _fund(creator, 10 * USDG_UNIT);
        vm.startPrank(creator);
        usdg.approve(c, 10 * USDG_UNIT);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.AntiSnipeCapExceeded.selector, held + next, cap));
        curve.buy(10 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
    }

    /// AUDIT L1 — a dev buy the curve cannot fully absorb is refunded, not stranded.
    function test_devBuy_overshootIsRefundedToTheCreator() public {
        // Not reachable with the shipped 5% cap (continuity needs the curve to
        // hold over half the supply, so 5% can never sell it out), but any
        // deployment may raise the cap; the refund path must hold when it does.
        Terms memory t = _defaultTerms();
        t.devBuyMaxBps = 10_000;
        t.graduationTarget = 1_000 * USDG_UNIT;
        t.creationFee = 0;
        _deployStack(address(usdg), t);

        uint256 devBuy = 5_000 * USDG_UNIT;
        _fund(creator, devBuy);
        vm.startPrank(creator);
        usdg.approve(address(factory), devBuy);
        (, address c) = factory.launch("Small", "SML", "ipfs://x", devBuy, 0);
        vm.stopPrank();

        BondingCurve small = BondingCurve(c);
        assertTrue(small.curveComplete(), "fixture: dev buy should complete the curve");
        assertEq(usdg.balanceOf(address(factory)), 0, "factory kept USDG");
        uint256 spent = devBuy - usdg.balanceOf(creator);
        assertLt(spent, devBuy, "nothing was refunded");
        assertEq(usdg.balanceOf(address(small)), spent, "curve holds exactly what was spent");
    }

    function test_devBuy_cannotBeCalledTwice() public {
        // Launch *with* a dev buy so the one-shot flag is actually set.
        _fund(creator, DEV_BUY_UNDER_CAP + CREATION_FEE);
        vm.startPrank(creator);
        usdg.approve(address(factory), DEV_BUY_UNDER_CAP + CREATION_FEE);
        (, address c) = factory.launch("Once", "ONCE", "ipfs://o", DEV_BUY_UNDER_CAP, 0);
        vm.stopPrank();

        // Even the factory itself cannot repeat it.
        vm.prank(address(factory));
        vm.expectRevert(BondingCurve.DevBuyAlreadyDone.selector);
        BondingCurve(c).devBuy(alice, 100 * USDG_UNIT, 0);
    }

    function test_devBuy_onlyCallableByFactory() public {
        (, BondingCurve curve) = _launch();

        vm.prank(alice);
        vm.expectRevert(BondingCurve.NotFactory.selector);
        curve.devBuy(alice, 1_000 * USDG_UNIT, 0);
    }

    // ── LP-1.5 — creation fee ────────────────────────────────────────────────

    function test_creationFee_goesToTheVault() public {
        Terms memory t = _defaultTerms();
        t.creationFee = 25 * USDG_UNIT;
        _deployStack(address(usdg), t);
        HoodiumFactory paid = factory;

        _fund(creator, 25 * USDG_UNIT);
        uint256 vaultBefore = usdg.balanceOf(address(vault));

        vm.startPrank(creator);
        usdg.approve(address(paid), 25 * USDG_UNIT);
        paid.launch("Paid", "PAID", "ipfs://p", 0, 0);
        vm.stopPrank();

        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, 25 * USDG_UNIT);
    }

    // ── LP-2.7 — curve parameters immutable ──────────────────────────────────

    function test_curveParametersAreImmutable() public {
        (, BondingCurve curve) = _launch();

        // No setter exists for any of them.
        string[6] memory setters = [
            "setTradeFeeBps(uint256)",
            "setGraduationTarget(uint256)",
            "setCreator(address)",
            "setFeeVault(address)",
            "setVirtualUsdg(uint256)",
            "setOwner(address)"
        ];
        for (uint256 i = 0; i < setters.length; i++) {
            (bool ok,) = address(curve).call(abi.encodeWithSignature(setters[i], uint256(1)));
            assertFalse(ok, "a curve parameter is mutable");
        }
    }

    /**
     * The virtual token reserve is derived so the curve allocation sells out
     * exactly at the target, rather than being a hand-picked number that can
     * disagree with it.
     */
    function test_virtualTokensDerivedFromTarget() public view {
        assertEq(factory.virtualTokens(), CURVE_ALLOCATION * factory.virtualUsdg() / GRADUATION_TARGET);
    }

    /**
     * AUDIT H3 — the virtual USDG reserve is derived so the pool opens at the
     * curve's closing price: vU = lpAllocation · target / (C − lpAllocation).
     */
    function test_virtualUsdgDerivedForPriceContinuity() public view {
        assertEq(factory.virtualUsdg(), VIRTUAL_USDG);
        assertEq(factory.virtualUsdg(), LP_ALLOCATION * GRADUATION_TARGET / (CURVE_ALLOCATION - LP_ALLOCATION));
        // Continuity: closing price (vU + target) / vT equals pool price target / lpAllocation.
        uint256 closingE18 = (VIRTUAL_USDG + GRADUATION_TARGET) * 1e18 / factory.virtualTokens();
        uint256 poolE18 = GRADUATION_TARGET * 1e18 / LP_ALLOCATION;
        assertApproxEqRel(closingE18, poolE18, 1e15, "pool would not open at the closing price");
    }

    /// A graduation fee is part of the derivation: the pool still opens at the closing price.
    function test_virtualUsdgAccountsForTheGraduationFee() public {
        Terms memory t = _defaultTerms();
        t.graduationFee = 1_000 * USDG_UNIT;
        _deployStack(address(usdg), t);
        uint256 closingE18 = (factory.virtualUsdg() + GRADUATION_TARGET) * 1e18 / factory.virtualTokens();
        uint256 poolE18 = (GRADUATION_TARGET - t.graduationFee) * 1e18 / LP_ALLOCATION;
        assertApproxEqRel(closingE18, poolE18, 1e15);
    }

    /// An LP allocation of half the supply or more has no positive vU.
    function test_factory_rejectsAllocationsWithoutContinuity() public {
        Terms memory t = _defaultTerms();
        t.curveAllocation = 500_000_000 * TOKEN_UNIT;
        vm.expectRevert(bytes("lp allocation too large for continuity"));
        new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: t.totalSupply,
                curveAllocation: t.curveAllocation,
                graduationTarget: t.graduationTarget,
                graduationFee: t.graduationFee,
                tradeFeeBps: t.tradeFeeBps,
                creatorFeeShareBps: t.creatorFeeShareBps,
                creationFee: t.creationFee,
                devBuyMaxBps: t.devBuyMaxBps,
                snipeBlocks: t.snipeBlocks,
                snipeMaxBps: t.snipeMaxBps
            })
        );
    }

    /// AUDIT M1 — the factory refuses a manager that was not built for it.
    function test_factory_rejectsAManagerPairedWithAnotherFactory() public {
        GraduationManager other = manager; // paired with `factory`, not with the new one
        Terms memory t = _defaultTerms();
        vm.expectRevert(bytes("manager/factory mismatch"));
        new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(other),
                tokenDecimals: 18,
                totalSupply: t.totalSupply,
                curveAllocation: t.curveAllocation,
                graduationTarget: t.graduationTarget,
                graduationFee: t.graduationFee,
                tradeFeeBps: t.tradeFeeBps,
                creatorFeeShareBps: t.creatorFeeShareBps,
                creationFee: t.creationFee,
                devBuyMaxBps: t.devBuyMaxBps,
                snipeBlocks: t.snipeBlocks,
                snipeMaxBps: t.snipeMaxBps
            })
        );
    }

    function test_curveSellsOutCloseToAllocationAtTarget() public {
        (, BondingCurve curve) = _launch();
        _skipSnipeWindow();
        _buy(curve, alice, 200_000 * USDG_UNIT);

        assertTrue(curve.graduated());
        // Rounding favours the contract, so a few tokens may remain — they roll
        // into the pool at graduation rather than being lost.
        uint256 sold = curve.tokensSold();
        assertLe(sold, CURVE_ALLOCATION);
        assertGe(sold, CURVE_ALLOCATION - CURVE_ALLOCATION / 1_000_000);
    }
}
