// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {GraduationManager} from "./GraduationManager.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback} from "./interfaces/IUniswapV3.sol";

/**
 * @title GraduationHelper
 * @notice Permissionless periphery that closes the AUDIT "Medium (liveness)"
 *         residual: a pool primed with dust liquidity at a hostile price makes
 *         every plain completing `buy` revert `PoolPriceManipulated` (or
 *         `UnexpectedSwapPayment` for an out-of-range position in the path), and
 *         because re-pricing and re-blocking both cost wei, fixing it in a
 *         separate transaction is a gas war the buyer can lose. Here the fix
 *         and the completing buy are one transaction, so nothing can be
 *         interleaved between them.
 *
 * ── What it is ───────────────────────────────────────────────────────────────
 * Stateless (the reentrancy guard is its only storage), unowned, and holds
 * nothing between calls: every wei of USDG and of tokens it touches — the
 * bought tokens, the arbitrage proceeds, the unspent fix budget, the curve's
 * overshoot refund — is swept to `msg.sender` before the call returns. It has
 * no privileged relationship with any core contract: it is just a caller of
 * `BondingCurve.buy` and of the Uniswap pool, and it works against any curve
 * of any `GraduationManager` because it reads both from the curve.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 * `GraduationManager.targetSqrtPriceX96(curve)` is the price the pool must sit
 * at. The helper swaps through the pool with `sqrtPriceLimitX96 = target` in
 * whichever direction moves the price toward it, so the swap consumes exactly
 * what it takes to land on the target and no more:
 *
 *   - if the token is too cheap in the pool, USDG goes in and tokens come out
 *     (the caller funds it, up to `maxFixUsdg`, and keeps the tokens);
 *   - if the token is too expensive, tokens must go in. The caller does not hold
 *     any, so when the pool asks for them in the swap callback the helper buys
 *     exactly that many from the curve — at the curve's price, which by
 *     construction is the fair price — with the caller's USDG (up to
 *     `maxFixUsdg`, and never enough to complete the curve, which would
 *     graduate into the still-mispriced pool). The USDG the pool pays out is
 *     the caller's. A non-completing `buy` from inside the pool's callback is
 *     safe: the curve only touches the pool when it graduates.
 *
 * Either way the mispriced liquidity is an order against a known fair price:
 * the fix is an arbitrage, and its proceeds go to whoever pays for it. A pool
 * with no liquidity in range walks to the target for free (the manager would do
 * the same) unless a position sits in the path, in which case it is swept
 * within the same budget. If `maxFixUsdg` does not reach the target the whole
 * call reverts (`FixBudgetExhausted` while paying, `FixBudgetInsufficient` if
 * the swap stopped short) — nothing is half-done.
 *
 * ── The buy ──────────────────────────────────────────────────────────────────
 * `BondingCurve.buy` is keyed on `msg.sender`, which here is this contract:
 * the anti-snipe window's per-address allowance would be the helper's, shared
 * by everyone routing through it. It is therefore **only for the completing
 * buy**, after the window, and refuses to run inside it (`SnipeWindowOpen`).
 * A UI should route a buy here only when the plain buy's simulation reverted
 * with one of the manager's pricing errors.
 */
contract GraduationHelper is IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    event PoolFixed(
        address indexed curve, address indexed pool, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96, bool tokenIn
    );

    error SnipeWindowOpen(uint256 opensAtBlock);
    error ZeroAmount();
    error NothingToFix();
    error FixBudgetInsufficient(uint160 landed, uint160 target);
    error FixBudgetExhausted(uint256 needed, uint256 available);
    error UnexpectedSwapCallback();

    struct Ctx {
        BondingCurve curve;
        GraduationManager manager;
        IERC20 usdg;
        IERC20 token;
        address pool;
        uint160 current;
        uint160 target;
        bool needed;
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /**
     * @notice What the pool looks like versus what graduation needs.
     * @return pool The pool (zero if not created yet).
     * @return current Its sqrtPriceX96 (zero if not initialised).
     * @return target `GraduationManager.targetSqrtPriceX96(curve)`.
     * @return needed Whether a plain completing buy would be refused on price:
     *         an initialised pool whose price is off the target and which either
     *         has liquidity in range and sits outside the band, or has none (the
     *         manager re-prices those for free, but only if nothing is in the
     *         path — a swap here costs nothing if nothing is).
     */
    function status(address curve) public view returns (address pool, uint160 current, uint160 target, bool needed) {
        Ctx memory c = _load(curve);
        return (c.pool, c.current, c.target, c.needed);
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /**
     * @notice Fix the pool price (if it needs it) and make the completing buy,
     *         atomically. Everything the call produces goes to `msg.sender`.
     * @param curve The curve to complete.
     * @param usdgIn Gross USDG for the buy, exactly as `BondingCurve.buy`.
     * @param minTokensOut Floor for the buy, exactly as `BondingCurve.buy`.
     * @param deadline Deadline for the buy, exactly as `BondingCurve.buy`.
     * @param maxFixUsdg Most USDG the fix may draw from the caller on top of
     *        `usdgIn`; whatever the fix does not need is returned. The caller
     *        must have approved `usdgIn + maxFixUsdg` to this contract.
     * @return tokensOut Tokens the buy delivered to the caller (excluding any
     *         the fix itself yielded, which are sent along too).
     */
    function fixAndBuy(address curve, uint256 usdgIn, uint256 minTokensOut, uint256 deadline, uint256 maxFixUsdg)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (usdgIn == 0) revert ZeroAmount();
        Ctx memory c = _load(curve);
        _requireAfterWindow(c.curve);

        if (c.needed) _fix(c, maxFixUsdg, deadline);

        c.usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        c.usdg.forceApprove(address(c.curve), usdgIn);
        tokensOut = c.curve.buy(usdgIn, minTokensOut, deadline);
        c.usdg.forceApprove(address(c.curve), 0);

        _sweep(c);
    }

    /**
     * @notice Re-price the pool without buying — for keepers and anyone who
     *         wants the arbitrage. Reverts `NothingToFix` when a plain completing
     *         buy would already be accepted.
     * @param maxFixUsdg Most USDG to draw from the caller; the unspent part and
     *        all proceeds are returned in the same call.
     */
    function fix(address curve, uint256 maxFixUsdg) external nonReentrant {
        Ctx memory c = _load(curve);
        if (!c.needed) revert NothingToFix();
        _requireAfterWindow(c.curve);
        _fix(c, maxFixUsdg, block.timestamp);
        _sweep(c);
    }

    /**
     * @notice Uniswap's payment hook. Accepts only a call from the pool named
     *         in `data`, and only while a fix is in progress — the guard is
     *         the "in progress" bit, so no extra storage is needed.
     */
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        (address pool, bool tokenIn, address curve, uint256 deadline) =
            abi.decode(data, (address, bool, address, uint256));
        if (!_reentrancyGuardEntered() || msg.sender != pool) revert UnexpectedSwapCallback();
        int256 signedOwed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (signedOwed <= 0) return;
        uint256 owed = uint256(signedOwed);

        BondingCurve c = BondingCurve(curve);
        if (tokenIn) {
            _buyAtLeast(c, owed, deadline);
            c.token().safeTransfer(pool, owed);
        } else {
            uint256 have = c.usdg().balanceOf(address(this));
            if (owed > have) revert FixBudgetExhausted(owed, have);
            c.usdg().safeTransfer(pool, owed);
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _load(address curve) private view returns (Ctx memory c) {
        c.curve = BondingCurve(curve);
        c.manager = GraduationManager(address(c.curve.graduationManager()));
        c.usdg = c.curve.usdg();
        c.token = c.curve.token();
        c.target = c.manager.targetSqrtPriceX96(curve);
        c.pool = c.manager.uniswapFactory().getPool(address(c.token), address(c.usdg), c.manager.poolFee());
        if (c.pool == address(0)) return c;
        (c.current,,,,,,) = IUniswapV3Pool(c.pool).slot0();
        if (c.current == 0 || c.current == c.target) return c;
        c.needed =
            IUniswapV3Pool(c.pool).liquidity() == 0 || !c.manager.isWithinBand(c.current, c.target);
    }

    function _requireAfterWindow(BondingCurve curve) private view {
        uint256 opensAt = curve.deployBlock() + curve.snipeBlocks();
        if (block.number < opensAt) revert SnipeWindowOpen(opensAt);
    }

    /**
     * @dev Swap toward the target. `zeroForOne` sells token0, which lowers
     *      sqrtPrice (= sqrt(token1/token0)); so the price must fall exactly
     *      when the target is below the current price.
     *
     *      With USDG going in the exact input is the budget itself (at least
     *      1 wei — Uniswap rejects a zero amount, and a pool with nothing in
     *      the path never asks for it). With tokens going in the input is
     *      "as much as it takes": the pool stops at the price limit and asks
     *      the callback for exactly that many, which is where the budget is
     *      enforced.
     */
    function _fix(Ctx memory c, uint256 maxFixUsdg, uint256 deadline) private {
        bool zeroForOne = c.target < c.current;
        bool tokenIn = zeroForOne == (address(c.token) < address(c.usdg));

        if (maxFixUsdg > 0) c.usdg.safeTransferFrom(msg.sender, address(this), maxFixUsdg);
        int256 amountSpecified = tokenIn
            ? int256(uint256(type(uint128).max))
            : int256(maxFixUsdg == 0 ? 1 : maxFixUsdg);

        IUniswapV3Pool(c.pool).swap(
            address(this), zeroForOne, amountSpecified, c.target, abi.encode(c.pool, tokenIn, address(c.curve), deadline)
        );

        (uint160 landed,,,,,,) = IUniswapV3Pool(c.pool).slot0();
        if (!c.manager.isWithinBand(landed, c.target)) revert FixBudgetInsufficient(landed, c.target);
        emit PoolFixed(address(c.curve), c.pool, c.current, landed, tokenIn);
    }

    /**
     * @dev Buy at least `tokens` from the curve with the USDG held, or revert.
     *
     *      Inverting the curve's quote: `tokensOut = y - ceil(x·y / (x + net))`,
     *      so the smallest net input yielding `tokens` is
     *      `ceil(x·y / (y - tokens)) - x`; grossed up for the fee and then
     *      nudged by the wei the two ceilings may cost. The buy must not
     *      complete the curve — that graduates into a pool that is still being
     *      re-priced — so a need that reaches the target is a budget failure.
     */
    function _buyAtLeast(BondingCurve curve, uint256 tokens, uint256 deadline) private {
        uint256 x = curve.reserveX();
        uint256 y = curve.reserveY();
        if (tokens >= y) revert FixBudgetExhausted(tokens, y);
        uint256 net = Math.mulDiv(x, y, y - tokens, Math.Rounding.Ceil) - x;
        uint256 feeBps = curve.tradeFeeBps();
        uint256 gross = Math.mulDiv(net, BPS, BPS - feeBps, Math.Rounding.Ceil);

        (uint256 out,,, uint256 netIn) = curve.quoteBuy(gross);
        for (uint256 i = 0; out < tokens && i < 8; i++) {
            gross += 1;
            (out,,, netIn) = curve.quoteBuy(gross);
        }
        if (out < tokens || netIn >= curve.remainingToTarget()) revert FixBudgetExhausted(tokens, out);

        IERC20 usdg = curve.usdg();
        uint256 have = usdg.balanceOf(address(this));
        if (gross > have) revert FixBudgetExhausted(gross, have);

        usdg.forceApprove(address(curve), gross);
        curve.buy(gross, tokens, deadline);
        usdg.forceApprove(address(curve), 0);
    }

    /// @dev The helper holds nothing between calls: whatever is here is the caller's.
    function _sweep(Ctx memory c) private {
        uint256 u = c.usdg.balanceOf(address(this));
        if (u > 0) c.usdg.safeTransfer(msg.sender, u);
        uint256 t = c.token.balanceOf(address(this));
        if (t > 0) c.token.safeTransfer(msg.sender, t);
    }
}
