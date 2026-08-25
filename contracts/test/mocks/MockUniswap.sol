// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager, IUniswapV3SwapCallback} from "../../src/interfaces/IUniswapV3.sol";

/**
 * Price-aware Uniswap v3 stand-ins.
 *
 * The first generation of these mocks ignored price entirely — `mint` took a
 * fixed share of both sides — which is exactly how the pre-initialised-pool
 * attack (AUDIT C1) went unnoticed by the suite. These reproduce the parts of
 * Uniswap that graduation's safety depends on:
 *
 *   - a pool has a `sqrtPriceX96`, in-range `liquidity`, and can be created and
 *     initialised by anyone at any price (that is the attack surface);
 *   - `mint` applies Uniswap's LiquidityAmounts maths for the full-range
 *     position [-887200, 887200] at the pool's current price, honours
 *     `amount*Min`, and moves the tokens into the pool;
 *   - `swap` on a pool with no in-range liquidity walks the price to the limit
 *     and calls back with zero deltas — the mechanism graduation uses to re-price
 *     a hostile empty pool; on a pool with liquidity it is a plain constant
 *     product over the pool's balances (a single full-range position *is* one),
 *     paid through the callback.
 *
 * They are still mocks: no ticks, no fee growth, no concentrated ranges. T2.4
 * (fork test against the real deployment, `ForkGraduation.t.sol`) is what proves
 * the real thing behaves the same way, and it is not replaced by these.
 *
 * Each carries a failure switch so a step can be made to revert on demand.
 */
contract MockUniswapPool {
    using SafeERC20 for IERC20;

    uint256 constant Q96 = 1 << 96;

    address public immutable token0;
    address public immutable token1;
    uint160 public sqrtPriceX96;
    uint128 public liquidity;
    bool public failInitialize;
    bool public failSwap;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function setFailInitialize(bool v) external {
        failInitialize = v;
    }

    function setFailSwap(bool v) external {
        failSwap = v;
    }

    function initialize(uint160 price) external {
        require(!failInitialize, "MockPool: initialize failed");
        require(sqrtPriceX96 == 0, "AI");
        sqrtPriceX96 = price;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }

    /// Called by the position manager after it has moved the tokens here.
    function addLiquidity(uint128 amount) external {
        liquidity += amount;
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        require(!failSwap, "MockPool: swap failed");
        require(amountSpecified != 0, "AS");
        require(sqrtPriceX96 != 0, "LOK");
        require(
            zeroForOne ? sqrtPriceLimitX96 < sqrtPriceX96 : sqrtPriceLimitX96 > sqrtPriceX96, "SPL"
        );

        if (liquidity == 0) {
            // Nothing in range: the price walks to the limit and nothing is owed.
            sqrtPriceX96 = sqrtPriceLimitX96;
            IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(0, 0, data);
            return (0, 0);
        }

        require(amountSpecified > 0, "MockPool: exact output unsupported");
        uint256 amountIn = uint256(amountSpecified);
        (address tokenIn, address tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);
        uint256 rIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 rOut = IERC20(tokenOut).balanceOf(address(this));
        uint256 amountOut = rOut - Math.mulDiv(rIn, rOut, rIn + amountIn, Math.Rounding.Ceil);

        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        (amount0, amount1) = zeroForOne
            ? (int256(amountIn), -int256(amountOut))
            : (-int256(amountOut), int256(amountIn));
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tokenIn).balanceOf(address(this)) >= rIn + amountIn, "IIA");

        // Re-derive the price from the balances: sqrt(bal1 / bal0) * 2^96.
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(b1, Q96, b0)) << 48);
    }
}

contract MockUniswapFactory {
    mapping(bytes32 => address) public pools;
    bool public failCreate;
    address public lastPool;

    function setFailCreate(bool v) external {
        failCreate = v;
    }

    function _key(address a, address b, uint24 fee) private pure returns (bytes32) {
        if (a > b) (a, b) = (b, a);
        return keccak256(abi.encode(a, b, fee));
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        require(!failCreate, "MockFactory: createPool failed");
        require(pools[_key(tokenA, tokenB, fee)] == address(0), "exists");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = address(new MockUniswapPool(t0, t1));
        pools[_key(tokenA, tokenB, fee)] = pool;
        lastPool = pool;
    }
}

contract MockPositionManager is ERC721 {
    using SafeERC20 for IERC20;

    uint256 constant Q96 = 1 << 96;
    // TickMath.getSqrtRatioAtTick(-887200) and (+887200): the full range at
    // tick spacing 200, which is what GraduationManager mints.
    uint160 public constant SQRT_LOWER = 4295343490;
    uint160 public constant SQRT_UPPER = 1461373636630004318706518188784493106690254656249;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    MockUniswapFactory public immutable factory;
    mapping(uint256 => Position) public positionOf;
    mapping(uint256 => uint256) public owed0;
    mapping(uint256 => uint256) public owed1;

    uint256 public nextId = 1;
    bool public failMint;
    /// Hold back this share of each side on top of what the price dictates, to
    /// exercise the dust path and its cap. Zero means Uniswap's own rounding.
    uint256 public dustBps;

    constructor(MockUniswapFactory factory_) ERC721("Mock Position", "MPOS") {
        factory = factory_;
    }

    function setFailMint(bool v) external {
        failMint = v;
    }

    function setDustBps(uint256 v) external {
        dustBps = v;
    }

    function creditFees(uint256 tokenId, uint256 a0, uint256 a1) external {
        owed0[tokenId] += a0;
        owed1[tokenId] += a1;
    }

    // ── LiquidityAmounts, full range ─────────────────────────────────────────

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
        require(!failMint, "MockPM: mint failed");
        require(p.tickLower == -887200 && p.tickUpper == 887200, "MockPM: full range only");
        require(block.timestamp <= p.deadline, "Transaction too old");

        MockUniswapPool pool = MockUniswapPool(factory.getPool(p.token0, p.token1, p.fee));
        require(address(pool) != address(0), "MockPM: no pool");
        uint160 sp = pool.sqrtPriceX96();
        require(sp != 0, "MockPM: not initialised");

        uint256 desired0 = p.amount0Desired - p.amount0Desired * dustBps / 10_000;
        uint256 desired1 = p.amount1Desired - p.amount1Desired * dustBps / 10_000;

        uint256 L;
        if (sp <= SQRT_LOWER) {
            L = _l0(SQRT_LOWER, SQRT_UPPER, desired0);
            amount0 = _a0(SQRT_LOWER, SQRT_UPPER, L);
        } else if (sp < SQRT_UPPER) {
            uint256 l0 = _l0(sp, SQRT_UPPER, desired0);
            uint256 l1 = _l1(SQRT_LOWER, sp, desired1);
            L = l0 < l1 ? l0 : l1;
            amount0 = _a0(sp, SQRT_UPPER, L);
            amount1 = _a1(SQRT_LOWER, sp, L);
        } else {
            L = _l1(SQRT_LOWER, SQRT_UPPER, desired1);
            amount1 = _a1(SQRT_LOWER, SQRT_UPPER, L);
        }
        if (amount0 > desired0) amount0 = desired0;
        if (amount1 > desired1) amount1 = desired1;
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "Price slippage check");
        require(L <= type(uint128).max, "L overflow");

        if (amount0 > 0) IERC20(p.token0).safeTransferFrom(msg.sender, address(pool), amount0);
        if (amount1 > 0) IERC20(p.token1).safeTransferFrom(msg.sender, address(pool), amount1);

        tokenId = nextId++;
        liquidity = uint128(L);
        positionOf[tokenId] = Position(p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, liquidity);
        pool.addLiquidity(liquidity);
        _mint(p.recipient, tokenId);
    }

    /// Fees are credited by tests with `creditFees` and paid from this
    /// contract's own balance, so a test funds it directly.
    function collect(INonfungiblePositionManager.CollectParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Position memory pos = positionOf[p.tokenId];
        amount0 = owed0[p.tokenId];
        amount1 = owed1[p.tokenId];
        owed0[p.tokenId] = 0;
        owed1[p.tokenId] = 0;

        if (amount0 > 0) IERC20(pos.token0).safeTransfer(p.recipient, amount0);
        if (amount1 > 0) IERC20(pos.token1).safeTransfer(p.recipient, amount1);
    }

    /// @dev Named returns assigned from storage directly: a `Position memory`
    ///      copy plus a 12-slot tuple overflows the stack on the legacy pipeline.
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
        tokensOwed0 = uint128(owed0[tokenId]);
        tokensOwed1 = uint128(owed1[tokenId]);
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
