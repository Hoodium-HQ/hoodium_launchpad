import { Waves } from 'lucide-react'
import { useAccount, useReadContract, useSimulateContract } from 'wagmi'
import { Address } from '@/components/Address'
import { TxStatus } from '@/components/TxStatus'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { env } from '@/config/env'
import { useLockerTerms } from '@/hooks/useLockerTerms'
import { useTransaction } from '@/hooks/useTransaction'
import { lpLockerAbi } from '@/lib/launchpad-abi'
import type { TokenDetail } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'

/**
 * Pool fees on a graduated token's locked LP position.
 *
 * Distinct from `CreatorFeesCard`, which is the creator's cut of trades against
 * the *curve*. Once a token graduates the pool it created keeps earning trading
 * fees forever, and this is where those are claimed.
 *
 * Hoodium takes a share of these fees on one condition: that it is stated
 * plainly in the UI. The contract takes its share whether or not this card is
 * rendered, so the card is the condition under which taking the share is
 * allowed at all — which is why the split is shown to **everyone**, not just to
 * the creator. Only the amounts and the button are restricted.
 *
 * The locker is found on-chain and the split is read from it, never typed here.
 * Our API contributes exactly one thing: `lpTokenId`, a pointer to which locked
 * position backs this token.
 *
 * Two ways fees leave the position. `collectFees` (creator only) pays the
 * creator their share and the vault its own. `sweepProtocolFees` (anyone) does
 * the same collection but only *pays* the protocol; the creator's share is
 * credited to `creatorOwed0/1` for them to collect later. That is what keeps a
 * creator with no call path — a contract, a lost key — from stranding the
 * protocol's share along with their own.
 */
export function PoolFeesCard({ token }: { token: TokenDetail }) {
  const { address, isConnected } = useAccount()
  const tx = useTransaction()

  const lpTokenId = token.lpTokenId

  // The same split the launch form states, read from the same place — a second
  // copy of this number would be free to disagree with the contract (WA-N6).
  const { address: locker, creatorPct: creatorSharePct, protocolPct: protocolSharePct } = useLockerTerms()

  // Only graduated tokens have a locked position, and only then is there
  // anything here to describe.
  const enabled = (token.status === 'graduated' || token.graduated) && Boolean(lpTokenId)
  const lockerReady = enabled && Boolean(locker)
  const tokenId = lpTokenId ? BigInt(lpTokenId) : 0n

  const { data: beneficiary } = useReadContract({
    address: locker,
    abi: lpLockerAbi,
    functionName: 'beneficiaryOf',
    args: [tokenId],
    query: { enabled: lockerReady },
  })

  // The creator's share already collected by a sweep and waiting to be paid.
  const { data: owed0, refetch: refetchOwed0 } = useReadContract({
    address: locker,
    abi: lpLockerAbi,
    functionName: 'creatorOwed0',
    args: [tokenId],
    query: { enabled: lockerReady, refetchInterval: 15_000 },
  })
  const { data: owed1, refetch: refetchOwed1 } = useReadContract({
    address: locker,
    abi: lpLockerAbi,
    functionName: 'creatorOwed1',
    args: [tokenId],
    query: { enabled: lockerReady, refetchInterval: 15_000 },
  })

  const isBeneficiary = Boolean(address && beneficiary && address.toLowerCase() === beneficiary.toLowerCase())

  /*
   * Claimable is simulated rather than read.
   *
   * `positions().tokensOwed0/1` only reflects fees already checkpointed into the
   * position, so it reads zero for a pool that has been trading all day. A
   * simulated `collectFees` returns what the caller would actually receive —
   * post-split, because that is what the function returns.
   */
  const { data: simulated, refetch: refetchClaimable } = useSimulateContract({
    address: locker,
    abi: lpLockerAbi,
    functionName: 'collectFees',
    args: [tokenId],
    account: address,
    query: { enabled: lockerReady && isBeneficiary, refetchInterval: 15_000 },
  })

  const refetchAll = () => {
    void refetchOwed0()
    void refetchOwed1()
    if (isBeneficiary) void refetchClaimable()
  }

  if (!enabled) return null

  /*
   * `collectFees` returns (amount0, amount1) in the pool's token order, which
   * Uniswap fixes by address. Labelling them by position rather than by name
   * would put the quote amount under the token's ticker half the time.
   */
  const tokenIsToken0 = token.address.toLowerCase() < env.quoteAddress.toLowerCase()
  const [amount0, amount1] = simulated?.result ?? [0n, 0n]
  const tokenAmount = tokenIsToken0 ? amount0 : amount1
  const quoteAmount = tokenIsToken0 ? amount1 : amount0
  const hasClaimable = tokenAmount > 0n || quoteAmount > 0n
  const owedToken = tokenIsToken0 ? (owed0 ?? 0n) : (owed1 ?? 0n)
  const owedQuote = tokenIsToken0 ? (owed1 ?? 0n) : (owed0 ?? 0n)
  const hasOwed = owedToken > 0n || owedQuote > 0n

  const claim = async () => {
    if (!locker) return
    const hash = await tx.execute({
      address: locker,
      abi: lpLockerAbi,
      functionName: 'collectFees',
      args: [tokenId],
    })
    if (hash) refetchAll()
  }

  const sweep = async () => {
    if (!locker) return
    const hash = await tx.execute({
      address: locker,
      abi: lpLockerAbi,
      functionName: 'sweepProtocolFees',
      args: [tokenId],
    })
    if (hash) refetchAll()
  }

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
          <Waves className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-card-title">Pool fees</h2>
          <p className="mt-0.5 text-label text-muted-foreground">
            The graduated pool keeps earning trading fees. They accrue without unlocking the
            liquidity, which is permanent.
          </p>
        </div>
      </div>

      {/*
        The disclosure. Shown to everyone who opens the page, whether or not they
        own the token — design.md section 3 makes stating this the condition on
        taking a share at all.
      */}
      <p className="mt-4 rounded-xl border border-border bg-muted/30 p-3 text-label">
        {creatorSharePct === null ? (
          <span className="text-muted-foreground">Reading the split from the contract…</span>
        ) : (
          <>
            <span className="font-medium">
              {creatorSharePct}% creator / {protocolSharePct}% protocol
            </span>
            <span className="text-muted-foreground">
              {' '}
              — set when the pool was created and immutable. The creator collects both shares in one
              call; anyone may sweep the protocol's share, and the creator's part of that sweep is held for
              them on the locker until they collect.
            </span>
          </>
        )}
      </p>

      {isBeneficiary ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Figure label={`Claimable · ${token.symbol}`}>
              {formatAmount(fromBaseUnits(tokenAmount, 18), { dp: 4 })}
            </Figure>
            <Figure label={`Claimable · ${env.quoteSymbol}`}>
              {formatAmount(fromBaseUnits(quoteAmount, env.quoteDecimals), { dp: 4 })}
            </Figure>
          </div>
          {/* Claimable (a simulated collect) already includes what a sweep set aside; this shows that part on its own. */}
          <p className="num mt-2 text-label text-muted-foreground">
            Held for you from sweeps: {formatAmount(fromBaseUnits(owedToken, 18), { dp: 4 })} {token.symbol} ·{' '}
            {formatAmount(fromBaseUnits(owedQuote, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
          </p>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 p-3">
            <div>
              <p className="text-label text-muted-foreground">Payout wallet</p>
              {beneficiary ? <Address value={beneficiary} link className="mt-0.5" /> : null}
            </div>
            <p className="max-w-[16rem] text-label text-muted-foreground">
              Recorded when the position was locked and never reassignable — there is no path in
              the contract to redirect it.
            </p>
          </div>

          <Button
            variant="primary"
            className="mt-4 w-full"
            disabled={!hasClaimable || tx.isBusy}
            onClick={() => void claim()}
          >
            {tx.isBusy ? 'Working…' : hasClaimable ? 'Claim pool fees' : 'No fees to claim'}
          </Button>
        </>
      ) : (
        <>
          <p className="mt-3 text-label text-muted-foreground">
            Fees accrue to the token's creator. Anyone can sweep the protocol's share to the vault; the
            creator's share of a sweep is held for them on the locker.
          </p>
          {hasOwed && (
            <p className="num mt-2 text-label text-muted-foreground">
              Held for the creator: {formatAmount(fromBaseUnits(owedToken, 18), { dp: 4 })} {token.symbol} ·{' '}
              {formatAmount(fromBaseUnits(owedQuote, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
            </p>
          )}
          {isConnected && (
            <Button variant="outline" className="mt-4 w-full" disabled={tx.isBusy || !locker} onClick={() => void sweep()}>
              {tx.isBusy ? 'Working…' : 'Sweep protocol fees'}
            </Button>
          )}
        </>
      )}

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
