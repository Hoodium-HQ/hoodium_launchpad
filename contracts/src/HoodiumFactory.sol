// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {HoodiumToken} from "./HoodiumToken.sol";

/**
 * @title HoodiumFactory
 * @notice T1.7 / LP-1.1, LP-1.3, LP-1.5, LP-1.6 — deploy a token and its curve in
 *         a single transaction, with an optional dev buy in the same transaction.
 *
 * Immutable and admin-free (LP-N1). Every launch parameter is fixed at factory
 * deployment, so a creator can read them before launching and know they cannot
 * move afterwards. Changing terms means deploying a new factory; tokens already
 * launched keep the terms they launched under.
 */
contract HoodiumFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;

    IERC20 public immutable usdg;
    address public immutable feeVault;
    address public immutable graduationManager;

    // ── Launch terms, fixed for every token this factory deploys ─────────────

    uint256 public immutable totalSupply;
    uint256 public immutable curveAllocation;
    uint256 public immutable lpAllocation;
    uint256 public immutable virtualUsdg;
    uint256 public immutable virtualTokens;
    uint256 public immutable graduationTarget;
    uint256 public immutable graduationFee;
    uint256 public immutable tradeFeeBps;
    uint256 public immutable creatorFeeShareBps;
    uint256 public immutable creationFee; // LP-1.5, in USDG
    uint256 public immutable devBuyMaxBps; // LP-1.6, default 500 = 5%
    uint256 public immutable snipeBlocks; // LP-2.5, default 3
    uint256 public immutable snipeMaxBps; // LP-2.5, default 100 = 1%
    uint8 public immutable tokenDecimals;

    struct Launch {
        address token;
        address curve;
        address creator;
        uint64 createdAt;
    }

    Launch[] private _launches;
    mapping(address => address) public curveOf; // token => curve
    mapping(address => address[]) private _launchesByCreator;

    event TokenLaunched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint256 devBuyUsdg,
        uint256 devBuyTokens
    );

    error DevBuyTooLarge(uint256 requested, uint256 cap);
    error InsufficientCreationFee();

    struct FactoryConfig {
        address usdg;
        address feeVault;
        address graduationManager;
        uint8 tokenDecimals;
        uint256 totalSupply;
        uint256 curveAllocation;
        uint256 virtualUsdg;
        uint256 graduationTarget;
        uint256 graduationFee;
        uint256 tradeFeeBps;
        uint256 creatorFeeShareBps;
        uint256 creationFee;
        uint256 devBuyMaxBps;
        uint256 snipeBlocks;
        uint256 snipeMaxBps;
    }

    constructor(FactoryConfig memory c) {
        require(c.usdg != address(0) && c.feeVault != address(0), "zero addr");
        require(c.graduationManager != address(0), "zero manager");
        require(c.curveAllocation > 0 && c.curveAllocation < c.totalSupply, "bad allocation");
        require(c.graduationTarget > c.graduationFee, "fee >= target");
        require(c.virtualUsdg > 0, "zero virtual usdg");
        require(c.tradeFeeBps < BPS && c.creatorFeeShareBps <= BPS, "bad bps");
        require(c.devBuyMaxBps <= BPS && c.snipeMaxBps <= BPS, "bad caps");

        usdg = IERC20(c.usdg);
        feeVault = c.feeVault;
        graduationManager = c.graduationManager;
        tokenDecimals = c.tokenDecimals;

        totalSupply = c.totalSupply;
        curveAllocation = c.curveAllocation;
        lpAllocation = c.totalSupply - c.curveAllocation;
        virtualUsdg = c.virtualUsdg;
        graduationTarget = c.graduationTarget;
        graduationFee = c.graduationFee;
        tradeFeeBps = c.tradeFeeBps;
        creatorFeeShareBps = c.creatorFeeShareBps;
        creationFee = c.creationFee;
        devBuyMaxBps = c.devBuyMaxBps;
        snipeBlocks = c.snipeBlocks;
        snipeMaxBps = c.snipeMaxBps;

        /*
         * Virtual token reserve is derived, not configured:
         *
         *   tokensSold(target) = (vT + C) x target / (vU + target)
         *
         * Setting that equal to C — the whole curve allocation sold exactly when
         * the target is hit — and solving gives vT = C x vU / target.
         *
         * Deriving it removes a way to misconfigure a launch: a hand-picked vT
         * that disagrees with the target leaves either unsold tokens at
         * graduation or a curve that runs out of supply before reaching it.
         */
        virtualTokens = Math.mulDiv(c.curveAllocation, c.virtualUsdg, c.graduationTarget);
        require(virtualTokens > 0, "virtual tokens underflow");
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function launchCount() external view returns (uint256) {
        return _launches.length;
    }

    function launchAt(uint256 index) external view returns (Launch memory) {
        return _launches[index];
    }

    function launchesByCreator(address creator) external view returns (address[] memory) {
        return _launchesByCreator[creator];
    }

    /// @notice The most a creator may buy of their own launch (LP-1.6).
    function devBuyCapTokens() public view returns (uint256) {
        return Math.mulDiv(totalSupply, devBuyMaxBps, BPS);
    }

    // ── Launch (LP-1.1) ──────────────────────────────────────────────────────

    /**
     * @notice Deploy a token and its bonding curve, optionally buying in.
     *
     * @param name Token name. Attacker-controlled and rendered by the UI — WA-N3
     *        makes sanitisation the frontend's job; nothing on-chain interprets it.
     * @param metadataURI IPFS hash of the metadata (LP-1.7).
     * @param devBuyUsdg USDG for the creator's own purchase, 0 for none (LP-1.6).
     * @param devBuyMinTokens Slippage floor for that purchase (LP-2.4).
     *
     * The creator provides no liquidity (LP-1.3): virtual reserves set the opening
     * price, so `devBuyUsdg` may be zero and usually is.
     */
    function launch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint256 devBuyUsdg,
        uint256 devBuyMinTokens
    ) external nonReentrant returns (address tokenAddress, address curveAddress) {
        (tokenAddress, curveAddress) = _deployPair(name, symbol, metadataURI);

        if (creationFee > 0) {
            usdg.safeTransferFrom(msg.sender, feeVault, creationFee);
        }

        uint256 devBuyTokens = _devBuy(curveAddress, devBuyUsdg, devBuyMinTokens);

        curveOf[tokenAddress] = curveAddress;
        _launches.push(
            Launch({token: tokenAddress, curve: curveAddress, creator: msg.sender, createdAt: uint64(block.timestamp)})
        );
        _launchesByCreator[msg.sender].push(tokenAddress);

        emit TokenLaunched(
            tokenAddress, curveAddress, msg.sender, name, symbol, metadataURI, devBuyUsdg, devBuyTokens
        );
    }

    /**
     * @dev Deploy the token and its curve. Split out of `launch` to keep both
     *      inside the stack limit without reaching for `via_ir` — the legacy
     *      pipeline produces bytecode that is simpler to review, which matters
     *      more than usual for a contract that can never be patched.
     */
    function _deployPair(string calldata name, string calldata symbol, string calldata metadataURI)
        private
        returns (address tokenAddress, address curveAddress)
    {
        // The token is minted to this factory first, then handed to the curve.
        // The alternative — predicting the curve address with CREATE2 — buys
        // nothing and adds a way to get the address wrong.
        HoodiumToken token =
            new HoodiumToken(name, symbol, tokenDecimals, totalSupply, address(this), msg.sender, metadataURI);

        BondingCurve curve = new BondingCurve(
            BondingCurve.CurveConfig({
                usdg: address(usdg),
                token: address(token),
                creator: msg.sender,
                feeVault: feeVault,
                graduationManager: graduationManager,
                virtualUsdg: virtualUsdg,
                virtualTokens: virtualTokens,
                curveAllocation: curveAllocation,
                lpAllocation: lpAllocation,
                graduationTarget: graduationTarget,
                graduationFee: graduationFee,
                tradeFeeBps: tradeFeeBps,
                creatorFeeShareBps: creatorFeeShareBps,
                snipeBlocks: snipeBlocks,
                snipeMaxTokens: Math.mulDiv(totalSupply, snipeMaxBps, BPS)
            })
        );

        IERC20(address(token)).safeTransfer(address(curve), totalSupply);

        return (address(token), address(curve));
    }

    /// @dev LP-1.6 — the creator's purchase, inside the deployment transaction.
    function _devBuy(address curveAddress, uint256 devBuyUsdg, uint256 minTokens)
        private
        returns (uint256 devBuyTokens)
    {
        if (devBuyUsdg == 0) return 0;

        BondingCurve curve = BondingCurve(curveAddress);

        // Quote first so the cap is enforced on tokens received, not on USDG
        // spent — the cap in LP-1.6 is "a percentage of supply".
        (uint256 quoted,,,) = curve.quoteBuy(devBuyUsdg);
        uint256 cap = devBuyCapTokens();
        if (quoted > cap) revert DevBuyTooLarge(quoted, cap);

        usdg.safeTransferFrom(msg.sender, address(this), devBuyUsdg);
        usdg.forceApprove(curveAddress, devBuyUsdg);
        devBuyTokens = curve.devBuy(msg.sender, devBuyUsdg, minTokens);
        usdg.forceApprove(curveAddress, 0);
    }
}
