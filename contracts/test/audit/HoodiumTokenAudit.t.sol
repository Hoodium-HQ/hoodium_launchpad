// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";

/**
 * AUDIT PoCs — HoodiumToken fixed-supply / no-privilege claims, and the
 * pre-graduation transfer surface.
 */
contract HoodiumTokenAuditTest is BaseTest {
    HoodiumToken token;
    BondingCurve curve;

    function setUp() public override {
        super.setUp();
        (token, curve) = _launch();
        _skipSnipeWindow();
    }

    /// No mint, burn, permit, owner, pause, blocklist or metadata setter exists.
    function test_token_hasNoPrivilegedOrSupplyChangingSelectors() public {
        string[12] memory sigs = [
            "mint(address,uint256)",
            "burn(uint256)",
            "burnFrom(address,uint256)",
            "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
            "owner()",
            "transferOwnership(address)",
            "setMetadataURI(string)",
            "pause()",
            "blacklist(address)",
            "setDecimals(uint8)",
            "DOMAIN_SEPARATOR()",
            "nonces(address)"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(token).call(abi.encodeWithSignature(sigs[i], address(this), uint256(1)));
            assertFalse(ok, sigs[i]);
        }
    }

    /// Supply, decimals and metadata are constant through the token's life.
    function test_supplyDecimalsMetadata_areConstant() public {
        uint256 supply = token.totalSupply();
        assertEq(supply, TOTAL_SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.metadataURI(), "ipfs://QmTest");

        _buy(curve, alice, 5_000 * USDG_UNIT);
        _sell(curve, token, alice, token.balanceOf(alice) / 2);

        assertEq(token.totalSupply(), supply, "supply moved");
        assertEq(token.metadataURI(), "ipfs://QmTest");
    }

    /// Only the curve and factory ever hold/allow the token; the factory keeps
    /// no balance and no allowance after launch.
    function test_noStandingAllowancesAfterLaunch() public view {
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.allowance(address(factory), address(curve)), 0);
        assertEq(token.allowance(address(curve), graduationManagerStub), 0);
        assertEq(token.allowance(address(curve), address(factory)), 0);
        assertEq(token.balanceOf(address(curve)), TOTAL_SUPPLY);
    }

    /**
     * LOW. Tokens are freely transferable before graduation. Sending them
     * straight to the curve does not change `tokensSold`, so they cannot be
     * sold back through the curve (`ExceedsSold` for the extra) and they are
     * not part of `tokensForLp` at graduation: the curve has no sweep, so they
     * are stranded forever. Holder accounting (`tokensSold`, reserves, k) is
     * unaffected — no bypass of the curve is possible, only self-harm.
     */
    function test_directTransferToCurve_isStrandedNotSellable() public {
        _buy(curve, alice, 5_000 * USDG_UNIT);
        uint256 held = token.balanceOf(alice);
        uint256 soldBefore = curve.tokensSold();
        uint256 kBefore = curve.currentK();

        vm.prank(alice);
        token.transfer(address(curve), held / 2);

        assertEq(curve.tokensSold(), soldBefore, "tokensSold moved on a donation");
        assertEq(curve.currentK(), kBefore, "k moved on a donation");

        // Bob receives the other half OTC and can sell it: transfers are open.
        vm.prank(alice);
        token.transfer(bob, held - held / 2);
        _sell(curve, token, bob, held - held / 2);

        // Nobody can sell more than tokensSold, so the donation is unreachable.
        assertEq(curve.tokensSold(), soldBefore - (held - held / 2));
        assertGt(token.balanceOf(address(curve)), TOTAL_SUPPLY - curve.tokensSold(), "donation not in curve");
    }

    /// The curve refuses to be sold more than it has sold.
    function test_cannotSellMoreThanTokensSold() public {
        _buy(curve, alice, 1_000 * USDG_UNIT);
        uint256 sold = curve.tokensSold();
        vm.startPrank(alice);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.ExceedsSold.selector);
        curve.sell(sold + 1, 0);
        vm.stopPrank();
    }
}
