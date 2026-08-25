// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/**
 * AUDIT — atomicity at EVERY external step of graduation, with a full state
 * snapshot rather than the two fields Graduation.t.sol checks.
 *
 * Graduation now runs inside the completing buy (AUDIT H2), so a fault in any
 * step reverts that buy as a whole. Steps in BondingCurve._graduate /
 * GraduationManager.migrate:
 *   1. graduation fee accrued (no transfer — AUDIT M2)
 *   2. usdg.approve / token.approve (manager)
 *   3. token.transferFrom(curve -> manager)
 *   4. usdg.transferFrom(curve -> manager)
 *   5. uniswapFactory.createPool            (Graduation.t.sol)
 *   6. pool.initialize / pool.swap          (Graduation.t.sol)
 *   7. positionManager.mint                 (Graduation.t.sol)
 *   8. positionManager.safeTransferFrom -> locker.onERC721Received
 *   9. dust credited (no transfer — AUDIT M2)
 *  10. positionManager.positions (for the Migrated event)
 *  11. approvals reset to 0
 */
contract GraduationAtomicityAuditTest is BaseTest {
    uint256 constant FEE = 1_000 * USDG_UNIT;

    HoodiumToken token;
    BondingCurve curve;

    struct Snap {
        bool graduated;
        uint256 reserveUsdg;
        uint256 tokensSold;
        uint256 creatorFeesAccrued;
        uint256 platformFeesAccrued;
        uint256 creatorFeesClaimed;
        uint256 platformFeesClaimed;
        uint256 curveUsdg;
        uint256 curveToken;
        uint256 vaultUsdg;
        uint256 managerUsdg;
        uint256 managerToken;
        uint256 creatorUsdg;
        uint256 creatorToken;
        uint256 allowUsdg;
        uint256 allowToken;
        uint256 locked;
        uint256 aliceUsdg;
        uint256 aliceToken;
    }

    function setUp() public override {
        super.setUp();
        Terms memory t = _defaultTerms();
        t.graduationFee = FEE;
        t.creationFee = 0;
        _deployStack(address(usdg), t);
        (token, curve) = _launch();
        _skipSnipeWindow();

        // Fill to within 1 USDG of the target; the next buy graduates.
        _fillAlmost(curve, alice);
        _fund(alice, 100_000 * USDG_UNIT);
        vm.prank(alice);
        usdg.approve(address(curve), type(uint256).max);
    }

    function _snap() internal view returns (Snap memory s) {
        s.graduated = curve.graduated();
        s.reserveUsdg = curve.reserveUsdg();
        s.tokensSold = curve.tokensSold();
        s.creatorFeesAccrued = curve.creatorFeesAccrued();
        s.platformFeesAccrued = curve.platformFeesAccrued();
        s.creatorFeesClaimed = curve.creatorFeesClaimed();
        s.platformFeesClaimed = curve.platformFeesClaimed();
        s.curveUsdg = usdg.balanceOf(address(curve));
        s.curveToken = token.balanceOf(address(curve));
        s.vaultUsdg = usdg.balanceOf(address(vault));
        s.managerUsdg = usdg.balanceOf(address(manager));
        s.managerToken = token.balanceOf(address(manager));
        s.creatorUsdg = usdg.balanceOf(creator);
        s.creatorToken = token.balanceOf(creator);
        s.allowUsdg = usdg.allowance(address(curve), address(manager));
        s.allowToken = token.allowance(address(curve), address(manager));
        s.locked = locker.lockedCount();
        s.aliceUsdg = usdg.balanceOf(alice);
        s.aliceToken = token.balanceOf(alice);
    }

    function _assertSame(Snap memory a, Snap memory b) internal pure {
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)), "curve/system state changed after a reverted graduation");
    }

    /// Oversized on purpose: it clamps at the target, so it completes the curve
    /// however far a preceding sell reopened it.
    function _completingBuy() internal {
        vm.prank(alice);
        curve.buy(50_000 * USDG_UNIT, 0, block.timestamp);
    }

    /// Revert-inject, assert byte-identical snapshot, then prove the curve is still
    /// tradeable AND that graduation succeeds once the fault is cleared.
    function _runWithFault() internal {
        Snap memory before = _snap();
        assertFalse(before.graduated);
        assertEq(before.allowUsdg, 0);
        assertEq(before.allowToken, 0);

        vm.expectRevert();
        _completingBuy();

        _assertSame(before, _snap());

        // Still tradeable: sell some, buy it back.
        uint256 held = token.balanceOf(alice);
        vm.startPrank(alice);
        token.approve(address(curve), held / 100);
        uint256 got = curve.sell(held / 100, 0, block.timestamp);
        assertGt(got, 0);
        curve.buy(got / 2, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());

        vm.clearMockedCalls();
        uniFactory.setFailCreate(false);
        pm.setFailMint(false);
        _completingBuy();
        assertTrue(curve.graduated());
        assertTrue(curve.pool() != address(0));
        assertEq(pm.ownerOf(curve.lpTokenId()), address(locker));
        assertEq(usdg.allowance(address(curve), address(manager)), 0);
        assertEq(token.allowance(address(curve), address(manager)), 0);
    }

    /**
     * AUDIT M2 — nothing is pushed to the vault or the creator during
     * graduation, so a frozen or reverting recipient cannot block it. Every
     * outbound USDG transfer to either is made to revert, and graduation still
     * succeeds; the fee accrues and the dust is credited.
     */
    function test_regression_M2_graduationPushesNothingToVaultOrCreator() public {
        pm.setDustBps(50); // force some dust so the credit path is exercised
        vm.mockCallRevert(address(usdg), abi.encodeWithSelector(IERC20.transfer.selector, address(vault)), "vault frozen");
        vm.mockCallRevert(address(usdg), abi.encodeWithSelector(IERC20.transfer.selector, creator), "creator frozen");
        vm.mockCallRevert(address(token), abi.encodeWithSelector(IERC20.transfer.selector, creator), "creator frozen");

        Snap memory before = _snap();
        _completingBuy();
        Snap memory after_ = _snap();

        assertTrue(after_.graduated);
        assertEq(after_.vaultUsdg, before.vaultUsdg, "USDG pushed to the vault");
        assertEq(after_.creatorUsdg, before.creatorUsdg, "USDG pushed to the creator");
        assertEq(after_.creatorToken, before.creatorToken, "tokens pushed to the creator");
        uint256 accrued = after_.platformFeesAccrued - before.platformFeesAccrued;
        assertGe(accrued, FEE, "graduation fee not accrued");
        assertLt(accrued - FEE, 1 * USDG_UNIT, "more than the completing buy's trade fee on top");
        assertEq(after_.curveUsdg, after_.creatorFeesAccrued + after_.platformFeesAccrued, "curve holds != owed fees");
        assertGt(manager.dustOf(address(usdg), creator), 0, "dust not credited");
        assertEq(after_.managerUsdg, manager.dustOf(address(usdg), creator), "manager holds more than the credit");
    }

    function test_audit_atomicity_step3_tokenPullIntoManagerFails() public {
        vm.mockCallRevert(
            address(token), abi.encodeWithSelector(IERC20.transferFrom.selector, address(curve), address(manager)),
            "token pull failed"
        );
        _runWithFault();
    }

    function test_audit_atomicity_step4_usdgPullIntoManagerFails() public {
        vm.mockCallRevert(
            address(usdg), abi.encodeWithSelector(IERC20.transferFrom.selector, address(curve), address(manager)),
            "usdg pull failed"
        );
        _runWithFault();
    }

    function test_audit_atomicity_step8_lockerRejectsPosition() public {
        vm.mockCallRevert(
            address(locker), abi.encodeWithSelector(IERC721Receiver.onERC721Received.selector), "locker down"
        );
        _runWithFault();
    }

    function test_audit_atomicity_step10_positionsReadFails() public {
        vm.mockCallRevert(
            address(pm), abi.encodeWithSelector(INonfungiblePositionManager.positions.selector), "positions down"
        );
        _runWithFault();
    }

    function test_audit_atomicity_poolCreateFails() public {
        uniFactory.setFailCreate(true);
        _runWithFault();
    }

    function test_audit_atomicity_mintFails() public {
        pm.setFailMint(true);
        _runWithFault();
    }

    /// A manager with no code: the completing buy has nothing to call —
    /// it reverts and the curve is intact.
    function test_audit_atomicity_managerWithoutCode() public {
        vm.etch(address(manager), "");
        Snap memory before = _snap();
        vm.expectRevert();
        _completingBuy();
        _assertSame(before, _snap());
    }
}
