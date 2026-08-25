/**
 * Launch terms, read from the factory — LP-N1.
 *
 * Immutable and admin-free: every launch parameter is fixed at factory
 * deployment. Read once, cached for the process lifetime; the only way they
 * change is a new factory address, which is a redeploy.
 *
 * Reads `launchpadFactoryAbi` explicitly. The historical `terms.ts` imported a
 * symbol named `factoryAbi`, which in one revision resolved to the *Uniswap*
 * factory ABI and made every terms read revert as "function not found". The
 * ABI here is the launchpad's own, and the two are never aliased to one name.
 *
 * Fifteen separate reads rather than one `multicall`: the chain definition
 * declares no Multicall3 contract, so `client.multicall()` would throw before
 * opening a socket. The values are immutable, so reads straddling a block
 * boundary cannot disagree.
 */
import type { Address } from 'viem'
import { launchpadFactoryAbi, graduationManagerAbi, lpLockerAbi } from '../chain/abi.js'
import type { ChainClient } from '../chain/client.js'
import { componentLogger } from '../lib/logger.js'
import type { LaunchTerms } from '../types.js'

const log = componentLogger('terms')

let cache: { key: string; terms: LaunchTerms } | null = null
let inflight: Promise<LaunchTerms | null> | null = null

export function resetLaunchTermsCacheForTesting(): void {
  cache = null
  inflight = null
}

export function setLaunchTermsForTesting(terms: LaunchTerms | null, key = 'test'): void {
  cache = terms ? { key, terms } : null
}

/**
 * @returns the factory's terms, or `null` when no factory is configured or the
 * chain cannot be reached. Null is a real answer the caller must render.
 */
export async function loadLaunchTerms(
  chain: ChainClient,
  factoryAddress: string | null,
  chainId: number,
): Promise<LaunchTerms | null> {
  if (!factoryAddress) return cache?.terms ?? null

  const key = `${chainId}:${factoryAddress.toLowerCase()}`
  if (cache?.key === key) return cache.terms
  if (inflight) return inflight

  inflight = readTerms(chain, factoryAddress, key).finally(() => {
    inflight = null
  })
  return inflight
}

async function readTerms(chain: ChainClient, factoryAddress: string, key: string): Promise<LaunchTerms | null> {
  const contract = { address: factoryAddress as Address, abi: launchpadFactoryAbi } as const

  try {
    const r = await chain.call('reads:launchTerms', (client) =>
      Promise.all([
        client.readContract({ ...contract, functionName: 'totalSupply' }),
        client.readContract({ ...contract, functionName: 'curveAllocation' }),
        client.readContract({ ...contract, functionName: 'lpAllocation' }),
        client.readContract({ ...contract, functionName: 'tokenDecimals' }),
        client.readContract({ ...contract, functionName: 'virtualUsdg' }),
        client.readContract({ ...contract, functionName: 'virtualTokens' }),
        client.readContract({ ...contract, functionName: 'creationFee' }),
        client.readContract({ ...contract, functionName: 'graduationTarget' }),
        client.readContract({ ...contract, functionName: 'graduationFee' }),
        client.readContract({ ...contract, functionName: 'devBuyCapTokens' }),
        client.readContract({ ...contract, functionName: 'devBuyMaxBps' }),
        client.readContract({ ...contract, functionName: 'tradeFeeBps' }),
        client.readContract({ ...contract, functionName: 'creatorFeeShareBps' }),
        client.readContract({ ...contract, functionName: 'snipeBlocks' }),
        client.readContract({ ...contract, functionName: 'snipeMaxBps' }),
        client.readContract({ ...contract, functionName: 'usdg' }),
        client.readContract({ ...contract, functionName: 'feeVault' }),
        client.readContract({ ...contract, functionName: 'graduationManager' }),
      ]),
    )

    const [
      totalSupply,
      curveAllocation,
      lpAllocation,
      tokenDecimals,
      virtualUsdg,
      virtualTokens,
      creationFee,
      graduationTarget,
      graduationFee,
      devBuyCapTokens,
      devBuyMaxBps,
      tradeFeeBps,
      creatorFeeShareBps,
      snipeBlocks,
      snipeMaxBps,
      usdg,
      feeVault,
      graduationManager,
    ] = r

    // Second and third hop: the locker and its protocol share. Optional — a
    // manager that cannot be read leaves these null rather than failing the terms.
    let locker: string | null = null
    let protocolFeeShareBps: number | null = null
    let positionManager: string | null = null
    try {
      const managerContract = { address: graduationManager as Address, abi: graduationManagerAbi } as const
      const [lockerAddr, pm] = await chain.call('reads:graduationManager', (client) =>
        Promise.all([
          client.readContract({ ...managerContract, functionName: 'locker' }),
          client.readContract({ ...managerContract, functionName: 'positionManager' }),
        ]),
      )
      locker = lockerAddr.toLowerCase()
      positionManager = pm.toLowerCase()
      const share = await chain.call('reads:locker', (client) =>
        client.readContract({ address: lockerAddr, abi: lpLockerAbi, functionName: 'protocolFeeShareBps' }),
      )
      protocolFeeShareBps = Number(share)
    } catch (err) {
      log.warn({ err }, 'could not read the locker terms; continuing without them')
    }

    const terms: LaunchTerms = {
      factoryAddress: factoryAddress.toLowerCase(),
      usdgAddress: usdg.toLowerCase(),
      feeVault: feeVault.toLowerCase(),
      graduationManager: graduationManager.toLowerCase(),
      locker,
      positionManager,
      totalSupply: totalSupply.toString(),
      curveAllocation: curveAllocation.toString(),
      lpAllocation: lpAllocation.toString(),
      tokenDecimals: Number(tokenDecimals),
      virtualUsdg: virtualUsdg.toString(),
      virtualTokens: virtualTokens.toString(),
      creationFee: creationFee.toString(),
      graduationTarget: graduationTarget.toString(),
      graduationFee: graduationFee.toString(),
      devBuyCapTokens: devBuyCapTokens.toString(),
      devBuyMaxBps: Number(devBuyMaxBps),
      tradeFeeBps: Number(tradeFeeBps),
      creatorFeeShareBps: Number(creatorFeeShareBps),
      protocolFeeShareBps,
      snipeBlocks: Number(snipeBlocks),
      snipeMaxBps: Number(snipeMaxBps),
    }

    cache = { key, terms }
    log.info({ factoryAddress }, 'launch terms loaded')
    return terms
  } catch (err) {
    log.warn({ err, factoryAddress }, 'could not read launch terms from the factory')
    return null
  }
}
