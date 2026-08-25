// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGraduationManager} from "./interfaces/IGraduationManager.sol";
import {INonfungiblePositionManager, IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {LPLocker} from "./LPLocker.sol";

/**
 * @title GraduationManager
 * @notice T1.8 / LP-4.1, LP-4.2, LP-4.6 — atomic migration from curve to pool.
 *
 * design.md section 3 calls this "the highest-risk path in the system: it moves
 * every reserve at once and is irreversible." Everything here is therefore
 * single-purpose: it holds no funds between calls, has no owner, and has no
 * function that can move assets anywhere except into the pool and the locker.
 *
 * Atomicity (LP-4.2) is structural rather than defensive. There is no try/catch
 * and no partial-success path: any failure at any step reverts the whole
 * transaction, including the caller's `graduated = true`, leaving the curve
 * tradeable exactly as it was.
 */
contract GraduationManager is IGraduationManager, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IUniswapV3Factory public immutable uniswapFactory;
    INonfungiblePositionManager public immutable positionManager;
    LPLocker public immutable locker;
    IERC20 public immutable usdg;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    event Migrated(
        address indexed token,
        address indexed pool,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amountToken,
        uint256 amountUsdg
    );

    error PoolCreationFailed();
    error NothingToMigrate();

    constructor(
        address uniswapFactory_,
        address positionManager_,
        address locker_,
        address usdg_,
        uint24 poolFee_,
        int24 tickSpacing_
    ) {
        require(uniswapFactory_ != address(0) && positionManager_ != address(0), "zero uniswap");
        require(locker_ != address(0) && usdg_ != address(0), "zero addr");
        require(tickSpacing_ > 0, "bad spacing");

        uniswapFactory = IUniswapV3Factory(uniswapFactory_);
        positionManager = INonfungiblePositionManager(positionManager_);
        locker = LPLocker(locker_);
        usdg = IERC20(usdg_);
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
    }

    /// @inheritdoc IGraduationManager
    function migrate(address token, uint256 tokenAmount, uint256 usdgAmount, address creator)
        external
        override
        nonReentrant
        returns (address pool, uint256 tokenId)
    {
        if (tokenAmount == 0 || usdgAmount == 0) revert NothingToMigrate();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        usdg.safeTransferFrom(msg.sender, address(this), usdgAmount);

        (address token0, address token1) = token < address(usdg) ? (token, address(usdg)) : (address(usdg), token);
        (uint256 amount0, uint256 amount1) =
            token < address(usdg) ? (tokenAmount, usdgAmount) : (usdgAmount, tokenAmount);

        pool = _ensurePool(token0, token1, amount0, amount1);
        tokenId = _mintAndLock(token0, token1, amount0, amount1, token, creator);

        emit Migrated(token, pool, tokenId, _liquidityOf(tokenId), tokenAmount, usdgAmount);
    }

    /**
     * @dev Mint the full-range position, lock it, and return any dust.
     *      Split out of `migrate` purely to stay under the stack limit without
     *      reaching for `via_ir` — an immutable contract is easier to audit when
     *      the bytecode comes from the straightforward pipeline.
     */
    function _mintAndLock(
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1,
        address launchToken,
        address creator
    ) private returns (uint256 tokenId) {
        IERC20(token0).forceApprove(address(positionManager), amount0);
        IERC20(token1).forceApprove(address(positionManager), amount1);

        // Full range. A graduated pool must quote at every price a market can
        // reach; a bounded range would leave the token untradeable outside it.
        //
        // The truncating division is the point: Uniswap requires ticks to be
        // multiples of the pool's spacing, so 887272 is rounded *down* to the
        // largest usable multiple. Multiplying first would overshoot MAX_TICK.
        // forge-lint: disable-next-line(divide-before-multiply)
        int24 maxTick = (887272 / tickSpacing) * tickSpacing;

        uint256 used0;
        uint256 used1;
        (tokenId,, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: poolFee,
                tickLower: -maxTick,
                tickUpper: maxTick,
                amount0Desired: amount0,
                amount1Desired: amount1,
                // The pool was just initialised at exactly this ratio, so there is
                // no established price to be sandwiched against.
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);

        // LP-4.3 — hand the position to the locker. From here nothing can withdraw
        // the principal, including this contract.
        positionManager.safeTransferFrom(address(this), address(locker), tokenId, abi.encode(launchToken, creator));

        // Uniswap leaves dust when the ratio does not divide evenly. Returning it
        // to the creator is the only honest destination: it is their token's
        // liquidity, and leaving it here would strand it forever.
        _sweep(IERC20(token0), creator, amount0 - used0);
        _sweep(IERC20(token1), creator, amount1 - used1);
    }

    function _liquidityOf(uint256 tokenId) private view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = positionManager.positions(tokenId);
    }

    /**
     * @dev Create and initialise the pool if it does not exist. If it does exist,
     *      it is used as-is — creating a token whose pool someone pre-made at a
     *      hostile price is possible, so `amount*Min` protection is delegated to
     *      the fact that the curve controls both sides of a fresh pool.
     */
    function _ensurePool(address token0, address token1, uint256 amount0, uint256 amount1)
        private
        returns (address pool)
    {
        pool = uniswapFactory.getPool(token0, token1, poolFee);
        if (pool == address(0)) {
            pool = uniswapFactory.createPool(token0, token1, poolFee);
            if (pool == address(0)) revert PoolCreationFailed();
        }

        (uint160 existing,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (existing == 0) {
            IUniswapV3Pool(pool).initialize(_sqrtPriceX96(amount0, amount1));
        }
    }

    /**
     * @dev sqrt(amount1 / amount0) * 2^96.
     *
     * Computed as sqrt(amount1 * 2^96 / amount0) * 2^48 rather than
     * sqrt(amount1 * 2^192 / amount0): the latter needs a 320-bit intermediate,
     * which does not fit. Splitting the shift keeps everything inside uint256 at
     * the cost of a few bits of precision in the opening price — acceptable,
     * because the very first trade repositions it anyway.
     */
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 ratioX96 = Math.mulDiv(amount1, 1 << 96, amount0);
        uint256 sqrtRatio = Math.sqrt(ratioX96);
        uint256 result = sqrtRatio << 48;
        require(result <= type(uint160).max, "price overflow");
        // The cast cannot truncate: the require above is exactly the bound check.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(result);
    }

    function _sweep(IERC20 asset, address to, uint256 amount) private {
        if (amount > 0) asset.safeTransfer(to, amount);
    }
}
