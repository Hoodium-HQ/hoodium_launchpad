import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { useProfile } from '@/hooks/useLaunchpad'
import { useTransaction } from '@/hooks/useTransaction'
import { curveAbi } from '@/lib/launchpad-abi'
import type { ProfileLaunch } from '@/lib/launchpad-api'

/** One launch of the connected wallet's with creator fees waiting on its curve. */
export interface ClaimableFee {
  token: ProfileLaunch
  curve: string
  /** Quote base units — `creatorFeesAccrued − creatorFeesClaimed` on the curve. */
  amount: string
}

/**
 * The connected wallet's claimable creator fees, per token, and the claim.
 *
 * Amounts come from the API's profile: every launch carries
 * `creatorFeesClaimable`, read off its curve, or `null` when the curve could
 * not be read — a null is not a zero and is left out rather than shown as
 * nothing to claim. The claim itself goes browser → curve; the API is only
 * telling us where to look. After a confirmed claim the profile is refetched
 * so the badge drops.
 */
export function useCreatorFees() {
  const { address } = useAccount()
  const profile = useProfile(address)
  const client = useQueryClient()
  const tx = useTransaction()

  const claimable: ClaimableFee[] = (profile.data?.launches ?? []).flatMap((launch) => {
    const amount = launch.creatorFeesClaimable
    if (amount === null || BigInt(amount) <= 0n) return []
    return [{ token: launch, curve: launch.curve, amount }]
  })

  const claim = async (fee: ClaimableFee) => {
    const hash = await tx.execute({
      address: fee.curve as `0x${string}`,
      abi: curveAbi,
      functionName: 'claimCreatorFees',
      args: [],
    })
    if (hash) void client.invalidateQueries({ queryKey: ['profile', address?.toLowerCase()] })
    return hash
  }

  return { claimable, count: claimable.length, claim, tx, isLoading: profile.isLoading }
}
