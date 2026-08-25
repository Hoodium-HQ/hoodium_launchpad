// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockPositionManager, MockUniswapFactory, MockUniswapPool} from "../mocks/MockUniswap.sol";

/**
 * AUDIT — factory -> curve -> manager -> locker trust boundaries, the sell-before-
 * graduate griefing, and the dev-buy refund path.
 */
contract TrustBoundariesAuditTest is Test {
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

    event Migrated(
        address indexed token,
        address indexed pool,
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amountToken,
        uint256 amountUsdg
    );
    event PositionLocked(uint256 indexed tokenId, address indexed token, address indexed beneficiary);

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

        factory = _newFactory(800_000_000 * TOKEN_UNIT);

        vm.prank(creator);
        (address t, address c) = factory.launch("Grad", "GRAD", "ipfs://x", 0, 0);
        token = HoodiumToken(t);
        curve = BondingCurve(c);
        vm.roll(block.number + 4);
    }

    function _newFactory(uint256 curveAllocation) internal returns (HoodiumFactory) {
        return new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: address(usdg),
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: curveAllocation,
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
    }

    function _buy(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(curve), amount);
        curve.buy(amount, 0);
        vm.stopPrank();
    }

    // ── GraduationManager.migrate is open to anyone with any token ───────────

    /// A stranger can drive the real manager with a token it made up. The real
    /// manager emits Migrated and the real locker emits PositionLocked for it.
    function test_audit_migrate_acceptsAnyCallerAndAnyToken() public {
        MockUSDG fake = new MockUSDG(); // any ERC-20 the attacker controls
        fake.mint(attacker, 1_000 * TOKEN_UNIT);
        usdg.mint(attacker, 10 * USDG_UNIT);

        vm.startPrank(attacker);
        fake.approve(address(manager), type(uint256).max);
        usdg.approve(address(manager), type(uint256).max);

        vm.expectEmit(true, false, false, false, address(locker));
        emit PositionLocked(1, address(fake), attacker);
        vm.expectEmit(true, false, false, false, address(manager));
        emit Migrated(address(fake), address(0), 1, 0, 0, 0);
        (address pool, uint256 tokenId) = manager.migrate(address(fake), 1_000 * TOKEN_UNIT, 10 * USDG_UNIT, attacker);
        vm.stopPrank();

        assertTrue(pool != address(0));
        assertEq(locker.beneficiaryOf(tokenId), attacker);
        assertEq(locker.tokenOf(tokenId), address(fake));
    }

    /// Worse: with the REAL launched token, before the curve graduates. The
    /// attacker becomes the first PositionLocked beneficiary for that token and
    /// the pool is created + initialised at the attacker's ratio via the
    /// manager itself (no direct Uniswap interaction needed). The later, real
    /// graduation then reuses that pool as-is.
    function test_audit_migrate_realTokenPreGraduation_primesPoolAndLocker() public {
        _buy(attacker, 1_000 * USDG_UNIT);
        uint256 have = token.balanceOf(attacker);
        usdg.mint(attacker, 1);

        vm.startPrank(attacker);
        token.approve(address(manager), have);
        usdg.approve(address(manager), 1);
        // 1 wei USDG against a pile of tokens: an absurd opening price.
        (address primedPool, uint256 attackerId) = manager.migrate(address(token), have, 1, attacker);
        vm.stopPrank();

        assertEq(locker.tokenOf(attackerId), address(token), "locker maps the real token to the attacker's position");
        assertEq(locker.beneficiaryOf(attackerId), attacker);
        assertGt(MockUniswapPool(primedPool).sqrtPriceX96(), 0, "pool already initialised at attacker price");
        assertFalse(curve.graduated());

        // Real graduation uses the primed pool without re-pricing it.
        _buy(alice, 200_000 * USDG_UNIT);
        uint256 priceBefore = MockUniswapPool(primedPool).sqrtPriceX96();
        (address pool,) = curve.graduate();
        assertEq(pool, primedPool, "graduation reused the pre-primed pool");
        assertEq(MockUniswapPool(pool).sqrtPriceX96(), priceBefore, "price untouched by graduation");
    }

    // ── A curve not deployed by the factory ──────────────────────────────────

    /// Anyone can deploy a BondingCurve directly (factory = msg.sender), pointing
    /// at the real vault + manager, with an arbitrary token. Its events have the
    /// real signatures. Only the address-list filter in the indexer separates it.
    function test_audit_rogueCurve_canReachRealManager() public {
        MockUSDG fakeToken = new MockUSDG();
        vm.startPrank(attacker);
        BondingCurve rogue = new BondingCurve(
            BondingCurve.CurveConfig({
                usdg: address(usdg),
                token: address(fakeToken),
                creator: attacker,
                feeVault: address(vault),
                graduationManager: address(manager),
                virtualUsdg: 1 * USDG_UNIT,
                virtualTokens: TOKEN_UNIT / 2, // = C * vU / target, as the factory derives it
                curveAllocation: 1 * TOKEN_UNIT,
                lpAllocation: 1 * TOKEN_UNIT,
                graduationTarget: 2 * USDG_UNIT,
                graduationFee: 0,
                tradeFeeBps: 0,
                creatorFeeShareBps: 0,
                snipeBlocks: 0,
                snipeMaxTokens: 0
            })
        );
        vm.stopPrank();
        assertEq(rogue.factory(), attacker);
        fakeToken.mint(address(rogue), 2 * TOKEN_UNIT);
        usdg.mint(attacker, 10 * USDG_UNIT);
        vm.startPrank(attacker);
        usdg.approve(address(rogue), type(uint256).max);
        rogue.buy(5 * USDG_UNIT, 0);
        (address pool,) = rogue.graduate(); // emits Graduated from a non-factory curve
        vm.stopPrank();
        assertTrue(pool != address(0));
        assertEq(factory.curveOf(address(fakeToken)), address(0), "factory does not know it - indexer must filter");
    }

    // ── Completion is not sticky: a 1-wei sell blocks graduate() ─────────────

    function test_audit_graduate_frontRunnableByTinySell() public {
        _buy(alice, 200_000 * USDG_UNIT);
        assertTrue(curve.curveComplete());

        // Any holder sells dust just before graduate() lands.
        vm.startPrank(alice);
        token.approve(address(curve), 1 * TOKEN_UNIT);
        curve.sell(1 * TOKEN_UNIT, 0);
        vm.stopPrank();

        assertFalse(curve.curveComplete(), "curve re-opened");
        vm.expectRevert(BondingCurve.TargetNotReached.selector);
        curve.graduate();
    }

    // ── Dev-buy refund path strands USDG in the factory ──────────────────────

    /// If the dev-buy quote clamps at the target (possible whenever the 5% cap
    /// exceeds what the curve sells before the target), `_devBuy` still pulls the
    /// full `devBuyUsdg` into the factory; the curve takes only what it can, and
    /// the remainder has no withdrawal path.
    function test_audit_devBuyRefund_strandedInFactory() public {
        // 1% of supply on the curve; 5% dev-buy cap is larger than the whole curve.
        HoodiumFactory smallCurveFactory = _newFactory(10_000_000 * TOKEN_UNIT);
        uint256 devBuy = 200_000 * USDG_UNIT;
        usdg.mint(creator, devBuy);
        vm.startPrank(creator);
        usdg.approve(address(smallCurveFactory), devBuy);
        (, address c) = smallCurveFactory.launch("Small", "SML", "ipfs://x", devBuy, 0);
        vm.stopPrank();

        BondingCurve small = BondingCurve(c);
        assertTrue(small.curveComplete());
        uint256 stranded = usdg.balanceOf(address(smallCurveFactory));
        emit log_named_uint("usdg stranded in factory", stranded);
        assertGt(stranded, 100_000 * USDG_UNIT, "refund left in the factory forever");
        assertEq(usdg.balanceOf(creator), 0, "creator got no refund");
    }
}
