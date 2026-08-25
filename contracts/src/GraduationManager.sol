// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGraduationManager, IHoodiumFactory} from "./interfaces/IGraduationManager.sol";
import {
    INonfungiblePositionManager,
    IUniswapV3Factory,
    IUniswapV3Pool,
    IUniswapV3SwapCallback
} from "./interfaces/IUniswapV3.sol";
import {LPLocker} from "./LPLocker.sol";
import {BondingCurve} from "./BondingCurve.sol";

/**
 * @title GraduationManager
 * @notice T1.8 / LP-4.1, LP-4.2, LP-4.6 — atomic migration from curve to pool.
 *
 * design.md section 3 calls this "the highest-risk path in the system: it moves
 * every reserve at once and is irreversible." Everything here is therefore
 * single-purpose: it has no owner, and it has no function that can move assets
 * anywhere except into the pool, into the locker, or back to the creator whose
 * curve left them here (see "Dust" below).
 *
 * Atomicity (LP-4.2) is structural rather than defensive. There is no try/catch
 * and no partial-success path: any failure at any step reverts the whole
 * transaction, including the caller's `graduated = true`, leaving the curve
 * tradeable exactly as it was.
 *
 * ── Who may call (AUDIT M1) ──────────────────────────────────────────────────
 * Only a curve this manager's `factory` deployed for `token`. The check is
 * `factory.curveOf(token) == msg.sender`, so a look-alike curve pointed at the
 * real manager, or anyone holding a few tokens, cannot create and price the real
 * token's pool "through" the trusted manager, nor lock a position labelled with
 * a token they do not own. The factory address is an immutable set at
 * construction — the factory does not exist yet when the manager is deployed,
 * so the deploy script precomputes it from the deployer's nonce and the factory
 * verifies the pairing in its own constructor.
 *
 * ── The pre-initialised pool (AUDIT C1) ──────────────────────────────────────
 * Creating and initialising a Uniswap v3 pool is permissionless and needs no
 * tokens; the token address is public from `TokenLaunched`. So by the time the
 * curve graduates, the pool may already exist at any price of an attacker's
 * choosing. A full-range mint against a hostile price consumes one side almost
 * entirely and leaves the other side unused — which, if that leftover is handed
 * to anyone, is the raise walking out of the door.
 *
 * Three rules make that impossible here:
 *
 *   1. A pre-existing pool with **no liquidity in range** is re-priced to the
 *      curve's closing price with a zero-liquidity `swap` before the mint. With
 *      nothing in range Uniswap moves the price without moving a token; the swap
 *      callback below refuses to pay anything, so if the price *cannot* be moved
 *      for free the migration reverts rather than spending the raise.
 *   2. A pre-existing pool **with liquidity** must already sit within
 *      `SQRT_PRICE_BAND_BPS` of the closing price, or the migration reverts with
 *      `PoolPriceManipulated`. A mispriced pool with liquidity is an arbitrage
 *      opportunity by construction — whoever takes it moves the price back into
 *      the band and graduation can proceed — so the worst an attacker can do is
 *      delay, at their own cost.
 *   3. The mint demands at least `MIN_FILL_BPS` of **both** sides be consumed.
 *      This is defence in depth: after 1 and 2 the price is right, so a mint
 *      that still leaves more than 1% behind is a sign something else is wrong.
 *
 * ── Dust ─────────────────────────────────────────────────────────────────────
 * Uniswap leaves a little of one side unused when the ratio does not divide
 * exactly (and `_sqrtPriceX96` drops a few bits of precision). It is bounded by
 * rule 3 above, and it is never *pushed* anywhere during graduation: pushing
 * USDG to a third party inside `migrate` would let a frozen or reverting
 * recipient block graduation forever (USDG is pausable and freezable, AUDIT M2).
 * Instead the leftover is credited to the creator in `dustOf` and they pull it
 * whenever they like. This is the only balance the manager ever holds between
 * calls, and the only path out of it is `pullDust` by the address it is owed to.
 */
contract GraduationManager is IGraduationManager, IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    /// TickMath.MIN_SQRT_RATIO / MAX_SQRT_RATIO. A swap's price limit must lie
    /// strictly inside these; so must any price this contract initialises at.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /**
     * How far a pre-existing pool's price may sit from the curve's closing price
     * and still be accepted, in basis points of `sqrtPriceX96`. 25 bps on the
     * square root is ~50 bps (0.5%) on the price itself. Tight on purpose: the
     * closing price is known exactly, so the only reason a liquid pool would be
     * further away is that somebody put it there.
     */
    uint256 public constant SQRT_PRICE_BAND_BPS = 25;

    /// The mint must consume at least this share of each side (99%).
    uint256 public constant MIN_FILL_BPS = 9_900;

    IUniswapV3Factory public immutable uniswapFactory;
    INonfungiblePositionManager public immutable positionManager;
    LPLocker public immutable locker;
    IERC20 public immutable usdg;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    /// @inheritdoc IGraduationManager
    address public immutable override factory;

    /// asset => creator => leftover from that creator's graduation, pullable.
    mapping(address => mapping(address => uint256)) public dustOf;

    /// The pool being re-priced, set only for the duration of the swap so the
    /// callback can verify its caller. Zero at rest.
    address private _repricing;

    event Migrated(
        address indexed token,
        address indexed pool,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amountToken,
        uint256 amountUsdg
    );
    event PoolRepriced(address indexed pool, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96);
    event DustAccrued(address indexed asset, address indexed creator, uint256 amount);
    event DustPulled(address indexed asset, address indexed creator, uint256 amount);

    error NotACurve();
    error PoolCreationFailed();
    error NothingToMigrate();
    error PoolPriceManipulated(uint160 have, uint160 want);
    error PriceOutOfRange(uint160 sqrtPriceX96);
    error RepriceFailed(uint160 have, uint160 want);
    error UnexpectedSwapCallback();
    error UnexpectedSwapPayment(int256 amount0Delta, int256 amount1Delta);
    error ExcessiveDust(address asset, uint256 leftover, uint256 desired);
    error NothingToPull();

    constructor(
        address uniswapFactory_,
        address positionManager_,
        address locker_,
        address usdg_,
        uint24 poolFee_,
        int24 tickSpacing_,
        address factory_
    ) {
        require(uniswapFactory_ != address(0) && positionManager_ != address(0), "zero uniswap");
        require(locker_ != address(0) && usdg_ != address(0), "zero addr");
        require(factory_ != address(0), "zero factory");
        require(tickSpacing_ > 0, "bad spacing");
        // The locker was deployed with this manager's precomputed address. If the
        // nonces were miscounted, fail here rather than at the first graduation.
        require(LPLocker(locker_).graduationManager() == address(this), "locker/manager mismatch");

        uniswapFactory = IUniswapV3Factory(uniswapFactory_);
        positionManager = INonfungiblePositionManager(positionManager_);
        locker = LPLocker(locker_);
        usdg = IERC20(usdg_);
        poolFee = poolFee_;
        tickSpacing = tickSpacing_;
        factory = factory_;
    }

    /// @inheritdoc IGraduationManager
    function migrate(address token, uint256 tokenAmount, uint256 usdgAmount, address creator)
        external
        override
        nonReentrant
        returns (address pool, uint256 tokenId)
    {
        // AUDIT M1 — only the factory's own curve for this token.
        if (IHoodiumFactory(factory).curveOf(token) != msg.sender) revert NotACurve();
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
     * @notice The sqrtPriceX96 `migrate` will open the pool at — or, for a
     *         pre-existing liquid pool, require it to sit within
     *         `SQRT_PRICE_BAND_BPS` of — if `curve` completed right now.
     * @dev View only; nothing here is trusted by `migrate`, which recomputes the
     *      same number from the amounts the curve actually hands over. It exists
     *      so a periphery contract (`GraduationHelper`) or a keeper can move a
     *      griefed pool to exactly this price before the completing buy. The
     *      completing buy's own token output is included via `quoteBuy`, so the
     *      result already reflects what the curve will still sell; a graduated
     *      curve reports the price it actually migrated at.
     */
    function targetSqrtPriceX96(address curve) external view returns (uint160) {
        BondingCurve c = BondingCurve(curve);
        uint256 usdgForLp = c.graduationTarget() - c.graduationFee();
        uint256 sold = c.tokensSold();
        if (!c.graduated()) {
            (uint256 stillToSell,,,) = c.quoteBuy(type(uint128).max);
            sold += stillToSell;
        }
        uint256 tokensForLp = c.lpAllocation() + c.curveAllocation() - sold;
        return address(c.token()) < address(usdg)
            ? _sqrtPriceX96(tokensForLp, usdgForLp)
            : _sqrtPriceX96(usdgForLp, tokensForLp);
    }

    /// @notice Whether a liquid pool at `current` would be accepted by `migrate`
    ///         for a curve whose target is `target` (AUDIT C1, rule 2).
    function isWithinBand(uint160 current, uint160 target) external pure returns (bool) {
        uint256 lo = Math.mulDiv(target, BPS - SQRT_PRICE_BAND_BPS, BPS);
        uint256 hi = Math.mulDiv(target, BPS + SQRT_PRICE_BAND_BPS, BPS, Math.Rounding.Ceil);
        return current >= lo && current <= hi;
    }

    /**
     * @notice Withdraw the leftover from a graduation that was credited to the
     *         caller. Anyone may call; it only ever pays what `dustOf` says the
     *         caller is owed.
     */
    function pullDust(address asset) external nonReentrant returns (uint256 amount) {
        amount = dustOf[asset][msg.sender];
        if (amount == 0) revert NothingToPull();
        dustOf[asset][msg.sender] = 0;
        IERC20(asset).safeTransfer(msg.sender, amount);
        emit DustPulled(asset, msg.sender, amount);
    }

    /**
     * @notice Uniswap's payment hook for the re-pricing swap.
     * @dev Only the pool currently being re-priced may call it, and only with
     *      nothing to pay. A zero-liquidity swap owes nothing; if Uniswap asks for
     *      a positive delta the pool had liquidity in the way after all, and the
     *      right answer is to refuse rather than spend the raise.
     */
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external view override {
        if (_repricing == address(0) || msg.sender != _repricing) revert UnexpectedSwapCallback();
        if (amount0Delta > 0 || amount1Delta > 0) revert UnexpectedSwapPayment(amount0Delta, amount1Delta);
    }

    /**
     * @dev Mint the full-range position, lock it, and credit any dust.
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
                // AUDIT C1, rule 3 — the pool is at the closing price by now, so
                // both sides must go in nearly whole.
                amount0Min: Math.mulDiv(amount0, MIN_FILL_BPS, BPS),
                amount1Min: Math.mulDiv(amount1, MIN_FILL_BPS, BPS),
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);

        // LP-4.3 — hand the position to the locker. From here nothing can withdraw
        // the principal, including this contract.
        positionManager.safeTransferFrom(address(this), address(locker), tokenId, abi.encode(launchToken, creator));

        _accrueDust(token0, creator, amount0, used0);
        _accrueDust(token1, creator, amount1, used1);
    }

    /**
     * @dev Belt and braces over `amount*Min`: the mint cannot have left more
     *      than 1% behind, and if it somehow did the migration is wrong, not the
     *      dust. What it did leave is credited, never pushed (AUDIT M2).
     */
    function _accrueDust(address asset, address creator, uint256 desired, uint256 used) private {
        uint256 leftover = desired - used;
        if (leftover == 0) return;
        if (leftover > desired - Math.mulDiv(desired, MIN_FILL_BPS, BPS)) {
            revert ExcessiveDust(asset, leftover, desired);
        }
        dustOf[asset][creator] += leftover;
        emit DustAccrued(asset, creator, leftover);
    }

    function _liquidityOf(uint256 tokenId) private view returns (uint128 liquidity) {
        (,,,,,,, liquidity,,,,) = positionManager.positions(tokenId);
    }

    /**
     * @dev Create the pool if needed and make sure it sits at the curve's closing
     *      price before anything is minted (AUDIT C1, rules 1 and 2).
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

        uint160 target = _sqrtPriceX96(amount0, amount1);
        if (target <= MIN_SQRT_RATIO || target >= MAX_SQRT_RATIO) revert PriceOutOfRange(target);

        (uint160 current,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (current == 0) {
            IUniswapV3Pool(pool).initialize(target);
            return pool;
        }
        if (current == target) return pool;

        if (IUniswapV3Pool(pool).liquidity() == 0) {
            _reprice(pool, current, target);
            return pool;
        }

        _requireWithinBand(current, target);
    }

    /**
     * @dev Move an empty pool's price to `target` with a swap that trades nothing.
     *
     *      With no liquidity in range Uniswap's swap loop advances the price to the
     *      limit without any amount changing hands, and calls back with zero
     *      deltas. `amountSpecified` must be non-zero for the call to be accepted
     *      and is otherwise irrelevant; 1 wei of exact input is never consumed.
     *
     *      If a position *is* in the way — liquidity out of range at the current
     *      price but inside the path to the target — the swap will ask the
     *      callback to pay, the callback refuses, and the migration reverts. That
     *      is the correct outcome: the raise is not spent clearing an attacker's
     *      order, and the order is an arbitrage anyone can take to unblock it.
     */
    function _reprice(address pool, uint160 current, uint160 target) private {
        bool zeroForOne = target < current;

        _repricing = pool;
        (int256 amount0, int256 amount1) = IUniswapV3Pool(pool).swap(address(this), zeroForOne, 1, target, "");
        _repricing = address(0);

        if (amount0 != 0 || amount1 != 0) revert UnexpectedSwapPayment(amount0, amount1);
        (uint160 landed,,,,,,) = IUniswapV3Pool(pool).slot0();
        if (landed != target) revert RepriceFailed(landed, target);

        emit PoolRepriced(pool, current, target);
    }

    function _requireWithinBand(uint160 current, uint160 target) private pure {
        uint256 lo = Math.mulDiv(target, BPS - SQRT_PRICE_BAND_BPS, BPS);
        uint256 hi = Math.mulDiv(target, BPS + SQRT_PRICE_BAND_BPS, BPS, Math.Rounding.Ceil);
        if (current < lo || current > hi) revert PoolPriceManipulated(current, target);
    }

    /**
     * @dev sqrt(amount1 / amount0) * 2^96.
     *
     * Computed as sqrt(amount1 * 2^96 / amount0) * 2^48 rather than
     * sqrt(amount1 * 2^192 / amount0): the latter needs a 320-bit intermediate,
     * which does not fit. Splitting the shift keeps everything inside uint256 at
     * the cost of a few bits of precision in the opening price — acceptable,
     * because the very first trade repositions it anyway, and the resulting
     * rounding dust is bounded by `MIN_FILL_BPS`.
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
}
