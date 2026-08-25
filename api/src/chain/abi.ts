/**
 * Contract ABIs — vendored.
 *
 * `../../contracts/abi/*.json` did not exist when this package was written, so
 * these fragments were transcribed from `contracts/src/HoodiumFactory.sol`,
 * `BondingCurve.sol`, `LPLocker.sol` and `GraduationManager.sol` (events and
 * public getters verified by hand against the Solidity). When the generated
 * JSON ABIs land, swap these for `import factory from '../../../contracts/abi/HoodiumFactory.json'`
 * — the names used below are the contract's own.
 */
import { parseAbi } from 'viem'

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

export const launchpadFactoryAbi = parseAbi([
  'function launch(string name, string symbol, string metadataURI, uint256 devBuyUsdg, uint256 devBuyMinTokens) returns (address token, address curve)',
  'function curveOf(address token) view returns (address)',
  'function launchCount() view returns (uint256)',
  'function launchesByCreator(address creator) view returns (address[])',
  'function usdg() view returns (address)',
  'function feeVault() view returns (address)',
  'function graduationManager() view returns (address)',
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
  'function token() view returns (address)',
  'function creatorFeesAccrued() view returns (uint256)',
  'function creatorFeesClaimed() view returns (uint256)',
  'function platformFeesAccrued() view returns (uint256)',
  'function platformFeesClaimed() view returns (uint256)',
  'function virtualUsdg() view returns (uint256)',
  'function virtualTokens() view returns (uint256)',
  'function curveAllocation() view returns (uint256)',
  'function tradeFeeBps() view returns (uint256)',
  'function creatorFeeShareBps() view returns (uint256)',
  'event Bought(address indexed buyer, uint256 usdgIn, uint256 tokensOut, uint256 fee, uint256 refund, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event Sold(address indexed seller, uint256 tokensIn, uint256 usdgOut, uint256 fee, uint256 reserveAfter, uint256 tokensSoldAfter)',
  'event FeesAccrued(uint256 creatorAmount, uint256 platformAmount)',
  'event CreatorFeesClaimed(address indexed to, uint256 amount)',
  'event PlatformFeesClaimed(address indexed to, uint256 amount)',
  'event Graduated(address indexed token, address indexed pool, uint256 tokenId, uint256 usdgIn, uint256 tokensIn)',
])

export const graduationManagerAbi = parseAbi([
  'function locker() view returns (address)',
  'function positionManager() view returns (address)',
  'function uniswapFactory() view returns (address)',
  'function poolFee() view returns (uint24)',
])

export const lpLockerAbi = parseAbi([
  'function collectFees(uint256 tokenId) returns (uint256 creatorAmount0, uint256 creatorAmount1)',
  'function beneficiaryOf(uint256 tokenId) view returns (address)',
  'function tokenOf(uint256 tokenId) view returns (address)',
  'function protocolFeeShareBps() view returns (uint256)',
  'function feeVault() view returns (address)',
  'function positionManager() view returns (address)',
  'function MAX_PROTOCOL_FEE_SHARE_BPS() view returns (uint256)',
  'event PositionLocked(uint256 indexed tokenId, address indexed token, address indexed beneficiary)',
  'event FeesCollected(uint256 indexed tokenId, address indexed beneficiary, uint256 creatorAmount0, uint256 creatorAmount1, uint256 protocolAmount0, uint256 protocolAmount1)',
])

type AbiEvent<T extends readonly unknown[]> = Extract<T[number], { type: 'event' }>

export const factoryEvents = launchpadFactoryAbi.filter(
  (i): i is AbiEvent<typeof launchpadFactoryAbi> => i.type === 'event',
)

/** The curve events the indexer consumes. Fee-claim events are read too, for the creator ledger. */
export const curveEvents = bondingCurveAbi.filter((i): i is AbiEvent<typeof bondingCurveAbi> => i.type === 'event')

export const LAUNCHPAD_FACTORY_EVENTS = ['TokenLaunched'] as const
export const LAUNCHPAD_CURVE_EVENTS = ['Bought', 'Sold', 'Graduated', 'CreatorFeesClaimed'] as const
