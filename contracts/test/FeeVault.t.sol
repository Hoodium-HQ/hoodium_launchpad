// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/// T1.12 / LP-3.5 — "The platform vault SHALL be a multisig, never an EOA."
contract FeeVaultTest is Test {
    MockUSDG usdg;
    FeeVault vault;

    address s1 = makeAddr("s1");
    address s2 = makeAddr("s2");
    address s3 = makeAddr("s3");
    address outsider = makeAddr("outsider");
    address payee = makeAddr("payee");

    function setUp() public {
        usdg = new MockUSDG();
        address[] memory owners = new address[](3);
        owners[0] = s1;
        owners[1] = s2;
        owners[2] = s3;
        vault = new FeeVault(owners, 2);
        usdg.mint(address(vault), 10_000e6);
    }

    /// A threshold of 1 is an EOA wearing a costume. The constructor refuses it.
    function test_constructor_rejectsSingleSignerThreshold() public {
        address[] memory owners = new address[](1);
        owners[0] = s1;
        vm.expectRevert("threshold must exceed 1");
        new FeeVault(owners, 1);
    }

    function test_constructor_rejectsThresholdAboveOwnerCount() public {
        address[] memory owners = new address[](2);
        owners[0] = s1;
        owners[1] = s2;
        vm.expectRevert("threshold > owners");
        new FeeVault(owners, 3);
    }

    function test_constructor_rejectsDuplicateOwners() public {
        address[] memory owners = new address[](2);
        owners[0] = s1;
        owners[1] = s1;
        vm.expectRevert("duplicate owner");
        new FeeVault(owners, 2);
    }

    function test_singleOwnerCannotMoveFunds() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 1_000e6);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.ThresholdNotMet.selector, 1, 2));
        vault.execute(id);

        assertEq(usdg.balanceOf(payee), 0);
    }

    function test_quorumMovesFunds() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 1_000e6);

        vm.prank(s2);
        vault.confirm(id);

        vm.prank(s1);
        vault.execute(id);

        assertEq(usdg.balanceOf(payee), 1_000e6);
    }

    function test_outsiderCannotProposeConfirmOrExecute() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 1_000e6);

        vm.startPrank(outsider);
        vm.expectRevert(FeeVault.NotOwner.selector);
        vault.propose(address(usdg), outsider, 1e6);
        vm.expectRevert(FeeVault.NotOwner.selector);
        vault.confirm(id);
        vm.expectRevert(FeeVault.NotOwner.selector);
        vault.execute(id);
        vm.stopPrank();
    }

    function test_cannotConfirmTwice() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 1_000e6);

        vm.prank(s1); // proposing already counted
        vm.expectRevert(FeeVault.AlreadyConfirmed.selector);
        vault.confirm(id);
    }

    function test_cannotExecuteTwice() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 1_000e6);
        vm.prank(s2);
        vault.confirm(id);
        vm.prank(s1);
        vault.execute(id);

        vm.prank(s1);
        vm.expectRevert(FeeVault.AlreadyExecuted.selector);
        vault.execute(id);
    }

    function test_ownerSetIsImmutable() public {
        string[3] memory setters = ["addOwner(address)", "removeOwner(address)", "setThreshold(uint256)"];
        for (uint256 i = 0; i < setters.length; i++) {
            (bool ok,) = address(vault).call(abi.encodeWithSignature(setters[i], s1));
            assertFalse(ok, "owner set is mutable");
        }
    }
}
