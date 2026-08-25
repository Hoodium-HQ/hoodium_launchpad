// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {HoodiumFactory} from "../src/HoodiumFactory.sol";
import {HoodiumToken} from "../src/HoodiumToken.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockUniswapFactory, MockPositionManager, MockUniswapPool} from "./mocks/MockUniswap.sol";

/**
 * Shared fixture: the whole stack — vault, locker, manager, factory — over the
 * price-aware Uniswap mocks, with the terms `Deploy.s.sol` ships.
 *
 * Every test file builds on this rather than its own copy because the stack is
 * now circular (locker → manager → factory are forward references verified by
 * each constructor, AUDIT M1) and because the mocks must be price-aware for the
 * graduation tests to mean anything (AUDIT C1). A file that needs different
 * terms calls `_deployStack` again with its own `Terms`.
 *
 * The tests assert *properties* rather than specific numbers wherever they can,
 * so re-parameterising does not invalidate them. Where a number is asserted it
 * is derived from the terms in the same way the factory derives it.
 */
abstract contract BaseTest is Test {
    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant TOKEN_UNIT = 1e18;
    uint256 internal constant Q96 = 1 << 96;

    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000 * TOKEN_UNIT;
    uint256 internal constant CURVE_ALLOCATION = 800_000_000 * TOKEN_UNIT;
    uint256 internal constant LP_ALLOCATION = TOTAL_SUPPLY - CURVE_ALLOCATION;
    uint256 internal constant GRADUATION_TARGET = 69_000 * USDG_UNIT;
    /*
     * Derived by the factory for price continuity (AUDIT H3):
     *   vU = lpAllocation · target / (C − lpAllocation) = 200M · 69k / 600M
     * Kept here as the number the suite expects the factory to arrive at.
     */
    uint256 internal constant VIRTUAL_USDG = 23_000 * USDG_UNIT;
    /*
     * Zero, and a creator share of 70%, because that is what Deploy.s.sol
     * ships — the fixture tracks the configuration that will actually be
     * deployed. The graduation-fee *mechanism* is still covered: Graduation.t.sol
     * builds its own stack with a non-zero fee.
     */
    uint256 internal constant GRADUATION_FEE = 0;
    uint256 internal constant CREATION_FEE = 1 * USDG_UNIT;
    uint256 internal constant TRADE_FEE_BPS = 100; // 1%
    uint256 internal constant CREATOR_SHARE_BPS = 7_000; // 70% of fees
    uint256 internal constant SNIPE_BLOCKS = 3;
    uint256 internal constant SNIPE_MAX_BPS = 100; // 1% of supply
    uint256 internal constant DEV_BUY_MAX_BPS = 500; // 5% of supply
    /// T0.4 — protocol's share of post-graduation pool fees. 30%, creator keeps 70%.
    uint256 internal constant PROTOCOL_FEE_SHARE_BPS = 3_000;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;

    struct Terms {
        uint256 totalSupply;
        uint256 curveAllocation;
        uint256 graduationTarget;
        uint256 graduationFee;
        uint256 tradeFeeBps;
        uint256 creatorFeeShareBps;
        uint256 creationFee;
        uint256 devBuyMaxBps;
        uint256 snipeBlocks;
        uint256 snipeMaxBps;
    }

    MockUSDG internal usdg;
    FeeVault internal vault;
    MockUniswapFactory internal uniFactory;
    MockPositionManager internal pm;
    LPLocker internal locker;
    GraduationManager internal manager;
    HoodiumFactory internal factory;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");
    address internal randomCaller = makeAddr("randomCaller");

    function setUp() public virtual {
        usdg = new MockUSDG();
        _deployStack(address(usdg), _defaultTerms());
    }

    function _defaultTerms() internal pure returns (Terms memory t) {
        t.totalSupply = TOTAL_SUPPLY;
        t.curveAllocation = CURVE_ALLOCATION;
        t.graduationTarget = GRADUATION_TARGET;
        t.graduationFee = GRADUATION_FEE;
        t.tradeFeeBps = TRADE_FEE_BPS;
        t.creatorFeeShareBps = CREATOR_SHARE_BPS;
        t.creationFee = CREATION_FEE;
        t.devBuyMaxBps = DEV_BUY_MAX_BPS;
        t.snipeBlocks = SNIPE_BLOCKS;
        t.snipeMaxBps = SNIPE_MAX_BPS;
    }

    /**
     * Deploy vault → locker → manager → factory the way Deploy.s.sol does,
     * precomputing the two forward references from this contract's nonce.
     * Replaces the fixture's stack in place.
     */
    function _deployStack(address usdgAddr, Terms memory t) internal {
        address[] memory owners = new address[](3);
        owners[0] = makeAddr("signer1");
        owners[1] = makeAddr("signer2");
        owners[2] = makeAddr("signer3");
        vault = new FeeVault(owners, 2);

        uniFactory = new MockUniswapFactory();
        pm = new MockPositionManager(uniFactory);

        uint64 nonce = vm.getNonce(address(this));
        address predictedManager = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedFactory = vm.computeCreateAddress(address(this), nonce + 2);

        locker = new LPLocker(address(pm), address(vault), PROTOCOL_FEE_SHARE_BPS, predictedManager);
        manager = new GraduationManager(
            address(uniFactory), address(pm), address(locker), usdgAddr, POOL_FEE, TICK_SPACING, predictedFactory
        );
        assertEq(address(manager), predictedManager, "fixture: manager nonce");

        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: usdgAddr,
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
                devBuyMaxBps: t.devBuyMaxBps,
                snipeBlocks: t.snipeBlocks,
                snipeMaxBps: t.snipeMaxBps
            })
        );
        assertEq(address(factory), predictedFactory, "fixture: factory nonce");
    }

    // ── Launching ────────────────────────────────────────────────────────────

    /// Launch as `creator`, funding the creation fee the factory charges.
    function _launch() internal returns (HoodiumToken token, BondingCurve curve) {
        return _launchWithDevBuy(0);
    }

    function _launchWithDevBuy(uint256 devBuyUsdg) internal returns (HoodiumToken token, BondingCurve curve) {
        uint256 fee = factory.creationFee();
        usdg.mint(creator, fee + devBuyUsdg);
        vm.startPrank(creator);
        usdg.approve(address(factory), fee + devBuyUsdg);
        (address t, address c) = factory.launch("Test Token", "TEST", "ipfs://QmTest", devBuyUsdg, 0);
        vm.stopPrank();
        return (HoodiumToken(t), BondingCurve(c));
    }

    // ── Trading ──────────────────────────────────────────────────────────────

    function _fund(address who, uint256 amount) internal {
        usdg.mint(who, amount);
    }

    /// Buy as `who`, handling approval. Past the anti-snipe window by default.
    function _buy(BondingCurve curve, address who, uint256 usdgIn) internal returns (uint256 tokensOut) {
        _fund(who, usdgIn);
        vm.startPrank(who);
        usdg.approve(address(curve), usdgIn);
        tokensOut = curve.buy(usdgIn, 0, block.timestamp);
        vm.stopPrank();
    }

    function _sell(BondingCurve curve, HoodiumToken token, address who, uint256 tokensIn)
        internal
        returns (uint256 usdgOut)
    {
        vm.startPrank(who);
        token.approve(address(curve), tokensIn);
        usdgOut = curve.sell(tokensIn, 0, block.timestamp);
        vm.stopPrank();
    }

    /**
     * Buy up to (but not reaching) the target, leaving `remaining` net USDG.
     * The completing buy graduates (AUDIT H2), so tests that need to act between
     * "nearly full" and "graduated" fill with this and then `_complete`.
     */
    function _fillAlmost(BondingCurve curve, address who, uint256 remaining) internal {
        uint256 net = curve.remainingToTarget() - remaining;
        uint256 gross = net * 10_000 / (10_000 - curve.tradeFeeBps());
        _buy(curve, who, gross);
        assertFalse(curve.curveComplete(), "fixture: overshot the target");
        assertGe(curve.remainingToTarget(), remaining, "fixture: left less than asked");
    }

    function _fillAlmost(BondingCurve curve, address who) internal {
        _fillAlmost(curve, who, 1 * USDG_UNIT);
    }

    /// The completing buy. Returns where the liquidity went.
    function _complete(BondingCurve curve, address who) internal returns (address pool, uint256 tokenId) {
        _buy(curve, who, 200 * USDG_UNIT + curve.remainingToTarget() * 2);
        assertTrue(curve.graduated(), "fixture: completing buy did not graduate");
        return (curve.pool(), curve.lpTokenId());
    }

    /// Fill and graduate in one buy.
    function _fillCurve(BondingCurve curve, address who) internal returns (address pool, uint256 tokenId) {
        _buy(curve, who, 200_000 * USDG_UNIT);
        assertTrue(curve.graduated(), "fixture: fill did not graduate");
        return (curve.pool(), curve.lpTokenId());
    }

    /// Move past the anti-snipe window so ordinary trades are not capped.
    function _skipSnipeWindow() internal {
        vm.roll(block.number + SNIPE_BLOCKS + 1);
    }

    // ── Pool arithmetic ──────────────────────────────────────────────────────

    function _order(address token) internal view returns (address t0, address t1, bool usdgIsToken1) {
        usdgIsToken1 = token < address(usdg);
        (t0, t1) = usdgIsToken1 ? (token, address(usdg)) : (address(usdg), token);
    }

    /**
     * What graduation will move. On a curve that has not completed yet this
     * includes what the completing buy will still sell (the quote clamps at the
     * target, so any oversized input gives exactly that amount).
     */
    function _lpAmounts(BondingCurve curve) internal view returns (uint256 usdgForLp, uint256 tokensForLp) {
        usdgForLp = curve.graduationTarget() - curve.graduationFee();
        uint256 sold = curve.tokensSold();
        if (!curve.graduated()) {
            (uint256 stillToSell,,,) = curve.quoteBuy(type(uint128).max);
            sold += stillToSell;
        }
        tokensForLp = curve.lpAllocation() + curve.curveAllocation() - sold;
    }

    /// sqrt(amount1/amount0) in Q96 — the same construction GraduationManager uses.
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(amount1, Q96, amount0)) << 48);
    }

    /// The price the pool should open at for `curve`, given what it will migrate.
    function _fairSqrtP(BondingCurve curve) internal view returns (uint160) {
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        (,, bool usdgIsToken1) = _order(address(curve.token()));
        return usdgIsToken1 ? _sqrtPriceX96(tokensForLp, usdgForLp) : _sqrtPriceX96(usdgForLp, tokensForLp);
    }

    /// Create and initialise the pool ahead of graduation, as anyone can.
    function _primePool(address who, address token, uint160 price) internal returns (address pool) {
        (address t0, address t1,) = _order(token);
        vm.startPrank(who);
        pool = uniFactory.createPool(t0, t1, POOL_FEE);
        MockUniswapPool(pool).initialize(price);
        vm.stopPrank();
    }

    /// Credit `amount` of USDG as accrued fees on a locked position.
    function _creditUsdgFees(address token, uint256 tokenId, uint256 amount) internal {
        usdg.mint(address(pm), amount);
        (,, bool usdgIsToken1) = _order(token);
        pm.creditFees(tokenId, usdgIsToken1 ? 0 : amount, usdgIsToken1 ? amount : 0);
    }
}
