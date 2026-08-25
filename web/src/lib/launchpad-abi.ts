/**
 * Contract ABIs — human-readable fragments regenerated from
 * `../contracts/abi/*.json` (HoodiumFactory, BondingCurve, LPLocker,
 * GraduationManager) after the 2026-08-25 security fix pass. Only what the app
 * calls or decodes is listed; the JSON files are the authority.
 *
 * Every action that moves money goes browser → chain directly, using these
 * fragments. Trading and claiming must keep working with Hoodium's servers
 * fully offline, which is why nothing here is fetched from the API.
 */
import { parseAbi } from 'viem'

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

export const factoryAbi = parseAbi([
  'function launch(string name, string symbol, string metadataURI, uint256 devBuyUsdg, uint256 devBuyMinTokens) returns (address token, address curve)',
  'function curveOf(address token) view returns (address)',
  'function launchCount() view returns (uint256)',
  'function launchesByCreator(address creator) view returns (address[])',
  'function graduationManager() view returns (address)',
  'function feeVault() view returns (address)',
  'function usdg() view returns (address)',
  'function creationFee() view returns (uint256)',
  'function devBuyCapTokens() view returns (uint256)',
  'function graduationTarget() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function virtualUsdg() view returns (uint256)',
  'function curveAllocation() view returns (uint256)',
  'function tradeFeeBps() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function lpAllocation() view returns (uint256)',
  'function graduationFee() view returns (uint256)',
  'function creatorFeeShareBps() view returns (uint256)',
  'function devBuyMaxBps() view returns (uint256)',
  'function snipeBlocks() view returns (uint256)',
  'function snipeMaxBps() view returns (uint256)',
  'function tokenDecimals() view returns (uint8)',
  'function CONTINUITY_TOLERANCE_BPS() view returns (uint256)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint256 devBuyUsdg, uint256 devBuyTokens)',
])

export const curveAbi = parseAbi([
  // `deadline` is a unix timestamp in seconds; past it the trade reverts `Expired`.
  'function buy(uint256 usdgIn, uint256 minTokensOut, uint256 deadline) returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minUsdgOut, uint256 deadline) returns (uint256 usdgOut)',
  // Only for a curve completed by the dev buy at launch; a public buy that
  // reaches the target graduates inside its own transaction.
  'function graduate() returns (address pool_, uint256 tokenId)',
  'function claimCreatorFees() returns (uint256)',
  'function claimPlatformFees() returns (uint256)',
  'function quoteBuy(uint256 usdgIn) view returns (uint256 tokensOut, uint256 fee, uint256 refund, uint256 netIn)',
  'function quoteSell(uint256 tokensIn) view returns (uint256 usdgOut, uint256 fee, uint256 grossOut)',
  'function reserveUsdg() view returns (uint256)',
  'function tokensSold() view returns (uint256)',
  'function progressBps() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function curveComplete() view returns (bool)',
  'function pool() view returns (address)',
  'function lpTokenId() view returns (uint256)',
  'function boughtInWindow(address) view returns (uint256)',
  'function remainingToTarget() view returns (uint256)',
  'function graduationTarget() view returns (uint256)',
  'function creator() view returns (address)',
  'function creatorFeesAccrued() view returns (uint256)',
  'function creatorFeesClaimed() view returns (uint256)',
  'function virtualUsdg() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function curveAllocation() view returns (uint256)',
  'function tradeFeeBps() view returns (uint256)',
  'function creatorFeeShareBps() view returns (uint256)',
  'event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 fee, uint256 refund, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 fee, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Graduated(address indexed token, address indexed pool, uint256 tokenId, uint256 usdgIn, uint256 tokensIn)',
  // Errors are listed so a simulated revert decodes to a name `TxStatus` can translate.
  'error CurveComplete()',
  'error Expired(uint256 deadline)',
  'error AlreadyGraduated()',
  'error AntiSnipeCapExceeded(uint256 requested, uint256 cap)',
  'error SlippageExceeded(uint256 got, uint256 minimum)',
  'error TargetNotReached()',
  'error ZeroAmount()',
  'error ExceedsSold()',
  'error NotCreator()',
  'error UnsupportedTokenBehaviour()',
])

/**
 * The lock that holds a graduated pool's LP position.
 *
 * `protocolFeeShareBps` is read from the contract rather than hard-coded, so
 * the split on screen cannot drift from the split that will actually be taken.
 */
export const lpLockerAbi = parseAbi([
  'function collectFees(uint256 tokenId) returns (uint256 creatorAmount0, uint256 creatorAmount1)',
  // Permissionless: collects, pays the protocol share to the vault, credits the creator's share.
  'function sweepProtocolFees(uint256 tokenId)',
  'function creatorOwed0(uint256 tokenId) view returns (uint256)',
  'function creatorOwed1(uint256 tokenId) view returns (uint256)',
  'function beneficiaryOf(uint256 tokenId) view returns (address)',
  'function tokenOf(uint256 tokenId) view returns (address)',
  'function protocolFeeShareBps() view returns (uint256)',
  'function feeVault() view returns (address)',
  'function positionManager() view returns (address)',
  'function lockedCount() view returns (uint256)',
  'event FeesCollected(uint256 indexed tokenId, address indexed beneficiary, uint256 creatorAmount0, uint256 creatorAmount1, uint256 protocolAmount0, uint256 protocolAmount1)',
  'event CreatorFeesPaid(uint256 indexed tokenId, address indexed beneficiary, uint256 amount0, uint256 amount1)',
  'error NotBeneficiary()',
  'error UnknownPosition()',
])

/**
 * The locker lookup (factory → manager → locker) plus the creator's migration
 * dust, which the manager credits instead of pushing so a frozen recipient can
 * never make graduation revert. The errors are the completing buy's: they
 * bubble up through `BondingCurve.buy` when a primed pool blocks graduation.
 */
export const graduationManagerAbi = parseAbi([
  'function locker() view returns (address)',
  'function positionManager() view returns (address)',
  'function dustOf(address asset, address creator) view returns (uint256)',
  'function pullDust(address asset) returns (uint256 amount)',
  'event DustPulled(address indexed asset, address indexed creator, uint256 amount)',
  'error PoolPriceManipulated(uint160 have, uint160 want)',
  'error UnexpectedSwapPayment(int256 amount0Delta, int256 amount1Delta)',
  'error ExcessiveDust(address asset, uint256 leftover, uint256 desired)',
  'error NothingToPull()',
])
