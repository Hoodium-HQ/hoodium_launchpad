// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FeeVault
 * @notice T1.12 / LP-3.5 — "The platform vault SHALL be a multisig, never an EOA."
 *
 * A deliberately small m-of-n multisig. It receives trade fees and graduation
 * fees, and the only thing it can do with them is pay out to an address a quorum
 * of owners has agreed on.
 *
 * The owner set and threshold are immutable. A vault whose signer set can change
 * is a vault with a governance attack surface, and this one holds nothing that
 * justifies that risk — it is a revenue account, not a treasury with a roadmap.
 * Rotating signers means deploying a new vault and pointing new launches at it;
 * existing curves keep paying the old one, which is exactly the immutability
 * LP-N1 demands.
 *
 * ── Proposals are not forever (AUDIT L3) ─────────────────────────────────────
 * A confirmation can be withdrawn while the proposal is still open, and every
 * proposal expires `PROPOSAL_TTL` after it was made. Without either, a
 * confirmation given by a key that is later compromised — or simply forgotten —
 * would be a standing half-quorum for the life of the vault, since the signer
 * set cannot be rotated. A payout the owners still want after 30 days is
 * proposed again; that costs one transaction and buys a hard bound on how long
 * any stale agreement stays live.
 *
 * ── Threshold shape (AUDIT L4) ───────────────────────────────────────────────
 * The constructor accepts `threshold == owners.length`; the deploy script does
 * not, unless told to explicitly. With every signer required, one lost key locks
 * the vault forever, and there is no rotation to recover from it.
 */
contract FeeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// How long a proposal stays confirmable and executable.
    uint256 public constant PROPOSAL_TTL = 30 days;

    address[] private _owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    struct Withdrawal {
        address asset;
        address to;
        uint256 amount;
        uint256 confirmations;
        uint256 proposedAt;
        bool executed;
    }

    Withdrawal[] private _withdrawals;
    mapping(uint256 => mapping(address => bool)) public hasConfirmed;

    event WithdrawalProposed(
        uint256 indexed id, address indexed asset, address indexed to, uint256 amount, uint256 expiresAt
    );
    event WithdrawalConfirmed(uint256 indexed id, address indexed owner, uint256 confirmations);
    event ConfirmationRevoked(uint256 indexed id, address indexed owner, uint256 confirmations);
    event WithdrawalExecuted(uint256 indexed id, address indexed asset, address indexed to, uint256 amount);

    error NotOwner();
    error AlreadyExecuted();
    error AlreadyConfirmed();
    error NotConfirmed();
    error ThresholdNotMet(uint256 have, uint256 need);
    error UnknownWithdrawal();
    error ProposalExpired(uint256 id, uint256 expiredAt);

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        require(owners_.length > 0, "no owners");
        require(threshold_ > 1, "threshold must exceed 1"); // LP-3.5: never an EOA
        require(threshold_ <= owners_.length, "threshold > owners");

        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            require(owner != address(0), "zero owner");
            require(!isOwner[owner], "duplicate owner");
            isOwner[owner] = true;
            _owners.push(owner);
        }
        threshold = threshold_;
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function withdrawalCount() external view returns (uint256) {
        return _withdrawals.length;
    }

    function withdrawal(uint256 id) external view returns (Withdrawal memory) {
        if (id >= _withdrawals.length) revert UnknownWithdrawal();
        return _withdrawals[id];
    }

    /// @notice When proposal `id` stops being confirmable or executable.
    function expiresAt(uint256 id) public view returns (uint256) {
        if (id >= _withdrawals.length) revert UnknownWithdrawal();
        return _withdrawals[id].proposedAt + PROPOSAL_TTL;
    }

    /// @notice Propose a payout. Proposing counts as the proposer's confirmation.
    function propose(address asset, address to, uint256 amount) external onlyOwner returns (uint256 id) {
        require(to != address(0), "zero recipient");
        require(amount > 0, "zero amount");

        id = _withdrawals.length;
        _withdrawals.push(
            Withdrawal({
                asset: asset,
                to: to,
                amount: amount,
                confirmations: 1,
                proposedAt: block.timestamp,
                executed: false
            })
        );
        hasConfirmed[id][msg.sender] = true;

        emit WithdrawalProposed(id, asset, to, amount, block.timestamp + PROPOSAL_TTL);
        emit WithdrawalConfirmed(id, msg.sender, 1);
    }

    function confirm(uint256 id) external onlyOwner {
        Withdrawal storage w = _open(id);
        if (hasConfirmed[id][msg.sender]) revert AlreadyConfirmed();

        hasConfirmed[id][msg.sender] = true;
        w.confirmations += 1;
        emit WithdrawalConfirmed(id, msg.sender, w.confirmations);
    }

    /// @notice Withdraw a confirmation from a proposal that has not executed.
    function revokeConfirmation(uint256 id) external onlyOwner {
        if (id >= _withdrawals.length) revert UnknownWithdrawal();
        Withdrawal storage w = _withdrawals[id];
        if (w.executed) revert AlreadyExecuted();
        if (!hasConfirmed[id][msg.sender]) revert NotConfirmed();

        hasConfirmed[id][msg.sender] = false;
        w.confirmations -= 1;
        emit ConfirmationRevoked(id, msg.sender, w.confirmations);
    }

    function execute(uint256 id) external onlyOwner nonReentrant {
        Withdrawal storage w = _open(id);
        if (w.confirmations < threshold) revert ThresholdNotMet(w.confirmations, threshold);

        w.executed = true; // effects before interactions
        IERC20(w.asset).safeTransfer(w.to, w.amount);

        emit WithdrawalExecuted(id, w.asset, w.to, w.amount);
    }

    /// @dev A proposal that exists, has not executed, and has not expired.
    function _open(uint256 id) private view returns (Withdrawal storage w) {
        if (id >= _withdrawals.length) revert UnknownWithdrawal();
        w = _withdrawals[id];
        if (w.executed) revert AlreadyExecuted();
        uint256 deadline = w.proposedAt + PROPOSAL_TTL;
        if (block.timestamp > deadline) revert ProposalExpired(id, deadline);
    }
}
