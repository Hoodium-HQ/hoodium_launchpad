import { useEffect, useId, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A modal dialog — WA-5.3, WA-5.5.
 *
 * `<dialog>` rather than a hand-rolled overlay, because the platform already
 * implements the parts that are easy to get wrong: the top layer, inert content
 * behind it, initial focus, and Escape. What is left is the part the platform
 * does *not* do — restoring focus to where it came from, and treating a click on
 * the backdrop as a cancel.
 *
 * Every dialog in this app is a confirmation of something irreversible, so
 * `showModal()` is used rather than `show()`: the content behind must not be
 * clickable while a signature is being decided on.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** Announced with the title. Keep it to what changes the decision. */
  description?: string
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    // Fires for Escape as well as `close()`, so the parent state can never drift
    // out of sync with what is on screen.
    const onCancelOrClose = () => onClose()
    dialog.addEventListener('close', onCancelOrClose)
    return () => dialog.removeEventListener('close', onCancelOrClose)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // `backdrop:` compiles to a bare `::backdrop` rule rather than one scoped
      // to this element. Harmless — a top-layer backdrop only exists while a
      // dialog is open, and this is the only dialog in the app.
      className={cn(
        // Entry and exit live in `index.css` — a `<dialog>` transitions out of
        // `display: none`, which needs `@starting-style` and `allow-discrete`
        // rather than anything expressible as a utility class.
        'modal-dialog',
        'w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-0 text-foreground',
        /*
         * A confirm dialog with a percentage picker, four amount rows and a
         * slippage control is taller than a phone in landscape. `<dialog>` caps
         * itself but does not scroll, so the buttons fell off the bottom with no
         * way to reach them. `overscroll-contain` stops that scroll chaining to
         * the page behind, which on iOS reads as the modal dragging the whole
         * app around.
         */
        'max-h-[min(85dvh,42rem)] overflow-y-auto overscroll-contain',
        'backdrop:bg-background/70 backdrop:backdrop-blur-sm',
        className,
      )}
      onClick={(event) => {
        // A click that lands on the dialog element itself — rather than on any
        // child — is a click on the backdrop, since the padding lives inside.
        if (event.target === ref.current) onClose()
      }}
    >
      <div className="p-5">
        <h2 id={titleId} className="text-section-title">
          {title}
        </h2>
        {description && (
          <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        )}
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  )
}
