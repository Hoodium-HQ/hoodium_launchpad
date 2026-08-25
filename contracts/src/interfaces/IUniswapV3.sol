// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Minimal Uniswap v3 surface. Only what graduation needs.
 *
 * v3 rather than v4 — design.md section 8 open question 1: "v4 hooks would let
 * Auto LP logic live in the pool itself — strategically interesting, materially
 * more risk. v3 for v1."
 */
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function token0() external view returns (address);
    function token1() external view returns (address);

    /// In-range liquidity. Zero means no position is active at the current
    /// price — which is what a pool someone merely created + initialised has.
    function liquidity() external view returns (uint128);

    /**
     * The pool's swap. Graduation uses it for exactly one thing: moving the price
     * of a pre-initialised, zero-liquidity pool to the curve's closing price. With
     * no liquidity in range nothing is bought or sold — the price simply walks to
     * `sqrtPriceLimitX96` and the callback is invoked with zero deltas.
     */
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// Callback every v3 swap makes to `msg.sender` to collect payment.
interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

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
        );

    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    /// The overload that carries `data` through to `onERC721Received` — the LPLocker
    /// needs it to learn which token and beneficiary a position belongs to.
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external;
}
