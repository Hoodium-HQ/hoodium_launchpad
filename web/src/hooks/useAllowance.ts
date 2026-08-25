import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { erc20Abi } from '@/lib/launchpad-abi'

const ZERO = '0x0000000000000000000000000000000000000000' as const

/** How long to keep asking a lagging RPC for the new allowance before giving up. */
const SYNC_ATTEMPTS = 12
const SYNC_INTERVAL_MS = 1_500

/**
 * An ERC-20 allowance that knows how to catch up after an approval.
 *
 * wagmi's `useReadContract` never refetches on its own, so a flag derived from
 * it stays stale after the approval confirms — the button kept saying "Approve"
 * over a green "Confirmed", and a second press approved again. `awaitAtLeast`
 * re-reads until the chain reports the granted amount (the public Robinhood RPC
 * can sit a block or two behind the receipt), with a cap so a genuinely missing
 * approval does not spin forever.
 */
export function useAllowance({
  token,
  owner,
  spender,
  enabled = true,
}: {
  token: Address | ''
  owner: Address | undefined
  spender: Address | ''
  enabled?: boolean
}) {
  const client = useQueryClient()
  const [syncing, setSyncing] = useState(false)

  const query = useReadContract({
    address: (token || '0x') as Address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner ?? ZERO, (spender || ZERO) as Address],
    query: { enabled: enabled && Boolean(token && owner && spender) },
  })
  const { refetch } = query

  const awaitAtLeast = useCallback(
    async (min: bigint): Promise<boolean> => {
      setSyncing(true)
      try {
        for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
          const result = await refetch()
          if ((result.data ?? 0n) >= min) return true
          await new Promise((resolve) => setTimeout(resolve, SYNC_INTERVAL_MS))
        }
        return false
      } finally {
        setSyncing(false)
        // Whatever moved the allowance may have moved balances too.
        void invalidateBalances(client)
      }
    },
    [refetch, client],
  )

  return { allowance: query.data, syncing, refetch, awaitAtLeast }
}

/**
 * Drop every cached `balanceOf` read. wagmi keys reads as
 * `['readContract', { address, functionName, args, … }]`, and react-query's
 * partial matching lets one call cover every token and every holder.
 */
export function invalidateBalances(client: ReturnType<typeof useQueryClient>) {
  return client.invalidateQueries({ queryKey: ['readContract', { functionName: 'balanceOf' }] })
}
