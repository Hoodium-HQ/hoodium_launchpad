import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import { useProfile } from '@/hooks/useLaunchpad'
import { useTransaction } from '@/hooks/useTransaction'
import { curveAbi } from '@/lib/launchpad-abi'
import type { ClaimableFee } from '@/lib/launchpad-api'

/**
 * The connected wallet's claimable creator fees, per token, and the claim.
 *
 * Amounts come from the API's profile (`claimable`), which reads
 * `creatorFeesAccrued − creatorFeesClaimed` off each curve the wallet created.
 * The claim itself goes browser → curve; the API is only telling us where to
 * look. After a confirmed claim the profile is refetched so the badge drops.
 */
export function useCreatorFees() {
  const { address } = useAccount()
  const profile = useProfile(address)
  const client = useQueryClient()
  const tx = useTransaction()

  const claimable: ClaimableFee[] = (profile.data?.claimable ?? []).filter((c) => c.amount !== '0')

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
