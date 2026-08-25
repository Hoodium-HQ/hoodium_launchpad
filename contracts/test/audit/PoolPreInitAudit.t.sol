// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {MockUniswapPool} from "../mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/**
 * AUDIT C1 — hostile pool pre-initialisation before graduation.
 *
 * Originally a proof of concept: `GraduationManager._ensurePool` kept an
 * existing pool and its price as-is, `_mintAndLock` minted with zero minimums
 * and swept the unused side to the *creator*. Because creating + initialising
 * a Uniswap v3 pool is permissionless and needs no tokens, the creator could
 * price the pool so the mint consumed all the tokens and ~none of the USDG,
 * and walk away with 99.99% of the raise as "dust".
 *
 * Now a regression suite. The manager re-prices an empty pre-made pool to the
 * curve's closing price, refuses a liquid one that is not already there, mints
 * with 99% minimums, and credits any dust rather than pushing it. The
 * price-aware position manager the PoC carried is now the suite's stock mock.
 */
contract PoolPreInitAuditTest is BaseTest {
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

    /// Baseline: with a fresh pool, essentially all USDG lands in the pool.
    function test_baseline_freshPool_usdgGoesToPool() public {
        _fillAlmost(curve, alice);
        (uint256 usdgForLp,) = _lpAmounts(curve);
        uint256 creatorBefore = usdg.balanceOf(creator);

        (address pool,) = _complete(curve, alice);

        assertEq(usdg.balanceOf(creator), creatorBefore, "creator received USDG at graduation");
        assertLt(manager.dustOf(address(usdg), creator), usdgForLp / 1000, "fresh pool should leave < 0.1% dust");
        assertGt(usdg.balanceOf(pool), usdgForLp * 999 / 1000, "pool should hold the reserves");
    }

    /**
     * The former CRITICAL. The creator initialises the pool at a price that
     * makes the token look ~10^6x cheaper in USDG than the curve's closing
     * price, then triggers graduation. The pool is empty, so the manager walks
     * its price to the closing price with a zero-liquidity swap; the mint then
     * consumes both sides and the creator receives nothing.
     */
    function test_regression_creatorPreInitsPoolAtHostilePrice_getsNothing() public {
        _fillAlmost(curve, alice);
        (,, bool usdgIsToken1) = _order(address(token));
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        uint160 fair = _fairSqrtP(curve);

        // Hostile: USDG side is over-valued 10^6x relative to the token.
        //   USDG is token1 -> lower sqrtP (token1 per token0 falls)
        //   USDG is token0 -> raise sqrtP
        uint160 hostile = usdgIsToken1 ? fair / 1000 : fair * 1000;
        address pool = _primePool(creator, address(token), hostile);

        uint256 creatorUsdgBefore = usdg.balanceOf(creator);
        uint256 creatorTokBefore = token.balanceOf(creator);

        // Permissionless graduation — whoever makes the completing buy.
        (address used,) = _complete(curve, bob);
        assertEq(used, pool);

        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair, "pool was not re-priced to the closing price");
        assertEq(usdg.balanceOf(creator) - creatorUsdgBefore, 0, "creator received USDG");
        assertGt(usdg.balanceOf(pool), usdgForLp * 999 / 1000, "pool holds < 99.9% of the reserve");
        assertGt(token.balanceOf(pool), tokensForLp * 999 / 1000, "pool holds < 99.9% of the tokens");
        assertLt(manager.dustOf(address(usdg), creator), usdgForLp / 1000, "USDG dust exceeds rounding");
        assertLt(manager.dustOf(address(token), creator), tokensForLp / 1000, "token dust exceeds rounding");
        assertEq(token.balanceOf(creator) - creatorTokBefore, 0, "creator received tokens");
        assertEq(token.balanceOf(address(curve)), 0, "curve emptied of tokens");
        uint256 feesHeld = curve.creatorFeesAccrued() + curve.platformFeesAccrued() - curve.creatorFeesClaimed()
            - curve.platformFeesClaimed();
        assertEq(usdg.balanceOf(address(curve)), feesHeld, "curve holds only unclaimed fees");
    }

    /// The mirror image: over-value the token. The LP token allocation used to
    /// come back to the creator; now the pool is re-priced and keeps it.
    function test_regression_preInitOtherDirection_lpTokensStayInThePool() public {
        _fillAlmost(curve, alice);
        (,, bool usdgIsToken1) = _order(address(token));
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        uint160 fair = _fairSqrtP(curve);
        uint160 hostile = usdgIsToken1 ? fair * 1000 : fair / 1000;
        address pool = _primePool(creator, address(token), hostile);

        uint256 creatorTokBefore = token.balanceOf(creator);
        _complete(curve, alice);

        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair);
        assertEq(token.balanceOf(creator) - creatorTokBefore, 0, "creator received LP tokens");
        assertGt(token.balanceOf(pool), tokensForLp * 999 / 1000, "pool holds < 99.9% of the LP tokens");
        assertGt(usdg.balanceOf(pool), usdgForLp * 999 / 1000, "pool holds < 99.9% of the USDG");
    }

    /// A hostile price *with liquidity behind it* cannot be re-priced for free,
    /// and is refused outright rather than minted against.
    function test_regression_hostilePriceWithLiquidity_graduationReverts() public {
        _buy(curve, creator, 50 * USDG_UNIT); // the creator's tokens for the mint
        _fillAlmost(curve, alice);
        (address t0, address t1, bool usdgIsToken1) = _order(address(token));
        uint160 fair = _fairSqrtP(curve);
        uint160 hostile = usdgIsToken1 ? fair / 1000 : fair * 1000;
        address pool = _primePool(creator, address(token), hostile);

        // The creator backs the price with a sliver of both sides.
        usdg.mint(creator, 10 * USDG_UNIT);
        vm.startPrank(creator);
        usdg.approve(address(pm), type(uint256).max);
        token.approve(address(pm), type(uint256).max);
        pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: usdgIsToken1 ? token.balanceOf(creator) : 10 * USDG_UNIT,
                amount1Desired: usdgIsToken1 ? 10 * USDG_UNIT : token.balanceOf(creator),
                amount0Min: 0,
                amount1Min: 0,
                recipient: creator,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(MockUniswapPool(pool).liquidity(), 0, "fixture: pool should be liquid");

        uint256 amount = 1_000 * USDG_UNIT;
        _fund(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        vm.expectRevert(abi.encodeWithSelector(GraduationManager.PoolPriceManipulated.selector, hostile, fair));
        curve.buy(amount, 0, block.timestamp);
        vm.stopPrank();

        assertFalse(curve.graduated());
        // Only what the creator's own mint put there, at most.
        assertLe(usdg.balanceOf(pool), 10 * USDG_UNIT, "pool received curve USDG");
    }
}
