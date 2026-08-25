import { PackageOpen } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { TxStatus } from '@/components/TxStatus'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { env } from '@/config/env'
import { useLockerTerms } from '@/hooks/useLockerTerms'
import { useTransaction } from '@/hooks/useTransaction'
import { graduationManagerAbi } from '@/lib/launchpad-abi'
import type { TokenDetail } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'

const ZERO = '0x0000000000000000000000000000000000000000' as const

/**
 * Migration leftovers, for the creator of a graduated token.
 *
 * Seeding a full-range position never takes exactly both sides; the sliver
 * left over (at most 1% of either) is the creator's. The manager does not push
 * it to them — USDG is freezable, and a frozen recipient must not be able to
 * make graduation revert — it credits `dustOf(asset, creator)` and the creator
 * pulls it. Rendered only for the creator, and only while something is owed.
 */
export function LeftoverCard({ token }: { token: TokenDetail }) {
  const { address } = useAccount()
  const { manager } = useLockerTerms()
  const tx = useTransaction()

  const graduated = token.status === 'graduated' || token.graduated
  const isCreator = Boolean(address && address.toLowerCase() === token.creator.toLowerCase())
  const enabled = graduated && isCreator && Boolean(manager)
  const creator = (address ?? ZERO) as `0x${string}`
  const quote = (env.quoteAddress || ZERO) as `0x${string}`
  const tokenAddress = token.address as `0x${string}`

  const { data: quoteDust, refetch: refetchQuote } = useReadContract({
    address: manager,
    abi: graduationManagerAbi,
    functionName: 'dustOf',
    args: [quote, creator],
    query: { enabled: enabled && Boolean(env.quoteAddress), refetchInterval: 30_000 },
  })
  const { data: tokenDust, refetch: refetchToken } = useReadContract({
    address: manager,
    abi: graduationManagerAbi,
    functionName: 'dustOf',
    args: [tokenAddress, creator],
    query: { enabled, refetchInterval: 30_000 },
  })

  const owedQuote = quoteDust ?? 0n
  const owedToken = tokenDust ?? 0n
  if (!enabled || (owedQuote === 0n && owedToken === 0n && tx.state === 'idle')) return null

  const pull = async (asset: `0x${string}`) => {
    if (!manager) return
    const hash = await tx.execute({ address: manager, abi: graduationManagerAbi, functionName: 'pullDust', args: [asset] })
    if (hash) {
      void refetchQuote()
      void refetchToken()
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
          <PackageOpen className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-card-title">Leftover from graduation</h2>
          <p className="mt-0.5 text-label text-muted-foreground">
            What the pool did not take when it was seeded. It is yours, held on the graduation manager until
            you pull it.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Figure label={`Leftover · ${env.quoteSymbol}`}>
          {formatAmount(fromBaseUnits(owedQuote, env.quoteDecimals), { dp: 4 })}
        </Figure>
        <Figure label={`Leftover · ${token.symbol}`}>{formatAmount(fromBaseUnits(owedToken, 18), { dp: 4 })}</Figure>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Button variant="primary" disabled={owedQuote === 0n || tx.isBusy} onClick={() => void pull(quote)}>
          {tx.isBusy ? 'Working…' : `Pull leftover ${env.quoteSymbol}`}
        </Button>
        <Button variant="outline" disabled={owedToken === 0n || tx.isBusy} onClick={() => void pull(tokenAddress)}>
          {tx.isBusy ? 'Working…' : `Pull leftover ${token.symbol}`}
        </Button>
      </div>

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
