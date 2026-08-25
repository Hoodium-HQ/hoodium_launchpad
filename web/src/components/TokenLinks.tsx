import { ExternalLink, FileCode2, Send, Waves } from 'lucide-react'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { env } from '@/config/env'
import { useSaveLinks } from '@/hooks/useLaunchpad'
import type { TokenDetail } from '@/lib/launchpad-api'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Modal } from './Modal'

/**
 * Where else this token can be looked at — and the creator's own links.
 *
 * ── Why the socials are rendered from handles ────────────────────────────────
 * The API stores `x` and `telegram` as bare handles, never as URLs, and the
 * prefix below is added at render. That is the whole defence: a creator-supplied
 * URL on a page a stranger arrives at cold is a phishing link with our styling on
 * it, and no amount of validating a URL string makes it safe to click. A handle
 * can only ever resolve to a profile on the host we chose.
 *
 * `rel="noopener noreferrer"` on every outbound link, and `nofollow` on the
 * creator's own — we are not vouching for whatever is on the other side.
 */
export function TokenLinks({ token }: { token: TokenDetail }) {
  const { address } = useAccount()
  const [editing, setEditing] = useState(false)

  const isCreator = Boolean(address && address.toLowerCase() === token.creator.toLowerCase())

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {env.explorerUrl && (
          <Outbound
            href={`${env.explorerUrl}/address/${token.address}`}
            icon={<FileCode2 className="size-3.5" aria-hidden />}
          >
            Contract
          </Outbound>
        )}

        {env.explorerUrl && token.pool && (
          <Outbound
            href={`${env.explorerUrl}/address/${token.pool}`}
            icon={<Waves className="size-3.5" aria-hidden />}
          >
            Pool
          </Outbound>
        )}

        {token.x && (
          <Outbound href={`https://x.com/${token.x}`} icon={<span aria-hidden>𝕏</span>} untrusted>
            @{token.x}
          </Outbound>
        )}

        {token.telegram && (
          <Outbound
            href={`https://t.me/${token.telegram}`}
            icon={<Send className="size-3.5" aria-hidden />}
            untrusted
          >
            Telegram
          </Outbound>
        )}

        {isCreator && (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit links
          </Button>
        )}
      </div>

      {isCreator && (
        <EditLinksDialog
          open={editing}
          onClose={() => setEditing(false)}
          tokenAddress={token.address}
          initialX={token.x ?? ''}
          initialTelegram={token.telegram ?? ''}
        />
      )}
    </>
  )
}

function Outbound({
  href,
  icon,
  children,
  untrusted = false,
}: {
  href: string
  icon: React.ReactNode
  children: React.ReactNode
  /** Creator-chosen destination — do not pass link equity to it. */
  untrusted?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel={untrusted ? 'noopener noreferrer nofollow ugc' : 'noopener noreferrer'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs',
        'text-muted-foreground transition-colors duration-[120ms] hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {icon}
      {children}
      <ExternalLink className="size-3 opacity-60" aria-hidden />
    </a>
  )
}

/**
 * `metadataURI` is immutable once launched — that is the point of recording it
 * on-chain. A creator who moves their Telegram has no way to correct the pinned
 * document, so these live off-chain as an overlay, and the dialog says so rather
 * than implying the on-chain record changed.
 */
function EditLinksDialog({
  open,
  onClose,
  tokenAddress,
  initialX,
  initialTelegram,
}: {
  open: boolean
  onClose: () => void
  tokenAddress: string
  initialX: string
  initialTelegram: string
}) {
  const [x, setX] = useState(initialX)
  const [telegram, setTelegram] = useState(initialTelegram)
  const save = useSaveLinks(tokenAddress)

  const submit = async () => {
    await save.mutateAsync({ x: x.trim() || null, telegram: telegram.trim() || null })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit links"
      description="Stored off-chain. The pinned metadata cannot change — that is what makes it verifiable."
    >
      <label className="block">
        <span className="text-sm">X profile</span>
        <span className="mt-1 flex items-center rounded-xl border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
          <span className="num shrink-0 text-sm text-muted-foreground">x.com/</span>
          <input
            value={x}
            onChange={(e) => setX(e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64))}
            placeholder="handle"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
          />
        </span>
      </label>

      <label className="mt-3 block">
        <span className="text-sm">Telegram</span>
        <span className="mt-1 flex items-center rounded-xl border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
          <span className="num shrink-0 text-sm text-muted-foreground">t.me/</span>
          <input
            value={telegram}
            onChange={(e) => setTelegram(e.target.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 64))}
            placeholder="community"
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none"
          />
        </span>
      </label>

      {save.isError && (
        <p className="mt-2 text-xs text-destructive">
          {save.error instanceof Error ? save.error.message : 'That could not be saved.'}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" disabled={save.isPending} onClick={() => void submit()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  )
}
