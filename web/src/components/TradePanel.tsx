import { useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { env } from '@/config/env'
import { useTransaction } from '@/hooks/useTransaction'
import { tradeDeadline } from '@/lib/deadline'
import { defaultMaxFix, shouldOfferPoolFix } from '@/lib/graduation-fix'
import { curveAbi, erc20Abi, graduationHelperAbi } from '@/lib/launchpad-abi'
import type { TokenDetail } from '@/lib/launchpad-api'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { cn, sanitizeText } from '@/lib/utils'
import { useUiStore } from '@/store/ui'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { ConnectButton } from './ConnectButton'
import { RiskDisclosure } from './RiskDisclosure'
import { SegmentedControl } from './SegmentedControl'
import { TxStatus } from './TxStatus'

/**
 * Buy/sell against the curve, with a slippage control and an explicit
 * minimum-output preview.
 *
 * The minimum is not decoration: it is the `minTokensOut`/`minUsdgOut`
 * argument the contract enforces. What the user reads is exactly what is sent.
 *
 * Quotes come from the curve itself via `quoteBuy`/`quoteSell` rather than
 * being recomputed here — one implementation, one answer. Balances are read
 * from the chain rather than from the holder index, which is blind to plain
 * transfers.
 *
 * Every trade carries a deadline (`@/lib/deadline`) so a signed transaction
 * that sits in a mempool cannot execute at a price the user never saw. The buy
 * that reaches the target graduates the curve in the same transaction — it
 * creates and seeds the Uniswap pool, so it costs more gas and can be blocked
 * by a hostilely primed pool; the panel says so before the signature. When
 * that simulation does revert on the pool's price and a `GraduationHelper` is
 * configured, the panel offers to fix the pool and buy in one transaction
 * through it (`@/lib/graduation-fix` decides when). Once the curve is complete
 * `sell` reverts, so the Sell side is withdrawn.
 *
 * Gas is never set here: the completing buy costs several times a normal one
 * (it creates and seeds the pool) and the wallet's estimate is the only number
 * that is right for it.
 */
const SIDES = [
  { value: 'buy' as const, label: 'Buy' },
  { value: 'sell' as const, label: 'Sell' },
]

const SLIPPAGE_PRESETS = [50, 100, 300, 1000]
const PERCENTAGES = [25, 50, 75, 100]
const ZERO = '0x0000000000000000000000000000000000000000' as const

export function TradePanel({ token }: { token: TokenDetail }) {
  const { address, isConnected } = useAccount()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmountRaw] = useState('')
  // A blocked completing buy, when the helper can unblock it. `maxFixInput` is
  // the user's ceiling for the fix, in whole USDG.
  const [fixOffered, setFixOffered] = useState(false)
  const [maxFixInput, setMaxFixInput] = useState('')
  const tx = useTransaction()

  // The offer belongs to the amount it was simulated for.
  const setAmount = (next: string) => {
    setAmountRaw(next)
    setFixOffered(false)
  }

  const riskAcknowledged = useUiStore((s) => s.riskAcknowledged)
  const slippageBps = useUiStore((s) => s.slippageBps)
  const setSlippageBps = useUiStore((s) => s.setSlippageBps)

  const curve = token.curve as `0x${string}`
  const graduated = token.status === 'graduated' || token.graduated
  // Complete but not yet graduated is the dev-buy edge case: the target was
  // reached inside the launch, and `graduate()` is waiting for anyone to call.
  const complete = graduated || token.curveState.complete || token.curveState.progressBps >= 10_000
  const remainingToTarget = BigInt(token.curveState.remaining || '0')
  const symbol = sanitizeText(token.symbol, 12) || '???'
  const name = sanitizeText(token.name, 24) || symbol

  const decimals = side === 'buy' ? env.quoteDecimals : 18
  const parsedAmount = useMemo(() => {
    if (!amount || !/^\d*\.?\d*$/.test(amount)) return 0n
    try {
      return parseUnits(amount, decimals)
    } catch {
      return 0n
    }
  }, [amount, decimals])

  const { data: buyQuote } = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: 'quoteBuy',
    args: [parsedAmount],
    query: { enabled: side === 'buy' && parsedAmount > 0n && !complete },
  })

  const { data: sellQuote } = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: 'quoteSell',
    args: [parsedAmount],
    query: { enabled: side === 'sell' && parsedAmount > 0n && !complete },
  })

  const { data: allowance } = useReadContract({
    address: (env.quoteAddress || '0x') as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address ?? ZERO, curve],
    query: { enabled: side === 'buy' && Boolean(address) && Boolean(env.quoteAddress) },
  })

  const helper = (env.graduationHelper || '0x') as `0x${string}`
  const { data: helperAllowance, refetch: refetchHelperAllowance } = useReadContract({
    address: (env.quoteAddress || '0x') as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address ?? ZERO, helper],
    query: { enabled: fixOffered && Boolean(address) && Boolean(env.quoteAddress) && Boolean(env.graduationHelper) },
  })

  const { data: quoteBalance } = useReadContract({
    address: (env.quoteAddress || '0x') as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address ?? ZERO],
    query: { enabled: Boolean(address && env.quoteAddress), refetchInterval: 15_000 },
  })

  const { data: tokenBalance } = useReadContract({
    address: token.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address ?? ZERO],
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  })

  const balance = (side === 'buy' ? quoteBalance : tokenBalance) ?? 0n
  const balanceSymbol = side === 'buy' ? env.quoteSymbol : symbol

  const expectedOut = side === 'buy' ? (buyQuote?.[0] ?? 0n) : (sellQuote?.[0] ?? 0n)
  const fee = side === 'buy' ? (buyQuote?.[1] ?? 0n) : (sellQuote?.[1] ?? 0n)
  const refund = side === 'buy' ? (buyQuote?.[2] ?? 0n) : 0n
  const netIn = side === 'buy' ? (buyQuote?.[3] ?? 0n) : 0n
  // This buy would bring the reserve to the target: the curve graduates inside it.
  const completesCurve = side === 'buy' && netIn > 0n && remainingToTarget > 0n && netIn >= remainingToTarget

  // What actually goes on-chain as the floor.
  const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n
  const outDecimals = side === 'buy' ? 18 : env.quoteDecimals
  const outSymbol = side === 'buy' ? symbol : env.quoteSymbol

  const needsApproval = side === 'buy' && (allowance ?? 0n) < parsedAmount

  const parsedMaxFix = useMemo(() => {
    if (!maxFixInput || !/^\d*\.?\d*$/.test(maxFixInput)) return 0n
    try {
      return parseUnits(maxFixInput, env.quoteDecimals)
    } catch {
      return 0n
    }
  }, [maxFixInput])
  const fixTotal = parsedAmount + parsedMaxFix
  const helperNeedsApproval = (helperAllowance ?? 0n) < fixTotal
  // eslint-disable-next-line money/no-number-on-money -- both sides are bigint base units
  const fixOverBalance = fixTotal > balance

  // The plain buy's simulation reverted on the pool's price: route to the helper.
  useEffect(() => {
    if (tx.state !== 'failed') return
    if (!shouldOfferPoolFix({ side, error: tx.error, helperAddress: env.graduationHelper })) return
    setFixOffered(true)
    setMaxFixInput(formatUnits(defaultMaxFix(parsedAmount), env.quoteDecimals))
  }, [tx.state, tx.error, side, parsedAmount])
  // eslint-disable-next-line money/no-number-on-money -- both sides are bigint base units
  const overBalance = parsedAmount > balance

  const setPercentage = (percent: number) => {
    // Integer arithmetic on base units — a float would round a "100%" sell to
    // slightly more than the wallet holds, and the transfer would revert.
    const part = (balance * BigInt(percent)) / 100n
    setAmount(formatUnits(part, decimals))
  }

  const switchSide = (next: 'buy' | 'sell') => {
    setSide(next)
    // The number means a different unit on the other side.
    setAmount('')
  }

  const submit = async () => {
    if (needsApproval) {
      await tx.execute({
        address: env.quoteAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [curve, parsedAmount],
      })
      return
    }

    await tx.execute({
      address: curve,
      abi: curveAbi,
      functionName: side === 'buy' ? 'buy' : 'sell',
      args: [parsedAmount, minOut, tradeDeadline()],
    })
  }

  const fixAndBuy = async () => {
    if (helperNeedsApproval) {
      const hash = await tx.execute({
        address: env.quoteAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [helper, fixTotal],
      })
      if (hash) await refetchHelperAllowance()
      return
    }
    await tx.execute({
      address: helper,
      abi: graduationHelperAbi,
      functionName: 'fixAndBuy',
      args: [curve, parsedAmount, minOut, tradeDeadline(), parsedMaxFix],
    })
  }

  const graduate = async () => {
    await tx.execute({ address: curve, abi: curveAbi, functionName: 'graduate', args: [] })
  }

  // The disclosure gates the first purchase; it does not merely precede it.
  if (!riskAcknowledged) return <RiskDisclosure />

  if (graduated) {
    return (
      <Card className="p-5 text-center">
        <p className="text-card-title">This token has graduated</p>
        <p className="mt-2 text-sm text-muted-foreground">
          The curve is permanently closed. Trading now happens in the Uniswap v3 pool, whose liquidity is
          locked and cannot be withdrawn.
        </p>
        {token.pool && env.explorerUrl && (
          <a
            href={`${env.explorerUrl}/address/${token.pool}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-sm text-primary hover:underline"
          >
            View the pool
          </a>
        )}
      </Card>
    )
  }

  if (complete) {
    return (
      <Card className="p-5 text-center">
        <p className="text-card-title">Curve complete — trading moved to the pool</p>
        <p className="mt-2 text-sm text-muted-foreground">
          The curve reached its target and no longer accepts buys or sells. The pool opens at the curve's
          closing price; anyone can trigger the opening, and the transaction creates and seeds it, so it
          costs more gas than a trade.
        </p>
        {isConnected ? (
          <Button variant="primary" className="mt-4 w-full" disabled={tx.isBusy} onClick={() => void graduate()}>
            {tx.isBusy ? 'Working…' : 'Open the pool'}
          </Button>
        ) : (
          <ConnectButton variant="primary" size="lg" className="mt-4 w-full" label="Connect wallet to open the pool" />
        )}
        <TxStatus tx={tx} className="mt-3" />
      </Card>
    )
  }

  return (
    <Card className="p-5">
      <SegmentedControl segments={SIDES} value={side} onChange={switchSide} label="Trade side" className="w-full [&>button]:flex-1" />

      <label className="mt-4 block">
        <span className="text-label text-muted-foreground">
          {side === 'buy' ? `Spend (${env.quoteSymbol})` : `Sell (${symbol})`}
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0.00"
          className={cn(
            'num mt-1 w-full rounded-xl border bg-background px-3 py-2.5 text-lg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            overBalance ? 'border-warning' : 'border-border',
          )}
        />
      </label>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="num text-label text-muted-foreground">
          {isConnected
            ? `${formatAmount(fromBaseUnits(balance, decimals), { compact: true })} ${balanceSymbol} available`
            : 'Connect to see your balance'}
        </span>
        <div className="flex gap-1">
          {PERCENTAGES.map((percent) => (
            <button
              key={percent}
              type="button"
              disabled={balance === 0n}
              onClick={() => setPercentage(percent)}
              className={cn(
                'num rounded-lg border border-border px-2 py-0.5 text-xs text-muted-foreground',
                'transition-colors duration-[120ms] hover:text-foreground disabled:opacity-40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              {percent === 100 ? 'Max' : `${percent}%`}
            </button>
          ))}
        </div>
      </div>

      {overBalance && (
        <p className="mt-1 text-xs text-warning">More than this wallet holds. The transaction would revert.</p>
      )}

      <div className="mt-3">
        <span className="text-label text-muted-foreground">Max slippage</span>
        <div className="mt-1 flex gap-1.5">
          {SLIPPAGE_PRESETS.map((bps) => (
            <button
              key={bps}
              type="button"
              aria-pressed={slippageBps === bps}
              onClick={() => setSlippageBps(bps)}
              className={cn(
                'num rounded-lg border px-2.5 py-1 text-xs transition-colors duration-[120ms]',
                slippageBps === bps
                  ? 'border-border bg-muted text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {parsedAmount > 0n && (
        <dl className="mt-4 space-y-1.5 rounded-xl border border-border bg-muted/30 p-3 text-xs">
          <Row label="Expected">
            <span className="num">
              {formatAmount(fromBaseUnits(expectedOut, outDecimals), { compact: true })} {outSymbol}
            </span>
          </Row>
          {/* This exact value is the contract argument — the display cannot drift from what is sent. */}
          <Row label="Minimum received">
            <span className="num font-medium text-foreground">
              {formatAmount(fromBaseUnits(minOut, outDecimals), { compact: true })} {outSymbol}
            </span>
          </Row>
          <Row label="Fee">
            <span className="num">
              {formatAmount(fromBaseUnits(fee, env.quoteDecimals), { dp: 4 })} {env.quoteSymbol}
            </span>
          </Row>
          {refund > 0n && (
            <Row label="Returned (curve full)">
              <span className="num text-warning">
                {formatAmount(fromBaseUnits(refund, env.quoteDecimals), { dp: 2 })} {env.quoteSymbol}
              </span>
            </Row>
          )}
        </dl>
      )}

      {completesCurve && (
        <p className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
          <span className="font-medium">This buy completes the curve.</span> It also creates and seeds the
          Uniswap pool in the same transaction, so it costs more gas than a normal buy. If someone has primed
          the pool with liquidity at a hostile price, it will not go through until the pool price is arbitraged
          back — nothing is spent if it fails.
        </p>
      )}

      {isConnected ? (
        <Button
          variant="primary"
          size="lg"
          className="mt-4 w-full"
          disabled={parsedAmount === 0n || overBalance || tx.isBusy}
          onClick={() => void submit()}
        >
          {tx.isBusy
            ? 'Working…'
            : parsedAmount === 0n
              ? 'Enter amount'
              : needsApproval
                ? `Approve ${env.quoteSymbol}`
                : side === 'buy'
                  ? `Buy ${name}`
                  : `Sell ${name}`}
        </Button>
      ) : (
        <ConnectButton variant="primary" size="lg" className="mt-4 w-full" label="Connect wallet to trade" />
      )}

      <TxStatus tx={tx} className="mt-3" />

      {fixOffered && side === 'buy' && tx.state !== 'confirmed' && (
        <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3 text-xs">
          <p className="font-medium text-foreground">Fix the pool and buy</p>
          <p className="mt-1 text-muted-foreground">
            One transaction moves the pool price back through the liquidity that is blocking it and then
            completes the curve; any tokens or {env.quoteSymbol} the re-pricing yields come back to your wallet,
            and whatever of the budget below is not needed is returned.
          </p>
          <label className="mt-2 block">
            <span className="text-label text-muted-foreground">Max spent on the fix ({env.quoteSymbol})</span>
            <input
              type="text"
              inputMode="decimal"
              value={maxFixInput}
              onChange={(e) => setMaxFixInput(e.target.value.replace(/[^\d.]/g, ''))}
              className={cn(
                'num mt-1 w-full rounded-xl border bg-background px-3 py-2 text-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                fixOverBalance ? 'border-warning' : 'border-border',
              )}
            />
          </label>
          {fixOverBalance && (
            <p className="mt-1 text-warning">Amount plus budget is more than this wallet holds.</p>
          )}
          <Button
            variant="primary"
            size="lg"
            className="mt-3 w-full"
            disabled={parsedAmount === 0n || fixOverBalance || tx.isBusy}
            onClick={() => void fixAndBuy()}
          >
            {tx.isBusy
              ? 'Working…'
              : helperNeedsApproval
                ? `Approve ${env.quoteSymbol} for the fix`
                : 'Fix the pool and buy'}
          </Button>
        </div>
      )}
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
