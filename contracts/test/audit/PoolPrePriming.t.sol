// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {MockUniswapPool} from "../mocks/MockUniswap.sol";
import {INonfungiblePositionManager, IUniswapV3SwapCallback} from "../../src/interfaces/IUniswapV3.sol";

/// A trader that pays the pool's swap callback — an arbitrageur, or an attacker
/// dumping into a mispriced pool.
contract Trader is IUniswapV3SwapCallback {
    function swapExactIn(address pool, address tokenIn, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        (int256 a0, int256 a1) = MockUniswapPool(pool).swap(
            address(this), zeroForOne, int256(amountIn), zeroForOne ? 4295128740 : type(uint160).max - 1, abi.encode(tokenIn)
        );
        amountOut = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        address tokenIn = abi.decode(data, (address));
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        IERC20(tokenIn).transfer(msg.sender, uint256(owed));
    }
}

/**
 * AUDIT C1 — pool pre-priming at graduation, third-party variant.
 *
 * Originally: anyone who knew the token address (it is in `TokenLaunched`)
 * could create and initialise the pool at 10^6x the fair token price; the
 * full-range mint then took ~all the USDG and ~0.1% of the tokens, 99.9% of the
 * LP allocation went to the creator as "dust", and the attacker sold the few
 * tokens they had bought on the curve into the near-tokenless pool for most of
 * the reserve. The other direction handed the USDG reserve to the creator.
 *
 * Now regressions: an empty primed pool is re-priced; a liquid one is refused
 * until its price is back within the band — and because a mispriced liquid
 * pool is an arbitrage, that is something anyone can and will do.
 */
contract PoolPrePrimingTest is BaseTest {
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

    /// `tokenExpensive` = true makes TOKEN 1e6x dearer than fair; false, 1e6x cheaper.
    function _hostilePrice(bool tokenExpensive) internal view returns (uint160) {
        (,, bool usdgIsToken1) = _order(address(token));
        uint160 fair = _fairSqrtP(curve);
        // price = token1/token0; TOKEN dear means high price if TOKEN is token0, low if token1.
        bool up = usdgIsToken1 == tokenExpensive;
        return up ? fair * 1000 : fair / 1000;
    }

    /// Control: with a fresh pool the manager sets the fair price and both sides land in the pool.
    function test_audit_control_freshPoolUsesBothSides() public {
        _fillAlmost(curve, alice);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);

        (address pool,) = _complete(curve, alice);

        // Not exact: _sqrtPriceX96 drops ~48 bits, so a few micro-USDG round off as dust.
        assertGt(usdg.balanceOf(pool), usdgForLp * 9999 / 10000, "~all usdg in pool");
        assertGt(token.balanceOf(pool), tokensForLp * 9999 / 10000, "~all tokens in pool");
        assertEq(usdg.balanceOf(creator), 0, "creator got USDG");
        assertLt(manager.dustOf(address(usdg), creator), usdgForLp / 10000, "more than rounding dust");
    }

    /**
     * Former attack: a third party buys a little on the curve, then initialises
     * the pool at 1,000,000x the fair token price. Now the manager re-prices the
     * empty pool, both sides land in it, and the attacker's dump is priced at
     * the closing price against the whole reserve — a constant-product trade
     * that cannot take more than their share.
     */
    function test_regression_prePrimedPool_thirdPartyCannotDrainReserve() public {
        _buy(curve, attacker, 2_000 * USDG_UNIT);
        _fillAlmost(curve, alice);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        uint160 fair = _fairSqrtP(curve);

        address pool = _primePool(attacker, address(token), _hostilePrice(true));

        // Graduation is permissionless; the attacker triggers it.
        _complete(curve, attacker);

        assertEq(MockUniswapPool(pool).sqrtPriceX96(), fair, "pool not re-priced");
        assertGt(usdg.balanceOf(pool), usdgForLp * 999 / 1000, "pool missing USDG");
        assertGt(token.balanceOf(pool), tokensForLp * 999 / 1000, "pool missing tokens");
        assertEq(token.balanceOf(creator), 0, "LP allocation handed to creator as dust");

        // The dump: everything the attacker holds, into the pool.
        (,, bool usdgIsToken1) = _order(address(token));
        uint256 attackerTokens = token.balanceOf(attacker);
        Trader t = new Trader();
        vm.prank(attacker);
        token.transfer(address(t), attackerTokens);
        uint256 out = t.swapExactIn(pool, address(token), usdgIsToken1, attackerTokens);

        // Bounded by constant product over the real reserve: no more than their
        // proportional share. (2,000 USDG at the opening price is ~8% of supply,
        // so an early buyer's *fair* exit is worth several times their outlay —
        // that is the curve, not the attack. The attack was taking most of the
        // raise for a sliver of tokens.)
        uint256 bound = Math.mulDiv(usdgForLp, attackerTokens, tokensForLp + attackerTokens) + 1;
        assertLe(out, bound, "attacker took more than a constant-product share");
        assertLt(out, usdgForLp / 2, "attacker took most of the reserve");
        assertGt(usdg.balanceOf(pool), usdgForLp / 2, "pool drained");
    }

    /// Former attack: the pool pre-priced the other way (token extremely cheap)
    /// sent the USDG "dust" to the creator. Now it is re-priced and the creator
    /// receives nothing.
    function test_regression_prePrimedPool_creatorReceivesNoReserveAsDust() public {
        _fillAlmost(curve, alice);
        (uint256 usdgForLp,) = _lpAmounts(curve);

        address pool = _primePool(creator, address(token), _hostilePrice(false));
        _complete(curve, bob);

        assertEq(usdg.balanceOf(creator), 0, "creator pocketed USDG");
        assertLt(manager.dustOf(address(usdg), creator), usdgForLp / 10000, "USDG credited beyond rounding");
        assertGt(usdg.balanceOf(pool), usdgForLp * 999 / 1000, "pool is under-funded");
    }

    /**
     * The residual: a primed pool *with liquidity* at a hostile price blocks the
     * completing buy (`PoolPriceManipulated`) — but only until someone takes the
     * arbitrage the attacker has put on the table. Once the price is back inside
     * the band, graduation goes through and the attacker's liquidity sits in the
     * pool at the fair price like anyone else's.
     */
    function test_regression_prePrimedLiquidPool_blocksOnlyUntilArbitraged() public {
        _buy(curve, attacker, 500 * USDG_UNIT);
        _fillAlmost(curve, alice);
        uint160 fair = _fairSqrtP(curve);
        (address t0, address t1, bool usdgIsToken1) = _order(address(token));

        // Token priced 4x above fair (2x on the square root), backed by liquidity.
        uint160 hostile = usdgIsToken1 ? fair * 2 : fair / 2;
        address pool = _primePool(attacker, address(token), hostile);
        _mintFullRange(attacker, pool, t0, t1, usdgIsToken1, 200 * USDG_UNIT);
        assertGt(MockUniswapPool(pool).liquidity(), 0);

        // Blocked.
        uint256 amount = 1_000 * USDG_UNIT;
        _fund(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        vm.expectRevert(abi.encodeWithSelector(GraduationManager.PoolPriceManipulated.selector, hostile, fair));
        curve.buy(amount, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());

        // An arbitrageur sells tokens into the over-priced pool until it sits at
        // the fair price: with reserves (b0, b1), k = b0·b1 and a target price
        // p* = (fair/2^96)^2, the new token0 reserve is sqrt(k / p*).
        _arbToPrice(pool, t0, t1, fair);
        uint160 landed = MockUniswapPool(pool).sqrtPriceX96();
        assertApproxEqRel(uint256(landed), uint256(fair), 2e15, "arb did not land inside the band");

        // Unblocked. The completing buy graduates into the now fairly priced pool.
        (uint256 usdgForLp,) = _lpAmounts(curve);
        (address used,) = _complete(curve, alice);
        assertEq(used, pool);
        assertGe(usdg.balanceOf(pool), usdgForLp, "pool holds less than the raise");
    }

    function _mintFullRange(address who, address pool, address t0, address t1, bool usdgIsToken1, uint256 usdgAmt)
        internal
    {
        uint256 price = uint256(MockUniswapPool(pool).sqrtPriceX96());
        uint256 tokAmt = usdgIsToken1 ? usdgAmt * Q96 / price * Q96 / price : usdgAmt * price / Q96 * price / Q96;
        usdg.mint(who, usdgAmt);
        (uint256 a0, uint256 a1) = usdgIsToken1 ? (tokAmt, usdgAmt) : (usdgAmt, tokAmt);
        vm.startPrank(who);
        usdg.approve(address(pm), type(uint256).max);
        token.approve(address(pm), type(uint256).max);
        pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: who,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    function _arbToPrice(address pool, address t0, address t1, uint160 target) internal {
        uint256 b0 = IERC20(t0).balanceOf(pool);
        uint256 b1 = IERC20(t1).balanceOf(pool);
        // b0' = sqrt(k) · 2^96 / target  (k = b0 · b1)
        uint256 sqrtK = Math.sqrt(b0 * b1);
        uint256 b0Target = Math.mulDiv(sqrtK, Q96, target);
        Trader t = new Trader();
        if (b0Target > b0) {
            // Price must fall: sell token0 in.
            uint256 amountIn = b0Target - b0;
            deal(t0, address(t), amountIn);
            t.swapExactIn(pool, t0, true, amountIn);
        } else {
            uint256 b1Target = Math.mulDiv(sqrtK, target, Q96);
            uint256 amountIn = b1Target - b1;
            deal(t1, address(t), amountIn);
            t.swapExactIn(pool, t1, false, amountIn);
        }
    }
}
