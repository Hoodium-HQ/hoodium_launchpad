// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockPositionManager, MockUniswapFactory} from "../mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/**
 * AUDIT — atomicity at EVERY external step of graduate(), with a full state
 * snapshot rather than the two fields Graduation.t.sol checks.
 *
 * Steps in BondingCurve.graduate / GraduationManager.migrate:
 *   1. usdg.transfer(feeVault, graduationFee)
 *   2. usdg.approve / token.approve (manager)
 *   3. token.transferFrom(curve -> manager)
 *   4. usdg.transferFrom(curve -> manager)
 *   5. uniswapFactory.createPool            (covered by existing test)
 *   6. pool.initialize                      (covered by existing test)
 *   7. positionManager.mint                 (covered by existing test)
 *   8. positionManager.safeTransferFrom -> locker.onERC721Received
 *   9. dust sweep transfers to creator
 *  10. positionManager.positions (for the Migrated event)
 *  11. approvals reset to 0
 */
contract GraduationAtomicityAuditTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;
    uint256 constant GRADUATION_FEE = 1_000 * USDG_UNIT;

    MockUSDG usdg;
    FeeVault vault;
    MockUniswapFactory uniFactory;
    MockPositionManager pm;
    LPLocker locker;
    GraduationManager manager;
    HoodiumFactory factory;
    HoodiumToken token;
    BondingCurve curve;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

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
    }

    function setUp() public {
        usdg = new MockUSDG();
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        vault = new FeeVault(owners, 2);

        uniFactory = new MockUniswapFactory();
        pm = new MockPositionManager();
        locker = new LPLocker(address(pm), address(vault), 3_000);
        manager = new GraduationManager(address(uniFactory), address(pm), address(locker), address(usdg), 10_000, 200);

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: 800_000_000 * TOKEN_UNIT,
                virtualUsdg: 12_000 * USDG_UNIT,
                graduationTarget: 69_000 * USDG_UNIT,
                graduationFee: GRADUATION_FEE,
                tradeFeeBps: 100,
                creatorFeeShareBps: 7_000,
                creationFee: 0,
                devBuyMaxBps: 500,
                snipeBlocks: 3,
                snipeMaxBps: 100
            })
        );

        vm.prank(creator);
        (address t, address c) = factory.launch("Grad", "GRAD", "ipfs://x", 0, 0);
        token = HoodiumToken(t);
        curve = BondingCurve(c);
        vm.roll(block.number + 4);

        // Fill the curve.
        usdg.mint(alice, 200_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), type(uint256).max);
        curve.buy(200_000 * USDG_UNIT, 0);
        vm.stopPrank();
        assertTrue(curve.curveComplete());
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
    }

    function _assertSame(Snap memory a, Snap memory b) internal pure {
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)), "curve/system state changed after a reverted graduation");
    }

    /// Revert-inject, assert byte-identical snapshot, then prove the curve is still
    /// tradeable AND that graduation succeeds once the fault is cleared.
    function _runWithFault() internal {
        Snap memory before = _snap();
        assertFalse(before.graduated);
        assertEq(before.allowUsdg, 0);
        assertEq(before.allowToken, 0);

        vm.expectRevert();
        curve.graduate();

        _assertSame(before, _snap());

        // Still tradeable: sell some, buy it back to re-complete the curve.
        uint256 held = token.balanceOf(alice);
        vm.startPrank(alice);
        token.approve(address(curve), held / 100);
        uint256 got = curve.sell(held / 100, 0);
        assertGt(got, 0);
        assertFalse(curve.curveComplete(), "a sell after completion re-opens the curve");
        curve.buy(got * 2, 0); // alice still has USDG from setUp funding
        vm.stopPrank();
        assertTrue(curve.curveComplete());

        vm.clearMockedCalls();
        uniFactory.setFailCreate(false);
        pm.setFailMint(false);
        (address pool, uint256 tokenId) = curve.graduate();
        assertTrue(pool != address(0));
        assertEq(pm.ownerOf(tokenId), address(locker));
        assertTrue(curve.graduated());
        assertEq(usdg.allowance(address(curve), address(manager)), 0);
        assertEq(token.allowance(address(curve), address(manager)), 0);
    }

    function test_audit_atomicity_step1_graduationFeeTransferFails() public {
        vm.mockCallRevert(
            address(usdg), abi.encodeCall(IERC20.transfer, (address(vault), GRADUATION_FEE)), "usdg: vault blocked"
        );
        _runWithFault();
    }

    function test_audit_atomicity_step3_tokenPullIntoManagerFails() public {
        uint256 tokensForLp = curve.lpAllocation() + curve.curveAllocation() - curve.tokensSold();
        vm.mockCallRevert(
            address(token),
            abi.encodeCall(IERC20.transferFrom, (address(curve), address(manager), tokensForLp)),
            "token pull failed"
        );
        _runWithFault();
    }

    function test_audit_atomicity_step4_usdgPullIntoManagerFails() public {
        uint256 usdgForLp = curve.reserveUsdg() - GRADUATION_FEE;
        vm.mockCallRevert(
            address(usdg),
            abi.encodeCall(IERC20.transferFrom, (address(curve), address(manager), usdgForLp)),
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

    function test_audit_atomicity_step9_dustSweepFails() public {
        pm.setDustBps(100); // force dust so the sweep actually transfers
        // Any transfer(creator, *) from the manager — prefix-matched calldata.
        vm.mockCallRevert(address(token), abi.encodeWithSelector(IERC20.transfer.selector, creator), "creator blocked");
        _runWithFault();
    }

    function test_audit_atomicity_step10_positionsReadFails() public {
        vm.mockCallRevert(
            address(pm), abi.encodeWithSelector(INonfungiblePositionManager.positions.selector), "positions down"
        );
        _runWithFault();
    }

    /// A stub manager with no code (the Reentrancy.t.sol / Base.t.sol fixture):
    /// SafeERC20.forceApprove to a no-code manager is fine, but migrate() has
    /// nothing to call — graduation reverts and the curve is intact.
    function test_audit_atomicity_managerWithoutCode() public {
        vm.etch(address(manager), "");
        Snap memory before = _snap();
        vm.expectRevert();
        curve.graduate();
        _assertSame(before, _snap());
    }
}
