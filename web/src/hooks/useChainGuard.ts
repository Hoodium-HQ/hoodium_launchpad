import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { robinhoodChain } from '@/config/chain'

/**
 * WA-1.2 — "WHEN connected to the wrong chain THEN the app SHALL prompt to
 * switch to Robinhood Chain and SHALL disable all actions until switched."
 *
 * 004 section 3 extends the backend's mainnet guard to the build target: the
 * frontend performs the equivalent check and refuses to render trading surfaces
 * on mismatch.
 *
 * `WA-1.3` is the counterweight — browsing and charts require no connection at
 * all, so a disconnected visitor is `ready: true` for reads and `canAct: false`
 * for writes, not blocked outright.
 */
export function useChainGuard() {
  const { isConnected, address } = useAccount()
  const connectedChainId = useChainId()
  const { switchChain, isPending, error } = useSwitchChain()

  const expectedChainId = robinhoodChain.id
  const isWrongChain = isConnected && connectedChainId !== expectedChainId

  return {
    address,
    isConnected,
    connectedChainId,
    expectedChainId,
    expectedChainName: robinhoodChain.name,
    isWrongChain,
    /** Writes are permitted only on a connected, correct chain. */
    canAct: isConnected && !isWrongChain,
    isSwitching: isPending,
    switchError: error,
    switchToExpected: () => switchChain({ chainId: expectedChainId }),
  }
}
