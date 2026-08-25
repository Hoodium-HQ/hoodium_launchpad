import { ArrowRight, ExternalLink, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Clipart } from '@/components/Clipart'
import { buttonVariants } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { env } from '@/config/env'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
import { useLaunchpadConfig } from '@/hooks/useLaunchpad'
import type { LaunchTerms } from '@/lib/api-types'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { cn } from '@/lib/utils'

/**
 * Learn — how the launchpad works, in one static page.
 *
 * Nothing here needs the API: every figure has a default from
 * `../contracts/script/Deploy.s.sol`, and the page reads the same with the
 * backend down as with it up. When `GET /api/config` answers with the live
 * terms they replace the defaults, so the numbers on this page are the numbers
 * the factory enforces; until the contracts deploy, a one-line note says the
 * figures are defaults.
 *
 * The shape is hoodium.app's: a one-line heading with a sticker beside it,
 * tracked uppercase labels over each section, cards for the surfaces, mono
 * for every figure. Written to be scanned on a phone — short sentences, one
 * idea per card, and a glossary rather than a wall of prose.
 */
const CONTRACTS_REPO = 'https://github.com/Hoodium-HQ/hoodium_launchpad'

/**
 * The deploy defaults, in base units as the API would serve them. The figures
 * the page prints are derived from these so the default and live paths share
 * one formatting step and cannot disagree in style.
 */
const TOKEN_DECIMALS = 18
const TOKEN_UNIT = 10n ** BigInt(TOKEN_DECIMALS)
const QUOTE_UNIT = 10n ** BigInt(env.quoteDecimals)

const DEFAULT_TOTAL_SUPPLY = 1_000_000_000n * TOKEN_UNIT
const DEFAULT_CURVE_ALLOCATION = 800_000_000n * TOKEN_UNIT
const DEFAULT_VIRTUAL_USDG = 12_000n * QUOTE_UNIT
const DEFAULT_GRADUATION_TARGET = 69_000n * QUOTE_UNIT
const DEFAULT_LP_PROTOCOL_SHARE_BPS = 3_000

/**
 * `LaunchTerms` minus the addresses, which is the part of the API's shape this
 * page has a default for. The live object is a superset, so it slots in as is.
 */
type Terms = Pick<
  LaunchTerms,
  | 'totalSupply'
  | 'curveAllocation'
  | 'lpAllocation'
  | 'virtualUsdg'
  | 'virtualTokens'
  | 'creationFee'
  | 'graduationTarget'
  | 'graduationFee'
  | 'devBuyMaxBps'
  | 'tradeFeeBps'
  | 'creatorFeeShareBps'
  | 'protocolFeeShareBps'
  | 'snipeBlocks'
  | 'snipeMaxBps'
>

export const DEFAULT_TERMS: Terms = {
  totalSupply: DEFAULT_TOTAL_SUPPLY.toString(),
  curveAllocation: DEFAULT_CURVE_ALLOCATION.toString(),
  lpAllocation: (DEFAULT_TOTAL_SUPPLY - DEFAULT_CURVE_ALLOCATION).toString(),
  virtualUsdg: DEFAULT_VIRTUAL_USDG.toString(),
  // The factory derives this: curveAllocation × virtualUsdg ÷ graduationTarget.
  virtualTokens: ((DEFAULT_CURVE_ALLOCATION * DEFAULT_VIRTUAL_USDG) / DEFAULT_GRADUATION_TARGET).toString(),
  creationFee: (1n * QUOTE_UNIT).toString(),
  graduationTarget: DEFAULT_GRADUATION_TARGET.toString(),
  graduationFee: '0',
  devBuyMaxBps: 500,
  tradeFeeBps: 100,
  creatorFeeShareBps: 7_000,
  protocolFeeShareBps: DEFAULT_LP_PROTOCOL_SHARE_BPS,
  snipeBlocks: 3,
  snipeMaxBps: 100,
}

/** `7000` → `70`, `100` → `1`, `250` → `2.5`. */
function pct(bps: number): string {
  const value = bps / 100
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '')
}

function tokens(raw: string, compact = false): string {
  return formatAmount(fromBaseUnits(raw, TOKEN_DECIMALS), { dp: 0, compact })
}

function usdg(raw: string): string {
  return `${formatAmount(fromBaseUnits(raw, env.quoteDecimals), { dp: 0 })} ${env.quoteSymbol}`
}

/** Share of the total supply, as a whole percentage — "80%". */
function shareOfSupply(part: string, total: string): string {
  const t = BigInt(total)
  if (t === 0n) return '—'
  return `${(BigInt(part) * 100n) / t}%`
}

export function Learn() {
  useDocumentMeta({
    title: 'How it works',
    description:
      `How Hoodium Launchpad works: fixed-supply tokens priced in ${env.quoteSymbol} on a bonding curve, ` +
      'graduating into a Uniswap v3 pool whose liquidity is locked forever. Fees, tokenomics, protections and risks.',
    canonicalPath: '/learn',
  })

  const config = useLaunchpadConfig()
  const live = config.data?.terms ?? null
  const t: Terms = live ?? DEFAULT_TERMS

  const creatorShare = pct(t.creatorFeeShareBps)
  const hoodiumShare = pct(10_000 - t.creatorFeeShareBps)
  // The locker's cut is reported by the API; null means the locker could not
  // be read, and the deploy default is the honest fallback.
  const lpProtocolBps = t.protocolFeeShareBps ?? DEFAULT_LP_PROTOCOL_SHARE_BPS
  const lpProtocolShare = pct(lpProtocolBps)
  const lpCreatorShare = pct(10_000 - lpProtocolBps)
  const tradeFee = pct(t.tradeFeeBps)
  const devBuyMax = pct(t.devBuyMaxBps)
  const snipeMax = pct(t.snipeMaxBps)
  const creationFee = usdg(t.creationFee)
  const graduationFee = usdg(t.graduationFee)
  const target = usdg(t.graduationTarget)
  const virtualUsdg = usdg(t.virtualUsdg)
  const lpAllocationCompact = tokens(t.lpAllocation, true)

  return (
    <div className="space-y-10">
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="max-w-2xl">
          <h1 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
            How Hoodium Launchpad works
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Anyone can launch a fixed-supply token here. It is priced in {env.quoteSymbol} on a bonding
            curve. When the curve raises its target, trading moves to a Uniswap v3 pool whose liquidity is
            locked forever. There are no admin keys and no custody: your wallet signs every transaction,
            and Hoodium never holds your assets.
          </p>
          {live === null && (
            <p className="mt-2 text-xs text-muted-foreground">
              Defaults shown — contracts not deployed yet. Once the factory is live, every figure on this
              page is read from it.
            </p>
          )}
        </div>
        <Clipart name="compass" float className="hidden size-16 sm:block" />
      </header>

      {/* ── Lifecycle ──────────────────────────────────────────────────── */}
      <Section label="The lifecycle" blurb="Four stages. A token is always in exactly one of them.">
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Step n={1} title="Launch">
            Pick a name, a symbol and an image; the image is pinned to IPFS. The creation fee is{' '}
            <Num>{creationFee}</Num>. The creator may buy in the same transaction, capped at{' '}
            <Num>{devBuyMax}%</Num> of supply.
          </Step>
          <Step n={2} title="Curve">
            Buy and sell against the curve. The price rises with every buy and falls with every sell. Each
            trade pays a <Num>{tradeFee}%</Num> fee, split <Num>{creatorShare}%</Num> to the creator and{' '}
            <Num>{hoodiumShare}%</Num> to Hoodium.
          </Step>
          <Step n={3} title="Graduation">
            At <Num>{target}</Num> raised, the curve closes in one atomic transaction. The remaining{' '}
            {env.quoteSymbol} and the <Num>{lpAllocationCompact}</Num> pool allocation seed a full-range
            Uniswap v3 pool on the 1% fee tier.
          </Step>
          <Step n={4} title="Locked pool">
            The LP NFT sits in a locker with no withdrawal function. Only accrued swap fees can be
            collected, split <Num>{lpCreatorShare}%</Num> to the creator and <Num>{lpProtocolShare}%</Num>{' '}
            to the protocol.
          </Step>
        </ol>
      </Section>

      {/* ── Tokenomics ─────────────────────────────────────────────────── */}
      <Section label="Tokenomics" blurb="Every token launched from this factory has the same terms.">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Figure label="Total supply" value={tokens(t.totalSupply)} note="Fixed at launch. No mint, no burn." />
          <Figure
            label="Sold on the curve"
            value={tokens(t.curveAllocation)}
            note={`${shareOfSupply(t.curveAllocation, t.totalSupply)} of supply, sold to buyers before graduation.`}
          />
          <Figure
            label="Reserved for the pool"
            value={tokens(t.lpAllocation)}
            note={`${shareOfSupply(t.lpAllocation, t.totalSupply)} of supply, paired with the raised ${env.quoteSymbol} at graduation.`}
          />
          <Figure label="Graduation target" value={target} note="Raised on the curve, net of fees, to close it." />
          <Figure
            label="Virtual reserves"
            value={virtualUsdg}
            note={`The curve starts as if ${virtualUsdg} were already in it, so the first buyer pays a real price without anyone seeding capital.`}
          />
          <Figure label="Trade fee" value={`${tradeFee}%`} note="On every curve buy and sell." />
          <Figure label="Creation fee" value={creationFee} note="Paid once, when the token launches." />
          <Figure label="Graduation fee" value={graduationFee} note="Taken from the raise when the curve closes." />
        </div>
      </Section>

      {/* ── Formula ────────────────────────────────────────────────────── */}
      <Section label="The curve, in one formula" blurb="A constant product over virtual reserves.">
        <Card className="p-5">
          <pre className="num overflow-x-auto whitespace-pre text-sm leading-relaxed text-foreground">
            {'(virtualUSDG + raised) × (virtualTokens + tokensRemaining) = k'}
          </pre>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            A buy adds {env.quoteSymbol} to the left factor and removes tokens from the right one; a sell is
            the reverse. <span className="text-foreground">k</span> never changes, so the more that has been
            raised, the fewer tokens each {env.quoteSymbol} buys.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Rounding always favours the curve: you receive slightly less, never more. That is what keeps the
            reserves from being drained by dust trades.
          </p>
        </Card>
      </Section>

      {/* ── Fees ───────────────────────────────────────────────────────── */}
      <Section label="Fees, and who gets them" blurb="Three fees. Holders are not paid from any of them.">
        <Card>
          <div className="divide-y divide-border">
            <div className="hidden grid-cols-[11rem_13rem_1fr] gap-4 px-4 py-3 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground sm:grid">
              <span>Fee</span>
              <span>Rate</span>
              <span>Goes to</span>
            </div>
            <FeeRow
              fee="Curve trades"
              rate={`${tradeFee}% per trade`}
              goesTo={
                <>
                  Creator <Num>{creatorShare}%</Num> · Hoodium <Num>{hoodiumShare}%</Num>. The creator claims
                  from the token page; Hoodium's share goes to a multisig FeeVault.
                </>
              }
            />
            <FeeRow
              fee="Locked-pool swap fees"
              rate="1% tier, as Uniswap charges it"
              goesTo={
                <>
                  Creator <Num>{lpCreatorShare}%</Num> · protocol <Num>{lpProtocolShare}%</Num>. Collected by
                  the creator; the principal never moves.
                </>
              }
            />
            <FeeRow fee="Creation" rate={creationFee} goesTo={<>FeeVault.</>} />
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Holders earn nothing from fees — the token has no tax and no rebase.
            </p>
          </div>
        </Card>
      </Section>

      {/* ── Protections ────────────────────────────────────────────────── */}
      <Section label="Protections" blurb="What the contracts enforce, not what a policy promises.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Point title="Anti-snipe">
            For the first <Num>{t.snipeBlocks}</Num> blocks a single buy is capped at <Num>{snipeMax}%</Num>{' '}
            of supply. The dev buy is exempt because it executes inside the launch transaction.
          </Point>
          <Point title="Atomic graduation">
            Either everything happens — the curve closes, the pool is created, the LP NFT is locked — or
            nothing does. If graduation fails, the curve stays tradeable.
          </Point>
          <Point title="No admin">
            The factory, every curve, the graduation manager and the locker are immutable and unowned.
            Nobody can pause, upgrade, or change a term after deployment.
          </Point>
          <Point title="Principal cannot leave">
            The locker has no transfer, no decreaseLiquidity and no burn. The only function that moves
            value is fee collection.
          </Point>
        </div>
      </Section>

      {/* ── Risks ──────────────────────────────────────────────────────── */}
      <Section label="Risks — read this" blurb="The same words you will be asked to acknowledge before your first trade.">
        <Card className="p-5">
          <ul className="space-y-2.5 text-sm leading-relaxed text-muted-foreground">
            <li>
              <span className="text-foreground">Anyone can launch a token here.</span> Hoodium does not review,
              endorse, or vet them. A name and symbol can be chosen to imitate something else.
            </li>
            <li>
              <span className="text-foreground">Most tokens never graduate.</span> Across comparable launchpads,
              roughly 1 in 100 reaches its target. Assume yours will not.
            </li>
            <li>
              <span className="text-foreground">The creator can sell whatever they hold, at any time,</span>{' '}
              including immediately after you buy.
            </li>
            <li>
              <span className="text-foreground">You can lose everything you put in.</span> There is no refund, no
              recovery, and no support that can reverse a trade.
            </li>
            <li>
              Hoodium charges a fee on every buy and sell, and a share of locked-pool fees. Those are how it
              makes money — <span className="text-foreground">whether or not your token succeeds.</span>
            </li>
            <li>
              <span className="text-foreground">The contracts are not externally audited.</span> They are small
              and public, and that is not the same thing.
            </li>
            <li>
              <span className="text-foreground">{env.quoteSymbol} is a regulated stablecoin.</span> Its issuer
              can blocklist addresses. A blocklisted curve could have its reserves frozen, and nobody — not
              Hoodium, not the creator — could unfreeze them.
            </li>
          </ul>
        </Card>
      </Section>

      {/* ── Glossary ───────────────────────────────────────────────────── */}
      <Section label="Glossary" blurb="The words this site uses, one line each.">
        <Card className="p-5">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Def term="MC">
              Market cap: the curve's spot price times the fixed supply, in {env.quoteSymbol} at $1.
            </Def>
            <Def term="FDV">
              Fully diluted value: the same figure, read from the pool once a token has graduated.
            </Def>
            <Def term="Bonding curve">
              A contract that sets the price from how much it holds. Buys push it up; sells push it down.
            </Def>
            <Def term="Graduation">The moment the curve hits its target and hands trading to a locked pool.</Def>
            <Def term="Virtual reserves">
              Starting balances the curve prices against as if they were real, so the first trade has a price.
            </Def>
            <Def term="Full-range">
              Liquidity spread across every possible price, so the pool can never run out of one side.
            </Def>
            <Def term="Locker">
              The contract that holds the pool's LP NFT. It can collect fees and nothing else.
            </Def>
            <Def term="FeeVault">A multisig that receives Hoodium's share of fees. It has no power over any token.</Def>
          </dl>
        </Card>
      </Section>

      {/* ── Closing ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <Link to="/" className={cn(buttonVariants({ variant: 'primary' }), 'gap-2')}>
          Explore tokens
          <ArrowRight className="size-4" aria-hidden />
        </Link>
        <Link to="/create" className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}>
          <Plus className="size-4" aria-hidden />
          Create a token
        </Link>
        <a
          href={CONTRACTS_REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Read the contracts
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </div>
    </div>
  )
}

/** A tracked label over a block, as hoodium.app heads a board. */
function Section({ label, blurb, children }: { label: string; blurb: string; children: ReactNode }) {
  return (
    <section className="scroll-mt-20">
      <h2 className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** A figure inside running text, in the mono every number on the site wears. */
function Num({ children }: { children: ReactNode }) {
  return <span className="num text-foreground">{children}</span>
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex h-full flex-col">
      <Card className="flex h-full flex-col p-4">
        <div className="flex items-center gap-2.5">
          <span className="num grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-xs font-medium text-primary-foreground">
            {n}
          </span>
          <h3 className="text-card-title">{title}</h3>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{children}</p>
      </Card>
    </li>
  )
}

/**
 * A StatTile for a figure that is not money in the tile's sense — a supply, a
 * percentage, a fee stated with its unit. Same label, same mono, same note.
 */
function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="flex h-full min-w-0 flex-col p-4">
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="num mt-1 break-words text-[1.0625rem] font-medium sm:text-xl">{value}</p>
      <p className="mt-auto pt-2 text-[11px] leading-snug text-muted-foreground">{note}</p>
    </Card>
  )
}

/**
 * One fee. A three-column row above `sm`; below it the three cells stack, with
 * the rate read directly under the name, so nothing scrolls sideways on a phone.
 */
function FeeRow({ fee, rate, goesTo }: { fee: string; rate: string; goesTo: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[11rem_13rem_1fr] sm:items-start">
      <p className="font-medium text-foreground">{fee}</p>
      <p className="num">{rate}</p>
      <p className="mt-1 text-muted-foreground sm:mt-0">{goesTo}</p>
    </div>
  )
}

function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4">
      <h3 className="text-card-title">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</p>
    </Card>
  )
}

function Def({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-foreground">{term}</dt>
      <dd className="mt-0.5 text-muted-foreground">{children}</dd>
    </div>
  )
}
