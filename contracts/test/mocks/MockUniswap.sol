// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/**
 * Minimal Uniswap v3 stand-ins.
 *
 * These are for the atomicity and lock tests (T2.5, T2.7), where what matters is
 * the *sequence* of calls and what happens when one fails — not Uniswap's own
 * correctness. T2.4 ("fork test: full graduation against real Uniswap contracts")
 * is a different test and needs a fork RPC; it is not replaced by these.
 *
 * Each mock carries a failure switch so a step can be made to revert on demand.
 */
contract MockUniswapPool {
    uint160 public sqrtPriceX96;
    address public immutable token0;
    address public immutable token1;
    bool public failInitialize;

    constructor(address t0, address t1) {
        token0 = t0;
        token1 = t1;
    }

    function setFailInitialize(bool v) external {
        failInitialize = v;
    }

    function initialize(uint160 price) external {
        require(!failInitialize, "MockPool: initialize failed");
        sqrtPriceX96 = price;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
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
        return keccak256(abi.encode(a, b, fee));
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        require(!failCreate, "MockFactory: createPool failed");
        pool = address(new MockUniswapPool(tokenA, tokenB));
        pools[_key(tokenA, tokenB, fee)] = pool;
        lastPool = pool;
    }
}

contract MockPositionManager is ERC721 {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    mapping(uint256 => Position) public positionOf;
    mapping(uint256 => uint256) public owed0;
    mapping(uint256 => uint256) public owed1;

    uint256 public nextId = 1;
    bool public failMint;
    /// Leave this share of each amount unused, to exercise the dust sweep.
    uint256 public dustBps;

    constructor() ERC721("Mock Position", "MPOS") {}

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

    function mint(INonfungiblePositionManager.MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(!failMint, "MockPM: mint failed");

        amount0 = p.amount0Desired - (p.amount0Desired * dustBps / 10_000);
        amount1 = p.amount1Desired - (p.amount1Desired * dustBps / 10_000);

        IERC20(p.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(p.token1).safeTransferFrom(msg.sender, address(this), amount1);

        tokenId = nextId++;
        liquidity = uint128(_sqrt(amount0 * amount1));
        positionOf[tokenId] = Position(p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, liquidity);
        _mint(p.recipient, tokenId);
    }

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

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
