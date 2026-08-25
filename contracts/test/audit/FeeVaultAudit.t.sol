// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/**
 * AUDIT — FeeVault m-of-n multisig.
 */
contract FeeVaultAuditTest is Test {
    MockUSDG usdg;
    FeeVault vault;
    address s1 = makeAddr("s1");
    address s2 = makeAddr("s2");
    address s3 = makeAddr("s3");
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

    /// The vault exposes nothing beyond propose/confirm/revoke/execute: no
    /// approve, no arbitrary call, no ETH withdrawal, no signer management.
    function test_vault_hasNoArbitraryCallOrApproveSurface() public {
        string[9] memory sigs = [
            "approve(address,address,uint256)",
            "call(address,bytes)",
            "execute(address,uint256,bytes)",
            "executeTransaction(address,uint256,bytes)",
            "withdrawEth(address,uint256)",
            "addOwner(address)",
            "removeOwner(address)",
            "changeThreshold(uint256)",
            "revoke(uint256)"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(vault).call(abi.encodeWithSignature(sigs[i], address(usdg), address(this), 1));
            assertFalse(ok, sigs[i]);
        }
    }

    /// LOW (L7, accepted). No receive/fallback: ETH cannot be sent normally, but
    /// ETH forced in (selfdestruct / coinbase) is stranded with no withdrawal
    /// path. The vault only ever receives USDG; a recovery path for a token it
    /// never handles is more surface than it is worth.
    function test_forcedEth_isStrandedForever() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "vault accepted ETH");

        vm.deal(address(vault), 1 ether); // simulates selfdestruct/coinbase
        assertEq(address(vault).balance, 1 ether);
        // `asset = address(0)` is rejected by SafeERC20 (no code), so ETH can
        // never be proposed out.
        vm.prank(s1);
        uint256 id = vault.propose(address(0), payee, 1 ether);
        vm.prank(s2);
        vault.confirm(id);
        vm.prank(s1);
        vm.expectRevert();
        vault.execute(id);
    }

    /**
     * Was LOW (L3): proposals never expired and confirmations could not be
     * revoked, so a confirmation given years ago was a standing half-quorum.
     * Now a proposal dies after PROPOSAL_TTL and a confirmation can be pulled
     * while it is live.
     */
    function test_regression_staleProposal_cannotExecuteYearsLater() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 5_000e6);
        uint256 deadline = vault.expiresAt(id);

        vm.warp(block.timestamp + 5 * 365 days);

        vm.prank(s3);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.ProposalExpired.selector, id, deadline));
        vault.confirm(id);
        vm.prank(s3);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.ProposalExpired.selector, id, deadline));
        vault.execute(id);
        assertEq(usdg.balanceOf(payee), 0);
    }

    function test_regression_compromisedSignersConfirmation_isRevocable() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 5_000e6);
        vm.prank(s2);
        vault.confirm(id);

        // s2 realises their key is exposed and withdraws before anyone executes.
        vm.prank(s2);
        vault.revokeConfirmation(id);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.ThresholdNotMet.selector, 1, 2));
        vault.execute(id);
        assertEq(usdg.balanceOf(payee), 0);
    }

    /**
     * LOW (L4), documented: threshold == owners.length is accepted by the
     * contract; losing one key then locks every asset forever, and no signer
     * rotation exists. The deploy script refuses this shape unless
     * ALLOW_FULL_THRESHOLD=true is set explicitly.
     */
    function test_thresholdEqualsOwners_oneLostKey_locksFundsForever() public {
        address[] memory owners = new address[](2);
        owners[0] = s1;
        owners[1] = s2;
        FeeVault v = new FeeVault(owners, 2);
        usdg.mint(address(v), 1e6);

        // s2's key is gone. s1 alone can never reach quorum.
        vm.prank(s1);
        uint256 id = v.propose(address(usdg), payee, 1e6);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(FeeVault.ThresholdNotMet.selector, 1, 2));
        v.execute(id);
        (bool ok,) = address(v).call(abi.encodeWithSignature("addOwner(address)", s3));
        assertFalse(ok);
    }

    /// The executor need not have confirmed; quorum is what matters. Executed
    /// proposals cannot be confirmed or re-executed; ids never repeat.
    function test_executeByNonConfirmer_thenNoReplay() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 1e6);
        vm.prank(s2);
        vault.confirm(id);
        vm.prank(s3);
        vault.execute(id);
        assertEq(usdg.balanceOf(payee), 1e6);

        vm.prank(s3);
        vm.expectRevert(FeeVault.AlreadyExecuted.selector);
        vault.confirm(id);
        vm.prank(s3);
        vm.expectRevert(FeeVault.AlreadyExecuted.selector);
        vault.execute(id);

        vm.prank(s1);
        uint256 id2 = vault.propose(address(usdg), payee, 1e6);
        assertEq(id2, id + 1, "id reused");
    }

    /// A proposal for more than the balance is harmless: it reverts at execute
    /// and can be executed later once the balance exists, within its TTL.
    function test_overdrawnProposal_revertsThenSucceedsWhenFunded() public {
        vm.prank(s1);
        uint256 id = vault.propose(address(usdg), payee, 50_000e6);
        vm.prank(s2);
        vault.confirm(id);
        vm.prank(s1);
        vm.expectRevert();
        vault.execute(id);

        usdg.mint(address(vault), 50_000e6);
        vm.prank(s1);
        vault.execute(id);
        assertEq(usdg.balanceOf(payee), 50_000e6);
    }
}
