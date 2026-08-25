// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {MockUniswapPool} from "./mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";

/**
 * T2.5 (atomicity), T2.7 (lock), and the LP-4.x graduation criteria.
 *
 * T2.4 — "fork test: full graduation against real Uniswap contracts" — lives in
 * `ForkGraduation.t.sol` and needs an RPC. These tests cover the call sequence,
 * its failure modes, and the pool-pricing rules against the price-aware mocks;
 * they do not prove Uniswap itself behaves as assumed.
 *
 * Since AUDIT H2 the buy that reaches the target graduates in the same call, so
 * "graduate" below is usually `_complete` — the last buy — and the external
 * `graduate()` is exercised separately for the dev-buy path.
 */
contract GraduationTest is BaseTest {
    uint256 constant FEE = 1_000 * USDG_UNIT;

    HoodiumToken token;
    BondingCurve curve;

    function setUp() public override {
        super.setUp();
        // A non-zero graduation fee so the fee mechanism is covered.
        Terms memory t = _defaultTerms();
        t.graduationFee = FEE;
        t.creatorFeeShareBps = 1_000;
        t.creationFee = 0;
        _deployStack(address(usdg), t);

        (token, curve) = _launch();
        _skipSnipeWindow();
    }

    // ── LP-4.1, LP-4.6, AUDIT H2 ─────────────────────────────────────────────

    function test_completingBuy_createsPoolAndLocksPosition() public {
        _fillAlmost(curve, alice);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 platformBefore = curve.platformFeesAccrued();

        // LP-4.6 — no privileged caller: a stranger's buy is the one that completes.
        (address pool, uint256 tokenId) = _complete(curve, randomCaller);

        assertTrue(pool != address(0), "pool not created");
        assertTrue(curve.graduated(), "curve not marked graduated");
        assertEq(curve.reserveUsdg(), 0, "reserves not migrated");
        assertEq(curve.pool(), pool);
        assertEq(curve.lpTokenId(), tokenId);

        // LP-3.3 / AUDIT M2 — the fee accrues, it is not pushed. The delta also
        // carries the platform share of the completing buy's own trade fee.
        assertEq(usdg.balanceOf(address(vault)), vaultBefore, "graduation pushed USDG to the vault");
        uint256 accrued = curve.platformFeesAccrued() - platformBefore;
        assertGe(accrued, FEE, "graduation fee not accrued");
        assertLt(accrued - FEE, 10 * USDG_UNIT, "more than the trade fee on top");

        // LP-4.3 — the position lives in the locker, not with the platform.
        assertEq(pm.ownerOf(tokenId), address(locker), "position not locked");
        assertEq(locker.beneficiaryOf(tokenId), creator, "creator should be the fee beneficiary");
        assertEq(locker.tokenOf(tokenId), address(token));

        // The pool holds what the curve raised, minus rounding dust.
        assertGe(usdg.balanceOf(pool), usdgForLp * 9999 / 10_000, "USDG not in pool");
        assertGe(token.balanceOf(pool), tokensForLp * 9999 / 10_000, "tokens not in pool");
    }

    function test_graduationFee_isClaimableToTheVaultAfterwards() public {
        _fillAlmost(curve, alice);
        _complete(curve, alice);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 owed = curve.platformFeesAccrued() - curve.platformFeesClaimed();
        assertGe(owed, FEE);
        vm.prank(randomCaller);
        curve.claimPlatformFees();
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, owed);
        // Nothing but the creator's unclaimed share is left in the curve.
        assertEq(usdg.balanceOf(address(curve)), curve.creatorFeesAccrued() - curve.creatorFeesClaimed());
    }

    function test_graduate_beforeTarget_reverts() public {
        vm.expectRevert(BondingCurve.TargetNotReached.selector);
        curve.graduate();
    }

    function test_graduate_afterCompletingBuy_reverts() public {
        _fillCurve(curve, alice);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.graduate();
    }

    /// AUDIT H2 — a dev buy can complete a curve without graduating it; the
    /// external, permissionless `graduate()` is for exactly that case.
    function test_devBuyCompletedCurve_graduatesPermissionlessly() public {
        Terms memory t = _defaultTerms();
        t.devBuyMaxBps = 10_000;
        t.graduationTarget = 500 * USDG_UNIT;
        t.creationFee = 0;
        _deployStack(address(usdg), t);
        (HoodiumToken tk, BondingCurve c) = _launchWithDevBuy(2_000 * USDG_UNIT);

        assertTrue(c.curveComplete());
        assertFalse(c.graduated());

        // The completed curve refuses sells (nothing can hold it back)...
        vm.startPrank(creator);
        tk.approve(address(c), 1);
        vm.expectRevert(BondingCurve.CurveComplete.selector);
        c.sell(1, 0, block.timestamp);
        vm.stopPrank();

        // ...and anyone graduates it.
        vm.prank(randomCaller);
        (address pool, uint256 tokenId) = c.graduate();
        assertTrue(c.graduated());
        assertEq(pm.ownerOf(tokenId), address(locker));
        assertGt(usdg.balanceOf(pool), 0);
    }

    /// LP-4.4 — the curve permanently refuses trades after graduation.
    function test_tradingDisabledAfterGraduation() public {
        _fillAlmost(curve, alice);
        uint256 held = token.balanceOf(alice);
        _complete(curve, alice);

        usdg.mint(alice, 1_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.buy(1_000 * USDG_UNIT, 0, block.timestamp);

        token.approve(address(curve), held);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.sell(held, 0, block.timestamp);
        vm.stopPrank();
    }

    function test_allUnsoldTokensLeaveTheCurve() public {
        _fillAlmost(curve, alice);
        (address pool,) = _complete(curve, alice);

        assertEq(token.balanceOf(address(curve)), 0, "curve kept tokens back");
        // Everything is in the pool or credited as dust on the manager.
        uint256 dust = manager.dustOf(address(token), creator);
        assertEq(token.balanceOf(pool) + dust, TOTAL_SUPPLY - curve.tokensSold(), "tokens went missing");
    }

    // ── Pool pricing (AUDIT C1, H3) ──────────────────────────────────────────

    /// The pool opens at the curve's closing price — the same number both ways.
    function test_poolOpensAtTheCurvesClosingPrice() public {
        _fillAlmost(curve, alice);
        // Marginal price at the end of the curve, from the buy side of the last unit.
        uint256 x = curve.reserveX() + curve.remainingToTarget();
        uint256 y = curve.virtualTokens() + curve.curveAllocation() - curve.tokensSold();
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);

        // x/y vs usdgForLp/tokensForLp, both scaled by 1e18.
        uint256 closingE18 = x * 1e18 / y;
        uint256 poolE18 = usdgForLp * 1e18 / tokensForLp;
        assertApproxEqRel(poolE18, closingE18, 2e15, "pool opens away from the closing price");

        (address pool,) = _complete(curve, alice);
        (,, bool usdgIsToken1) = _order(address(token));
        uint160 expected =
            usdgIsToken1 ? _sqrtPriceX96(tokensForLp, usdgForLp) : _sqrtPriceX96(usdgForLp, tokensForLp);
        assertEq(MockUniswapPool(pool).sqrtPriceX96(), expected, "pool price != fair price");
    }

    function test_preInitialisedEmptyPool_isRepricedNotTrusted() public {
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        address pool = _primePool(attacker, address(token), fair / 1000);
        assertEq(MockUniswapPool(pool).liquidity(), 0);

        uint256 amount = 1_000 * USDG_UNIT;
        _fund(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        vm.expectEmit(true, false, false, true, address(manager));
        emit GraduationManager.PoolRepriced(pool, fair / 1000, fair);
        curve.buy(amount, 0, block.timestamp);
        vm.stopPrank();
        address used = curve.pool();

        assertEq(used, pool, "graduation should reuse the pool");
        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair, "price not moved to fair");
        (uint256 usdgForLp,) = _lpAmounts(curve);
        assertGe(usdg.balanceOf(pool), usdgForLp * 9999 / 10_000, "USDG did not land in the pool");
    }

    function test_preInitialisedPoolWithHostileLiquidity_reverts() public {
        _buy(curve, attacker, 100 * USDG_UNIT); // the attacker's tokens for the mint
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        address pool = _primePool(attacker, address(token), fair / 2);
        _attackerMints(pool, 1);
        assertGt(MockUniswapPool(pool).liquidity(), 0);

        _fund(alice, 1_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        vm.expectRevert(
            abi.encodeWithSelector(GraduationManager.PoolPriceManipulated.selector, uint160(fair / 2), fair)
        );
        curve.buy(1_000 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());
    }

    function test_preInitialisedPoolWithLiquidityInsideTheBand_isAccepted() public {
        _buy(curve, attacker, 100 * USDG_UNIT);
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        // 0.1% off on the square root: inside the 0.25% band.
        address pool = _primePool(attacker, address(token), uint160(uint256(fair) * 10_010 / 10_000));
        _attackerMints(pool, 1);

        (address used,) = _complete(curve, alice);
        assertEq(used, pool);
        assertTrue(curve.graduated());
    }

    /// Mint a sliver of liquidity at the pool's current price as `attacker`.
    function _attackerMints(address pool, uint256 usdgSide) internal {
        (address t0, address t1, bool usdgIsToken1) = _order(address(token));
        uint256 price = uint256(MockUniswapPool(pool).sqrtPriceX96());
        // amount1/amount0 = (sqrtP/2^96)^2; pick the token side to match.
        uint256 usdgAmt = usdgSide * USDG_UNIT;
        uint256 tokAmt = usdgIsToken1
            ? usdgAmt * Q96 / price * Q96 / price
            : usdgAmt * price / Q96 * price / Q96;
        if (tokAmt == 0) tokAmt = 1;
        usdg.mint(attacker, usdgAmt);
        (uint256 a0, uint256 a1) = usdgIsToken1 ? (tokAmt, usdgAmt) : (usdgAmt, tokAmt);
        vm.startPrank(attacker);
        usdg.approve(address(pm), type(uint256).max);
        token.approve(address(pm), type(uint256).max);
        pm.mint(_mintParams(t0, t1, a0, a1, attacker));
        vm.stopPrank();
    }

    function _mintParams(address t0, address t1, uint256 a0, uint256 a1, address to)
        internal
        view
        returns (INonfungiblePositionManager.MintParams memory)
    {
        return INonfungiblePositionManager.MintParams({
            token0: t0,
            token1: t1,
            fee: POOL_FEE,
            tickLower: -887200,
            tickUpper: 887200,
            amount0Desired: a0,
            amount1Desired: a1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: to,
            deadline: block.timestamp
        });
    }

    // ── T2.5 — atomicity (LP-4.2) ────────────────────────────────────────────

    function test_atomicity_poolCreationFailure_revertsEverything() public {
        _fillAlmost(curve, alice);
        uniFactory.setFailCreate(true);
        _assertCompletingBuyRevertsAndCurveUntouched();
    }

    function test_atomicity_poolInitializeFailure_revertsEverything() public {
        _fillAlmost(curve, alice);
        (address t0, address t1,) = _order(address(token));
        address pool = uniFactory.createPool(t0, t1, POOL_FEE);
        MockUniswapPool(pool).setFailInitialize(true);
        _assertCompletingBuyRevertsAndCurveUntouched();
    }

    function test_atomicity_repriceSwapFailure_revertsEverything() public {
        _fillAlmost(curve, alice);
        address pool = _primePool(attacker, address(token), _fairSqrtP(curve) * 2);
        MockUniswapPool(pool).setFailSwap(true);
        _assertCompletingBuyRevertsAndCurveUntouched();
    }

    function test_atomicity_mintFailure_revertsEverything() public {
        _fillAlmost(curve, alice);
        pm.setFailMint(true);
        _assertCompletingBuyRevertsAndCurveUntouched();
    }

    /**
     * @dev The point of LP-4.2: after a failed migration the curve must be
     *      exactly as it was, and still tradeable. A half-migrated curve with
     *      `graduated = true` and no pool would strand every holder. The buy
     *      that would have completed it reverts as a whole.
     */
    function _assertCompletingBuyRevertsAndCurveUntouched() private {
        uint256 reserveBefore = curve.reserveUsdg();
        uint256 soldBefore = curve.tokensSold();
        uint256 amount = 1_000 * USDG_UNIT;
        _fund(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        vm.expectRevert();
        curve.buy(amount, 0, block.timestamp);
        vm.stopPrank();

        assertFalse(curve.graduated(), "graduated flag survived a reverted migration");
        assertEq(curve.reserveUsdg(), reserveBefore, "reserve changed");
        assertEq(curve.tokensSold(), soldBefore, "tokensSold changed");
        assertTrue(usdg.balanceOf(address(curve)) >= curve.reserveUsdg(), "curve went insolvent");

        // And still tradeable: sell back into it.
        uint256 held = token.balanceOf(alice);
        uint256 out = _sell(curve, token, alice, held / 100);
        assertGt(out, 0, "curve is no longer tradeable after a failed graduation");
    }

    // ── T2.7 — locked principal is unrecoverable (LP-4.3) ────────────────────

    function test_lockedPosition_cannotBeMovedByAnyone() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);

        // Creator cannot take it.
        vm.prank(creator);
        vm.expectRevert();
        pm.safeTransferFrom(address(locker), creator, tokenId);

        // Neither can the graduation manager that put it there.
        vm.prank(address(manager));
        vm.expectRevert();
        pm.safeTransferFrom(address(locker), address(manager), tokenId);

        // Nor a stranger.
        vm.prank(randomCaller);
        vm.expectRevert();
        pm.safeTransferFrom(address(locker), randomCaller, tokenId);

        assertEq(pm.ownerOf(tokenId), address(locker), "position moved");
    }

    /// T0.4 — fees split 70/30, and the collection still cannot reach principal.
    function test_lockedPosition_feesSplitBetweenCreatorAndProtocol() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        _creditUsdgFees(address(token), tokenId, 500 * USDG_UNIT);

        // Only the creator may collect for themselves.
        vm.prank(alice);
        vm.expectRevert(LPLocker.NotBeneficiary.selector);
        locker.collectFees(tokenId);

        uint256 creatorBefore = usdg.balanceOf(creator);
        uint256 vaultBefore = usdg.balanceOf(address(vault));

        vm.prank(creator);
        locker.collectFees(tokenId);

        uint256 expectedProtocol = (500 * USDG_UNIT * PROTOCOL_FEE_SHARE_BPS) / 10_000;
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, expectedProtocol, "protocol share wrong");
        assertEq(
            usdg.balanceOf(creator) - creatorBefore, 500 * USDG_UNIT - expectedProtocol, "creator share wrong"
        );

        // Nothing is left stranded in the locker.
        assertEq(usdg.balanceOf(address(locker)), 0, "locker retained fees");

        // Liquidity is untouched by a fee collection.
        (,,,,,,, uint128 liquidity,,,,) = pm.positions(tokenId);
        assertGt(liquidity, 0, "principal moved");
    }

    /// AUDIT L2 — anyone can sweep the protocol's share; the creator's is held.
    function test_lockedPosition_anyoneCanSweepTheProtocolShare() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        _creditUsdgFees(address(token), tokenId, 1_000 * USDG_UNIT);
        (,, bool usdgIsToken1) = _order(address(token));

        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 creatorBefore = usdg.balanceOf(creator);
        vm.prank(randomCaller);
        locker.sweepProtocolFees(tokenId);

        uint256 protocol = 1_000 * USDG_UNIT * PROTOCOL_FEE_SHARE_BPS / 10_000;
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, protocol, "protocol not paid");
        assertEq(usdg.balanceOf(creator), creatorBefore, "creator share was pushed");
        uint256 owed = usdgIsToken1 ? locker.creatorOwed1(tokenId) : locker.creatorOwed0(tokenId);
        assertEq(owed, 1_000 * USDG_UNIT - protocol, "creator share not credited");
        assertEq(usdg.balanceOf(address(locker)), owed, "locker holds exactly the credit");

        // The creator pulls it later, on top of anything new.
        _creditUsdgFees(address(token), tokenId, 100 * USDG_UNIT);
        vm.prank(creator);
        (uint256 c0, uint256 c1) = locker.collectFees(tokenId);
        uint256 paid = usdgIsToken1 ? c1 : c0;
        assertEq(paid, owed + 100 * USDG_UNIT * (10_000 - PROTOCOL_FEE_SHARE_BPS) / 10_000);
        assertEq(usdg.balanceOf(creator) - creatorBefore, paid);
        assertEq(usdg.balanceOf(address(locker)), 0);
    }

    /// When the split cannot divide evenly, the remainder is the creator's.
    function test_lockedPosition_dustFavoursTheCreator() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        _creditUsdgFees(address(token), tokenId, 3); // 30% of 3 wei rounds down to zero

        uint256 creatorBefore = usdg.balanceOf(creator);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        vm.prank(creator);
        locker.collectFees(tokenId);

        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, 0, "protocol took the dust");
        assertEq(usdg.balanceOf(creator) - creatorBefore, 3, "creator did not get the dust");
    }

    /// The split is public and immutable — a creator can read it before launching.
    function test_locker_publishesItsSplit() public view {
        assertEq(locker.protocolFeeShareBps(), PROTOCOL_FEE_SHARE_BPS, "split not readable");
        assertEq(locker.feeVault(), address(vault), "vault not readable");
        assertEq(locker.graduationManager(), address(manager), "manager not readable");
    }

    /**
     * The contract is immutable, so a mistyped constructor argument is permanent.
     * No deployment may take the majority of a creator's pool fees.
     */
    function test_locker_refusesAShareAboveTheCeiling() public {
        uint256 ceiling = locker.MAX_PROTOCOL_FEE_SHARE_BPS();

        vm.expectRevert(bytes("share too high"));
        new LPLocker(address(pm), address(vault), ceiling + 1, address(manager));

        // The ceiling itself is allowed — it is a limit, not an exclusion.
        LPLocker atCeiling = new LPLocker(address(pm), address(vault), ceiling, address(manager));
        assertEq(atCeiling.protocolFeeShareBps(), ceiling);
    }

    function test_locker_rejectsPositionsFromNonPositionManager() public {
        vm.prank(alice);
        vm.expectRevert(LPLocker.NotPositionManager.selector);
        locker.onERC721Received(alice, alice, 999, abi.encode(address(token), alice));
    }

    /// AUDIT M1 — even the position manager may only deliver on the manager's behalf.
    function test_locker_rejectsPositionsNotSentByTheGraduationManager() public {
        vm.prank(address(pm));
        vm.expectRevert(LPLocker.NotGraduationManager.selector);
        locker.onERC721Received(alice, alice, 999, abi.encode(address(token), alice));
    }

    // ── Dust handling (AUDIT C1 / M2) ────────────────────────────────────────

    function test_migrationDust_isCreditedForTheCreatorToPull() public {
        pm.setDustBps(50); // the mock leaves 0.5% of each side unused
        _fillAlmost(curve, alice);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);

        uint256 creatorUsdgBefore = usdg.balanceOf(creator);
        _complete(curve, alice);

        // Nothing was pushed to the creator during graduation.
        assertEq(usdg.balanceOf(creator), creatorUsdgBefore, "USDG pushed to creator");
        uint256 usdgDust = manager.dustOf(address(usdg), creator);
        uint256 tokenDust = manager.dustOf(address(token), creator);
        assertGt(usdgDust, 0, "usdg dust not credited");
        assertGt(tokenDust, 0, "token dust not credited");
        assertLe(usdgDust, usdgForLp / 100);
        assertLe(tokenDust, tokensForLp / 100);
        assertEq(usdg.balanceOf(address(manager)), usdgDust, "manager balance != credited dust");
        assertEq(token.balanceOf(address(manager)), tokenDust, "manager balance != credited dust");

        // Only the creator can pull, and only their own.
        vm.prank(alice);
        vm.expectRevert(GraduationManager.NothingToPull.selector);
        manager.pullDust(address(usdg));

        vm.prank(creator);
        assertEq(manager.pullDust(address(usdg)), usdgDust);
        vm.prank(creator);
        assertEq(manager.pullDust(address(token)), tokenDust);
        assertEq(usdg.balanceOf(creator) - creatorUsdgBefore, usdgDust);
        assertEq(usdg.balanceOf(address(manager)), 0, "manager retained funds");
        assertEq(token.balanceOf(address(manager)), 0, "manager retained funds");

        vm.prank(creator);
        vm.expectRevert(GraduationManager.NothingToPull.selector);
        manager.pullDust(address(usdg));
    }

    /// More than 1% left behind on either side is a broken migration, not dust.
    function test_migrationLeavingOverOnePercent_reverts() public {
        pm.setDustBps(150);
        _fillAlmost(curve, alice);
        _assertCompletingBuyRevertsAndCurveUntouched();
    }
}

