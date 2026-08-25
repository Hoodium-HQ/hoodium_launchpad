// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "../Base.t.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {MockHdm} from "../mocks/MockHdm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A token whose `burnFrom` reports failure the ERC20-legacy way: it returns
/// false rather than reverting, and destroys nothing.
contract SilentFailBurnToken is ERC20 {
    constructor() ERC20("Silent", "SIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burnFrom(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// An HDM that calls back into the factory during `burnFrom`.
contract ReentrantHdm is ERC20 {
    HoodiumFactory public factory;
    bool internal armed;

    constructor() ERC20("Reentrant", "RHDM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(HoodiumFactory f) external {
        factory = f;
        armed = true;
    }

    function burnFrom(address account, uint256 value) external {
        _spendAllowance(account, msg.sender, value);
        _burn(account, value);
        if (armed) {
            armed = false;
            factory.launch("Re", "RE", "ipfs://Qm", 0, 0);
        }
    }
}

/// Audit scratch tests for the HDM launch-fee burn. Not part of the shipped suite.
contract LaunchFeeBurnAuditTest is BaseTest {
    uint256 internal constant BURN = 1_000e18;

    function _terms(address hdmAddr, uint256 burnAmt) internal pure returns (Terms memory t) {
        t = _defaultTerms();
        t.hdm = hdmAddr;
        t.hdmLaunchBurn = burnAmt;
    }

    /// Construct a factory directly against the fixture's live manager, so a
    /// `vm.expectRevert` targets the constructor under test rather than the
    /// first contract `_deployStack` happens to deploy.
    function _newFactory(address hdmAddr, uint256 burnAmt) internal returns (HoodiumFactory) {
        Terms memory t = _defaultTerms();
        return new HoodiumFactory(
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
                hdm: hdmAddr,
                hdmLaunchBurn: burnAmt,
                devBuyMaxBps: t.devBuyMaxBps,
                snipeBlocks: t.snipeBlocks,
                snipeMaxBps: t.snipeMaxBps
            })
        );
    }

    function _fundAndApprove(address who, address hdmAddr) internal {
        usdg.mint(who, factory.creationFee());
        vm.startPrank(who);
        usdg.approve(address(factory), type(uint256).max);
        if (hdmAddr != address(0)) ERC20(hdmAddr).approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    // ── F1: burnFrom returning false is a silent skip ────────────────────────
    //
    // IERC20Burnable declares `burnFrom` with no return value, so solc decodes
    // nothing and checks nothing. A token that returns false instead of
    // reverting lets the launch through having destroyed no supply.
    /// FIXED: the factory measures supply around the burn, so a token that
    /// reports failure the legacy way can no longer buy a free launch.
    function test_F1_burnFromReturningFalseIsRejected() public {
        SilentFailBurnToken bad = new SilentFailBurnToken();
        _deployStack(address(usdg), _terms(address(bad), BURN));
        bad.mint(creator, 10_000e18);
        _fundAndApprove(creator, address(bad));

        uint256 supplyBefore = bad.totalSupply();

        vm.prank(creator);
        vm.expectRevert(bytes("burn ineffective"));
        factory.launch("Test", "T", "ipfs://Qm", 0, 0);

        assertEq(bad.totalSupply(), supplyBefore);
        assertEq(factory.launchCount(), 0, "no launch escaped without a burn");
    }

    // Control: the real ERC20Burnable reverts, so the same launch fails.
    function test_F1b_aRevertingBurnStopsTheLaunch() public {
        MockHdm good = new MockHdm();
        _deployStack(address(usdg), _terms(address(good), BURN));
        // No HDM minted to the creator.
        _fundAndApprove(creator, address(good));
        vm.prank(creator);
        vm.expectRevert();
        factory.launch("Test", "T", "ipfs://Qm", 0, 0);
    }

    // ── F2: constructor guard is one-directional ─────────────────────────────
    //
    // `hdmLaunchBurn == 0 || hdm != address(0)` accepts a real HDM address with
    // a zero burn. The factory then advertises an HDM launch fee it never
    // charges, permanently — it is immutable and admin-free.
    /// FIXED: the guard is two-directional, so a factory can no longer publish
    /// an HDM address it never charges.
    function test_F2_hdmAddressWithZeroBurnIsRefused() public {
        MockHdm hdm = new MockHdm();
        vm.expectRevert(bytes("hdm/burn mismatch"));
        _newFactory(address(hdm), 0);
    }

    // ── F3: no code check on `hdm` — a typo bricks every launch ──────────────
    /// FIXED: a non-contract `hdm` is refused at construction, so the typo
    /// cannot reach an immutable factory that would brick every launch.
    function test_F3_hdmWithNoCodeIsRefusedAtConstruction() public {
        address typo = address(0xDEAD);
        assertEq(typo.code.length, 0);
        vm.expectRevert(bytes("hdm not a contract"));
        _newFactory(typo, BURN);
    }

    // A contract without burnFrom is the same story.
    function test_F3b_hdmWithoutBurnFromBricksEveryLaunch() public {
        _deployStack(address(usdg), _terms(address(usdg), BURN));
        _fundAndApprove(creator, address(0));
        vm.prank(creator);
        vm.expectRevert();
        factory.launch("Test", "T", "ipfs://Qm", 0, 0);
    }

    // ── F4: the burn cannot be reentered ─────────────────────────────────────
    function test_F4_reentrantHdmCannotLaunchTwiceOnOneBurn() public {
        ReentrantHdm hdm = new ReentrantHdm();
        _deployStack(address(usdg), _terms(address(hdm), BURN));
        hdm.mint(creator, 10_000e18);
        usdg.mint(creator, factory.creationFee() * 4);
        vm.startPrank(creator);
        usdg.approve(address(factory), type(uint256).max);
        hdm.approve(address(factory), type(uint256).max);
        vm.stopPrank();

        hdm.arm(factory);
        vm.prank(creator);
        vm.expectRevert(); // ReentrancyGuardReentrantCall
        factory.launch("Test", "T", "ipfs://Qm", 0, 0);
        assertEq(factory.launchCount(), 0);
    }

    // ── F5: the burn cannot be skipped by self-deploying the pair ────────────
    //
    // Anyone can deploy a HoodiumToken and a BondingCurve directly and never
    // touch the factory, but the result is unregistered: `curveOf` is empty and
    // the manager refuses to graduate it, so the burn gates everything the
    // launchpad actually offers.
    function test_F5_selfDeployedCurveIsNotRegisteredAndCannotGraduate() public {
        MockHdm hdm = new MockHdm();
        _deployStack(address(usdg), _terms(address(hdm), BURN));

        vm.startPrank(attacker);
        HoodiumToken token = new HoodiumToken("Free", "FREE", 18, TOTAL_SUPPLY, attacker, attacker, "ipfs://Qm");
        vm.stopPrank();

        assertEq(hdm.totalSupply(), 0, "no HDM burned");
        assertEq(factory.curveOf(address(token)), address(0), "unknown to the factory");
        assertEq(factory.launchCount(), 0);
        // GraduationManager gates on factory.curveOf(token) == msg.sender.
    }

    // ── F6: every launch path goes through the burn ──────────────────────────
    function test_F6_devBuyPathAlsoBurns() public {
        MockHdm hdm = new MockHdm();
        _deployStack(address(usdg), _terms(address(hdm), BURN));
        hdm.mint(creator, 10_000e18);
        uint256 devBuy = 1_000 * USDG_UNIT;
        usdg.mint(creator, factory.creationFee() + devBuy);
        vm.startPrank(creator);
        usdg.approve(address(factory), type(uint256).max);
        hdm.approve(address(factory), type(uint256).max);
        uint256 before = hdm.totalSupply();
        factory.launch("Test", "T", "ipfs://Qm", devBuy, 0);
        vm.stopPrank();
        assertEq(hdm.totalSupply(), before - BURN);
    }

    // ── F7 (pre-existing, unrelated to the burn): a USDG donation to the
    // factory reverts every dev buy smaller than the donation. ───────────────
    function test_F7_usdgDonationNoLongerDosesDevBuys() public {
        uint256 donation = 5_000 * USDG_UNIT;
        usdg.mint(address(factory), donation); // anyone can do this

        uint256 devBuy = 1_000 * USDG_UNIT; // smaller than the donation
        usdg.mint(creator, factory.creationFee() * 2 + devBuy);
        vm.startPrank(creator);
        usdg.approve(address(factory), type(uint256).max);
        // FIXED: the refund is a delta, so the donation is simply ignored.
        factory.launch("Test", "T", "ipfs://Qm", devBuy, 0);
        factory.launch("Ok", "OK", "ipfs://Qm", 0, 0);
        vm.stopPrank();

        assertEq(factory.launchCount(), 2);
        assertEq(usdg.balanceOf(address(factory)), donation, "the donation stays put");
    }

    // F7b: the donation is not the factory's, but the next big dev buyer keeps it.
    function test_F7b_donationIsNotPaidOutToTheNextDevBuyer() public {
        uint256 donation = 100 * USDG_UNIT;
        usdg.mint(address(factory), donation);

        uint256 devBuy = 1_000 * USDG_UNIT;
        usdg.mint(creator, factory.creationFee() + devBuy);
        uint256 before = usdg.balanceOf(creator);
        vm.startPrank(creator);
        usdg.approve(address(factory), type(uint256).max);
        factory.launch("Test", "T", "ipfs://Qm", devBuy, 0);
        vm.stopPrank();

        // FIXED: the dev buyer pays their own way and the donation is untouched.
        uint256 spent = before - usdg.balanceOf(creator);
        assertEq(spent, factory.creationFee() + devBuy, "no donation pocketed");
        assertEq(usdg.balanceOf(address(factory)), donation);
    }
}
