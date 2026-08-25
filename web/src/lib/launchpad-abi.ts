/**
 * Contract ABIs — vendored from the retired `@hoodium/shared/abi` module and
 * checked against `../contracts/src` (HoodiumFactory, BondingCurve, LPLocker,
 * GraduationManager).
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
  'event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint256 devBuyUsdg, uint256 devBuyTokens)',
])

export const curveAbi = parseAbi([
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
  'function creatorFeeShareBps() view returns (uint256)',
  'event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 fee, uint256 refund, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 fee, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Graduated(address indexed token, address indexed pool, uint256 tokenId, uint256 usdgIn, uint256 tokensIn)',
])

/**
 * The lock that holds a graduated pool's LP position.
 *
 * `protocolFeeShareBps` is read from the contract rather than hard-coded, so
 * the split on screen cannot drift from the split that will actually be taken.
 */
export const lpLockerAbi = parseAbi([
  'function collectFees(uint256 tokenId) returns (uint256 creatorAmount0, uint256 creatorAmount1)',
  'function beneficiaryOf(uint256 tokenId) view returns (address)',
  'function tokenOf(uint256 tokenId) view returns (address)',
  'function protocolFeeShareBps() view returns (uint256)',
  'function feeVault() view returns (address)',
  'function positionManager() view returns (address)',
  'function lockedCount() view returns (uint256)',
  'event FeesCollected(uint256 indexed tokenId, address indexed beneficiary, uint256 creatorAmount0, uint256 creatorAmount1, uint256 protocolAmount0, uint256 protocolAmount1)',
])

/** Only the getters the locker lookup needs — factory → manager → locker. */
export const graduationManagerAbi = parseAbi([
  'function locker() view returns (address)',
  'function positionManager() view returns (address)',
])
