// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {
    INonfungiblePositionManager,
    IUniswapV3Factory,
    IUniswapV3Pool,
    IUniswapV3SwapCallback
} from "../src/interfaces/IUniswapV3.sol";

interface IPMExt {
    function factory() external view returns (address);
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
}

/// Pays a real pool's swap callback.
contract Swapper is IUniswapV3SwapCallback {
    function swapExactIn(address pool, address tokenIn, bool zeroForOne, uint256 amountIn)
        external
        returns (uint256 amountOut)
    {
        (int256 a0, int256 a1) = IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
            abi.encode(tokenIn)
        );
        amountOut = uint256(-(zeroForOne ? a1 : a0));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        address tokenIn = abi.decode(data, (address));
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owed > 0) IERC20(tokenIn).transfer(msg.sender, uint256(owed));
    }
}

/**
 * T2.4 — the whole stack against the real Robinhood Chain Uniswap v3
 * deployment, launching through the factory and graduating through a real
 * completing buy.
 *
 *   forge test --match-contract ForkGraduation --fork-url https://rpc.mainnet.chain.robinhood.com -vv
 *
 * The pre-initialised-pool tests are the AUDIT C1 reproduction turned around:
 * they prime the real pool the way an attacker would and assert the migration
 * re-prices an empty pool, refuses a liquid one, and never hands the raise to
 * anyone. Skipped on any chain other than 4663.
 */
contract ForkGraduationTest is Test {
    address constant PM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint24 constant POOL_FEE = 10_000;
    int24 constant TICK_SPACING = 200;

    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;
    uint256 constant Q96 = 1 << 96;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address attacker = makeAddr("attacker");

    IUniswapV3Factory uniFactory;
    FeeVault vault;
    LPLocker locker;
    GraduationManager manager;
    HoodiumFactory factory;

    modifier onFork() {
        vm.skip(block.chainid != 4663);
        _;
    }

    function setUp() public {
        // Only meaningful on a Robinhood Chain fork; skipped elsewhere.
        if (block.chainid != 4663) return;
        uniFactory = IUniswapV3Factory(IPMExt(PM).factory());

        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        vault = new FeeVault(owners, 2);

        uint64 nonce = vm.getNonce(address(this));
        address predictedManager = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedFactory = vm.computeCreateAddress(address(this), nonce + 2);
        locker = new LPLocker(PM, address(vault), 3_000, predictedManager);
        manager =
            new GraduationManager(address(uniFactory), PM, address(locker), USDG, POOL_FEE, TICK_SPACING, predictedFactory);
        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: USDG,
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: 800_000_000 * TOKEN_UNIT,
                graduationTarget: 69_000 * USDG_UNIT,
                graduationFee: 0,
                tradeFeeBps: 100,
                creatorFeeShareBps: 7_000,
                creationFee: 0,
                devBuyMaxBps: 500,
                snipeBlocks: 3,
                snipeMaxBps: 100
            })
        );
        assertEq(address(factory), predictedFactory);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /// Launch until the token sorts on the requested side of USDG, so both
    /// token0/token1 orderings are exercised against the real pool.
    function _launchOrdered(bool tokenIsToken0) internal returns (HoodiumToken token, BondingCurve curve) {
        for (uint256 i = 0; i < 16; i++) {
            vm.prank(creator);
            (address t, address c) = factory.launch("Fork", "FORK", "ipfs://fork", 0, 0);
            if ((t < USDG) == tokenIsToken0) {
                vm.roll(block.number + 4);
                return (HoodiumToken(t), BondingCurve(c));
            }
        }
        revert("could not get the requested token ordering in 16 launches");
    }

    function _buy(BondingCurve curve, address who, uint256 usdgIn) internal returns (uint256 out) {
        deal(USDG, who, IERC20(USDG).balanceOf(who) + usdgIn, false);
        vm.startPrank(who);
        IERC20(USDG).approve(address(curve), usdgIn);
        out = curve.buy(usdgIn, 0, block.timestamp);
        vm.stopPrank();
    }

    function _fillAlmost(BondingCurve curve) internal {
        uint256 net = curve.remainingToTarget() - 1 * USDG_UNIT;
        _buy(curve, alice, net * 10_000 / 9_900);
        assertFalse(curve.curveComplete());
    }

    function _complete(BondingCurve curve) internal returns (address pool, uint256 tokenId) {
        _buy(curve, alice, 500 * USDG_UNIT);
        assertTrue(curve.graduated(), "completing buy did not graduate");
        return (curve.pool(), curve.lpTokenId());
    }

    /// What graduation will move, including what the completing buy still sells.
    function _lpAmounts(BondingCurve curve) internal view returns (uint256 usdgForLp, uint256 tokensForLp) {
        usdgForLp = curve.graduationTarget() - curve.graduationFee();
        uint256 sold = curve.tokensSold();
        if (!curve.graduated()) {
            (uint256 stillToSell,,,) = curve.quoteBuy(type(uint128).max);
            sold += stillToSell;
        }
        tokensForLp = curve.lpAllocation() + curve.curveAllocation() - sold;
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(amount1, Q96, amount0)) << 48);
    }

    function _fair(BondingCurve curve) internal view returns (uint160) {
        (uint256 u, uint256 t) = _lpAmounts(curve);
        return address(curve.token()) < USDG ? _sqrtPriceX96(t, u) : _sqrtPriceX96(u, t);
    }

    function _sorted(address token) internal pure returns (address t0, address t1) {
        return token < USDG ? (token, USDG) : (USDG, token);
    }

    function _prime(address token, uint160 price) internal returns (address pool) {
        (address t0, address t1) = _sorted(token);
        vm.prank(attacker);
        pool = IPMExt(PM).createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, price);
    }

    function _assertGraduatedWell(HoodiumToken token, BondingCurve curve, address pool, uint256 tokenId) internal {
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = INonfungiblePositionManager(PM).positions(tokenId);
        console2.log("pool", pool);
        console2.log("sqrtPriceX96", uint256(sqrtP));
        console2.log("tick", int256(tick));
        console2.log("liquidity", uint256(liq));
        console2.log("USDG in pool", IERC20(USDG).balanceOf(pool));
        console2.log("TOKEN in pool", token.balanceOf(pool));
        console2.log("USDG dust credited", manager.dustOf(USDG, creator));
        console2.log("TOKEN dust credited", manager.dustOf(address(token), creator));

        assertEq(tl, -887200);
        assertEq(tu, 887200);
        assertGt(liq, 0);
        assertEq(INonfungiblePositionManager(PM).ownerOf(tokenId), address(locker));
        assertEq(locker.beneficiaryOf(tokenId), creator);
        assertEq(locker.tokenOf(tokenId), address(token));

        // Everything landed in the pool bar rounding; nothing went to the creator.
        uint256 usdgForLp = curve.graduationTarget();
        assertGe(IERC20(USDG).balanceOf(pool), usdgForLp * 999 / 1000, "USDG not in pool");
        assertEq(IERC20(USDG).balanceOf(creator), 0, "creator received USDG");
        assertEq(token.balanceOf(creator), 0, "creator received tokens");
        assertLt(manager.dustOf(USDG, creator), usdgForLp / 1000, "USDG dust beyond rounding");
        assertEq(IERC20(USDG).balanceOf(address(manager)), manager.dustOf(USDG, creator));
        assertEq(IERC20(USDG).allowance(address(manager), PM), 0);
        assertEq(token.allowance(address(manager), PM), 0);
    }

    // ── happy path, both orderings ───────────────────────────────────────────

    function test_fork_tokenIsToken0() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        (address pool, uint256 tokenId) = _complete(curve);
        _assertGraduatedWell(token, curve, pool, tokenId);
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        assertApproxEqRel(uint256(sqrtP), uint256(fair), 1e12); // within 1e-6
        assertLt(tick, -300_000); // token0 = TOKEN: USDG per TOKEN is ~1e-16 raw
    }

    function test_fork_tokenIsToken1() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(false);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        (address pool, uint256 tokenId) = _complete(curve);
        _assertGraduatedWell(token, curve, pool, tokenId);
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        assertApproxEqRel(uint256(sqrtP), uint256(fair), 1e12);
        assertGt(tick, 300_000);
    }

    // ── AUDIT C1 on the real chain ───────────────────────────────────────────

    /// The pool is created and initialised BEFORE graduation at a price where
    /// TOKEN is 10,000x cheaper than the curve price. Used to send 99.99% of the
    /// raise to the creator; now the empty pool is re-priced and the raise lands.
    function test_fork_preInitialisedPool_tokenCheap_isRepriced() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(fair / 100));
        assertEq(IUniswapV3Pool(pool).liquidity(), 0);

        (address used, uint256 tokenId) = _complete(curve);
        assertEq(used, pool, "graduation should reuse the primed pool");
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertApproxEqRel(uint256(sqrtP), uint256(fair), 1e12, "price was not re-set by graduation");
        _assertGraduatedWell(token, curve, pool, tokenId);
    }

    /// The other direction: TOKEN 10,000x more expensive. Used to leave the pool
    /// nearly tokenless and hand 200M LP tokens to the creator; the attacker's
    /// dump then took ~68k USDG. Now: re-priced, and the dump gets a fair fill.
    function test_fork_preInitialisedPool_tokenExpensive_isRepriced() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 2_000 * USDG_UNIT); // early, cheap
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        address pool = _prime(address(token), uint160(fair * 100));

        (address used, uint256 tokenId) = _complete(curve);
        assertEq(used, pool);
        _assertGraduatedWell(token, curve, pool, tokenId);
        assertGe(token.balanceOf(pool), tokensForLp * 999 / 1000, "tokens not in pool");

        // The attacker sells everything they hold into the pool.
        Swapper s = new Swapper();
        vm.prank(attacker);
        token.transfer(address(s), attackerTokens);
        uint256 got = s.swapExactIn(pool, address(token), true, attackerTokens);
        console2.log("attacker sold tokens for USDG", got);
        // No more than a constant-product share of the real reserve. (An early
        // 2,000 USDG buy is ~8% of supply, so its fair exit is worth several
        // times the outlay — that is the curve. The attack was most of the raise
        // for a sliver of tokens.)
        uint256 bound = Math.mulDiv(usdgForLp, attackerTokens, tokensForLp + attackerTokens) + 1;
        assertLe(got, bound, "attacker took more than a constant-product share");
        assertLt(got, usdgForLp / 2, "attacker took most of the raise");
    }

    /// A hostile price *backed by liquidity* cannot be re-priced for free and
    /// is refused; the raise stays on the curve, which stays tradeable.
    function test_fork_preInitialisedPoolWithLiquidity_reverts() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 500 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        uint160 hostile = uint160(fair / 100);
        address pool = _prime(address(token), hostile);

        // Attacker mints a full-range position at the hostile price.
        deal(USDG, attacker, 50 * USDG_UNIT, false);
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        IERC20(USDG).approve(PM, type(uint256).max);
        INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(token),
                token1: USDG,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: attackerTokens,
                amount1Desired: 50 * USDG_UNIT,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(IUniswapV3Pool(pool).liquidity(), 0, "fixture: pool should be liquid");

        uint256 reserveBefore = curve.reserveUsdg();
        deal(USDG, alice, 500 * USDG_UNIT, false);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(curve), 500 * USDG_UNIT);
        vm.expectRevert(abi.encodeWithSelector(GraduationManager.PoolPriceManipulated.selector, hostile, fair));
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();

        assertFalse(curve.graduated());
        assertEq(curve.reserveUsdg(), reserveBefore);
        assertEq(IERC20(USDG).balanceOf(pool), IERC20(USDG).balanceOf(pool)); // nothing from the curve
        assertLt(IERC20(USDG).balanceOf(pool), 100 * USDG_UNIT, "curve USDG reached the pool");
    }

    /// An out-of-range position sitting in the path between the primed price
    /// and the fair one: `liquidity()` is zero, but the re-pricing swap would
    /// have to buy through it. The manager refuses to pay, so the buy reverts.
    function test_fork_outOfRangeLiquidityInThePath_reverts() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 500 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(fair / 100)); // price must rise to reach fair
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();

        // A token0-only position just above the current price, well below fair.
        int24 lower = ((tick / TICK_SPACING) + 2) * TICK_SPACING;
        int24 upper = lower + 4 * TICK_SPACING;
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(token),
                token1: USDG,
                fee: POOL_FEE,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: attackerTokens,
                amount1Desired: 0,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertEq(IUniswapV3Pool(pool).liquidity(), 0, "fixture: nothing should be in range");

        deal(USDG, alice, 500 * USDG_UNIT, false);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(curve), 500 * USDG_UNIT);
        vm.expectPartialRevert(GraduationManager.UnexpectedSwapPayment.selector);
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());
    }

    /// Liquidity already at (near) the fair price is simply joined.
    function test_fork_preInitialisedPoolInsideTheBand_isAccepted() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 500 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(uint256(fair) * 10_010 / 10_000));

        deal(USDG, attacker, 50 * USDG_UNIT, false);
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        IERC20(USDG).approve(PM, type(uint256).max);
        INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(token),
                token1: USDG,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: attackerTokens,
                amount1Desired: 50 * USDG_UNIT,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(IUniswapV3Pool(pool).liquidity(), 0);

        (address used, uint256 tokenId) = _complete(curve);
        assertEq(used, pool);
        assertEq(INonfungiblePositionManager(PM).ownerOf(tokenId), address(locker));
        assertGe(IERC20(USDG).balanceOf(pool), curve.graduationTarget() * 99 / 100);
    }

    /// AUDIT M1 on the real chain: nobody but a factory curve can drive the manager.
    function test_fork_migrate_rejectsStrangers() public onFork {
        (HoodiumToken token,) = _launchOrdered(true);
        vm.prank(attacker);
        vm.expectRevert(GraduationManager.NotACurve.selector);
        manager.migrate(address(token), 1, 1, attacker);
    }
}
