import { useEffect } from 'react'
import { applyDocumentMeta, type DocumentMeta } from '@/lib/seo'

/**
 * Give the current route its own title, description and canonical URL.
 *
 * Every route calls this, including the ones that ask to be hidden — because
 * the head is shared state, and a route that sets nothing inherits whatever the
 * route before it wrote. There is nothing to undo on unmount for the same
 * reason: the next route overwrites, and between the two there is no frame for
 * a reader to observe.
 *
 * The dependencies are the fields rather than the object, so a caller can build
 * the argument inline — which every caller does — without rewriting the head on
 * every render.
 */
export function useDocumentMeta({ title, description, canonicalPath, noindex }: DocumentMeta): void {
  useEffect(() => {
    applyDocumentMeta({ title, description, canonicalPath, noindex })
  }, [title, description, canonicalPath, noindex])
}
