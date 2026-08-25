import * as React from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '@/lib/utils'

/**
 * Tooltip — shadcn's Base UI component, restyled for this design system.
 *
 * ── What was kept and what was changed ───────────────────────────────────────
 * The structure is shadcn's, verbatim: the same four exports, the same slot
 * attributes, the same `Portal → Positioner → Popup → Arrow` nesting, and the
 * same prop surface, so the upstream docs describe this file correctly. What is
 * ours is the skin. shadcn's ships Tailwind v4 syntax — `origin-(--transform-origin)`,
 * and `cn-tooltip-content`, a component class defined in their globals.css —
 * neither of which exists in this project's Tailwind 3.4 build; pasting it
 * unchanged would have produced an unstyled box with class names that silently
 * do nothing.
 *
 * The surface is `popover`, not `foreground`. shadcn inverts its tooltips —
 * dark chip on a light page — which on this near-black canvas would be a white
 * card flashing under the cursor. Every other hanging surface here (the account
 * menu, the notification panel) is `bg-popover`, and a tooltip is one of those
 * (design-system.md section 4).
 *
 * ── Why the trigger renders as a span by default ─────────────────────────────
 * Base UI's trigger is a `button`, and most of this app's tooltips sit on text
 * *inside* a control — a figure in a row that is itself one big button. A
 * button inside a button is invalid HTML and React will say so at runtime. The
 * `render` prop makes the element ours, so the default here is the one that is
 * safe everywhere; pass `render={<button …/>}` at the call sites that want a
 * real control.
 *
 * ── What this replaced, and what that costs ──────────────────────────────────
 * `title=""`. Native titles are unstyled, appear after a browser-chosen delay
 * nobody can tune, cannot wrap a long sentence legibly, and are unreadable on
 * this palette. They also cannot be tested for content the way an element can.
 *
 * The honest cost: a `title` is announced by every screen reader and shown by
 * every browser, including on a long-press on iOS. A hover tooltip is a hover
 * tooltip. So anything that a reader *needs* stays in the text of the row —
 * these carry the explanation behind a figure, never the figure itself, which
 * is the rule this card already followed (WA-5.5).
 */
function TooltipProvider({ delay = 200, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ render, ...props }: TooltipPrimitive.Trigger.Props) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      /* A span, unless the call site says otherwise — see the header. */
      render={render ?? <span />}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 6,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            /* `max-w-xs` and normal leading: these hold whole sentences — the
               reason a `title` was the wrong container for them. */
            'z-50 w-fit max-w-xs rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-lg',
            /* The dropdown budget, and the same keyframe every other hanging
               surface uses (design-system.md section 10). It honours
               prefers-reduced-motion through `.popover-in`'s own media query. */
            'popover-in',
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow
            className={cn(
              'z-50 fill-popover',
              'data-[side=bottom]:top-[-0.3rem] data-[side=bottom]:rotate-180',
              'data-[side=top]:bottom-[-0.3rem]',
              'data-[side=left]:right-[-0.55rem] data-[side=left]:-rotate-90',
              'data-[side=right]:left-[-0.55rem] data-[side=right]:rotate-90',
            )}
          >
            {/* Base UI draws nothing itself — the arrow is whatever child it is
                given. Stroked in the border colour so it reads as part of the
                popup's outline rather than as a shape stuck to its edge. */}
            <svg width="12" height="6" viewBox="0 0 12 6" aria-hidden>
              <path d="M0 6 L6 0 L12 6" className="fill-popover stroke-border" strokeWidth="1" />
            </svg>
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * The common case, in one element: a tooltip on a piece of text.
 *
 * Nine in ten call sites in this app are "the thing that was a `title`" — one
 * trigger, one sentence, no configuration. Written out longhand that is five
 * lines of JSX around every figure on a row, which is how a row of six
 * tooltips becomes unreadable source. The pieces stay exported for the call
 * sites that need them.
 */
export function Hint({
  content,
  children,
  className,
  contentClassName,
  side,
  render,
  ...props
}: {
  /** The sentence. Kept out of `children` so the trigger stays the visible thing. */
  content: React.ReactNode
  /** Optional only for a `render` that draws itself — a bare marker on a meter. */
  children?: React.ReactNode
  className?: string
  /**
   * Styling for the popup — `font-mono` on a hex address, and little else.
   *
   * It exists so that a hint whose whole content is one string can be styled
   * without wrapping it in an element: the moment `content` stops being a
   * string, `data-hint` cannot carry it and the sentence is invisible to
   * anything that is not a pointer.
   */
  contentClassName?: string
  side?: TooltipPrimitive.Positioner.Props['side']
  /** A real element for the trigger — `<button …/>` where this hangs off a control. */
  render?: TooltipPrimitive.Trigger.Props['render']
} & Omit<TooltipPrimitive.Trigger.Props, 'content' | 'children' | 'className' | 'render'>) {
  return (
    <Tooltip>
      <TooltipTrigger
        className={className}
        render={render}
        /*
         * The sentence, on the trigger, for anything that cannot hover.
         *
         * The popup exists only while it is open, which is correct for a
         * tooltip and awkward for everything else: a test asserting what a
         * figure explains would have to drive a pointer, and forty of those
         * cost twelve seconds and describe the mouse rather than the copy.
         * This is the string the popup will show, parked where it can be read
         * without opening — the one job `title` did that a portal cannot.
         *
         * Strings only. A `content` built from elements has no honest flat
         * form, and half a sentence would be worse than none.
         */
        data-hint={typeof content === 'string' ? content : undefined}
        {...props}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={contentClassName}>
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * A hint where there may be nothing to say.
 *
 * Several figures carry an explanation only in the case that needs one — a
 * total drawn from four of eleven positions says so, a complete one says
 * nothing. As a `title` that was free: `title={undefined}` is no attribute.
 * A `Tooltip` is a real element, and one wrapped around every row with an
 * empty popup is a control that opens to nothing.
 *
 * So this collapses to a plain span when there is no sentence, and the call
 * sites keep reading as one element either way.
 */
export function MaybeHint({
  content,
  children,
  className,
  render,
  ...props
}: {
  content: React.ReactNode | null | undefined
  children?: React.ReactNode
  className?: string
  render?: TooltipPrimitive.Trigger.Props['render']
} & Omit<TooltipPrimitive.Trigger.Props, 'content' | 'children' | 'className' | 'render'>) {
  if (content === null || content === undefined || content === '') {
    /*
     * The element the call site asked for, with nothing wrapped around it —
     * a `render` here is not a styling choice, it is "this is a bar / an image
     * / a table cell", and putting a span around one of those in the quiet case
     * would make the layout depend on whether there was anything to explain.
     */
    if (render && React.isValidElement(render)) {
      return React.cloneElement(render, undefined, children)
    }
    return <span className={className}>{children}</span>
  }
  return (
    <Hint content={content} className={className} render={render} {...props}>
      {children}
    </Hint>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
