// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {GraduationHelper} from "../../src/GraduationHelper.sol";
import {GraduationManager} from "../../src/GraduationManager.sol";
import {HoodiumFactory} from "../../src/HoodiumFactory.sol";
import {HoodiumToken} from "../../src/HoodiumToken.sol";
import {LPLocker} from "../../src/LPLocker.sol";
import {FeeVault} from "../../src/FeeVault.sol";
import {
    INonfungiblePositionManager,
    IUniswapV3Factory,
    IUniswapV3Pool,
    IUniswapV3SwapCallback
} from "../../src/interfaces/IUniswapV3.sol";

interface IPMExt {
    function factory() external view returns (address);
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
}

/// Swaps to an exact price limit and reports what it actually paid.
contract LimitSwapper is IUniswapV3SwapCallback {
    function swapToLimit(address pool, address tokenIn, bool zeroForOne, uint256 maxIn, uint160 limit)
        public
        returns (uint256 paid, uint256 received)
    {
        (int256 a0, int256 a1) = IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(maxIn), limit, abi.encode(tokenIn));
        paid = uint256(zeroForOne ? a0 : a1);
        received = uint256(-(zeroForOne ? a1 : a0));
    }

    /// Atomic "fix the price, then complete the curve" — what a griefed buyer needs.
    function fixAndBuy(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 maxIn,
        uint160 limit,
        BondingCurve curve,
        uint256 usdgIn
    ) external returns (uint256 paid) {
        (paid,) = swapToLimit(pool, tokenIn, zeroForOne, maxIn, limit);
        IERC20(address(curve.usdg())).approve(address(curve), usdgIn);
        curve.buy(usdgIn, 0, block.timestamp);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        address tokenIn = abi.decode(data, (address));
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owed > 0) IERC20(tokenIn).transfer(msg.sender, uint256(owed));
    }
}

/**
 * Adversarial verification of the fix pass against the real Robinhood Chain
 * Uniswap v3. Run with:
 *   forge test --match-contract ForkVerify --fork-url https://rpc.mainnet.chain.robinhood.com -vv
 */
contract ForkVerifyTest is Test {
    address constant PM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint24 constant POOL_FEE = 10_000;
    int24 constant TICK_SPACING = 200;
    uint256 constant USDG_UNIT = 1e6;
    uint256 constant TOKEN_UNIT = 1e18;
    uint256 constant Q96 = 1 << 96;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address attacker = makeAddr("attacker");

    IUniswapV3Factory uniFactory;
    FeeVault vault;
    LPLocker locker;
    GraduationManager manager;
    HoodiumFactory factory;

    modifier onFork() {
        vm.skip(block.chainid != 4663);
        _;
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        uniFactory = IUniswapV3Factory(IPMExt(PM).factory());
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        vault = new FeeVault(owners, 2);
        uint64 nonce = vm.getNonce(address(this));
        address predictedManager = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedFactory = vm.computeCreateAddress(address(this), nonce + 2);
        locker = new LPLocker(PM, address(vault), 3_000, predictedManager);
        manager =
            new GraduationManager(address(uniFactory), PM, address(locker), USDG, POOL_FEE, TICK_SPACING, predictedFactory);
        factory = new HoodiumFactory(
            HoodiumFactory.FactoryConfig({
                usdg: USDG,
                feeVault: address(vault),
                graduationManager: address(manager),
                tokenDecimals: 18,
                totalSupply: 1_000_000_000 * TOKEN_UNIT,
                curveAllocation: 800_000_000 * TOKEN_UNIT,
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
        assertEq(address(factory), predictedFactory);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _launchOrdered(bool tokenIsToken0) internal returns (HoodiumToken token, BondingCurve curve) {
        for (uint256 i = 0; i < 16; i++) {
            vm.prank(creator);
            (address t, address c) = factory.launch("Fork", "FORK", "ipfs://fork", 0, 0);
            if ((t < USDG) == tokenIsToken0) {
                vm.roll(block.number + 4);
                return (HoodiumToken(t), BondingCurve(c));
            }
        }
        revert("ordering");
    }

    function _buy(BondingCurve curve, address who, uint256 usdgIn) internal returns (uint256 out) {
        deal(USDG, who, IERC20(USDG).balanceOf(who) + usdgIn, false);
        vm.startPrank(who);
        IERC20(USDG).approve(address(curve), usdgIn);
        out = curve.buy(usdgIn, 0, block.timestamp);
        vm.stopPrank();
    }

    function _fillAlmost(BondingCurve curve) internal {
        uint256 net = curve.remainingToTarget() - 1 * USDG_UNIT;
        _buy(curve, alice, net * 10_000 / 9_900);
        assertFalse(curve.curveComplete());
    }

    function _lpAmounts(BondingCurve curve) internal view returns (uint256 usdgForLp, uint256 tokensForLp) {
        usdgForLp = curve.graduationTarget() - curve.graduationFee();
        uint256 sold = curve.tokensSold();
        if (!curve.graduated()) {
            (uint256 stillToSell,,,) = curve.quoteBuy(type(uint128).max);
            sold += stillToSell;
        }
        tokensForLp = curve.lpAllocation() + curve.curveAllocation() - sold;
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(amount1, Q96, amount0)) << 48);
    }

    function _fair(BondingCurve curve) internal view returns (uint160) {
        (uint256 u, uint256 t) = _lpAmounts(curve);
        return address(curve.token()) < USDG ? _sqrtPriceX96(t, u) : _sqrtPriceX96(u, t);
    }

    function _prime(address token, uint160 price) internal returns (address pool) {
        (address t0, address t1) = token < USDG ? (token, USDG) : (USDG, token);
        vm.prank(attacker);
        pool = IPMExt(PM).createAndInitializePoolIfNecessary(t0, t1, POOL_FEE, price);
    }

    /// Full-range mint by the attacker with the given desired amounts (token0 = TOKEN ordering).
    function _attackerFullRangeMint(HoodiumToken token, uint256 tokenAmt, uint256 usdgAmt)
        internal
        returns (uint256 used0, uint256 used1, uint128 liq)
    {
        deal(USDG, attacker, IERC20(USDG).balanceOf(attacker) + usdgAmt, false);
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        IERC20(USDG).approve(PM, type(uint256).max);
        (, liq, used0, used1) = INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(token),
                token1: USDG,
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: tokenAmt,
                amount1Desired: usdgAmt,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
    }

    function _expectCompleteReverts(BondingCurve curve, bytes4 selector) internal {
        deal(USDG, alice, 500 * USDG_UNIT, false);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(curve), 500 * USDG_UNIT);
        vm.expectPartialRevert(selector);
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(curve.graduated());
    }

    // ── Q2/Q3: a DUST full-range position + out-of-band price griefs the completing buy ──

    /// The attacker needs almost nothing: a 1e15-wei token / 1000-wei USDG full
    /// range position at a hostile price. `liquidity() != 0`, so the band check
    /// applies and the completing buy reverts. Fixing costs a few wei through a
    /// swap; re-blocking costs a few wei too. It is a gas war, not an arbitrage
    /// anyone is paid to take. An atomic fix+buy wins deterministically.
    function test_verify_dustFullRangePosition_griefsCompletingBuy_atomicFixWins() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 1 * USDG_UNIT); // one dollar of tokens
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        uint160 hostile = uint160(fair / 100); // TOKEN 10,000x cheaper
        address pool = _prime(address(token), hostile);

        (uint256 used0, uint256 used1, uint128 liq) =
            _attackerFullRangeMint(token, attackerTokens, 1_000 /* 0.001 USDG */ );
        console2.log("attacker position: tokens used", used0);
        console2.log("attacker position: USDG wei used", used1);
        console2.log("attacker position: liquidity", uint256(liq));
        assertGt(IUniswapV3Pool(pool).liquidity(), 0);

        // Plain UI buy: bricked.
        _expectCompleteReverts(curve, GraduationManager.PoolPriceManipulated.selector);

        _fixThenReblock(token, curve, pool, fair, hostile);

        // Atomic fix + buy in one transaction cannot be interleaved.
        LimitSwapper fixer = new LimitSwapper();
        deal(USDG, address(fixer), 10 * USDG_UNIT + 500 * USDG_UNIT, false);
        fixer.fixAndBuy(pool, USDG, false, 10 * USDG_UNIT, fair, curve, 500 * USDG_UNIT);
        assertTrue(curve.graduated(), "atomic fix+buy graduates");
        assertGe(IERC20(USDG).balanceOf(pool), curve.graduationTarget() * 99 / 100);
        assertEq(INonfungiblePositionManager(PM).ownerOf(curve.lpTokenId()), address(locker));
    }

    function _fixThenReblock(HoodiumToken token, BondingCurve curve, address pool, uint160 fair, uint160 hostile)
        internal
    {
        // Fixer moves the price to exactly `fair` (token1 = USDG in, price rises).
        LimitSwapper fixer = new LimitSwapper();
        deal(USDG, address(fixer), 10 * USDG_UNIT, false);
        (uint256 paid, uint256 got) = fixer.swapToLimit(pool, USDG, false, 10 * USDG_UNIT, fair);
        console2.log("fixer paid USDG wei", paid);
        console2.log("fixer got token wei", got);
        (uint160 now_,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(now_, fair, "fixer lands exactly on fair");
        assertLt(paid, 1 * USDG_UNIT, "fixing a dust position costs less than 1 USDG");

        // Attacker re-blocks: swaps back down to the hostile price (token in).
        LimitSwapper reblock = new LimitSwapper();
        uint256 bal = token.balanceOf(attacker);
        vm.prank(attacker);
        token.transfer(address(reblock), bal);
        (uint256 rePaid,) = reblock.swapToLimit(pool, address(token), true, bal, hostile);
        console2.log("attacker re-block paid token wei", rePaid);
        (now_,,,,,,) = IUniswapV3Pool(pool).slot0();
        console2.log("price after re-block / fair (1e6 scale)", uint256(now_) * 1e6 / uint256(fair));
        assertLt(uint256(now_), Math.mulDiv(fair, 9_975, 10_000), "re-block leaves the price below the band");
        _expectCompleteReverts(curve, GraduationManager.PoolPriceManipulated.selector);
    }

    // ── The residual, closed: GraduationHelper on the real pool ──────────────

    function _helperFixAndBuy(BondingCurve curve, address who, uint256 usdgIn, uint256 maxFix)
        internal
        returns (GraduationHelper helper, uint256 out)
    {
        helper = new GraduationHelper();
        deal(USDG, who, IERC20(USDG).balanceOf(who) + usdgIn + maxFix, false);
        vm.startPrank(who);
        IERC20(USDG).approve(address(helper), usdgIn + maxFix);
        out = helper.fixAndBuy(address(curve), usdgIn, 0, block.timestamp, maxFix);
        vm.stopPrank();
    }

    /// Same griefing position as above, token 10,000x too cheap: the helper
    /// buys the attacker's tokens up to the fair price with the buyer's USDG
    /// and completes the curve in the same transaction.
    function test_verify_dustPosition_tokenCheap_helperFixAndBuyGraduates() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 1 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(fair / 100));
        _attackerFullRangeMint(token, attackerTokens, 1_000);
        _expectCompleteReverts(curve, GraduationManager.PoolPriceManipulated.selector);

        assertEq(manager.targetSqrtPriceX96(address(curve)), fair, "manager view agrees with the test's fair price");
        _assertHelperCheapDirection(token, curve, pool);
    }

    function _assertHelperCheapDirection(HoodiumToken token, BondingCurve curve, address pool) internal {
        uint256 usdgIn = 500 * USDG_UNIT;
        uint256 maxFix = 5 * USDG_UNIT;
        (,, uint256 refund,) = curve.quoteBuy(usdgIn);
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        uint256 tokensBefore = token.balanceOf(alice);
        (GraduationHelper helper, uint256 out) = _helperFixAndBuy(curve, alice, usdgIn, maxFix);

        assertTrue(curve.graduated(), "helper fix+buy graduates");
        assertEq(curve.pool(), pool);
        assertGt(out, 0);
        assertGt(token.balanceOf(alice) - tokensBefore, out, "arbitrage tokens came back to the buyer");
        uint256 spent = usdgBefore + usdgIn + maxFix - IERC20(USDG).balanceOf(alice);
        console2.log("helper fix+buy: USDG wei spent beyond the buy", spent - (usdgIn - refund));
        assertLe(spent, usdgIn + maxFix);
        assertLt(spent - (usdgIn - refund), 1 * USDG_UNIT, "fixing a dust position costs less than 1 USDG");
        assertEq(IERC20(USDG).balanceOf(address(helper)), 0, "helper holds no USDG");
        assertEq(token.balanceOf(address(helper)), 0, "helper holds no tokens");
        assertGe(IERC20(USDG).balanceOf(pool), curve.graduationTarget() * 99 / 100);
        assertEq(INonfungiblePositionManager(PM).ownerOf(curve.lpTokenId()), address(locker));
    }

    /// Token 10,000x too expensive: the pool asks for tokens in the callback,
    /// the helper buys exactly that many from the curve (non-completing, at the
    /// fair price) and sells them into the position. The pool's USDG comes back
    /// to the buyer.
    function test_verify_dustPosition_tokenExpensive_helperBuysFromCurveInsideCallback() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 1 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(fair * 100));
        (,, uint128 liq) = _attackerFullRangeMint(token, attackerTokens, 1_000);
        assertGt(liq, 0);
        _expectCompleteReverts(curve, GraduationManager.PoolPriceManipulated.selector);

        _assertHelperExpensiveDirection(token, curve, pool);
    }

    function _assertHelperExpensiveDirection(HoodiumToken token, BondingCurve curve, address pool) internal {
        uint256 usdgIn = 500 * USDG_UNIT;
        uint256 maxFix = 5 * USDG_UNIT;
        (,, uint256 refund,) = curve.quoteBuy(usdgIn);
        uint256 usdgBefore = IERC20(USDG).balanceOf(alice);
        (GraduationHelper helper,) = _helperFixAndBuy(curve, alice, usdgIn, maxFix);

        assertTrue(curve.graduated(), "helper fix+buy graduates");
        assertEq(curve.pool(), pool);
        int256 spent = int256(usdgBefore + usdgIn + maxFix) - int256(IERC20(USDG).balanceOf(alice));
        int256 fixCost = spent - int256(usdgIn - refund);
        console2.log("helper fix (token in): USDG wei net cost (negative = profit)", fixCost);
        assertLt(fixCost, int256(maxFix));
        assertEq(IERC20(USDG).balanceOf(address(helper)), 0);
        assertEq(token.balanceOf(address(helper)), 0);
        assertEq(INonfungiblePositionManager(PM).ownerOf(curve.lpTokenId()), address(locker));
    }

    /// Out-of-range dust in the path (`UnexpectedSwapPayment` from the manager's
    /// free re-price): `fix` alone sweeps it for wei and pays the keeper.
    function test_verify_outOfRangeDust_helperFixSweepsIt_thenPlainBuyWorks() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 1 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(fair / 100));
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 lower = ((tick / TICK_SPACING) + 2) * TICK_SPACING;
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(token),
                token1: USDG,
                fee: POOL_FEE,
                tickLower: lower,
                tickUpper: lower + TICK_SPACING,
                amount0Desired: attackerTokens / 1000,
                amount1Desired: 0,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        _expectCompleteReverts(curve, GraduationManager.UnexpectedSwapPayment.selector);

        GraduationHelper helper = new GraduationHelper();
        (,,, bool needed) = helper.status(address(curve));
        assertTrue(needed, "zero in-range liquidity off the target is reported as fixable");
        address keeper = makeAddr("keeper");
        deal(USDG, keeper, 1 * USDG_UNIT, false);
        vm.startPrank(keeper);
        IERC20(USDG).approve(address(helper), 1 * USDG_UNIT);
        helper.fix(address(curve), 1 * USDG_UNIT);
        vm.stopPrank();
        (uint160 now_,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(now_, fair, "fix lands exactly on the target");
        console2.log("keeper paid USDG wei", 1 * USDG_UNIT - IERC20(USDG).balanceOf(keeper));
        assertGt(token.balanceOf(keeper), 0, "keeper keeps the swept tokens");
        assertEq(IERC20(USDG).balanceOf(address(helper)), 0);
        assertEq(token.balanceOf(address(helper)), 0);

        vm.expectRevert(GraduationHelper.NothingToFix.selector);
        helper.fix(address(curve), 0);

        _buy(curve, alice, 500 * USDG_UNIT);
        assertTrue(curve.graduated());
    }

    // ── Q2: fill ratio at the band edge — is 99% too tight? ──────────────────

    /// Pool with liquidity sitting at exactly the upper band bound (sqrt +25 bps,
    /// price +50.06 bps): accepted, and the mint's fill is ~99.50%, above the
    /// 99% floor. One wei past the band: refused by the band, not by the fill.
    function test_verify_bandEdge_fillIsAbove99pct_andBandIsTheBindingCheck() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 100 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        uint160 hi = uint160(Math.mulDiv(fair, 10_025, 10_000, Math.Rounding.Ceil));
        address pool = _prime(address(token), hi);
        _attackerFullRangeMint(token, attackerTokens, 10 * USDG_UNIT);
        assertGt(IUniswapV3Pool(pool).liquidity(), 0);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);

        _buy(curve, alice, 500 * USDG_UNIT);
        assertTrue(curve.graduated());
        uint256 tokenDust = manager.dustOf(address(token), creator);
        uint256 usdgDust = manager.dustOf(USDG, creator);
        console2.log("token dust (wei)", tokenDust);
        console2.log("token dust bps of desired", tokenDust * 10_000 / tokensForLp);
        console2.log("usdg dust (wei)", usdgDust);
        // Price above fair => token0 (TOKEN) is the under-consumed side: 1/(1.0025^2) ~ 99.50%.
        assertLe(tokenDust * 10_000 / tokensForLp, 51, "token dust at band edge should be ~50 bps");
        assertLe(usdgDust * 10_000 / usdgForLp, 1, "USDG side fully consumed");
        assertGe(tokenDust * 10_000 / tokensForLp, 49, "fill really is ~99.5%, not 100%");
    }

    function test_verify_oneWeiPastBand_isRefusedByBand_notFill() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 100 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        uint160 hi = uint160(Math.mulDiv(fair, 10_025, 10_000, Math.Rounding.Ceil)) + 1;
        address pool = _prime(address(token), hi);
        _attackerFullRangeMint(token, attackerTokens, 10 * USDG_UNIT);
        assertGt(IUniswapV3Pool(pool).liquidity(), 0);
        _expectCompleteReverts(curve, GraduationManager.PoolPriceManipulated.selector);
    }

    /// Lower band edge, other token ordering (USDG = token0): symmetric.
    function test_verify_bandEdgeLow_otherOrdering_isAccepted() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(false);
        uint256 attackerTokens = _buy(curve, attacker, 100 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        uint160 lo = uint160(Math.mulDiv(fair, 9_975, 10_000));
        address pool = _prime(address(token), lo);
        deal(USDG, attacker, 10 * USDG_UNIT, false);
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        IERC20(USDG).approve(PM, type(uint256).max);
        INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: USDG,
                token1: address(token),
                fee: POOL_FEE,
                tickLower: -887200,
                tickUpper: 887200,
                amount0Desired: 10 * USDG_UNIT,
                amount1Desired: attackerTokens,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(IUniswapV3Pool(pool).liquidity(), 0);
        (uint256 usdgForLp, uint256 tokensForLp) = _lpAmounts(curve);
        _buy(curve, alice, 500 * USDG_UNIT);
        assertTrue(curve.graduated());
        uint256 tokenDust = manager.dustOf(address(token), creator);
        console2.log("token dust bps (lower edge, token1)", tokenDust * 10_000 / tokensForLp);
        console2.log("usdg dust bps", manager.dustOf(USDG, creator) * 10_000 / usdgForLp);
        assertLe(tokenDust * 10_000 / tokensForLp, 51);
    }

    // ── Q1: callback restricted to the pool being repriced ───────────────────

    function test_verify_fakePool_cannotCallSwapCallback() public onFork {
        vm.prank(attacker);
        vm.expectRevert(GraduationManager.UnexpectedSwapCallback.selector);
        manager.uniswapV3SwapCallback(-1, -1, "");
    }

    // ── Q3: gas of the completing buy on the real chain ──────────────────────

    function test_verify_completingBuyGas_freshPool() public onFork {
        (, BondingCurve curve) = _launchOrdered(true);
        _fillAlmost(curve);
        deal(USDG, alice, 500 * USDG_UNIT, false);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(curve), 500 * USDG_UNIT);
        uint256 g = gasleft();
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        g -= gasleft();
        vm.stopPrank();
        console2.log("completing buy gas (fresh pool)", g);
        assertTrue(curve.graduated());
    }

    function test_verify_completingBuyGas_repricedPool() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        _prime(address(token), uint160(fair * 50));
        deal(USDG, alice, 500 * USDG_UNIT, false);
        vm.startPrank(alice);
        IERC20(USDG).approve(address(curve), 500 * USDG_UNIT);
        uint256 g = gasleft();
        curve.buy(500 * USDG_UNIT, 0, block.timestamp);
        g -= gasleft();
        vm.stopPrank();
        console2.log("completing buy gas (repriced pool)", g);
        assertTrue(curve.graduated());
    }

    // ── Q1: tiny out-of-range liquidity in the path; sweeping it is cheap ────

    /// After the out-of-range block, a fixer walks the price through the dust
    /// position to `fair` for wei, then the plain buy succeeds (no reprice needed
    /// because current == target; or a free reprice if not exact).
    function test_verify_outOfRangeDust_isSweptForWei() public onFork {
        (HoodiumToken token, BondingCurve curve) = _launchOrdered(true);
        uint256 attackerTokens = _buy(curve, attacker, 1 * USDG_UNIT);
        _fillAlmost(curve);
        uint160 fair = _fair(curve);
        address pool = _prime(address(token), uint160(fair / 100));
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 lower = ((tick / TICK_SPACING) + 2) * TICK_SPACING;
        vm.startPrank(attacker);
        token.approve(PM, type(uint256).max);
        INonfungiblePositionManager(PM).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(token),
                token1: USDG,
                fee: POOL_FEE,
                tickLower: lower,
                tickUpper: lower + TICK_SPACING,
                amount0Desired: attackerTokens / 1000,
                amount1Desired: 0,
                amount0Min: 0,
                amount1Min: 0,
                recipient: attacker,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        _expectCompleteReverts(curve, GraduationManager.UnexpectedSwapPayment.selector);

        LimitSwapper fixer = new LimitSwapper();
        deal(USDG, address(fixer), 10 * USDG_UNIT, false);
        (uint256 paid,) = fixer.swapToLimit(pool, USDG, false, 10 * USDG_UNIT, fair);
        console2.log("fixer paid USDG wei to sweep out-of-range dust", paid);
        (uint160 now_,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(now_, fair);
        _buy(curve, alice, 500 * USDG_UNIT);
        assertTrue(curve.graduated());
    }
}
