// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MockUSDG, FeeOnTransferUSDG} from "../mocks/MockUSDG.sol";
import {MockPositionManager, MockUniswapFactory} from "../mocks/MockUniswap.sol";
import {INonfungiblePositionManager} from "../../src/interfaces/IUniswapV3.sol";

/// A beneficiary with no way to call anything: a contract that only receives.
contract DumbContract {}

/**
 * AUDIT PoCs — LPLocker.
 */
contract LPLockerAuditTest is Test {
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;

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
    address attacker = makeAddr("attacker");

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
                graduationFee: 0,
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
    }

    function _fillCurve() internal {
        uint256 amount = 200_000 * USDG_UNIT;
        usdg.mint(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(curve), amount);
        curve.buy(amount, 0);
        vm.stopPrank();
    }

    function _usdgIsToken1() internal view returns (bool) {
        return address(token) < address(usdg);
    }

    function _creditUsdg(uint256 tokenId, uint256 amount) internal {
        usdg.mint(address(pm), amount);
        pm.creditFees(tokenId, _usdgIsToken1() ? 0 : amount, _usdgIsToken1() ? amount : 0);
    }

    // ── No withdrawal surface ────────────────────────────────────────────────

    /// Every selector a withdrawal path could hide behind reverts: the locker
    /// has no fallback, so an unknown selector is a hard revert. It cannot
    /// receive ETH either.
    function test_locker_hasNoHiddenSelectorsAndRejectsEth() public {
        string[12] memory sigs = [
            "approve(address,uint256)",
            "setApprovalForAll(address,bool)",
            "transferFrom(address,address,uint256)",
            "safeTransferFrom(address,address,uint256)",
            "decreaseLiquidity(uint256)",
            "burn(uint256)",
            "withdraw(uint256)",
            "multicall(bytes[])",
            "execute(address,bytes)",
            "upgradeTo(address)",
            "setBeneficiary(uint256,address)",
            "setFeeVault(address)"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(locker).call(abi.encodeWithSignature(sigs[i], uint256(1), address(this)));
            assertFalse(ok, sigs[i]);
        }
        vm.deal(address(this), 1 ether);
        (bool sent,) = address(locker).call{value: 1}("");
        assertFalse(sent, "locker accepted ETH");
    }

    /// The locker never grants an operator approval on the position manager,
    /// so nobody — not even the beneficiary — is authorised for the token.
    function test_locker_neverGrantsOperatorApproval() public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();

        _creditUsdg(tokenId, 100 * USDG_UNIT);
        vm.prank(creator);
        locker.collectFees(tokenId);

        assertEq(pm.getApproved(tokenId), address(0), "token-level approval granted");
        assertFalse(pm.isApprovedForAll(address(locker), creator), "creator is operator");
        assertFalse(pm.isApprovedForAll(address(locker), address(manager)), "manager is operator");
        assertFalse(pm.isApprovedForAll(address(locker), address(vault)), "vault is operator");
        assertEq(pm.ownerOf(tokenId), address(locker));
    }

    // ── Rounding / split ─────────────────────────────────────────────────────

    /// creator + protocol == collected, protocol == floor(collected * bps / 1e4).
    function testFuzz_split_conservesAndRoundsAgainstProtocol(uint128 fees) public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();
        _creditUsdg(tokenId, fees);

        uint256 c0 = usdg.balanceOf(creator);
        uint256 v0 = usdg.balanceOf(address(vault));
        vm.prank(creator);
        locker.collectFees(tokenId);

        uint256 toCreator = usdg.balanceOf(creator) - c0;
        uint256 toVault = usdg.balanceOf(address(vault)) - v0;
        assertEq(toCreator + toVault, fees, "split does not conserve");
        assertEq(toVault, uint256(fees) * 3_000 / 10_000, "protocol did not round down");
        assertEq(usdg.balanceOf(address(locker)), 0, "locker retained");
    }

    /// Zero accrued fees: no transfers, no revert.
    function test_collectFees_withNothingOwed_doesNotRevert() public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();
        vm.prank(creator);
        (uint256 a, uint256 b) = locker.collectFees(tokenId);
        assertEq(a + b, 0);
    }

    // ── Beneficiary is fixed forever ─────────────────────────────────────────

    /**
     * LOW. The beneficiary is the curve's `creator` (msg.sender of launch) and
     * can never change. A creator that is a contract with no ability to call
     * `collectFees` — or an EOA whose key is lost — strands 100% of that pool's
     * fees forever, including the protocol's 30%. There is no fallback path.
     */
    function test_contractCreatorWithoutCallPath_strandsAllFeesForever() public {
        DumbContract dumb = new DumbContract();
        vm.prank(address(dumb));
        (address t, address c) = factory.launch("Dumb", "DUMB", "ipfs://y", 0, 0);
        BondingCurve dumbCurve = BondingCurve(c);
        vm.roll(block.number + 4);

        usdg.mint(alice, 200_000 * USDG_UNIT);
        vm.startPrank(alice);
        usdg.approve(address(dumbCurve), type(uint256).max);
        dumbCurve.buy(200_000 * USDG_UNIT, 0);
        vm.stopPrank();
        (, uint256 tokenId) = dumbCurve.graduate();
        assertEq(locker.beneficiaryOf(tokenId), address(dumb));

        usdg.mint(address(pm), 1_000 * USDG_UNIT);
        bool usdgIs1 = t < address(usdg);
        pm.creditFees(tokenId, usdgIs1 ? 0 : 1_000 * USDG_UNIT, usdgIs1 ? 1_000 * USDG_UNIT : 0);

        // Nobody else can trigger it — not the vault signers, not the manager.
        address[] memory callers = new address[](4);
        callers[0] = makeAddr("s1");
        callers[1] = address(manager);
        callers[2] = address(vault);
        callers[3] = attacker;
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(LPLocker.NotBeneficiary.selector);
            locker.collectFees(tokenId);
        }
    }

    // ── Anyone can lock anything, labelled as anything ───────────────────────

    /**
     * LOW. `onERC721Received` only checks msg.sender == positionManager, and
     * `GraduationManager.migrate` is permissionless. Any NFT holder can lock any
     * position in the locker and label it with a legitimate launch token and
     * themselves as beneficiary; `migrate` additionally emits `Migrated` for a
     * token that has not graduated. The indexer keys graduation off the curve's
     * `Graduated` event, so status is not spoofable, but `PositionLocked(token)`
     * and `tokenOf` are not trustworthy on their own.
     */
    function test_strangerCanLockAPositionLabelledWithSomeoneElsesToken() public {
        // Attacker buys a few tokens from the still-live curve.
        usdg.mint(attacker, 100 * USDG_UNIT);
        vm.startPrank(attacker);
        usdg.approve(address(curve), type(uint256).max);
        curve.buy(100 * USDG_UNIT, 0);
        uint256 held = token.balanceOf(attacker);

        // ... and "migrates" them, before graduation, naming themselves creator.
        token.approve(address(manager), held);
        usdg.mint(attacker, 1 * USDG_UNIT);
        usdg.approve(address(manager), 1 * USDG_UNIT);
        (, uint256 tokenId) = manager.migrate(address(token), held, 1 * USDG_UNIT, attacker);
        vm.stopPrank();

        assertFalse(curve.graduated(), "curve did not graduate");
        assertEq(locker.tokenOf(tokenId), address(token), "labelled with the real launch token");
        assertEq(locker.beneficiaryOf(tokenId), attacker, "attacker is beneficiary");
        assertEq(locker.lockedCount(), 1);

        // The same is possible without the manager: any NPM holder can
        // safeTransferFrom with forged data.
        uint256 id2 = _mintDummyPosition(attacker);
        vm.prank(attacker);
        pm.safeTransferFrom(attacker, address(locker), id2, abi.encode(address(token), attacker));
        assertEq(locker.tokenOf(id2), address(token));
        assertEq(locker.lockedCount(), 2);
    }

    /// A position pushed in with plain `transferFrom` (no callback) has no
    /// beneficiary: principal AND fees are stuck forever. Self-inflicted only.
    function test_unsafeTransferIntoLocker_isUnrecoverableEvenForFees() public {
        uint256 id = _mintDummyPosition(alice);
        vm.prank(alice);
        pm.transferFrom(alice, address(locker), id);
        assertEq(pm.ownerOf(id), address(locker));
        assertEq(locker.beneficiaryOf(id), address(0));
        vm.prank(alice);
        vm.expectRevert(LPLocker.UnknownPosition.selector);
        locker.collectFees(id);
    }

    /// A tokenId can only be registered once; the mapping cannot be overwritten.
    function test_tokenIdCannotBeReRegistered() public {
        _fillCurve();
        (, uint256 tokenId) = curve.graduate();
        vm.prank(address(pm));
        vm.expectRevert(LPLocker.AlreadyLocked.selector);
        locker.onERC721Received(address(0), address(0), tokenId, abi.encode(address(token), attacker));
        assertEq(locker.beneficiaryOf(tokenId), creator);
    }

    // ── Fee-on-transfer pool token bricks collection ─────────────────────────

    /**
     * INFO. If either pool token skims on transfer, `collect` delivers less
     * than it reports and the split transfers revert: fees on that position
     * become uncollectable forever. Not reachable with HoodiumToken (standard)
     * and only reachable via USDG if T0.2 turns out badly — in which case the
     * curve already refuses to launch. Recorded so the dependency is explicit.
     */
    function test_feeOnTransferPoolToken_bricksCollectFees() public {
        FeeOnTransferUSDG fot = new FeeOnTransferUSDG();
        uint256 id = _mintPosition(alice, address(fot), address(usdg));
        vm.prank(alice);
        pm.safeTransferFrom(alice, address(locker), id, abi.encode(address(0), alice));

        fot.mint(address(pm), 1_000e6);
        pm.creditFees(id, 1_000e6, 0);

        vm.prank(alice);
        vm.expectRevert(); // SafeERC20 transfer of more than the locker received
        locker.collectFees(id);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _mintDummyPosition(address to) internal returns (uint256 id) {
        MockUSDG a = new MockUSDG();
        MockUSDG b = new MockUSDG();
        (address t0, address t1) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        return _mintPosition(to, t0, t1);
    }

    function _mintPosition(address to, address t0, address t1) internal returns (uint256 id) {
        if (t0 > t1) (t0, t1) = (t1, t0);
        MockUSDG(t0).mint(address(this), 1e6);
        MockUSDG(t1).mint(address(this), 1e6);
        IERC20(t0).approve(address(pm), 1e6);
        IERC20(t1).approve(address(pm), 1e6);
        (id,,,) = pm.mint(
            INonfungiblePositionManager.MintParams({
                token0: t0,
                token1: t1,
                fee: 10_000,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: 1e6,
                amount1Desired: 1e6,
                amount0Min: 0,
                amount1Min: 0,
                recipient: to,
                deadline: block.timestamp
            })
        );
    }
}
