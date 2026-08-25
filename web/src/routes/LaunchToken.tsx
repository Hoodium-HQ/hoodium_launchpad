import { ArrowLeft, ChevronDown, ImageIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { formatUnits, parseUnits } from 'viem'
import { useAccount, useReadContract } from 'wagmi'
import { ConnectButton } from '@/components/ConnectButton'
import { WrongChainBanner } from '@/components/Banners'
import { Clipart } from '@/components/Clipart'
import { LaunchConfirmDialog } from '@/components/LaunchConfirmDialog'
import { LaunchPreview } from '@/components/LaunchPreview'
import { TxStatus } from '@/components/TxStatus'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { env } from '@/config/env'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
import { useLaunchpadConfig, usePinMetadata } from '@/hooks/useLaunchpad'
import { useLockerTerms } from '@/hooks/useLockerTerms'
import { useTransaction } from '@/hooks/useTransaction'
import { erc20Abi, factoryAbi } from '@/lib/launchpad-abi'
import {
  DESCRIPTION_MAX,
  ImageRejected,
  NAME_MAX,
  SYMBOL_MAX,
  hasLink,
  isValidName,
  isValidSymbol,
  maxDevBuyQuote,
  previewDevBuy,
  readImageFile,
  type PickedImage,
} from '@/lib/launch-form'
import { formatAmount, fromBaseUnits } from '@/lib/money'
import { cn, hasConfusableCharacters } from '@/lib/utils'

/**
 * Launch form.
 *
 * "A launch form — name, symbol, image, optional dev buy — submitting in **one
 *  transaction**."
 *
 * ── The order of operations ──────────────────────────────────────────────────
 * Pinning happens *before* the confirmation dialog opens, and outside the
 * transaction. Metadata lives at somebody else's service and the upload can fail;
 * a launch that half-succeeded would leave a permanent, ownerless token pointing
 * at nothing. So the creator watches the upload finish, then reads exactly what
 * they are about to sign, then signs once (LP-1.1).
 *
 * ── What the form is not allowed to invent ───────────────────────────────────
 * Every number on the right — the launch fee, the fee split, the graduation
 * target, the dev-buy cap — is read from the factory, which is immutable
 * (LP-N1). When that read fails the form says so and refuses to submit. Filling
 * in plausible defaults would have a creator agreeing to terms nobody verified,
 * and the disagreement would surface as a reverted transaction at best.
 */
export function LaunchToken() {
  useDocumentMeta({
    title: 'Create a token',
    description: `Deploy a fixed-supply token on ${env.chainName} in one transaction. It trades on a bonding curve priced in ${env.quoteSymbol} and graduates into locked Uniswap v3 liquidity.`,
    canonicalPath: '/create',
  })

  const { address, isConnected } = useAccount()
  const navigate = useNavigate()
  const tx = useTransaction()
  const config = useLaunchpadConfig()
  const pin = usePinMetadata()

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [xHandle, setXHandle] = useState('')
  const [telegram, setTelegram] = useState('')
  const [devBuy, setDevBuy] = useState('')
  const [manualUri, setManualUri] = useState('')
  const [consent, setConsent] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [image, setImage] = useState<PickedImage | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /** Set once the metadata URI exists; the confirmation dialog opens on it. */
  const [pendingUri, setPendingUri] = useState<string | null>(null)

  const terms = config.data?.terms ?? null
  /** T0.4 — the post-graduation split, read from the locker, stated before signing. */
  const lockerTerms = useLockerTerms()
  const pinningEnabled = config.data?.pinningEnabled ?? false
  const factoryAddress = (config.data?.factoryAddress ?? env.launchpadFactory) as `0x${string}` | ''

  // Object URLs leak if the picker is used more than once.
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.previewUrl)
    },
    [image],
  )

  const devBuyAmount = useMemo(() => {
    if (!devBuy || Number(devBuy) <= 0) return 0n
    try {
      return parseUnits(devBuy, env.quoteDecimals)
    } catch {
      return 0n
    }
  }, [devBuy])

  const maxDevBuy = useMemo(() => (terms ? maxDevBuyQuote(terms) : 0n), [terms])
  const devBuyPreview = useMemo(
    () => (terms && devBuyAmount > 0n ? previewDevBuy(terms, devBuyAmount) : null),
    [terms, devBuyAmount],
  )

  const creationFee = terms ? BigInt(terms.creationFee) : 0n
  const totalDue = creationFee + devBuyAmount

  /**
   * Both the creation fee and the dev buy are pulled by the factory with
   * `transferFrom`, so a launch with either reverts without an allowance. The
   * form had no approval step at all before this — the failure landed on the
   * creator's very first transaction, which is the worst possible place for it.
   */
  const { data: allowance } = useReadContract({
    address: (env.quoteAddress || '0x') as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [
      address ?? '0x0000000000000000000000000000000000000000',
      (factoryAddress || '0x0000000000000000000000000000000000000000') as `0x${string}`,
    ],
    query: {
       
      enabled: Boolean(address && factoryAddress && env.quoteAddress) && totalDue > 0n,
    },
  })
  // eslint-disable-next-line money/no-number-on-money -- allowance and totalDue are both bigint base units
  const needsApproval = totalDue > 0n && (allowance ?? 0n) < totalDue

  const nameConfusable = hasConfusableCharacters(name)
  const symbolConfusable = hasConfusableCharacters(symbol)
  const descriptionHasLink = description.length > 0 && hasLink(description)

  /**
   * The first unmet requirement, in the order a creator meets them. It names the
   * button, so the button always says what to do next rather than sitting
   * disabled with no explanation.
   */
  const blocker: { label: string; blocking: boolean } = !isConnected
    ? { label: 'Connect a wallet', blocking: true }
    : config.isLoading
      ? { label: 'Reading launch terms…', blocking: true }
      : !terms
        ? { label: 'Launch terms unavailable', blocking: true }
        : name.trim().length === 0
          ? { label: 'Add a name', blocking: true }
          : !isValidName(name)
            ? { label: 'Fix the name', blocking: true }
            : symbol.trim().length === 0
              ? { label: 'Add a ticker', blocking: true }
              : !isValidSymbol(symbol)
                ? { label: 'Fix the ticker', blocking: true }
                : descriptionHasLink
                  ? { label: 'Remove the link', blocking: true }
                  : pinningEnabled && !image
                    ? { label: 'Add token image', blocking: true }
                    : pinningEnabled && !consent
                      ? { label: 'Accept the artwork notice', blocking: true }
                      : !pinningEnabled && manualUri.trim().length === 0
                        ? { label: 'Add a metadata URI', blocking: true }
                        : maxDevBuy > 0n && devBuyAmount > maxDevBuy
                          ? { label: 'Reduce the developer buy', blocking: true }
                          : needsApproval
                            ? { label: `Approve ${env.quoteSymbol}`, blocking: false }
                            : { label: 'Launch token', blocking: false }

  const pickImage = async (file: File | undefined) => {
    if (!file) return
    setImageError(null)
    try {
      const picked = await readImageFile(file)
      setImage((previous) => {
        if (previous) URL.revokeObjectURL(previous.previewUrl)
        return picked
      })
    } catch (err) {
      setImageError(err instanceof ImageRejected ? err.message : 'That file could not be read.')
    }
  }

  /** The CTA. Approves, or pins and opens the dialog — it never signs the launch. */
  const onPrimary = async () => {
    if (needsApproval) {
      await tx.execute({
        address: env.quoteAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [factoryAddress as `0x${string}`, totalDue],
      })
      return
    }

    if (!pinningEnabled) {
      setPendingUri(manualUri.trim())
      return
    }

    pin.reset()
    const result = await pin.mutateAsync({
      name: name.trim(),
      symbol: symbol.trim().toUpperCase(),
      description: description.trim() || undefined,
      x: xHandle.trim() || null,
      telegram: telegram.trim() || null,
      image: image ? { contentType: image.contentType, data: image.data } : undefined,
    })
    setPendingUri(result.uri)
  }

  const submit = async () => {
    if (!factoryAddress || pendingUri === null) return

    const hash = await tx.execute({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: 'launch',
      // LP-1.1 / LP-1.6 — deployment and the dev buy are one transaction. The
      // creator cannot front-run their own launch from a second address, because
      // there is no gap to front-run into (design.md section 4).
      //
      // The last argument is the dev buy's floor (LP-2.4), set to the previewed
      // output exactly. This is the first trade against a curve whose opening
      // state is fixed by the factory, so unlike a trade against a live curve
      // there is no price that can move between preview and execution.
      args: [
        name.trim(),
        symbol.trim().toUpperCase(),
        pendingUri,
        devBuyAmount,
        devBuyPreview?.tokensOut ?? 0n,
      ],
    })

    setPendingUri(null)

    // LP-1.4 — a shareable token page within 5 seconds. The indexer needs a beat
    // to pick the launch up, so land on the feed rather than a 404 token page.
    if (hash) setTimeout(() => navigate('/?sort=newest'), 1500)
  }

  if (!factoryAddress) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-section-title">Launching is not open yet</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The factory contract has not been deployed on {env.chainName}. Exploring and profiles work; creating a
          token will open the moment it is.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Back to explore
      </Link>

      <WrongChainBanner />

      {/* One line and a sticker, like every page heading on hoodium.app. */}
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-balance text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
            Create a token
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One transaction: a fixed supply, a bonding curve in {env.quoteSymbol}, and liquidity that locks at
            graduation.
          </p>
        </div>
        <Clipart name="coins-sprout" float className="hidden size-16 sm:block" />
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* ── The form ──────────────────────────────────────────────────── */}
        <Card className="space-y-5 p-5 sm:p-6">

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" description={`Letters, numbers, and spaces. ${NAME_MAX} characters max.`}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                placeholder="Token name"
                className={inputClass}
              />
              {name.length > 0 && !isValidName(name) && (
                <Warning>Use letters, numbers and spaces only.</Warning>
              )}
              {nameConfusable && <Warning>This name contains characters that imitate Latin letters.</Warning>}
            </Field>

            <Field label="Ticker" description={`Letters and numbers. ${SYMBOL_MAX} characters max.`}>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.slice(0, SYMBOL_MAX).toUpperCase())}
                placeholder="symbol"
                className={cn(inputClass, 'num uppercase')}
              />
              {symbol.length > 0 && !isValidSymbol(symbol) && <Warning>Use letters and numbers only.</Warning>}
              {symbolConfusable && (
                <Warning>
                  This ticker contains characters that imitate Latin letters. Buyers will see a warning flag.
                </Warning>
              )}
            </Field>
          </div>

          <Field label="Description" description={`No links. ${DESCRIPTION_MAX} characters max.`}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              placeholder="A short description of the token"
              rows={3}
              className={cn(inputClass, 'resize-y')}
            />
            {descriptionHasLink && (
              // The token page is where a stranger arrives with no context, which
              // is exactly where a link is worth the most to a phisher. Refused
              // rather than stripped — a stripped link leaves a sentence that
              // reads as if it said something it did not.
              <Warning>Links are not allowed in the description.</Warning>
            )}
          </Field>

          {/* ── Artwork (LP-1.7) ────────────────────────────────────────── */}
          <div>
            <span className="text-sm">Token image</span>

            {pinningEnabled ? (
              <>
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 size-3.5 accent-[hsl(var(--primary))]"
                  />
                  <span>I understand that selected artwork will be moderated and uploaded to public IPFS.</span>
                </label>

                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="sr-only"
                  onChange={(e) => void pickImage(e.target.files?.[0])}
                />

                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className={cn(
                    'mt-2 flex w-full items-center gap-3 rounded-xl border border-border bg-background p-3 text-left',
                    'transition-colors duration-[120ms] hover:border-primary/40',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <span className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted">
                    {image ? (
                      <img src={image.previewUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <ImageIcon className="size-4 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm">{image ? 'Image ready' : 'Choose image'}</span>
                    <span className="num block text-label text-muted-foreground">
                      {image ? `${(image.bytes / 1024).toFixed(0)} KB` : 'PNG, JPEG, WebP or GIF · 1 MB max'}
                    </span>
                  </span>
                </button>

                {imageError && <Warning>{imageError}</Warning>}
              </>
            ) : (
              <div className="mt-2">
                {/*
                  No pinning credential is configured, so there is no upload path.
                  Saying that, and taking a URI the creator pinned themselves, is
                  the honest degradation — an upload button that silently dropped
                  the image would be worse than no upload button.
                */}
                <p className="text-label text-muted-foreground">
                  Uploads are off on this deployment. Paste an IPFS URI you control — it is recorded on-chain
                  exactly as you type it.
                </p>
                <input
                  value={manualUri}
                  onChange={(e) => setManualUri(e.target.value)}
                  placeholder="ipfs://Qm…"
                  className={cn(inputClass, 'num text-xs')}
                />
              </div>
            )}
          </div>

          {pinningEnabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="X profile">
                <Prefixed prefix="x.com/">
                  <input
                    value={xHandle}
                    onChange={(e) => setXHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64))}
                    placeholder="handle"
                    className={bareInputClass}
                  />
                </Prefixed>
              </Field>

              <Field label="Telegram">
                <Prefixed prefix="t.me/">
                  <input
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64))}
                    placeholder="community"
                    className={bareInputClass}
                  />
                </Prefixed>
              </Field>
            </div>
          )}

          {/* ── Dev buy (LP-1.6) ────────────────────────────────────────── */}
          <div>
            <span className="text-sm">Developer buy</span>
            <div className="mt-1 rounded-xl border border-border bg-background p-3">
              <div className="flex items-center gap-2">
                <input
                  value={devBuy}
                  inputMode="decimal"
                  onChange={(e) => setDevBuy(e.target.value.replace(/[^\d.]/g, ''))}
                  placeholder="0.00"
                  className="num min-w-0 flex-1 bg-transparent text-2xl outline-none placeholder:text-muted-foreground"
                  aria-label={`Developer buy in ${env.quoteSymbol}`}
                />
                <span className="num shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs">{env.quoteSymbol}</span>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="num text-label text-muted-foreground">
                  {terms ? (
                    <>
                      Max {formatAmount(fromBaseUnits(maxDevBuy, env.quoteDecimals), { dp: 4 })} ·{' '}
                      {(terms.devBuyMaxBps / 100).toFixed(terms.devBuyMaxBps % 100 === 0 ? 0 : 2)}% of supply
                    </>
                  ) : (
                    'Cap unavailable'
                  )}
                </span>
                <button
                  type="button"
                  disabled={maxDevBuy === 0n}
                  onClick={() => setDevBuy(formatUnits(maxDevBuy, env.quoteDecimals))}
                  className={cn(
                    'rounded-full bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary',
                    'transition-colors duration-[120ms] hover:bg-primary/25 disabled:opacity-40',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  Max
                </button>
              </div>

              {devBuyPreview && (
                <p className="num mt-2 border-t border-border pt-2 text-label text-muted-foreground">
                  You receive{' '}
                  <span className="text-foreground">
                    {formatAmount(fromBaseUnits(devBuyPreview.tokensOut, 18), { compact: true })}{' '}
                    {symbol || 'tokens'}
                  </span>{' '}
                  · fee {formatAmount(fromBaseUnits(devBuyPreview.fee, env.quoteDecimals), { dp: 4 })}{' '}
                  {env.quoteSymbol}
                </p>
              )}

              {terms && maxDevBuy > 0n && devBuyAmount > maxDevBuy && (
                <Warning>
                  Over the {(terms.devBuyMaxBps / 100).toFixed(0)}% cap. The factory would reject this launch.
                </Warning>
              )}
            </div>
          </div>

          {/* ── Advanced ────────────────────────────────────────────────── */}
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center justify-between text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Advanced
              <ChevronDown
                className={cn('size-4 transition-transform duration-[120ms]', advancedOpen && 'rotate-180')}
                aria-hidden
              />
            </button>

            {advancedOpen && (
              <div className="mt-3">
                <label className="block">
                  <span className="text-sm">Creator wallet</span>
                  <input
                    value={address ?? ''}
                    readOnly
                    disabled
                    placeholder="Connect a wallet"
                    className={cn(inputClass, 'num cursor-not-allowed text-xs opacity-60')}
                  />
                </label>
                {/*
                  Not an omission. `BondingCurve.claimCreatorFees` pays `creator`,
                  and `creator` is `msg.sender` at deployment — immutable, like
                  every other launch parameter (LP-N1). An editable field here
                  would be a field that does nothing, and the creator would only
                  discover that when the fees arrived somewhere else.
                */}
                <p className="mt-1.5 text-label text-muted-foreground">
                  Fixed to the wallet that signs the launch. The creator address is immutable on-chain, so the
                  fee share ({terms ? `${terms.creatorFeeShareBps / 100}%` : '—'}) and the developer buy always
                  go here. Launch from the wallet you want paid.
                </p>
                {/*
                  T0.4 — the second fee stream, stated where the creator agrees to
                  it rather than where they later discover it. This is the moment
                  the arrangement becomes permanent for them; the token page is
                  already too late to be a choice.

                  Percentages come from `useLockerTerms`, which reads them off the
                  locker. Typing them here would create a second copy free to
                  disagree with the contract, which is the failure design.md
                  section 3 requires this disclosure to prevent (WA-N6).
                */}
                {lockerTerms.protocolPct === null ? null : (
                  <p className="mt-1.5 text-label text-muted-foreground">
                    After graduation the pool keeps earning trading fees, split{' '}
                    <span className="font-medium text-foreground">
                      {lockerTerms.creatorPct}% to you / {lockerTerms.protocolPct}% to the protocol
                    </span>
                    . They are paid to this same wallet, which is recorded when the position is locked and can
                    never be changed afterwards.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Submit ──────────────────────────────────────────────────── */}
          <div className="border-t border-border pt-4">
            <p className="num text-xs text-muted-foreground">
              {terms ? (
                <>
                  {env.quoteSymbol} {formatAmount(fromBaseUnits(totalDue, env.quoteDecimals), { dp: 4 })} due
                  {creationFee > 0n && devBuyAmount > 0n ? ' — launch fee and developer buy' : ''}
                </>
              ) : (
                'Terms unavailable — the factory could not be read.'
              )}
            </p>

            {isConnected ? (
              <Button
                variant="primary"
                className="mt-3 w-full"
                disabled={blocker.blocking || tx.isBusy || pin.isPending}
                onClick={() => void onPrimary()}
              >
                {pin.isPending ? 'Uploading metadata…' : tx.isBusy ? 'Working…' : blocker.label}
              </Button>
            ) : (
              <div className="mt-3 flex justify-center">
                <ConnectButton variant="primary" size="md" label="Connect wallet" />
              </div>
            )}

            {pin.isError && (
              <p className="mt-2 text-xs text-destructive">
                {pin.error instanceof Error ? pin.error.message : 'The upload failed.'} Nothing was submitted
                to the chain.
              </p>
            )}

            <TxStatus tx={tx} className="mt-3" />
          </div>
        </Card>

        {/* ── Live preview ──────────────────────────────────────────────── */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <LaunchPreview
            name={name}
            symbol={symbol}
            imageUrl={image?.previewUrl ?? null}
            devBuy={devBuyAmount}
            terms={terms}
            termsUnavailable={!config.isLoading && !terms}
          />
        </div>
      </div>

      <div className="space-y-2 px-1 text-xs text-muted-foreground">
        <p>
          <span className="text-foreground">The token has no owner and no mint function.</span> Supply is
          fixed at deployment and nothing — including Hoodium — can change it afterwards.
        </p>
        <p>
          <span className="text-foreground">Curve parameters are immutable.</span> Fees, the graduation
          target, and the split with Hoodium are fixed when your token is created.
        </p>
      </div>

      <LaunchConfirmDialog
        open={pendingUri !== null}
        onClose={() => setPendingUri(null)}
        onConfirm={() => void submit()}
        busy={tx.isBusy}
        name={name.trim()}
        symbol={symbol.trim().toUpperCase()}
        metadataURI={pendingUri ?? ''}
        devBuy={devBuyAmount}
        creator={address ?? ''}
        terms={terms}
        factoryAddress={factoryAddress}
      />
    </div>
  )
}

const inputClass =
  'mt-1 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

const bareInputClass = 'min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none'

function Field({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-sm">{label}</span>
      {children}
      {description && <span className="mt-1 block text-label text-muted-foreground">{description}</span>}
    </label>
  )
}

/**
 * A fixed prefix inside the field. Not decoration: the value is stored and sent
 * as a bare handle, never as a URL, so this prefix is the only thing that decides
 * where the resulting link points.
 */
function Prefixed({ prefix, children }: { prefix: string; children: React.ReactNode }) {
  return (
    <span className="mt-1 flex items-center rounded-xl border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
      <span className="num shrink-0 text-sm text-muted-foreground">{prefix}</span>
      {children}
    </span>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 block text-xs text-warning">{children}</span>
}
