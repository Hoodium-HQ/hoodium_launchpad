// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockUniswapPool} from "../mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/// A beneficiary with no way to call anything: a contract that only receives.
contract DumbContract {}

/**
 * AUDIT — LPLocker. The "no withdrawal path" claims were sound and stay; the
 * two LOW findings (a stranded beneficiary strands the protocol's share too;
 * anyone could lock anything under any label) are regressions now.
 */
contract LPLockerAuditTest is BaseTest {
    HoodiumToken token;
    BondingCurve curve;

    function setUp() public override {
        super.setUp();
        Terms memory t = _defaultTerms();
        t.creationFee = 0;
        _deployStack(address(usdg), t);
        (token, curve) = _launch();
        _skipSnipeWindow();
    }

    function _usdgIsToken1() internal view returns (bool) {
        return address(token) < address(usdg);
    }

    // ── No withdrawal surface ────────────────────────────────────────────────

    /// Every selector a withdrawal path could hide behind reverts: the locker
    /// has no fallback, so an unknown selector is a hard revert. It cannot
    /// receive ETH either.
    function test_locker_hasNoHiddenSelectorsAndRejectsEth() public {
        string[12] memory sigs = [
            "approve(address,uint256)",
            "setApprovalForAll(address,bool)",
            "transferFrom(address,address,uint256)",
            "safeTransferFrom(address,address,uint256)",
            "decreaseLiquidity(uint256)",
            "burn(uint256)",
            "withdraw(uint256)",
            "multicall(bytes[])",
            "execute(address,bytes)",
            "upgradeTo(address)",
            "setBeneficiary(uint256,address)",
            "setFeeVault(address)"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(locker).call(abi.encodeWithSignature(sigs[i], uint256(1), address(this)));
            assertFalse(ok, sigs[i]);
        }
        vm.deal(address(this), 1 ether);
        (bool sent,) = address(locker).call{value: 1}("");
        assertFalse(sent, "locker accepted ETH");
    }

    /// The locker never grants an operator approval on the position manager,
    /// so nobody — not even the beneficiary — is authorised for the token.
    function test_locker_neverGrantsOperatorApproval() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);

        _creditUsdgFees(address(token), tokenId, 100 * USDG_UNIT);
        vm.prank(creator);
        locker.collectFees(tokenId);
        vm.prank(randomCaller);
        locker.sweepProtocolFees(tokenId);

        assertEq(pm.getApproved(tokenId), address(0), "token-level approval granted");
        assertFalse(pm.isApprovedForAll(address(locker), creator), "creator is operator");
        assertFalse(pm.isApprovedForAll(address(locker), address(manager)), "manager is operator");
        assertFalse(pm.isApprovedForAll(address(locker), address(vault)), "vault is operator");
        assertEq(pm.ownerOf(tokenId), address(locker));
    }

    // ── Rounding / split ─────────────────────────────────────────────────────

    /// creator + protocol == collected, protocol == floor(collected * bps / 1e4).
    function testFuzz_split_conservesAndRoundsAgainstProtocol(uint128 fees) public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        _creditUsdgFees(address(token), tokenId, fees);

        uint256 c0 = usdg.balanceOf(creator);
        uint256 v0 = usdg.balanceOf(address(vault));
        vm.prank(creator);
        locker.collectFees(tokenId);

        uint256 toCreator = usdg.balanceOf(creator) - c0;
        uint256 toVault = usdg.balanceOf(address(vault)) - v0;
        assertEq(toCreator + toVault, fees, "split does not conserve");
        assertEq(toVault, uint256(fees) * PROTOCOL_FEE_SHARE_BPS / 10_000, "protocol did not round down");
        assertEq(usdg.balanceOf(address(locker)), 0, "locker retained");
    }

    /// The same conservation holds when the two entry points are interleaved.
    function testFuzz_split_conservesAcrossSweepAndCollect(uint128 feesA, uint128 feesB) public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        uint256 c0 = usdg.balanceOf(creator);
        uint256 v0 = usdg.balanceOf(address(vault));

        _creditUsdgFees(address(token), tokenId, feesA);
        vm.prank(randomCaller);
        locker.sweepProtocolFees(tokenId);
        _creditUsdgFees(address(token), tokenId, feesB);
        vm.prank(creator);
        locker.collectFees(tokenId);

        uint256 total = uint256(feesA) + uint256(feesB);
        uint256 toCreator = usdg.balanceOf(creator) - c0;
        uint256 toVault = usdg.balanceOf(address(vault)) - v0;
        assertEq(toCreator + toVault, total, "split does not conserve");
        assertEq(
            toVault,
            uint256(feesA) * PROTOCOL_FEE_SHARE_BPS / 10_000 + uint256(feesB) * PROTOCOL_FEE_SHARE_BPS / 10_000
        );
        assertEq(usdg.balanceOf(address(locker)), 0, "locker retained");
    }

    /// Zero accrued fees: no transfers, no revert.
    function test_collectFees_withNothingOwed_doesNotRevert() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        vm.prank(creator);
        (uint256 a, uint256 b) = locker.collectFees(tokenId);
        assertEq(a + b, 0);
        vm.prank(randomCaller);
        locker.sweepProtocolFees(tokenId);
    }

    // ── Beneficiary is fixed forever, but the protocol share is not hostage ──

    /**
     * Was LOW: a creator with no call path stranded 100% of the pool's fees,
     * including the protocol's 30%. Now anyone can sweep the protocol's share
     * to the vault; the creator's share is credited and waits for them. What
     * stays stranded is only what was always theirs to lose.
     */
    function test_regression_contractCreatorWithoutCallPath_protocolShareStillFlows() public {
        DumbContract dumb = new DumbContract();
        vm.prank(address(dumb));
        (address t, address c) = factory.launch("Dumb", "DUMB", "ipfs://y", 0, 0);
        BondingCurve dumbCurve = BondingCurve(c);
        _skipSnipeWindow();

        (, uint256 tokenId) = _fillCurve(dumbCurve, alice);
        assertEq(locker.beneficiaryOf(tokenId), address(dumb));

        _creditUsdgFees(t, tokenId, 1_000 * USDG_UNIT);
        bool usdgIs1 = t < address(usdg);

        // Nobody else can collect *for* the beneficiary...
        address[] memory callers = new address[](4);
        callers[0] = makeAddr("signer1");
        callers[1] = address(manager);
        callers[2] = address(vault);
        callers[3] = attacker;
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LPLocker.NotBeneficiary.selector);
            locker.collectFees(tokenId);
        }

        // ...but anyone can move the protocol's share.
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        vm.prank(attacker);
        locker.sweepProtocolFees(tokenId);
        uint256 protocol = 1_000 * USDG_UNIT * PROTOCOL_FEE_SHARE_BPS / 10_000;
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, protocol, "protocol share not swept");
        uint256 owed = usdgIs1 ? locker.creatorOwed1(tokenId) : locker.creatorOwed0(tokenId);
        assertEq(owed, 1_000 * USDG_UNIT - protocol, "creator share not credited");
        assertEq(usdg.balanceOf(address(dumb)), 0, "creator share was pushed to a contract that cannot use it");
    }

    // ── Only the manager's positions are accepted ────────────────────────────

    /**
     * Was LOW: `onERC721Received` only checked msg.sender == positionManager,
     * and `migrate` was permissionless, so anyone could lock any position under
     * any token/creator label. Both doors are shut.
     */
    function test_regression_strangerCannotLockAPositionLabelledWithSomeoneElsesToken() public {
        usdg.mint(attacker, 100 * USDG_UNIT);
        vm.startPrank(attacker);
        usdg.approve(address(curve), type(uint256).max);
        curve.buy(100 * USDG_UNIT, 0, block.timestamp);
        uint256 held = token.balanceOf(attacker);

        // Through the manager: refused.
        token.approve(address(manager), held);
        usdg.mint(attacker, 1 * USDG_UNIT);
        usdg.approve(address(manager), 1 * USDG_UNIT);
        vm.expectRevert(GraduationManager.NotACurve.selector);
        manager.migrate(address(token), held, 1 * USDG_UNIT, attacker);
        vm.stopPrank();

        // Around the manager, with a real position and forged data: refused.
        uint256 id2 = _mintDummyPosition(attacker);
        vm.prank(attacker);
        vm.expectRevert(LPLocker.NotGraduationManager.selector);
        pm.safeTransferFrom(attacker, address(locker), id2, abi.encode(address(token), attacker));

        assertEq(locker.lockedCount(), 0);
        assertEq(locker.tokenOf(id2), address(0));
        assertEq(pm.ownerOf(id2), attacker);
    }

    /// A position pushed in with plain `transferFrom` (no callback) has no
    /// beneficiary: principal AND fees are stuck forever. Self-inflicted only.
    function test_unsafeTransferIntoLocker_isUnrecoverableEvenForFees() public {
        uint256 id = _mintDummyPosition(alice);
        vm.prank(alice);
        pm.transferFrom(alice, address(locker), id);
        assertEq(pm.ownerOf(id), address(locker));
        assertEq(locker.beneficiaryOf(id), address(0));
        vm.prank(alice);
        vm.expectRevert(LPLocker.UnknownPosition.selector);
        locker.collectFees(id);
        vm.expectRevert(LPLocker.UnknownPosition.selector);
        locker.sweepProtocolFees(id);
    }

    /// A tokenId can only be registered once; the mapping cannot be overwritten.
    function test_tokenIdCannotBeReRegistered() public {
        (, uint256 tokenId) = _fillCurve(curve, alice);
        vm.prank(address(pm));
        vm.expectRevert(LPLocker.AlreadyLocked.selector);
        locker.onERC721Received(address(manager), address(manager), tokenId, abi.encode(address(token), attacker));
        assertEq(locker.beneficiaryOf(tokenId), creator);
    }

    /*
     * INFO, kept for the record: if either pool token skimmed on transfer,
     * `collect` would deliver less than it reports and the split transfers
     * would revert, bricking fee collection on that position. Not reachable:
     * the only positions that can enter are the manager's, whose sides are a
     * HoodiumToken (plain OZ ERC20) and USDG, and the curve already refuses a
     * USDG that does not deliver what was requested.
     */

    // ── helpers ──────────────────────────────────────────────────────────────

    function _mintDummyPosition(address to) internal returns (uint256 id) {
        MockUSDG a = new MockUSDG();
        MockUSDG b = new MockUSDG();
        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        address pool = uniFactory.createPool(t0, t1, POOL_FEE);
        MockUniswapPool(pool).initialize(uint160(Q96)); // 1:1
        MockUSDG(t0).mint(address(this), 1e6);
        MockUSDG(t1).mint(address(this), 1e6);
        IERC20(t0).approve(address(pm), 1e6);
        IERC20(t1).approve(address(pm), 1e6);
        (id,,,) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: 1e6,
                amount1Desired: 1e6,
                amount0Min: 0,
                amount1Min: 0,
                recipient: to,
                deadline: block.timestamp
            })
        );
    }
}
