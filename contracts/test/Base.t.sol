// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";

/**
 * Shared fixture. Parameters are design.md section 2's proposed values.
 *
 * Those values are explicitly "placeholders until modelled against real data"
 * (T0.1, blocking for T2.1). The tests below assert *properties* rather than
 * specific numbers precisely so that re-parameterising after T0.1 does not
 * invalidate them.
 */
abstract contract BaseTest is Test {
    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant TOKEN_UNIT = 1e18;

    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000 * TOKEN_UNIT;
    uint256 internal constant CURVE_ALLOCATION = 800_000_000 * TOKEN_UNIT;
    uint256 internal constant VIRTUAL_USDG = 12_000 * USDG_UNIT;
    uint256 internal constant GRADUATION_TARGET = 69_000 * USDG_UNIT;
    /*
     * Zero, and a creator share of 70%, because that is what Deploy.s.sol now
     * ships — the fixture tracks the configuration that will actually be
     * deployed, so the suite exercises the real terms rather than an abandoned
     * set. The graduation-fee *mechanism* is still covered: Graduation.t.sol
     * builds its own factory with a non-zero fee, since a later deployment may
     * charge one.
     */
    uint256 internal constant GRADUATION_FEE = 0;
    uint256 internal constant CREATION_FEE = 1 * USDG_UNIT;
    uint256 internal constant TRADE_FEE_BPS = 100; // 1%
    uint256 internal constant CREATOR_SHARE_BPS = 7_000; // 70% of fees
    uint256 internal constant SNIPE_BLOCKS = 3;
    uint256 internal constant SNIPE_MAX_BPS = 100; // 1% of supply
    uint256 internal constant DEV_BUY_MAX_BPS = 500; // 5% of supply

    MockUSDG internal usdg;
    FeeVault internal vault;
    HoodiumFactory internal factory;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal graduationManagerStub = makeAddr("graduationManager");

    function setUp() public virtual {
        usdg = new MockUSDG();

        address[] memory owners = new address[](3);
        owners[0] = makeAddr("signer1");
        owners[1] = makeAddr("signer2");
        owners[2] = makeAddr("signer3");
        vault = new FeeVault(owners, 2);

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: graduationManagerStub,
                tokenDecimals: 18,
                totalSupply: TOTAL_SUPPLY,
                curveAllocation: CURVE_ALLOCATION,
                virtualUsdg: VIRTUAL_USDG,
                graduationTarget: GRADUATION_TARGET,
                graduationFee: GRADUATION_FEE,
                tradeFeeBps: TRADE_FEE_BPS,
                creatorFeeShareBps: CREATOR_SHARE_BPS,
                creationFee: CREATION_FEE,
                devBuyMaxBps: DEV_BUY_MAX_BPS,
                snipeBlocks: SNIPE_BLOCKS,
                snipeMaxBps: SNIPE_MAX_BPS
            })
        );
    }

    /// Launch as `creator`, funding the creation fee the deployed factory charges.
    function _launch() internal returns (HoodiumToken token, BondingCurve curve) {
        usdg.mint(creator, CREATION_FEE);
        vm.startPrank(creator);
        usdg.approve(address(factory), CREATION_FEE);
        (address t, address c) = factory.launch("Test Token", "TEST", "ipfs://QmTest", 0, 0);
        vm.stopPrank();
        return (HoodiumToken(t), BondingCurve(c));
    }

    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
    }

    /// Buy as `who`, handling approval. Past the anti-snipe window by default.
    function _buy(BondingCurve curve, address who, uint256 usdgIn) internal returns (uint256 tokensOut) {
        _fund(who, usdgIn);
        vm.startPrank(who);
        usdg.approve(address(curve), usdgIn);
        tokensOut = curve.buy(usdgIn, 0);
        vm.stopPrank();
    }

    function _sell(BondingCurve curve, HoodiumToken token, address who, uint256 tokensIn)
        internal
        returns (uint256 usdgOut)
    {
        vm.startPrank(who);
        token.approve(address(curve), tokensIn);
        usdgOut = curve.sell(tokensIn, 0);
        vm.stopPrank();
    }

    /// Move past the anti-snipe window so ordinary trades are not capped.
    function _skipSnipeWindow() internal {
        vm.roll(block.number + SNIPE_BLOCKS + 1);
    }
}
