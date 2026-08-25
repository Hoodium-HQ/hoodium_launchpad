import { useMemo, useState } from 'react'
import { formatUnits, parseUnits } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { env } from '@/config/env'
import { useTransaction } from '@/hooks/useTransaction'
import { curveAbi, erc20Abi } from '@/lib/launchpad-abi'
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
  const [amount, setAmount] = useState('')
  const tx = useTransaction()

  const riskAcknowledged = useUiStore((s) => s.riskAcknowledged)
  const slippageBps = useUiStore((s) => s.slippageBps)
  const setSlippageBps = useUiStore((s) => s.setSlippageBps)

  const curve = token.curve as `0x${string}`
  const graduated = token.status === 'graduated' || token.graduated
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
    query: { enabled: side === 'buy' && parsedAmount > 0n && !graduated },
  })

  const { data: sellQuote } = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: 'quoteSell',
    args: [parsedAmount],
    query: { enabled: side === 'sell' && parsedAmount > 0n && !graduated },
  })

  const { data: allowance } = useReadContract({
    address: (env.quoteAddress || '0x') as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address ?? ZERO, curve],
    query: { enabled: side === 'buy' && Boolean(address) && Boolean(env.quoteAddress) },
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

  // What actually goes on-chain as the floor.
  const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n
  const outDecimals = side === 'buy' ? 18 : env.quoteDecimals
  const outSymbol = side === 'buy' ? symbol : env.quoteSymbol

  const needsApproval = side === 'buy' && (allowance ?? 0n) < parsedAmount
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
      args: [parsedAmount, minOut],
    })
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
