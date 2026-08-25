/**
 * Contract ABIs — WA-N6: "Shared types SHALL come from one package consumed by
 * both frontend and backend; **no duplicated ABI or model definitions**."
 *
 * Before this package existed, the launchpad ABI lived in two files that could
 * drift silently: the contract changes, one side is updated, the other keeps
 * encoding calldata for a function that no longer exists. There is now one copy.
 */
import { parseAbi } from 'viem'

// ── ERC-20 ──────────────────────────────────────────────────────────────────

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

// ── Uniswap v3 (spec 001) ───────────────────────────────────────────────────

export const positionManagerAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function factory() view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
])

/**
 * The position manager's **write** surface — 003 WA-7.x, browser only.
 *
 * Deliberately a separate export rather than more entries on `positionManagerAbi`,
 * and `@hoodium/core/chain` does not re-export it. 001 keeps the property that
 * nothing server-side can build a position transaction: the API and the worker
 * hold no key (`AL-1.6`), and until Phase 5's session keys exist they must not
 * even be able to encode the calldata. Merging these into the read ABI would
 * hand every server import the ability to, on the same line that fetches
 * `ownerOf`.
 *
 * The browser is the other case entirely. Here the *user's own wallet* signs, in
 * front of them, for their own position — the thing `AL-1.6` forbids is Hoodium
 * holding the key, not the owner using theirs.
 *
 * `multicall` is what makes the compound and remove flows one signature instead
 * of two. It `delegatecall`s into this same contract, so `msg.sender` survives
 * and a `collect` followed by an `increaseLiquidity` still sees the owner.
 */
export const positionManagerWriteAbi = parseAbi([
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(IncreaseLiquidityParams params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
])

export const uniswapFactoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
])

export const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  /*
   * Fee accounting (001 R8, design section 6a). A position's uncollected fees are not
   * exposed by any contract: `positions()` returns what was owed at the last
   * *touch*, and everything earned since then lives in the difference between
   * the pool's fee growth and the growth recorded outside the position's range.
   * These three reads are what make that difference computable.
   */
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
])

/**
 * Uniswap v4 PoolManager — the events pool discovery reads (003 R7).
 *
 * v4 has no per-pool contract, so both of these arrive on the singleton with
 * the pool id as the first indexed topic. Discovery uses `Swap` rather than
 * `Initialize` on purpose: this chain creates roughly 4,600 pools a day, almost
 * all of them dust, while only a few hundred trade in any given window. Which
 * pools *exist* is not a useful question; which pools are *being traded* is.
 *
 * Both signatures were confirmed against real logs on chain 4663 — `Swap`
 * carries two indexed topics beyond the selector, `Initialize` three, and five
 * data words.
 */
export const poolManagerAbi = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])

/** Position-manager events the Auto LP indexer consumes (001 T2.1). */
export const AUTO_LP_INDEXED_EVENTS = [
  'Transfer',
  'IncreaseLiquidity',
  'DecreaseLiquidity',
  'Collect',
] as const

// ── Launchpad (spec 002) ────────────────────────────────────────────────────

export const launchpadFactoryAbi = parseAbi([
  'function launch(string name, string symbol, string metadataURI, uint256 devBuyUsdg, uint256 devBuyMinTokens) returns (address token, address curve)',
  'function curveOf(address token) view returns (address)',
  'function launchCount() view returns (uint256)',
  /** First hop of the on-chain locker lookup — see `lpLockerAbi`. */
  'function graduationManager() view returns (address)',
  'function creationFee() view returns (uint256)',
  'function devBuyCapTokens() view returns (uint256)',
  'function graduationTarget() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function virtualUsdg() view returns (uint256)',
  'function curveAllocation() view returns (uint256)',
  'function tradeFeeBps() view returns (uint256)',
  /*
   * The rest of the launch terms. Read as a block so the launch form can state
   * every number a creator is agreeing to *before* they sign — a preview built
   * from constants in the frontend would be a second copy of the terms, free to
   * disagree with the factory it claims to describe (WA-N6).
   */
  'function totalSupply() view returns (uint256)',
  'function lpAllocation() view returns (uint256)',
  'function graduationFee() view returns (uint256)',
  'function creatorFeeShareBps() view returns (uint256)',
  'function devBuyMaxBps() view returns (uint256)',
  'function snipeBlocks() view returns (uint256)',
  'function snipeMaxBps() view returns (uint256)',
  'function tokenDecimals() view returns (uint8)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint256 devBuyUsdg, uint256 devBuyTokens)',
])

/**
 * The lock that holds a graduated pool's LP position, and the two hops needed to
 * find it from a factory address (T0.4).
 *
 * Discovery is on-chain rather than served by us on purpose: LP-N7 requires the
 * claim path to work with Hoodium's servers fully offline, and a locker address
 * that only our API knows would break that the day the API is down.
 *
 * `protocolFeeShareBps` is here because the token page states the split in words
 * before anyone claims. It is read from the contract rather than hard-coded, so
 * the number on screen cannot drift from the number that will actually be taken.
 */
export const lpLockerAbi = parseAbi([
  'function collectFees(uint256 tokenId) returns (uint256 creatorAmount0, uint256 creatorAmount1)',
  'function beneficiaryOf(uint256 tokenId) view returns (address)',
  'function tokenOf(uint256 tokenId) view returns (address)',
  'function protocolFeeShareBps() view returns (uint256)',
  'function feeVault() view returns (address)',
  'function positionManager() view returns (address)',
  'function MAX_PROTOCOL_FEE_SHARE_BPS() view returns (uint256)',
  'event FeesCollected(uint256 indexed tokenId, address indexed beneficiary, uint256 creatorAmount0, uint256 creatorAmount1, uint256 protocolAmount0, uint256 protocolAmount1)',
])

/** Only the two getters the locker lookup needs — factory → manager → locker. */
export const graduationManagerAbi = parseAbi([
  'function locker() view returns (address)',
  'function positionManager() view returns (address)',
])

export const bondingCurveAbi = parseAbi([
  'function buy(uint256 usdgIn, uint256 minTokensOut) returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minUsdgOut) returns (uint256 usdgOut)',
  'function graduate() returns (address pool, uint256 tokenId)',
  'function claimCreatorFees() returns (uint256)',
  'function claimPlatformFees() returns (uint256)',
  'function quoteBuy(uint256 usdgIn) view returns (uint256 tokensOut, uint256 fee, uint256 refund, uint256 netIn)',
  'function quoteSell(uint256 tokensIn) view returns (uint256 usdgOut, uint256 fee, uint256 grossOut)',
  'function reserveUsdg() view returns (uint256)',
  'function tokensSold() view returns (uint256)',
  'function progressBps() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function curveComplete() view returns (bool)',
  'function graduationTarget() view returns (uint256)',
  'function creator() view returns (address)',
  'function creatorFeesAccrued() view returns (uint256)',
  'function creatorFeesClaimed() view returns (uint256)',
  'function virtualUsdg() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function curveAllocation() view returns (uint256)',
  'function tradeFeeBps() view returns (uint256)',
  'event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 fee, uint256 refund, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 fee, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Graduated(address indexed token, address indexed pool, uint256 tokenId, uint256 usdgIn, uint256 tokensIn)',
])

export const LAUNCHPAD_FACTORY_EVENTS = ['TokenLaunched'] as const
export const LAUNCHPAD_CURVE_EVENTS = ['Bought', 'Sold', 'Graduated'] as const
