import { Coins } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { Address } from '@/components/Address'
import { TxStatus } from '@/components/TxStatus'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { env } from '@/config/env'
import { useTransaction } from '@/hooks/useTransaction'
import { curveAbi } from '@/lib/launchpad-abi'
import type { TokenDetail } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'

/**
 * Creator fee claim.
 *
 * Accrued and claimed are both on-chain counters, read directly from the
 * curve. The indexer's figure would be a second answer to the same question,
 * and it lags — a creator would claim, see the old number, and claim again.
 *
 * There is no payout-wallet control: `claimCreatorFees` transfers to
 * `creator`, which is `msg.sender` at deployment and immutable.
 */
export function CreatorFeesCard({ token }: { token: TokenDetail }) {
  const { address } = useAccount()
  const tx = useTransaction()

  const curve = token.curve as `0x${string}`
  const isCreator = Boolean(address && address.toLowerCase() === token.creator.toLowerCase())

  const { data: accrued, refetch: refetchAccrued } = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: 'creatorFeesAccrued',
    query: { enabled: isCreator, refetchInterval: 15_000 },
  })

  const { data: claimed, refetch: refetchClaimed } = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: 'creatorFeesClaimed',
    query: { enabled: isCreator, refetchInterval: 15_000 },
  })

  // Only the creator can claim, so nobody else needs to see the panel at all.
  if (!isCreator) return null

  const claimable = (accrued ?? 0n) - (claimed ?? 0n)

  const claim = async () => {
    const hash = await tx.execute({
      address: curve,
      abi: curveAbi,
      functionName: 'claimCreatorFees',
      args: [],
    })
    if (hash) {
      void refetchAccrued()
      void refetchClaimed()
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
          <Coins className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-card-title">Creator fees</h2>
          <p className="mt-0.5 text-label text-muted-foreground">
            Your share of every trade against the curve, accrued in {env.quoteSymbol}.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Figure label="Claimable">
          {formatAmount(fromBaseUnits(claimable, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
        </Figure>
        <Figure label="Claimed to date">
          {formatAmount(fromBaseUnits(claimed ?? 0n, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
        </Figure>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <div>
          <p className="text-label text-muted-foreground">Payout wallet</p>
          <Address value={token.creator} link className="mt-0.5" />
        </div>
        <p className="max-w-[16rem] text-label text-muted-foreground">
          Fixed at deployment and immutable — there is no path in the contract to redirect it.
        </p>
      </div>

      <Button
        variant="primary"
        className="mt-4 w-full"
        disabled={claimable <= 0n || tx.isBusy}
        onClick={() => void claim()}
      >
        {tx.isBusy
          ? 'Working…'
          : claimable > 0n
            ? `Claim ${formatAmount(fromBaseUnits(claimable, env.quoteDecimals), { dp: 4 })} ${env.quoteSymbol}`
            : 'No fees to claim'}
      </Button>

      <TxStatus tx={tx} className="mt-3" />
    </Card>
  )
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="num mt-1 text-[17px] font-medium">{children}</p>
    </div>
  )
}
