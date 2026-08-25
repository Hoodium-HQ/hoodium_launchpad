// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GraduationManager} from "../src/GraduationManager.sol";
import {LPLocker} from "../src/LPLocker.sol";
import {FeeVault} from "../src/FeeVault.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {INonfungiblePositionManager, IUniswapV3Factory, IUniswapV3Pool} from "../src/interfaces/IUniswapV3.sol";

interface IPMExt {
    function factory() external view returns (address);
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
}

interface ISwapRouterLike {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
}

/// Fork probe against the real Robinhood Chain Uniswap v3 deployment.
/// forge test --match-contract ForkGraduation --fork-url https://rpc.mainnet.chain.robinhood.com -vvv
contract ForkGraduationTest is Test {
    address constant PM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint256 constant TOKENS = 400_000_000e18; // lpAllocation + unsold at graduation
    uint256 constant USDG_AMT = 69_000e6;

    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");

    IUniswapV3Factory uniFactory;
    GraduationManager manager;
    LPLocker locker;

    function setUp() public {
        // Only meaningful on a Robinhood Chain fork; skipped elsewhere.
        if (block.chainid != 4663) return;
        uniFactory = IUniswapV3Factory(IPMExt(PM).factory());
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("s1");
        owners[1] = makeAddr("s2");
        FeeVault vault = new FeeVault(owners, 2);
        locker = new LPLocker(PM, address(vault), 3000);
        manager = new GraduationManager(address(uniFactory), PM, address(locker), USDG, 10_000, 200);
    }

    /// Deploy a plain ERC20 and etch it at a chosen address so ordering is controlled.
    function _tokenAt(address at) internal returns (address) {
        MockUSDG t = new MockUSDG();
        vm.etch(at, address(t).code);
        vm.label(at, "TOKEN");
        return at;
    }

    function _fund(address token) internal {
        // MockUSDG.mint works on the etched copy
        MockUSDG(token).mint(address(this), TOKENS);
        deal(USDG, address(this), USDG_AMT, false);
        IERC20(token).approve(address(manager), TOKENS);
        IERC20(USDG).approve(address(manager), USDG_AMT);
    }

    function _expectedPrice(address token) internal pure returns (uint256 sqrtP) {
        // price = token1 per token0
        (uint256 a0, uint256 a1) = token < USDG ? (TOKENS, USDG_AMT) : (USDG_AMT, TOKENS);
        // exact: sqrt(a1/a0) * 2^96 computed as sqrt(a1 * 2^192 / a0) via two-step
        sqrtP = _sqrt((a1 << 96) / a0) << 48;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _run(address token) internal returns (address pool, uint256 tokenId) {
        _fund(token);
        (pool, tokenId) = manager.migrate(token, TOKENS, USDG_AMT, creator);
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        (,,,,, int24 tl, int24 tu, uint128 liq,,,,) = INonfungiblePositionManager(PM).positions(tokenId);
        console2.log("pool", pool);
        console2.log("sqrtPriceX96", uint256(sqrtP));
        console2.log("tick", int256(tick));
        console2.log("tickLower", int256(tl)); console2.log("tickUpper", int256(tu));
        console2.log("liquidity", uint256(liq));
        console2.log("token dust to creator", IERC20(token).balanceOf(creator));
        console2.log("usdg dust to creator", IERC20(USDG).balanceOf(creator));
        console2.log("manager token left", IERC20(token).balanceOf(address(manager)));
        console2.log("manager usdg left", IERC20(USDG).balanceOf(address(manager)));
        console2.log("allowance token->PM", IERC20(token).allowance(address(manager), PM));
        console2.log("allowance usdg->PM", IERC20(USDG).allowance(address(manager), PM));
        assertEq(INonfungiblePositionManager(PM).ownerOf(tokenId), address(locker));
        assertEq(locker.beneficiaryOf(tokenId), creator);
        // 1 token = 69000/400M USDG = 0.0001725 USDG. Check via pool price.
        // price1per0 = (sqrtP/2^96)^2
        uint256 p = Math_mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 192); // integer part only
        console2.log("price token1/token0 (integer part)", p);
    }

    function Math_mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }

    function test_fork_tokenIsToken0() public {
        vm.skip(block.chainid != 4663);
        address token = _tokenAt(address(0x0000000000000000000000000000000000001234)); // < USDG
        (address pool,) = _run(token);
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertApproxEqRel(uint256(sqrtP), _expectedPrice(token), 1e12); // within 1e-6
        // fair: token0 = TOKEN, so token1/token0 = USDG per TOKEN in raw = 69000e6/400e24
        // Check tick ~ log_1.0001(1.725e-16) ~ -362,900
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        assertLt(tick, -300_000);
    }

    function test_fork_tokenIsToken1() public {
        vm.skip(block.chainid != 4663);
        address token = _tokenAt(address(0xfFffFfFFFfFffFFfFfFFfFffFFffFfFfFffF1234)); // > USDG
        (address pool,) = _run(token);
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        assertApproxEqRel(uint256(sqrtP), _expectedPrice(token), 1e12);
        assertGt(tick, 300_000);
    }

    /// Griefing: the pool is created and initialised BEFORE graduation at a price where
    /// TOKEN is 10,000x cheaper than the curve price. Measure what leaves the pool.
    function test_fork_preInitialisedPool_tokenCheap() public {
        vm.skip(block.chainid != 4663);
        address token = _tokenAt(address(0x0000000000000000000000000000000000001234)); // token0
        uint256 fair = _expectedPrice(token);
        // token is token0; price = USDG per TOKEN. 10,000x cheaper -> sqrt 100x lower
        uint160 hostile = uint160(fair / 100);
        vm.prank(attacker);
        IPMExt(PM).createAndInitializePoolIfNecessary(token, USDG, 10_000, hostile);
        (address pool,) = _run(token);
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(pool).slot0();
        assertEq(uint256(sqrtP), uint256(hostile), "price was not re-set by graduation");
        console2.log("USDG NOT in pool (to creator)", IERC20(USDG).balanceOf(creator));
        console2.log("USDG in pool", IERC20(USDG).balanceOf(pool));
        console2.log("TOKEN in pool", IERC20(token).balanceOf(pool));
    }

    function test_fork_preInitialisedPool_tokenExpensive() public {
        vm.skip(block.chainid != 4663);
        address token = _tokenAt(address(0x0000000000000000000000000000000000001234)); // token0
        uint256 fair = _expectedPrice(token);
        uint160 hostile = uint160(fair * 100); // token 10,000x more expensive
        vm.prank(attacker);
        IPMExt(PM).createAndInitializePoolIfNecessary(token, USDG, 10_000, hostile);
        (address pool,) = _run(token);
        console2.log("TOKEN NOT in pool (to creator)", IERC20(token).balanceOf(creator));
        console2.log("USDG in pool", IERC20(USDG).balanceOf(pool));
        console2.log("TOKEN in pool", IERC20(token).balanceOf(pool));
        // attacker now sells TOKEN into the pool directly (swap on the pool) — how much USDG comes out?
        // Simulate with a direct pool swap via a tiny callback contract.
        Swapper s = new Swapper();
        MockUSDG(token).mint(address(s), 4_000_000e18); // 1% of curve supply
        uint256 got = s.sellToken0(pool, token, 4_000_000e18);
        console2.log("attacker sold 4M TOKEN (1% of LP side) for USDG", got);
    }
}

interface IPoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

contract Swapper {
    address tokenIn_;

    function sellToken0(address pool, address token0, uint256 amount) external returns (uint256 usdgOut) {
        tokenIn_ = token0;
        (, int256 a1) = IPoolSwap(pool).swap(address(this), true, int256(amount), 4295128740, "");
        usdgOut = uint256(-a1);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256, bytes calldata) external {
        if (amount0Delta > 0) IERC20(tokenIn_).transfer(msg.sender, uint256(amount0Delta));
    }
}
