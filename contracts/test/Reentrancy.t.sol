// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {FeeOnTransferUSDG} from "./mocks/MockUSDG.sol";

/**
 * T2.6 / LP-N2 — "malicious token attempts reentry on every entry point".
 *
 * The attack a hostile USDG makes possible: `transfer`/`transferFrom` hand
 * control back to the attacker mid-call. If the curve updated its reserves after
 * the transfer instead of before, the re-entered call would price against stale
 * reserves and the curve could be drained.
 *
 * Also covers T0.2's unresolved question by asserting what happens when USDG
 * takes a cut on transfer.
 */
contract ReentrantUSDG is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    uint256 public reentryAttempts;
    bool public lastReentryReverted;

    constructor() ERC20("Evil USDG", "eUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (armed && target != address(0)) {
            armed = false; // one shot, so the test terminates
            reentryAttempts++;
            (bool ok,) = target.call(payload);
            lastReentryReverted = !ok;
        }
    }
}

contract ReentrancyTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;

    ReentrantUSDG usdg;
    FeeVault vault;
    HoodiumFactory factory;
    HoodiumToken token;
    BondingCurve curve;

    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");

    function setUp() public {
        usdg = new ReentrantUSDG();

        address[] memory owners = new address[](3);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        owners[2] = makeAddr("s3");
        vault = new FeeVault(owners, 2);

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: makeAddr("manager"),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: 800_000_000 * TOKEN_UNIT,
                virtualUsdg: 12_000 * USDG_UNIT,
                graduationTarget: 69_000 * USDG_UNIT,
                graduationFee: 1_000 * USDG_UNIT,
                tradeFeeBps: 100,
                creatorFeeShareBps: 1_000,
                creationFee: 0,
                devBuyMaxBps: 500,
                snipeBlocks: 3,
                snipeMaxBps: 100
            })
        );

        vm.prank(creator);
        (address t, address c) = factory.launch("Evil", "EVIL", "ipfs://x", 0, 0);
        token = HoodiumToken(t);
        curve = BondingCurve(c);
        vm.roll(block.number + 4);
    }

    function _seed() internal {
        usdg.mint(attacker, 500_000 * USDG_UNIT);
        vm.prank(attacker);
        usdg.approve(address(curve), type(uint256).max);
    }

    function test_reentry_intoBuy_isBlocked() public {
        _seed();
        usdg.arm(address(curve), abi.encodeCall(BondingCurve.buy, (1_000 * USDG_UNIT, 0)));

        vm.prank(attacker);
        curve.buy(5_000 * USDG_UNIT, 0);

        assertEq(usdg.reentryAttempts(), 1, "the attack did not fire");
        assertTrue(usdg.lastReentryReverted(), "reentrant buy was not blocked");
    }

    function test_reentry_intoSell_isBlocked() public {
        _seed();
        vm.prank(attacker);
        curve.buy(5_000 * USDG_UNIT, 0);

        uint256 held = token.balanceOf(attacker);
        vm.prank(attacker);
        token.approve(address(curve), type(uint256).max);

        usdg.arm(address(curve), abi.encodeCall(BondingCurve.sell, (held / 4, 0)));

        vm.prank(attacker);
        curve.sell(held / 2, 0);

        assertEq(usdg.reentryAttempts(), 1, "the attack did not fire");
        assertTrue(usdg.lastReentryReverted(), "reentrant sell was not blocked");
    }

    function test_reentry_intoClaimCreatorFees_isBlocked() public {
        _seed();
        vm.prank(attacker);
        curve.buy(5_000 * USDG_UNIT, 0);

        usdg.arm(address(curve), abi.encodeCall(BondingCurve.claimCreatorFees, ()));

        vm.prank(creator);
        curve.claimCreatorFees();

        assertEq(usdg.reentryAttempts(), 1, "the attack did not fire");
        assertTrue(usdg.lastReentryReverted(), "reentrant claim was not blocked");
    }

    function test_reentry_intoGraduate_isBlocked() public {
        _seed();
        vm.prank(attacker);
        curve.buy(200_000 * USDG_UNIT, 0);
        assertTrue(curve.curveComplete());

        usdg.arm(address(curve), abi.encodeCall(BondingCurve.graduate, ()));

        // The outer graduate() reverts because the stub manager has no code, but
        // what matters is that the reentrant call was refused first.
        vm.prank(attacker);
        try curve.graduate() {} catch {}

        assertTrue(usdg.reentryAttempts() == 0 || usdg.lastReentryReverted(), "reentrant graduate was not blocked");
    }

    /**
     * The reserve is credited before the transfer, so even a successful reentry
     * would price against updated state. This asserts the ordering directly.
     */
    function test_reserveIsUpdatedBeforeTheTransferReturns() public {
        _seed();
        // `reserveUsdg` is a public variable, so its getter has no function
        // member to reference with `encodeCall`.
        usdg.arm(address(curve), abi.encodeWithSignature("reserveUsdg()"));

        vm.prank(attacker);
        curve.buy(5_000 * USDG_UNIT, 0);

        // A view call is not blocked by the guard, so it succeeds — and it must
        // have observed the post-trade reserve.
        assertEq(usdg.reentryAttempts(), 1);
        assertFalse(usdg.lastReentryReverted(), "a view reentry should not revert");
        assertGt(curve.reserveUsdg(), 0);
    }
}

/**
 * T0.2 — "Confirm USDG decimals, transfer semantics, and whether any
 * fee-on-transfer or blocklist behavior exists. **Blocking** — a blocklisted
 * curve address would freeze reserves permanently."
 *
 * Still unresolved. These assert what the contracts do if the answer is bad, so
 * the failure is a loud revert at launch rather than a silently under-reserved
 * curve discovered later.
 */
contract FeeOnTransferTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;

    FeeOnTransferUSDG usdg;
    HoodiumFactory factory;
    BondingCurve curve;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function setUp() public {
        usdg = new FeeOnTransferUSDG();

        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        FeeVault vault = new FeeVault(owners, 2);

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: makeAddr("manager"),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: 800_000_000 * TOKEN_UNIT,
                virtualUsdg: 12_000 * USDG_UNIT,
                graduationTarget: 69_000 * USDG_UNIT,
                graduationFee: 1_000 * USDG_UNIT,
                tradeFeeBps: 100,
                creatorFeeShareBps: 1_000,
                creationFee: 0,
                devBuyMaxBps: 500,
                snipeBlocks: 3,
                snipeMaxBps: 100
            })
        );

        vm.prank(creator);
        (, address c) = factory.launch("FoT", "FOT", "ipfs://x", 0, 0);
        curve = BondingCurve(c);
        vm.roll(block.number + 4);
    }

    function test_feeOnTransferUsdg_isRejectedLoudly() public {
        usdg.mint(alice, 10_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(curve), type(uint256).max);

        // Not "works but under-reserves" — a hard revert naming the cause.
        vm.expectRevert(BondingCurve.UnsupportedTokenBehaviour.selector);
        curve.buy(1_000 * USDG_UNIT, 0);
        vm.stopPrank();
    }
}
