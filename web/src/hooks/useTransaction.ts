import { useCallback, useState } from 'react'
import { BaseError, ContractFunctionRevertedError, type Abi, type Address } from 'viem'
import { usePublicClient, useWalletClient } from 'wagmi'
import { useChainGuard } from './useChainGuard'

/**
 * T1.4 / WA-4.1–WA-4.4 — one hook wrapping every write.
 *
 * design.md section 6:
 *
 *   idle → simulating → awaiting_signature → pending → confirmed
 *                            │                  │
 *                            └──▶ rejected      └──▶ failed (decoded reason)
 *
 * **Always simulate first.** A simulated revert becomes a readable message
 * *before* the user is asked to sign, rather than a wasted signature and a hex
 * string afterwards (WA-4.3).
 */
export type TxState = 'idle' | 'simulating' | 'awaiting_signature' | 'pending' | 'confirmed' | 'rejected' | 'failed'

export interface TxRequest {
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
}

export interface TransactionResult {
  state: TxState
  hash: `0x${string}` | null
  /** Decoded revert reason, never a raw hex string (WA-4.3). */
  error: string | null
  isBusy: boolean
  execute: (request: TxRequest) => Promise<`0x${string}` | null>
  reset: () => void
}

/** Turn a viem error into something a human can act on (WA-4.3). */
export function decodeTxError(err: unknown): { message: string; rejected: boolean } {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name) {
        // Custom errors carry the contract's own vocabulary; surface it verbatim
        // and let the caller map it to copy.
        const args = reverted.data?.args?.length ? ` (${reverted.data.args.join(', ')})` : ''
        return { message: `${name}${args}`, rejected: false }
      }
      if (reverted.reason) return { message: reverted.reason, rejected: false }
    }

    const text = err.shortMessage || err.message
    const rejected = /user rejected|denied|rejected the request/i.test(text)
    return { message: rejected ? 'You declined the signature. Nothing was sent.' : text, rejected }
  }

  const text = err instanceof Error ? err.message : String(err)
  const rejected = /user rejected|denied/i.test(text)
  return { message: rejected ? 'You declined the signature. Nothing was sent.' : text, rejected }
}

export function useTransaction(): TransactionResult {
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { canAct } = useChainGuard()

  const [state, setState] = useState<TxState>('idle')
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setState('idle')
    setHash(null)
    setError(null)
  }, [])

  const execute = useCallback(
    async (request: TxRequest) => {
      if (!walletClient || !publicClient) {
        setError('Connect a wallet first.')
        setState('failed')
        return null
      }
      // WA-1.2 — every action is disabled until the chain matches.
      if (!canAct) {
        setError('Switch to the correct network before continuing.')
        setState('failed')
        return null
      }

      setError(null)
      setHash(null)

      try {
        // 1. Simulate. A revert here costs nothing and produces a real message.
        setState('simulating')
        const { request: simulated } = await publicClient.simulateContract({
          account: walletClient.account,
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args,
        })

        // 2. Sign.
        setState('awaiting_signature')
        const txHash = await walletClient.writeContract(simulated)
        setHash(txHash)

        // 3. Wait. WA-4.2 — the app stays usable while this resolves.
        setState('pending')
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

        if (receipt.status === 'reverted') {
          setState('failed')
          setError('The transaction reverted on-chain.')
          return null
        }

        setState('confirmed')
        return txHash
      } catch (err) {
        const decoded = decodeTxError(err)
        setError(decoded.message)
        setState(decoded.rejected ? 'rejected' : 'failed')
        return null
      }
    },
    [walletClient, publicClient, canAct],
  )

  return {
    state,
    hash,
    error,
    isBusy: state === 'simulating' || state === 'awaiting_signature' || state === 'pending',
    execute,
    reset,
  }
}
