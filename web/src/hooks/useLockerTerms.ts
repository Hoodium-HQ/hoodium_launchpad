import { useReadContract } from 'wagmi'
import { env } from '@/config/env'
import { factoryAbi, graduationManagerAbi, lpLockerAbi } from '@/lib/launchpad-abi'

export interface LockerTerms {
  /** The lock contract holding graduated positions, or undefined until resolved. */
  address: `0x${string}` | undefined
  /** The graduation manager (holds creators' migration dust), or undefined until resolved. */
  manager: `0x${string}` | undefined
  /** Creator's share of pool fees, as a percentage. Null until read. */
  creatorPct: number | null
  /** Protocol's share of pool fees, as a percentage. Null until read. */
  protocolPct: number | null
}

/**
 * The pool-fee split, read from the chain.
 *
 * Hoodium takes a share of a graduated pool's fees on the condition that it is
 * stated plainly in the UI. That obligation lands in two places — the launch
 * form, where a creator agrees to it, and the token page, where they claim
 * against it — and this hook is what makes both read the same number from the
 * same contract. A percentage hard-coded in a component is free to drift from
 * the percentage the contract actually takes.
 *
 * Discovery is factory → graduationManager → locker, unless `VITE_LOCKER`
 * short-circuits it. Every value is immutable, so wagmi caches them forever.
 */
export function useLockerTerms(): LockerTerms {
  const factory = env.launchpadFactory as `0x${string}`
  const configured = env.locker as `0x${string}` | ''
  const enabled = Boolean(factory)

  // The manager is read even when the locker is configured: it is where a
  // creator's migration dust waits, and there is no shortcut env for it.
  const { data: manager } = useReadContract({
    address: factory,
    abi: factoryAbi,
    functionName: 'graduationManager',
    query: { enabled, staleTime: Infinity },
  })

  const { data: discovered } = useReadContract({
    address: manager,
    abi: graduationManagerAbi,
    functionName: 'locker',
    query: { enabled: enabled && !configured && Boolean(manager), staleTime: Infinity },
  })

  const locker = configured || discovered

  const { data: shareBps } = useReadContract({
    address: locker || undefined,
    abi: lpLockerAbi,
    functionName: 'protocolFeeShareBps',
    query: { enabled: Boolean(locker), staleTime: Infinity },
  })

  if (shareBps === undefined) {
    return { address: locker || undefined, manager, creatorPct: null, protocolPct: null }
  }

  return {
    address: locker || undefined,
    manager,
    creatorPct: (10_000 - Number(shareBps)) / 100,
    protocolPct: Number(shareBps) / 100,
  }
}
