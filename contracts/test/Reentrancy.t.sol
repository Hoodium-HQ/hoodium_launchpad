// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
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
    /// Number of transfers to let pass before firing, so the hook can be aimed
    /// at a specific step of a multi-transfer call (e.g. inside graduation).
    uint256 public skip;
    uint256 public reentryAttempts;
    bool public lastReentryReverted;
    bytes public lastReentryData;

    constructor() ERC20("Evil USDG", "eUSDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        armAfter(target_, payload_, 0);
    }

    function armAfter(address target_, bytes calldata payload_, uint256 skip_) public {
        target = target_;
        payload = payload_;
        skip = skip_;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (armed && target != address(0)) {
            if (skip > 0) {
                skip--;
                return;
            }
            armed = false; // one shot, so the test terminates
            reentryAttempts++;
            (bool ok, bytes memory data) = target.call(payload);
            lastReentryReverted = !ok;
            lastReentryData = data;
        }
    }
}

contract ReentrancyTest is BaseTest {
    ReentrantUSDG evil;
    HoodiumToken token;
    BondingCurve curve;

    function setUp() public override {
        evil = new ReentrantUSDG();
        Terms memory t = _defaultTerms();
        t.graduationFee = 1_000 * USDG_UNIT;
        t.creatorFeeShareBps = 1_000;
        t.creationFee = 0;
        _deployStack(address(evil), t);

        vm.prank(creator);
        (address tk, address c) = factory.launch("Evil", "EVIL", "ipfs://x", 0, 0);
        token = HoodiumToken(tk);
        curve = BondingCurve(c);
        _skipSnipeWindow();
    }

    function _seed() internal {
        evil.mint(attacker, 500_000 * USDG_UNIT);
        vm.prank(attacker);
        evil.approve(address(curve), type(uint256).max);
    }

    function _buyAs(address who, uint256 amount) internal {
        vm.prank(who);
        curve.buy(amount, 0, block.timestamp);
    }

    function test_reentry_intoBuy_isBlocked() public {
        _seed();
        evil.arm(address(curve), abi.encodeCall(BondingCurve.buy, (1_000 * USDG_UNIT, 0, block.timestamp)));

        _buyAs(attacker, 5_000 * USDG_UNIT);

        assertEq(evil.reentryAttempts(), 1, "the attack did not fire");
        assertTrue(evil.lastReentryReverted(), "reentrant buy was not blocked");
    }

    function test_reentry_intoSell_isBlocked() public {
        _seed();
        _buyAs(attacker, 5_000 * USDG_UNIT);

        uint256 held = token.balanceOf(attacker);
        vm.prank(attacker);
        token.approve(address(curve), type(uint256).max);

        evil.arm(address(curve), abi.encodeCall(BondingCurve.sell, (held / 4, 0, block.timestamp)));

        vm.prank(attacker);
        curve.sell(held / 2, 0, block.timestamp);

        assertEq(evil.reentryAttempts(), 1, "the attack did not fire");
        assertTrue(evil.lastReentryReverted(), "reentrant sell was not blocked");
    }

    function test_reentry_intoClaimCreatorFees_isBlocked() public {
        _seed();
        _buyAs(attacker, 5_000 * USDG_UNIT);

        evil.arm(address(curve), abi.encodeCall(BondingCurve.claimCreatorFees, ()));

        vm.prank(creator);
        curve.claimCreatorFees();

        assertEq(evil.reentryAttempts(), 1, "the attack did not fire");
        assertTrue(evil.lastReentryReverted(), "reentrant claim was not blocked");
    }

    /**
     * Graduation runs inside the completing buy. The USDG transfers in that call
     * are: (1) buyer → curve, (2) curve → manager, (3) manager → pool. The hook
     * is aimed at (2), i.e. mid-migration, and tries to re-enter `graduate()`.
     * The outer call must succeed — the previous version of this test let the
     * outer call fail and asserted nothing.
     */
    function test_reentry_intoGraduate_isBlocked() public {
        _seed();
        evil.armAfter(address(curve), abi.encodeCall(BondingCurve.graduate, ()), 1);

        _buyAs(attacker, 200_000 * USDG_UNIT);

        assertTrue(curve.graduated(), "the completing buy should have graduated");
        assertEq(evil.reentryAttempts(), 1, "the attack did not fire mid-graduation");
        assertTrue(evil.lastReentryReverted(), "reentrant graduate was not blocked");
        assertEq(locker.lockedCount(), 1, "graduation happened more than once, or not at all");
    }

    function test_reentry_intoBuy_duringGraduation_isBlocked() public {
        _seed();
        evil.armAfter(address(curve), abi.encodeCall(BondingCurve.buy, (1 * USDG_UNIT, 0, block.timestamp)), 1);

        _buyAs(attacker, 200_000 * USDG_UNIT);

        assertTrue(curve.graduated());
        assertEq(evil.reentryAttempts(), 1);
        assertTrue(evil.lastReentryReverted(), "a buy slipped in mid-graduation");
    }

    function test_reentry_intoSell_duringGraduation_isBlocked() public {
        _seed();
        _buyAs(attacker, 5_000 * USDG_UNIT);
        vm.prank(attacker);
        token.approve(address(curve), type(uint256).max);
        evil.armAfter(address(curve), abi.encodeCall(BondingCurve.sell, (1, 0, block.timestamp)), 1);

        _buyAs(attacker, 200_000 * USDG_UNIT);

        assertTrue(curve.graduated());
        assertEq(evil.reentryAttempts(), 1);
        assertTrue(evil.lastReentryReverted(), "a sell slipped in mid-graduation");
    }

    /**
     * The reserve is credited before the transfer, so even a successful reentry
     * would price against updated state. This asserts the ordering directly.
     */
    function test_reserveIsUpdatedBeforeTheTransferReturns() public {
        _seed();
        // `reserveUsdg` is a public variable, so its getter has no function
        // member to reference with `encodeCall`.
        evil.arm(address(curve), abi.encodeWithSignature("reserveUsdg()"));

        _buyAs(attacker, 5_000 * USDG_UNIT);

        // A view call is not blocked by the guard, so it succeeds — and it must
        // have observed the post-trade reserve.
        assertEq(evil.reentryAttempts(), 1);
        assertFalse(evil.lastReentryReverted(), "a view reentry should not revert");
        assertGt(abi.decode(evil.lastReentryData(), (uint256)), 0, "reentry saw a stale reserve");
    }
}

/**
 * T0.2 — "Confirm USDG decimals, transfer semantics, and whether any
 * fee-on-transfer or blocklist behavior exists. **Blocking** — a blocklisted
 * curve address would freeze reserves permanently."
 *
 * The fork probe found real USDG to be a plain 6-decimal token with no transfer
 * fee. These assert what the contracts do if that ever changes, so the failure
 * is a loud revert at launch rather than a silently under-reserved curve.
 */
contract FeeOnTransferTest is BaseTest {
    FeeOnTransferUSDG fot;
    BondingCurve curve;

    function setUp() public override {
        fot = new FeeOnTransferUSDG();
        Terms memory t = _defaultTerms();
        t.creationFee = 0;
        _deployStack(address(fot), t);

        vm.prank(creator);
        (, address c) = factory.launch("FoT", "FOT", "ipfs://x", 0, 0);
        curve = BondingCurve(c);
        _skipSnipeWindow();
    }

    function test_feeOnTransferUsdg_isRejectedLoudly() public {
        fot.mint(alice, 10_000 * USDG_UNIT);
        vm.startPrank(alice);
        fot.approve(address(curve), type(uint256).max);

        // Not "works but under-reserves" — a hard revert naming the cause.
        vm.expectRevert(BondingCurve.UnsupportedTokenBehaviour.selector);
        curve.buy(1_000 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
    }
}
