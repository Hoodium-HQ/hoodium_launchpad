// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockPositionManager, MockUniswapFactory, MockUniswapPool} from "./mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../src/interfaces/IUniswapV3.sol";

/**
 * T2.5 (atomicity), T2.7 (lock), and the LP-4.x graduation criteria.
 *
 * T2.4 — "fork test: full graduation against real Uniswap contracts" — is NOT
 * covered here and cannot be: it needs an RPC to fork from, and Robinhood Chain's
 * Uniswap deployment addresses are unknown (004 section 10 open question 3).
 * These tests cover the call sequence and its failure modes; they do not prove
 * Uniswap itself behaves as assumed.
 */
contract GraduationTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;
    uint256 constant TOTAL_SUPPLY = 1_000_000_000 * TOKEN_UNIT;
    uint256 constant CURVE_ALLOCATION = 800_000_000 * TOKEN_UNIT;
    uint256 constant GRADUATION_TARGET = 69_000 * USDG_UNIT;
    uint256 constant GRADUATION_FEE = 1_000 * USDG_UNIT;
    /// T0.4 — protocol's share of post-graduation pool fees. 30%, creator keeps 70%.
    uint256 constant PROTOCOL_FEE_SHARE_BPS = 3_000;

    MockUSDG usdg;
    FeeVault vault;
    MockUniswapFactory uniFactory;
    MockPositionManager positionManager;
    LPLocker locker;
    GraduationManager manager;
    HoodiumFactory factory;

    HoodiumToken token;
    BondingCurve curve;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address randomCaller = makeAddr("randomCaller");

    function setUp() public {
        usdg = new MockUSDG();

        address[] memory owners = new address[](3);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        owners[2] = makeAddr("s3");
        vault = new FeeVault(owners, 2);

        uniFactory = new MockUniswapFactory();
        positionManager = new MockPositionManager();
        locker = new LPLocker(address(positionManager), address(vault), PROTOCOL_FEE_SHARE_BPS);
        manager = new GraduationManager(
            address(uniFactory), address(positionManager), address(locker), address(usdg), 10_000, 200
        );

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: TOTAL_SUPPLY,
                curveAllocation: CURVE_ALLOCATION,
                virtualUsdg: 12_000 * USDG_UNIT,
                graduationTarget: GRADUATION_TARGET,
                graduationFee: GRADUATION_FEE,
                tradeFeeBps: 100,
                creatorFeeShareBps: 1_000,
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
    }

    function _fillCurve() internal {
        uint256 amount = 200_000 * USDG_UNIT;
        usdg.mint(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        curve.buy(amount, 0);
        vm.stopPrank();
        assertTrue(curve.curveComplete(), "curve should be complete");
    }

    // ── LP-4.1, LP-4.6 ───────────────────────────────────────────────────────

    function test_graduate_createsPoolAndLocksPosition() public {
        _fillCurve();
        uint256 vaultBefore = usdg.balanceOf(address(vault));

        // LP-4.6 — permissionless. A stranger calls it, not the platform.
        vm.prank(randomCaller);
        (address pool, uint256 tokenId) = curve.graduate();

        assertTrue(pool != address(0), "pool not created");
        assertTrue(curve.graduated(), "curve not marked graduated");
        assertEq(curve.reserveUsdg(), 0, "reserves not migrated");
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, GRADUATION_FEE, "graduation fee not paid");

        // LP-4.3 — the position lives in the locker, not with the platform.
        assertEq(positionManager.ownerOf(tokenId), address(locker), "position not locked");
        assertEq(locker.beneficiaryOf(tokenId), creator, "creator should be the fee beneficiary");
    }

    function test_graduate_beforeTarget_reverts() public {
        vm.expectRevert(BondingCurve.TargetNotReached.selector);
        curve.graduate();
    }

    function test_graduate_twice_reverts() public {
        _fillCurve();
        curve.graduate();
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.graduate();
    }

    /// LP-4.4 — the curve permanently refuses trades after graduation.
    function test_tradingDisabledAfterGraduation() public {
        _fillCurve();
        uint256 held = token.balanceOf(alice);
        curve.graduate();

        usdg.mint(alice, 1_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), 1_000 * USDG_UNIT);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.buy(1_000 * USDG_UNIT, 0);

        token.approve(address(curve), held);
        vm.expectRevert(BondingCurve.AlreadyGraduated.selector);
        curve.sell(held, 0);
        vm.stopPrank();
    }

    function test_allUnsoldTokensGoToThePool() public {
        _fillCurve();
        uint256 curveTokensBefore = token.balanceOf(address(curve));
        curve.graduate();

        assertEq(token.balanceOf(address(curve)), 0, "curve kept tokens back");
        assertEq(token.balanceOf(address(positionManager)), curveTokensBefore, "pool did not receive them");
    }

    // ── T2.5 — atomicity (LP-4.2) ────────────────────────────────────────────

    function test_atomicity_poolCreationFailure_revertsEverything() public {
        _fillCurve();
        uniFactory.setFailCreate(true);

        uint256 reserveBefore = curve.reserveUsdg();
        vm.expectRevert();
        curve.graduate();

        _assertCurveUntouched(reserveBefore);
    }

    function test_atomicity_poolInitializeFailure_revertsEverything() public {
        _fillCurve();
        // Pre-create the pool so we can arm its failure switch.
        (address t0, address t1) =
            address(token) < address(usdg) ? (address(token), address(usdg)) : (address(usdg), address(token));
        address pool = uniFactory.createPool(t0, t1, 10_000);
        MockUniswapPool(pool).setFailInitialize(true);

        uint256 reserveBefore = curve.reserveUsdg();
        vm.expectRevert();
        curve.graduate();

        _assertCurveUntouched(reserveBefore);
    }

    function test_atomicity_mintFailure_revertsEverything() public {
        _fillCurve();
        positionManager.setFailMint(true);

        uint256 reserveBefore = curve.reserveUsdg();
        vm.expectRevert();
        curve.graduate();

        _assertCurveUntouched(reserveBefore);
    }

    /**
     * @dev The point of LP-4.2: after a failed migration the curve must be
     *      exactly as it was, and still tradeable. A half-migrated curve with
     *      `graduated = true` and no pool would strand every holder.
     */
    function _assertCurveUntouched(uint256 reserveBefore) private {
        assertFalse(curve.graduated(), "graduated flag survived a reverted migration");
        assertEq(curve.reserveUsdg(), reserveBefore, "reserve changed");
        assertEq(usdg.balanceOf(address(curve)) >= curve.reserveUsdg(), true, "curve went insolvent");

        // And still tradeable: sell back into it.
        uint256 held = token.balanceOf(alice);
        vm.startPrank(alice);
        token.approve(address(curve), held / 100);
        uint256 out = curve.sell(held / 100, 0);
        vm.stopPrank();
        assertGt(out, 0, "curve is no longer tradeable after a failed graduation");
    }

    // ── T2.7 — locked principal is unrecoverable (LP-4.3) ────────────────────

    function test_lockedPosition_cannotBeMovedByAnyone() public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();

        // Creator cannot take it.
        vm.prank(creator);
        vm.expectRevert();
        positionManager.safeTransferFrom(address(locker), creator, tokenId);

        // Neither can the graduation manager that put it there.
        vm.prank(address(manager));
        vm.expectRevert();
        positionManager.safeTransferFrom(address(locker), address(manager), tokenId);

        // Nor a stranger.
        vm.prank(randomCaller);
        vm.expectRevert();
        positionManager.safeTransferFrom(address(locker), randomCaller, tokenId);

        assertEq(positionManager.ownerOf(tokenId), address(locker), "position moved");
    }

    /// Credit `amount` of USDG as accrued fees on a locked position.
    function _creditUsdgFees(uint256 tokenId, uint256 amount) private {
        usdg.mint(address(positionManager), amount);
        (address t0,) =
            address(token) < address(usdg) ? (address(token), address(usdg)) : (address(usdg), address(token));
        bool usdgIsToken1 = t0 == address(token);
        positionManager.creditFees(tokenId, usdgIsToken1 ? 0 : amount, usdgIsToken1 ? amount : 0);
    }

    /// T0.4 — fees split 70/30, and the collection still cannot reach principal.
    function test_lockedPosition_feesSplitBetweenCreatorAndProtocol() public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();

        _creditUsdgFees(tokenId, 500 * USDG_UNIT);

        // Only the creator may trigger it. The protocol cannot sweep on its own —
        // it is paid when the creator claims, never instead of them.
        vm.prank(alice);
        vm.expectRevert(LPLocker.NotBeneficiary.selector);
        locker.collectFees(tokenId);

        uint256 creatorBefore = usdg.balanceOf(creator);
        uint256 vaultBefore = usdg.balanceOf(address(vault));

        vm.prank(creator);
        locker.collectFees(tokenId);

        uint256 expectedProtocol = (500 * USDG_UNIT * PROTOCOL_FEE_SHARE_BPS) / 10_000;
        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, expectedProtocol, "protocol share wrong");
        assertEq(
            usdg.balanceOf(creator) - creatorBefore, 500 * USDG_UNIT - expectedProtocol, "creator share wrong"
        );

        // Nothing is left stranded in the locker.
        assertEq(usdg.balanceOf(address(locker)), 0, "locker retained fees");

        // Liquidity is untouched by a fee collection.
        (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(tokenId);
        assertGt(liquidity, 0, "principal moved");
    }

    /// When the split cannot divide evenly, the remainder is the creator's.
    function test_lockedPosition_dustFavoursTheCreator() public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();

        // 3 wei: 30% of it rounds down to zero.
        _creditUsdgFees(tokenId, 3);

        uint256 creatorBefore = usdg.balanceOf(creator);
        uint256 vaultBefore = usdg.balanceOf(address(vault));

        vm.prank(creator);
        locker.collectFees(tokenId);

        assertEq(usdg.balanceOf(address(vault)) - vaultBefore, 0, "protocol took the dust");
        assertEq(usdg.balanceOf(creator) - creatorBefore, 3, "creator did not get the dust");
    }

    /// The split is public and immutable — a creator can read it before launching.
    function test_locker_publishesItsSplit() public view {
        assertEq(locker.protocolFeeShareBps(), PROTOCOL_FEE_SHARE_BPS, "split not readable");
        assertEq(locker.feeVault(), address(vault), "vault not readable");
    }

    /**
     * The contract is immutable, so a mistyped constructor argument is permanent.
     * No deployment may take the majority of a creator's pool fees.
     */
    function test_locker_refusesAShareAboveTheCeiling() public {
        uint256 ceiling = locker.MAX_PROTOCOL_FEE_SHARE_BPS();

        vm.expectRevert(bytes("share too high"));
        new LPLocker(address(positionManager), address(vault), ceiling + 1);

        // The ceiling itself is allowed — it is a limit, not an exclusion.
        LPLocker atCeiling = new LPLocker(address(positionManager), address(vault), ceiling);
        assertEq(atCeiling.protocolFeeShareBps(), ceiling);
    }

    function test_locker_rejectsPositionsFromNonPositionManager() public {
        vm.prank(alice);
        vm.expectRevert(LPLocker.NotPositionManager.selector);
        locker.onERC721Received(alice, alice, 999, abi.encode(address(token), alice));
    }

    // ── Dust handling ────────────────────────────────────────────────────────

    function test_migrationDust_returnsToCreator() public {
        positionManager.setDustBps(100); // Uniswap uses 99% of each side
        _fillCurve();

        uint256 creatorTokensBefore = token.balanceOf(creator);
        uint256 creatorUsdgBefore = usdg.balanceOf(creator);
        curve.graduate();

        assertGt(token.balanceOf(creator) - creatorTokensBefore, 0, "token dust stranded");
        assertGt(usdg.balanceOf(creator) - creatorUsdgBefore, 0, "usdg dust stranded");
        assertEq(usdg.balanceOf(address(manager)), 0, "manager retained funds");
        assertEq(token.balanceOf(address(manager)), 0, "manager retained funds");
    }
}
