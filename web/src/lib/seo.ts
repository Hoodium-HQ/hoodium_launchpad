/**
 * What a page says about itself to something that is not a person.
 *
 * Every route renders into one `index.html`, so without this module every URL
 * on the site shares one title, one description and one canonical — the
 * landing page's. That is invisible in the browser tab and very visible
 * everywhere else: a shared pool link previews as the market page, a search
 * result for a provider is titled "Liquidity intelligence across chains", and
 * an answer engine that renders JavaScript sees six pages it cannot tell apart.
 *
 * ── What this can and cannot fix ─────────────────────────────────────────────
 * These tags are written by JavaScript, so they exist for readers that run it:
 * Googlebot, and the wallet-and-browser crowd. A crawler that fetches the HTML
 * and stops — which is most of the answer engines, and every social unfurler —
 * sees the static head in `index.html` and nothing here.
 *
 * That is why the static head keeps a canonical pointing at `/`: for a reader
 * that never runs the app, every URL genuinely is the same document, and saying
 * so consolidates them instead of publishing a dozen duplicates. A reader that
 * does run the app has that canonical corrected below, per route, before it
 * matters. The non-rendering half is served by `public/llms.txt` and the public
 * JSON API, which are the honest answer to "what is on this page" for anything
 * that cannot execute the page.
 */

export const SITE_NAME = 'Hoodium Launchpad'

/**
 * The landing page's title and description, and the fallback for any route that
 * does not set its own.
 *
 * Kept identical to the copy in `index.html` and `public/site.webmanifest` on
 * purpose: three files stating the same claim in three slightly different ways
 * is how one of them goes stale without anyone noticing. If this sentence
 * changes, it changes in all three.
 */
export const DEFAULT_TITLE = 'Hoodium Launchpad: launch and trade tokens on Robinhood Chain'

export const DEFAULT_DESCRIPTION =
  'Launch and explore fixed-supply tokens on Robinhood Chain. Bonding curves priced in USDG ' +
  'that graduate into locked Uniswap v3 liquidity. Your wallet submits every transaction; ' +
  'Hoodium never custodies assets.'

/** The robots directive a page carries unless it asks to be kept out. */
const INDEXABLE = 'index, follow, max-image-preview:large, max-snippet:-1'

/**
 * `follow`, not `nofollow`, on the pages we hide.
 *
 * A noindex page here is one with nothing of its own to index — the portfolio
 * before a wallet is connected, a position that has since closed — not one we
 * want walled off. Its links still point at pages that are worth reaching.
 */
const HIDDEN = 'noindex, follow'

export interface DocumentMeta {
  /**
   * The page's own name, without the site's. `undefined` means "this is the
   * landing page" and yields `DEFAULT_TITLE` whole, rather than a title that
   * reads "Hoodium · Hoodium".
   */
  title?: string
  description?: string
  /**
   * Path and query as the canonical URL should carry them — `/?tab=momentum`,
   * `/market/v4/0x…`. Resolved against the current origin, so a preview
   * deployment canonicalises to itself instead of to production.
   *
   * Omitted means "the current path, without its query string", which is right
   * for every route whose query is a UI control rather than a distinct page.
   */
  canonicalPath?: string
  /** Keep this URL out of search results. Its links are still followed. */
  noindex?: boolean
}

/** `Pool ETH/USDG` → `Pool ETH/USDG · Hoodium`; nothing → the site's own title. */
export function documentTitle(title?: string): string {
  return title ? `${title} · ${SITE_NAME}` : DEFAULT_TITLE
}

/**
 * The one `<meta name="x" content="…">` with this name, created if the static
 * head did not ship one.
 *
 * Creating rather than assuming lets `index.html` stay the floor rather than a
 * list this file has to be kept in step with: adding a property here does not
 * require adding a placeholder tag there.
 */
function metaTag(attribute: 'name' | 'property', key: string): HTMLMetaElement {
  const selector = `meta[${attribute}="${key}"]`
  const existing = document.head.querySelector<HTMLMetaElement>(selector)
  if (existing) return existing

  const created = document.createElement('meta')
  created.setAttribute(attribute, key)
  document.head.appendChild(created)
  return created
}

function linkTag(rel: string): HTMLLinkElement {
  const existing = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (existing) return existing

  const created = document.createElement('link')
  created.rel = rel
  document.head.appendChild(created)
  return created
}

/**
 * Write one route's metadata into the document head.
 *
 * Separate from the hook so it can be tested without mounting a component, and
 * so the ordering rule below is stated once: the description a page gives to
 * search, to Open Graph and to Twitter is always the same string. Three
 * descriptions that disagree is a bug that only shows up in someone else's
 * screenshot.
 */
export function applyDocumentMeta(meta: DocumentMeta): void {
  const title = documentTitle(meta.title)
  const description = meta.description ?? DEFAULT_DESCRIPTION

  document.title = title

  const canonical = new URL(
    meta.canonicalPath ?? window.location.pathname,
    window.location.origin,
  ).toString()

  metaTag('name', 'description').content = description
  metaTag('name', 'robots').content = meta.noindex ? HIDDEN : INDEXABLE

  linkTag('canonical').href = canonical

  metaTag('property', 'og:title').content = title
  metaTag('property', 'og:description').content = description
  metaTag('property', 'og:url').content = canonical

  metaTag('name', 'twitter:title').content = title
  metaTag('name', 'twitter:description').content = description
}
