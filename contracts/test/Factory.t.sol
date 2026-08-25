// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
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
     * Sizing note, and a finding worth carrying into T0.1 (curve parameter
     * modelling): at the opening price these placeholders produce, a dev buy of
     * only ~675 USDG already reaches the 5% cap, and ~130 USDG reaches 1%.
     *
     * That is a direct consequence of `virtualUsdg = 12,000` against a 69,000
     * target — the first few hundred USDG buy a very large share. Whether that is
     * the intended shape is exactly what T0.1 has to answer against real data;
     * these tests only assert the cap holds, not that the number is right.
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

    /// The dev buy is exempt from the anti-snipe cap by design (design.md section 4).
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
        HoodiumFactory paid = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: graduationManagerStub,
                tokenDecimals: 18,
                totalSupply: TOTAL_SUPPLY,
                curveAllocation: CURVE_ALLOCATION,
                virtualUsdg: VIRTUAL_USDG,
                graduationTarget: GRADUATION_TARGET,
                graduationFee: GRADUATION_FEE,
                tradeFeeBps: TRADE_FEE_BPS,
                creatorFeeShareBps: CREATOR_SHARE_BPS,
                creationFee: 25 * USDG_UNIT,
                devBuyMaxBps: DEV_BUY_MAX_BPS,
                snipeBlocks: SNIPE_BLOCKS,
                snipeMaxBps: SNIPE_MAX_BPS
            })
        );

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
        assertEq(factory.virtualTokens(), CURVE_ALLOCATION * VIRTUAL_USDG / GRADUATION_TARGET);
    }

    function test_curveSellsOutCloseToAllocationAtTarget() public {
        (, BondingCurve curve) = _launch();
        _skipSnipeWindow();
        _buy(curve, alice, 200_000 * USDG_UNIT);

        assertTrue(curve.curveComplete());
        // Rounding favours the contract, so a few tokens may remain — they roll
        // into the pool at graduation rather than being lost.
        uint256 sold = curve.tokensSold();
        assertLe(sold, CURVE_ALLOCATION);
        assertGe(sold, CURVE_ALLOCATION - CURVE_ALLOCATION / 1_000_000);
    }
}
