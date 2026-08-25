// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {MockHdm} from "./mocks/MockHdm.sol";

/**
 * The launch fee paid in HDM and burned.
 *
 * Two claims are on trial here, and both are about supply rather than about
 * revenue: a launch that succeeds always destroyed the fee, and a launch that
 * fails never did.
 */
contract LaunchFeeBurnTest is BaseTest {
    MockHdm internal hdm;
    uint256 internal constant BURN = 1_000e18;

    event LaunchFeeBurned(address indexed creator, uint256 amount);

    function setUp() public override {
        super.setUp();
        hdm = new MockHdm();

        Terms memory t = _defaultTerms();
        t.hdm = address(hdm);
        t.hdmLaunchBurn = BURN;
        _deployStack(address(usdg), t);

        hdm.mint(creator, 10_000e18);
    }

    function _approveAll(uint256 usdgAmount) internal {
        usdg.mint(creator, usdgAmount);
        vm.startPrank(creator);
        usdg.approve(address(factory), usdgAmount);
        hdm.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    function test_launchBurnsTheFeeFromTheCreator() public {
        _approveAll(factory.creationFee());
        uint256 supplyBefore = hdm.totalSupply();

        vm.prank(creator);
        vm.expectEmit(true, false, false, true, address(factory));
        emit LaunchFeeBurned(creator, BURN);
        factory.launch("Test Token", "TEST", "ipfs://QmTest", 0, 0);

        assertEq(hdm.balanceOf(creator), 10_000e18 - BURN);
        assertEq(hdm.totalSupply(), supplyBefore - BURN);
        // Burned, not collected: the vault holds no HDM at any point.
        assertEq(hdm.balanceOf(address(vault)), 0);
        assertEq(hdm.balanceOf(address(factory)), 0);
    }

    function test_launchNeedsAnHdmAllowance() public {
        usdg.mint(creator, factory.creationFee());
        vm.startPrank(creator);
        usdg.approve(address(factory), factory.creationFee());
        // No HDM approval: the launch cannot proceed.
        vm.expectRevert();
        factory.launch("Test Token", "TEST", "ipfs://QmTest", 0, 0);
        vm.stopPrank();
    }

    function test_launchNeedsTheHdmItself() public {
        address broke = makeAddr("broke");
        usdg.mint(broke, factory.creationFee());
        vm.startPrank(broke);
        usdg.approve(address(factory), factory.creationFee());
        hdm.approve(address(factory), type(uint256).max);
        vm.expectRevert();
        factory.launch("Test Token", "TEST", "ipfs://QmTest", 0, 0);
        vm.stopPrank();
    }

    function test_oneApprovalIsNotTwoLaunches() public {
        _approveAll(factory.creationFee() * 2);
        vm.startPrank(creator);
        hdm.approve(address(factory), BURN); // exactly one launch
        factory.launch("One", "ONE", "ipfs://QmOne", 0, 0);

        vm.expectRevert();
        factory.launch("Two", "TWO", "ipfs://QmTwo", 0, 0);
        vm.stopPrank();
    }

    function test_aRevertedLaunchBurnsNothing() public {
        _approveAll(factory.creationFee() + 1_000_000 * USDG_UNIT);
        uint256 supplyBefore = hdm.totalSupply();

        // A dev buy over the cap reverts the whole launch after the burn line.
        vm.prank(creator);
        vm.expectRevert();
        factory.launch("Test Token", "TEST", "ipfs://QmTest", 1_000_000 * USDG_UNIT, 0);

        assertEq(hdm.totalSupply(), supplyBefore);
        assertEq(hdm.balanceOf(creator), 10_000e18);
    }

    function test_severalLaunchesCompound() public {
        _approveAll(factory.creationFee() * 3);
        uint256 supplyBefore = hdm.totalSupply();
        vm.startPrank(creator);
        factory.launch("A", "A", "ipfs://QmA", 0, 0);
        factory.launch("B", "B", "ipfs://QmB", 0, 0);
        factory.launch("C", "C", "ipfs://QmC", 0, 0);
        vm.stopPrank();
        assertEq(hdm.totalSupply(), supplyBefore - 3 * BURN);
    }

    function test_aFactoryWithoutHdmChargesNothingExtra() public {
        // The configuration this factory shipped with, and the one it keeps
        // until HDM exists: no address, no burn, launches unaffected.
        Terms memory t = _defaultTerms();
        _deployStack(address(usdg), t);
        assertEq(factory.hdm(), address(0));
        assertEq(factory.hdmLaunchBurn(), 0);

        (HoodiumToken token,) = _launch();
        assertTrue(address(token) != address(0));
    }

    function test_constructorRefusesABurnWithoutAToken() public {
        Terms memory t = _defaultTerms();
        vm.expectRevert(bytes("hdm/burn mismatch"));
        new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: t.totalSupply,
                curveAllocation: t.curveAllocation,
                graduationTarget: t.graduationTarget,
                graduationFee: t.graduationFee,
                tradeFeeBps: t.tradeFeeBps,
                creatorFeeShareBps: t.creatorFeeShareBps,
                creationFee: t.creationFee,
                hdm: address(0),
                hdmLaunchBurn: BURN,
                devBuyMaxBps: t.devBuyMaxBps,
                snipeBlocks: t.snipeBlocks,
                snipeMaxBps: t.snipeMaxBps
            })
        );
    }
}
