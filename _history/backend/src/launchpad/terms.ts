/**
 * Launch terms, read from the factory — LP-N1.
 *
 * "Immutable and admin-free. Every launch parameter is fixed at factory
 *  deployment, so a creator can read them before launching and know they cannot
 *  move afterwards."
 *
 * The launch form shows a creator the fee, the split, the graduation target and
 * the dev-buy cap before they sign. Those numbers come from here — one read of
 * the contract — rather than from configuration on either side. A constant in the
 * frontend would be a second copy of the terms, free to disagree with the factory
 * it claims to describe, and the disagreement would only surface as a reverted
 * transaction (WA-N6).
 *
 * Cached for the process lifetime, because immutable means immutable. The only
 * way these change is a new factory address, which is a redeploy.
 */
import type { Address } from 'viem'
import { factoryAbi } from '../chain/launchpad-abi.js'
import { componentLogger } from '../lib/logger.js'
import type { ChainClient } from '../chain/rpc.js'

const log = componentLogger('launchpad-terms')

export interface LaunchTerms {
  factoryAddress: string
  /** Base units, 18 decimals unless the factory says otherwise. */
  totalSupply: string
  curveAllocation: string
  lpAllocation: string
  tokenDecimals: number
  /**
   * The opening reserves. Sent because the launch form has to price a dev buy
   * against a curve that does not exist yet — there is no `quoteBuy` to call
   * until the token is deployed, so the form runs the shared curve math on these
   * (`@hoodium/shared/curve`, which mirrors the contract bit for bit).
   */
  virtualUsdg: string
  virtualTokens: string
  /** Quote-token base units. */
  creationFee: string
  graduationTarget: string
  graduationFee: string
  /** The most a creator may buy of their own launch, in token base units (LP-1.6). */
  devBuyCapTokens: string
  devBuyMaxBps: number
  tradeFeeBps: number
  creatorFeeShareBps: number
  snipeBlocks: number
  snipeMaxBps: number
}

let cache: { key: string; terms: LaunchTerms } | null = null

export function resetLaunchTermsCacheForTesting(): void {
  cache = null
}

/**
 * @returns the factory's terms, or `null` when no factory is deployed here or the
 * chain cannot be reached. Null is a real answer the caller must render — a
 * launch form that invents a fee is worse than one that says it cannot read it.
 */
export async function loadLaunchTerms(
  chain: ChainClient,
  factoryAddress: string | undefined,
  chainId: number,
): Promise<LaunchTerms | null> {
  if (!factoryAddress) return null

  const key = `${chainId}:${factoryAddress.toLowerCase()}`
  if (cache?.key === key) return cache.terms

  const contract = { address: factoryAddress as Address, abi: factoryAbi } as const

  /*
   * Fifteen separate reads rather than one `multicall`.
   *
   * viem resolves the Multicall3 address from `chain.contracts.multicall3`, and
   * the chain this process builds (chain/rpc.ts) declares no contracts at all —
   * so `client.multicall()` throws `ChainDoesNotSupportContract` before it opens
   * a socket, on every chain, and these terms were therefore never readable
   * anywhere. The launch form's "Launch terms unavailable" was that, not a
   * chain problem.
   *
   * The fix is not to assert the canonical Multicall3 address in the chain
   * definition. That would be a claim about every chain this runs on that nobody
   * verified, and on a local anvil it is verifiably false — anvil 1.7 does not
   * predeploy it.
   *
   * Nothing is lost by splitting them. Multicall's value is atomicity: all reads
   * observe one block. These values are immutable by construction (LP-N1 — fixed
   * at factory deployment, no admin, no setter), so reads that straddle a block
   * boundary cannot disagree. And the result is cached for the process lifetime,
   * so the extra round trips are paid once.
   */
  try {
    const results = await chain.call('reads:launchTerms', (client) =>
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
    ] = results as unknown as [
      bigint, bigint, bigint, number, bigint, bigint, bigint,
      bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
    ]

    const terms: LaunchTerms = {
      factoryAddress: factoryAddress.toLowerCase(),
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
      snipeBlocks: Number(snipeBlocks),
      snipeMaxBps: Number(snipeMaxBps),
    }

    cache = { key, terms }
    return terms
  } catch (err) {
    log.warn({ err, factoryAddress }, 'could not read launch terms from the factory')
    return null
  }
}
