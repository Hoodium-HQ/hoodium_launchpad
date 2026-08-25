// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IGraduationManager} from "./interfaces/IGraduationManager.sol";

/**
 * @title BondingCurve
 * @notice T1.2–T1.6, T1.10, T1.11 — constant product over virtual reserves,
 *         denominated in USDG (design.md section 2).
 *
 *   k = (virtualUsdg + reserveUsdg) x (virtualTokens + unsoldTokens)
 *
 *   Buy:  tokensOut = y - k / (x + usdgIn)
 *   Sell: usdgOut   = x - k / (y + tokensIn)
 *
 * Virtual reserves set the opening price without anyone seeding capital (LP-1.3).
 *
 * ── The rounding rule (LP-N8) ────────────────────────────────────────────────
 * Every division rounds in the contract's favour, never the caller's. Both quote
 * paths divide `k` and round the quotient **up**, which makes the output the user
 * receives round **down**. Fees round up.
 *
 * This is not pedantry. Every historically drained bonding curve was drained
 * through rounding, not through a dramatic exploit (design.md section 7) — a curve
 * that rounds toward the caller can be bled by repeated dust trades until the
 * reserve no longer backs the supply.
 *
 * ── Completion is final (AUDIT H2) ───────────────────────────────────────────
 * The buy that brings `reserveUsdg` to the target graduates the curve in the
 * same transaction, and `sell` refuses once the target is reached. Without both,
 * anyone holding a wei of tokens could sell it ahead of every `graduate()` and
 * keep the curve one wei short forever. The external `graduate()` remains for
 * the one way a curve can complete without a public buy — a dev buy at launch —
 * and is permissionless (LP-4.6).
 *
 * ── The anti-snipe window counts per address (AUDIT H1) ──────────────────────
 * For the first `snipeBlocks` blocks, cumulative tokens bought per address are
 * capped at `snipeMaxTokens`. A per-call cap is no cap at all: a contract can
 * launch and loop `buy` a hundred times in the deployment transaction. The dev
 * buy is bounded separately (`devBuyMaxBps`) but still counts against the
 * creator's window allowance, so "dev buy then keep buying" is closed too.
 * Splitting across addresses is still possible; each needs its own USDG and
 * gets its own 1%, which is the window's intent.
 *
 * ── USDG assumption (T0.2, unresolved) ───────────────────────────────────────
 * This contract assumes USDG is a standard ERC-20: no fee-on-transfer, no
 * rebasing. T0.2 is still open, so rather than assume silently, every inbound
 * transfer asserts the balance delta equals the amount requested. If USDG turns
 * out to take a transfer fee, launches fail loudly on day one instead of leaving
 * curves under-reserved.
 */
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    // ── Immutable configuration (LP-2.7: curve parameters immutable) ──────────

    IERC20 public immutable usdg;
    IERC20 public immutable token;
    address public immutable creator;
    address public immutable feeVault;
    IGraduationManager public immutable graduationManager;
    address public immutable factory;

    /// Synthetic reserves that set the opening price (design.md section 2).
    uint256 public immutable virtualUsdg;
    uint256 public immutable virtualTokens;

    /// Tokens sold along the curve; the rest is held back for the pool.
    uint256 public immutable curveAllocation;
    uint256 public immutable lpAllocation;

    /// Net USDG at which the curve completes (LP-4.1).
    uint256 public immutable graduationTarget;
    /// Paid to the fee vault out of reserves at graduation (LP-3.3).
    uint256 public immutable graduationFee;

    uint256 public immutable tradeFeeBps; // LP-2.3
    uint256 public immutable creatorFeeShareBps; // LP-3.1

    /// Anti-snipe window (LP-2.5, design.md section 4).
    uint256 public immutable deployBlock;
    uint256 public immutable snipeBlocks;
    uint256 public immutable snipeMaxTokens;

    /// The product at deployment. The k-invariant is measured against this.
    uint256 public immutable initialK;

    // ── State ────────────────────────────────────────────────────────────────

    uint256 public reserveUsdg;
    uint256 public tokensSold;
    bool public graduated;
    bool private _devBuyDone;

    /// Tokens bought per address inside the anti-snipe window (AUDIT H1).
    mapping(address => uint256) public boughtInWindow;

    /// Where the liquidity went. Zero until graduation.
    address public pool;
    uint256 public lpTokenId;

    /// Fee balances, held separately from reserves so neither can spend the other.
    uint256 public creatorFeesAccrued;
    uint256 public platformFeesAccrued;
    uint256 public creatorFeesClaimed;
    uint256 public platformFeesClaimed;

    // ── Events ───────────────────────────────────────────────────────────────

    event Bought(
        address indexed buyer,
        uint256 usdgIn,
        uint256 tokensOut,
        uint256 fee,
        uint256 refund,
        uint256 reserveAfter,
        uint256 tokensSoldAfter
    );
    event Sold(
        address indexed seller,
        uint256 tokensIn,
        uint256 usdgOut,
        uint256 fee,
        uint256 reserveAfter,
        uint256 tokensSoldAfter
    );
    event FeesAccrued(uint256 creatorAmount, uint256 platformAmount);
    event CreatorFeesClaimed(address indexed to, uint256 amount);
    event PlatformFeesClaimed(address indexed to, uint256 amount);
    event Graduated(address indexed token, address indexed pool, uint256 tokenId, uint256 usdgIn, uint256 tokensIn);

    // ── Errors ───────────────────────────────────────────────────────────────

    error AlreadyGraduated();
    error NotGraduated();
    error TargetNotReached();
    error ZeroAmount();
    error SlippageExceeded(uint256 got, uint256 minimum);
    error AntiSnipeCapExceeded(uint256 requested, uint256 cap);
    error UnsupportedTokenBehaviour();
    error NotFactory();
    error DevBuyAlreadyDone();
    error ExceedsSold();
    error NotCreator();
    error CurveComplete();
    error Expired(uint256 deadline);

    struct CurveConfig {
        address usdg;
        address token;
        address creator;
        address feeVault;
        address graduationManager;
        uint256 virtualUsdg;
        uint256 virtualTokens;
        uint256 curveAllocation;
        uint256 lpAllocation;
        uint256 graduationTarget;
        uint256 graduationFee;
        uint256 tradeFeeBps;
        uint256 creatorFeeShareBps;
        uint256 snipeBlocks;
        uint256 snipeMaxTokens;
    }

    constructor(CurveConfig memory c) {
        require(c.usdg != address(0) && c.token != address(0), "zero token");
        require(c.feeVault != address(0), "zero vault");
        require(c.virtualUsdg > 0 && c.virtualTokens > 0, "zero virtual");
        require(c.curveAllocation > 0, "zero curve alloc");
        require(c.graduationTarget > c.graduationFee, "fee >= target");
        require(c.tradeFeeBps < BPS, "fee too high");
        require(c.creatorFeeShareBps <= BPS, "share too high");

        usdg = IERC20(c.usdg);
        token = IERC20(c.token);
        creator = c.creator;
        feeVault = c.feeVault;
        graduationManager = IGraduationManager(c.graduationManager);
        factory = msg.sender;

        virtualUsdg = c.virtualUsdg;
        virtualTokens = c.virtualTokens;
        curveAllocation = c.curveAllocation;
        lpAllocation = c.lpAllocation;
        graduationTarget = c.graduationTarget;
        graduationFee = c.graduationFee;
        tradeFeeBps = c.tradeFeeBps;
        creatorFeeShareBps = c.creatorFeeShareBps;

        deployBlock = block.number;
        snipeBlocks = c.snipeBlocks;
        snipeMaxTokens = c.snipeMaxTokens;

        initialK = c.virtualUsdg * (c.virtualTokens + c.curveAllocation);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice USDG side of the constant product.
    function reserveX() public view returns (uint256) {
        return virtualUsdg + reserveUsdg;
    }

    /// @notice Token side of the constant product.
    function reserveY() public view returns (uint256) {
        return virtualTokens + curveAllocation - tokensSold;
    }

    /// @notice The invariant fuzz tests assert never decreases (LP-N4, T2.1).
    function currentK() public view returns (uint256) {
        return reserveX() * reserveY();
    }

    /// @notice Net USDG still accepted before the curve completes (LP-2.6).
    function remainingToTarget() public view returns (uint256) {
        return reserveUsdg >= graduationTarget ? 0 : graduationTarget - reserveUsdg;
    }

    function curveComplete() public view returns (bool) {
        return reserveUsdg >= graduationTarget;
    }

    /// @notice Progress toward graduation in basis points — what the UI renders.
    function progressBps() external view returns (uint256) {
        if (reserveUsdg >= graduationTarget) return BPS;
        return Math.mulDiv(reserveUsdg, BPS, graduationTarget);
    }

    /**
     * @notice Quote a buy without executing it (WA-2.4 needs an exact preview).
     * @return tokensOut Tokens the buyer receives.
     * @return fee Trade fee taken.
     * @return refund Excess returned because the buy would overshoot the target.
     */
    function quoteBuy(uint256 usdgIn)
        public
        view
        returns (uint256 tokensOut, uint256 fee, uint256 refund, uint256 netIn)
    {
        if (graduated || usdgIn == 0) return (0, 0, usdgIn, 0);

        (netIn, fee, refund) = _splitBuyInput(usdgIn);
        if (netIn == 0) return (0, 0, usdgIn, 0);

        uint256 x = reserveX();
        uint256 y = reserveY();
        // Round the quotient up so `tokensOut` rounds down (LP-N8).
        uint256 newY = Math.mulDiv(x, y, x + netIn, Math.Rounding.Ceil);
        tokensOut = y - newY;
    }

    /// @notice Quote a sell without executing it.
    function quoteSell(uint256 tokensIn) public view returns (uint256 usdgOut, uint256 fee, uint256 grossOut) {
        if (graduated || tokensIn == 0 || tokensIn > tokensSold) return (0, 0, 0);

        uint256 x = reserveX();
        uint256 y = reserveY();
        // Round up so the payout rounds down (LP-N8).
        uint256 newX = Math.mulDiv(x, y, y + tokensIn, Math.Rounding.Ceil);
        grossOut = x - newX;
        if (grossOut > reserveUsdg) grossOut = reserveUsdg;

        fee = Math.mulDiv(grossOut, tradeFeeBps, BPS, Math.Rounding.Ceil);
        usdgOut = grossOut - fee;
    }

    // ── Trading ──────────────────────────────────────────────────────────────

    /**
     * @notice Buy tokens from the curve (LP-2.1).
     * @param usdgIn Gross USDG offered. Only what the curve can absorb is taken;
     *        the rest is left with the caller (LP-2.6).
     * @param minTokensOut Caller's floor — reverts if the result is worse (LP-2.4).
     * @param deadline Last block timestamp at which the trade is acceptable
     *        (AUDIT L5) — a quote is only as good as the moment it was made.
     *
     * If this buy is the one that reaches the target, the curve graduates before
     * the call returns (AUDIT H2): the pool exists and the position is locked by
     * the time the buyer sees their tokens.
     */
    function buy(uint256 usdgIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        _checkDeadline(deadline);
        tokensOut = _buy(msg.sender, msg.sender, usdgIn, minTokensOut, true, true);
    }

    /**
     * @notice The creator's own purchase, executed inside the deployment
     *         transaction (LP-1.6, design.md section 4).
     *
     * Exempt from the anti-snipe *cap* because it is bounded separately by the
     * factory's `devBuyMaxBps`, and because it cannot front-run anything — no
     * other buy can precede it, since the curve does not exist until this
     * transaction completes. It still *counts* toward the creator's window
     * allowance (AUDIT H1), so the creator cannot follow it with more buys in
     * the window.
     *
     * Does not graduate on completion: it runs inside `HoodiumFactory.launch`,
     * before the factory has finished recording the launch. A curve a dev buy
     * completes outright is graduated by anyone via `graduate()`.
     */
    function devBuy(address recipient, uint256 usdgIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.sender != factory) revert NotFactory();
        if (_devBuyDone) revert DevBuyAlreadyDone();
        _devBuyDone = true;
        tokensOut = _buy(msg.sender, recipient, usdgIn, minTokensOut, false, false);
    }

    function _buy(
        address payer,
        address recipient,
        uint256 usdgIn,
        uint256 minTokensOut,
        bool enforceSnipeCap,
        bool graduateOnCompletion
    ) private returns (uint256 tokensOut) {
        if (graduated) revert AlreadyGraduated();
        if (usdgIn == 0) revert ZeroAmount();

        (uint256 netIn, uint256 fee, uint256 refund) = _splitBuyInput(usdgIn);
        if (netIn == 0) revert ZeroAmount();

        uint256 x = reserveX();
        uint256 y = reserveY();
        uint256 newY = Math.mulDiv(x, y, x + netIn, Math.Rounding.Ceil);
        tokensOut = y - newY;

        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
        if (tokensOut == 0) revert ZeroAmount();

        // LP-2.5 / AUDIT H1 — cap cumulative size per address for the opening
        // blocks. Recorded for every buy in the window (the dev buy included) and
        // enforced for every buy but the dev buy.
        if (block.number < deployBlock + snipeBlocks) {
            uint256 total = boughtInWindow[recipient] + tokensOut;
            boughtInWindow[recipient] = total;
            if (enforceSnipeCap && total > snipeMaxTokens) revert AntiSnipeCapExceeded(total, snipeMaxTokens);
        }

        // Effects before interactions (LP-N2).
        uint256 taken = netIn + fee;
        reserveUsdg += netIn;
        tokensSold += tokensOut;
        _accrueFee(fee);

        _pullUsdg(payer, taken);
        token.safeTransfer(recipient, tokensOut);

        emit Bought(recipient, taken, tokensOut, fee, refund, reserveUsdg, tokensSold);

        // AUDIT H2 — the completing buy graduates. Still inside the caller's
        // nonReentrant frame, so nothing can trade between completion and the
        // pool existing.
        if (graduateOnCompletion && reserveUsdg >= graduationTarget) _graduate();
    }

    /**
     * @notice Sell tokens back to the curve (LP-2.2).
     * @param minUsdgOut Caller's floor — reverts if the result is worse (LP-2.4).
     * @param deadline Last block timestamp at which the trade is acceptable (AUDIT L5).
     *
     * Refuses once the target is reached (AUDIT H2): a completed curve is on its
     * way to the pool, and a sell at that point could only serve to hold it back.
     */
    function sell(uint256 tokensIn, uint256 minUsdgOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        _checkDeadline(deadline);
        if (graduated) revert AlreadyGraduated();
        if (curveComplete()) revert CurveComplete();
        if (tokensIn == 0) revert ZeroAmount();
        if (tokensIn > tokensSold) revert ExceedsSold();

        uint256 x = reserveX();
        uint256 y = reserveY();
        uint256 newX = Math.mulDiv(x, y, y + tokensIn, Math.Rounding.Ceil);
        uint256 grossOut = x - newX;
        // The virtual reserve is not real money and can never be paid out.
        if (grossOut > reserveUsdg) grossOut = reserveUsdg;

        uint256 fee = Math.mulDiv(grossOut, tradeFeeBps, BPS, Math.Rounding.Ceil);
        usdgOut = grossOut - fee;

        if (usdgOut < minUsdgOut) revert SlippageExceeded(usdgOut, minUsdgOut);

        reserveUsdg -= grossOut;
        tokensSold -= tokensIn;
        _accrueFee(fee);

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), tokensIn);
        if (token.balanceOf(address(this)) - before != tokensIn) revert UnsupportedTokenBehaviour();

        usdg.safeTransfer(msg.sender, usdgOut);

        emit Sold(msg.sender, tokensIn, usdgOut, fee, reserveUsdg, tokensSold);
    }

    // ── Fees (LP-3.1, LP-3.2, LP-3.4) ────────────────────────────────────────

    /**
     * @dev The platform share is the *remainder* after the creator share, so the
     *      split can neither create nor destroy a wei (LP-3.4).
     */
    function _accrueFee(uint256 fee) private {
        if (fee == 0) return;
        uint256 creatorCut = Math.mulDiv(fee, creatorFeeShareBps, BPS); // rounds down
        uint256 platformCut = fee - creatorCut;
        creatorFeesAccrued += creatorCut;
        platformFeesAccrued += platformCut;
        emit FeesAccrued(creatorCut, platformCut);
    }

    /// @notice LP-3.2 — claimable by the creator at any time, by nobody else.
    function claimCreatorFees() external nonReentrant returns (uint256 amount) {
        if (msg.sender != creator) revert NotCreator();
        amount = creatorFeesAccrued - creatorFeesClaimed;
        if (amount == 0) revert ZeroAmount();
        creatorFeesClaimed += amount;
        usdg.safeTransfer(creator, amount);
        emit CreatorFeesClaimed(creator, amount);
    }

    /**
     * @notice Sweep the platform share to the fee vault.
     * @dev Permissionless: it can only ever move funds to the immutable vault, so
     *      there is nothing to gain by calling it and nothing to gate.
     */
    function claimPlatformFees() external nonReentrant returns (uint256 amount) {
        amount = platformFeesAccrued - platformFeesClaimed;
        if (amount == 0) revert ZeroAmount();
        platformFeesClaimed += amount;
        usdg.safeTransfer(feeVault, amount);
        emit PlatformFeesClaimed(feeVault, amount);
    }

    // ── Graduation (LP-4.1, LP-4.2, LP-4.4, LP-4.6) ──────────────────────────

    /**
     * @notice Migrate the curve into a Uniswap pool.
     *
     * Permissionless (LP-4.6): anyone may call it, and Hoodium is not a
     * dependency. If Hoodium disappears entirely, tokens still graduate.
     *
     * Normally unnecessary — the buy that reaches the target graduates on its
     * own (AUDIT H2). This entry point covers the one case that does not: a dev
     * buy at launch that completes the curve outright.
     *
     * Atomic (LP-4.2): if any step reverts the whole transaction reverts and the
     * curve stays tradeable, because `graduated` is only durable if the call
     * succeeds.
     */
    function graduate() external nonReentrant returns (address pool_, uint256 tokenId) {
        return _graduate();
    }

    /**
     * @dev Shared by `graduate()` and the completing buy. Both callers hold the
     *      reentrancy lock, so the manager cannot re-enter `buy`/`sell`/`graduate`
     *      while this runs — and `graduated` is set before the first external
     *      call anyway (LP-4.4).
     *
     *      Nothing is *pushed* to a third party here (AUDIT M2): the graduation
     *      fee accrues to `platformFeesAccrued` and leaves via
     *      `claimPlatformFees`; any dust the mint leaves is credited on the
     *      manager for the creator to pull. A frozen or paused recipient can
     *      therefore never make graduation revert.
     */
    function _graduate() private returns (address pool_, uint256 tokenId) {
        if (graduated) revert AlreadyGraduated();
        if (!curveComplete()) revert TargetNotReached();

        // design.md section 3 step 2 — set BEFORE any external call. From here on
        // buy/sell revert with AlreadyGraduated even under reentrancy (LP-4.4).
        graduated = true;

        uint256 usdgForLp = reserveUsdg - graduationFee;
        uint256 tokensForLp = lpAllocation + (curveAllocation - tokensSold);
        reserveUsdg = 0;

        // LP-3.3 — the graduation fee is the platform's. It stays in this
        // contract's balance as an accrued fee rather than being transferred.
        if (graduationFee > 0) {
            platformFeesAccrued += graduationFee;
            emit FeesAccrued(0, graduationFee);
        }

        usdg.forceApprove(address(graduationManager), usdgForLp);
        token.forceApprove(address(graduationManager), tokensForLp);

        (pool_, tokenId) = graduationManager.migrate(address(token), tokensForLp, usdgForLp, creator);

        // Leave no standing allowance behind.
        usdg.forceApprove(address(graduationManager), 0);
        token.forceApprove(address(graduationManager), 0);

        pool = pool_;
        lpTokenId = tokenId;

        emit Graduated(address(token), pool_, tokenId, usdgForLp, tokensForLp);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /// @dev AUDIT L5 — a signed trade must not be executable indefinitely.
    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert Expired(deadline);
    }

    /**
     * @dev Split gross input into (net, fee, refund), clamping to what the curve
     *      can still absorb (LP-2.6).
     *
     * On the clamped path the fee is recomputed from the accepted net and rounded
     * up, so the platform is never short-changed by the overshoot path.
     */
    function _splitBuyInput(uint256 usdgIn) private view returns (uint256 netIn, uint256 fee, uint256 refund) {
        fee = Math.mulDiv(usdgIn, tradeFeeBps, BPS, Math.Rounding.Ceil);
        netIn = usdgIn - fee;

        uint256 remaining = remainingToTarget();
        if (netIn > remaining) {
            netIn = remaining;
            // fee / (net + fee) = tradeFeeBps / BPS  =>  fee = net * bps / (BPS - bps)
            fee = Math.mulDiv(netIn, tradeFeeBps, BPS - tradeFeeBps, Math.Rounding.Ceil);
            refund = usdgIn - netIn - fee;
        }
    }

    /**
     * @dev T0.2 is unresolved, so a USDG that does not deliver exactly what was
     *      requested fails loudly rather than leaving the curve under-reserved.
     */
    function _pullUsdg(address from, uint256 amount) private {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(from, address(this), amount);
        if (usdg.balanceOf(address(this)) - before != amount) revert UnsupportedTokenBehaviour();
    }
}
