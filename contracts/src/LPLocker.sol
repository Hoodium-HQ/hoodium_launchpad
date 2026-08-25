// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager} from "./interfaces/IUniswapV3.sol";

/**
 * @title LPLocker
 * @notice T1.9 / LP-4.3 — "LP tokens from migration SHALL be permanently locked —
 *         burned or sent to an address provably without a withdrawal path."
 *
 * design.md section 3 prefers a lock contract over burning the NFT: accrued fees
 * stay claimable while principal is provably unrecoverable.
 *
 * ── The proof ────────────────────────────────────────────────────────────────
 * There is no `decreaseLiquidity`, no `burn`, no `safeTransferFrom` of the
 * position, no owner, no delegatecall, no upgrade path and no `receive`. The only
 * call this contract makes to the position manager is `collect`, and Uniswap's
 * `collect` can move *accrued fees* and nothing else — it cannot touch liquidity.
 *
 * It does now transfer ERC-20s: the collected fees arrive here and are forwarded
 * on. That does not weaken the property above. Those transfers can only ever move
 * tokens this contract already holds, and the only way tokens arrive is `collect`,
 * which cannot return principal. Nothing here is capable of *asking* for
 * liquidity, so no amount of transferring can move it.
 *
 * ── Who claims the fees (T0.4) ───────────────────────────────────────────────
 * Split between the creator and the protocol, `protocolFeeShareBps` to the fee
 * vault and the remainder to the creator. design.md section 3 permits this and
 * states the one condition on it:
 *
 *   "Platform-claimable fees on locked LP would be a hidden revenue stream and
 *    must not ship without being stated plainly in the UI."
 *
 * So the split is not hidden anywhere: it is an immutable public value on this
 * contract, it is carried on every `FeesCollected` event with both sides broken
 * out, and the token page states it in words next to the claim button. A creator
 * can read the number before they launch and it can never move afterwards.
 *
 * Only the creator can trigger a collection. The protocol has no way to sweep
 * fees on its own — it is paid when the creator claims, never instead of them.
 *
 * T0.4 is marked blocking-for-audit in tasks.md, and this is the decision.
 */
contract LPLocker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    /**
     * Hard ceiling on the protocol's share, enforced at construction.
     *
     * The contract is immutable, so a mistyped constructor argument is permanent.
     * This is the promise that no deployment of this contract can ever take the
     * majority of a creator's pool fees, verifiable on-chain by anyone who reads
     * it rather than by trusting whoever ran the deploy script.
     */
    uint256 public constant MAX_PROTOCOL_FEE_SHARE_BPS = 5_000;

    INonfungiblePositionManager public immutable positionManager;

    /// Where the protocol's share is sent. The multisig, never an EOA (LP-3.5).
    address public immutable feeVault;

    /// The protocol's share of collected pool fees, in basis points.
    uint256 public immutable protocolFeeShareBps;

    /// tokenId => the address entitled to collect fees. Never reassignable.
    mapping(uint256 => address) public beneficiaryOf;
    /// tokenId => the launched token this position backs, for indexing.
    mapping(uint256 => address) public tokenOf;

    uint256[] private _lockedIds;

    event PositionLocked(uint256 indexed tokenId, address indexed token, address indexed beneficiary);
    /**
     * Both sides broken out on purpose. A single `amount0` would let the UI show
     * a number that is not what the creator received, which is the failure mode
     * design.md section 3 is guarding against.
     */
    event FeesCollected(
        uint256 indexed tokenId,
        address indexed beneficiary,
        uint256 creatorAmount0,
        uint256 creatorAmount1,
        uint256 protocolAmount0,
        uint256 protocolAmount1
    );

    error NotPositionManager();
    error NotBeneficiary();
    error AlreadyLocked();
    error UnknownPosition();

    constructor(address positionManager_, address feeVault_, uint256 protocolFeeShareBps_) {
        require(positionManager_ != address(0), "zero pm");
        require(feeVault_ != address(0), "zero vault");
        require(protocolFeeShareBps_ <= MAX_PROTOCOL_FEE_SHARE_BPS, "share too high");

        positionManager = INonfungiblePositionManager(positionManager_);
        feeVault = feeVault_;
        protocolFeeShareBps = protocolFeeShareBps_;
    }

    /**
     * @notice Accept a position and record who may collect its fees.
     * @dev `data` carries `(address launchToken, address beneficiary)`.
     *      Only the position manager may deliver positions here; anything else
     *      would let a caller register an arbitrary tokenId.
     */
    function onERC721Received(address, address, uint256 tokenId, bytes calldata data)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        if (beneficiaryOf[tokenId] != address(0)) revert AlreadyLocked();

        (address launchToken, address beneficiary) = abi.decode(data, (address, address));
        require(beneficiary != address(0), "zero beneficiary");

        beneficiaryOf[tokenId] = beneficiary;
        tokenOf[tokenId] = launchToken;
        _lockedIds.push(tokenId);

        emit PositionLocked(tokenId, launchToken, beneficiary);
        return IERC721Receiver.onERC721Received.selector;
    }

    /**
     * @notice Collect accrued trading fees, split between creator and protocol.
     * @dev `amount0Max`/`amount1Max` are saturated because Uniswap caps them at
     *      what is actually owed, and what is owed is fees only — never liquidity.
     *
     *      Fees are collected to this contract first so the split can be made on
     *      the real amounts. Collecting straight to two recipients is not
     *      possible: `collect` takes one.
     * @return creatorAmount0 what the beneficiary received of token0.
     * @return creatorAmount1 what the beneficiary received of token1.
     */
    function collectFees(uint256 tokenId)
        external
        nonReentrant
        returns (uint256 creatorAmount0, uint256 creatorAmount1)
    {
        address beneficiary = beneficiaryOf[tokenId];
        if (beneficiary == address(0)) revert UnknownPosition();
        if (msg.sender != beneficiary) revert NotBeneficiary();

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        (,, address token0, address token1,,,,,,,,) = positionManager.positions(tokenId);

        /*
         * The protocol's cut rounds *down*, so the dust always lands with the
         * creator. It is a wei either way; the point is that when the arithmetic
         * has to give way, it gives way against the party that wrote the contract.
         */
        uint256 protocolAmount0 = Math.mulDiv(amount0, protocolFeeShareBps, BPS);
        uint256 protocolAmount1 = Math.mulDiv(amount1, protocolFeeShareBps, BPS);
        creatorAmount0 = amount0 - protocolAmount0;
        creatorAmount1 = amount1 - protocolAmount1;

        if (creatorAmount0 > 0) IERC20(token0).safeTransfer(beneficiary, creatorAmount0);
        if (creatorAmount1 > 0) IERC20(token1).safeTransfer(beneficiary, creatorAmount1);
        if (protocolAmount0 > 0) IERC20(token0).safeTransfer(feeVault, protocolAmount0);
        if (protocolAmount1 > 0) IERC20(token1).safeTransfer(feeVault, protocolAmount1);

        emit FeesCollected(tokenId, beneficiary, creatorAmount0, creatorAmount1, protocolAmount0, protocolAmount1);
    }

    function lockedCount() external view returns (uint256) {
        return _lockedIds.length;
    }

    function lockedAt(uint256 index) external view returns (uint256) {
        return _lockedIds[index];
    }
}
