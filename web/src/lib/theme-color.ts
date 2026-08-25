/**
 * Resolve a CSS custom property to a colour a canvas library can parse.
 *
 * The theme stores colours as bare HSL components (`110 4% 56%`), which is what
 * Tailwind needs. Reassembling them into `hsla(...)` is fine for CSS and fatal
 * for `lightweight-charts`: its parser accepts hex, `rgb`, `rgba`, and named
 * colours only, and throws `Cannot parse color` on anything else — taking the
 * whole chart component down with it, since the throw happens during construction.
 *
 * Rather than hand-rolling an HSL→RGB conversion that has to track whatever the
 * theme does next, the browser is asked to do it: assign the colour to a
 * detached element and read back the computed value, which is always `rgb(...)`.
 */
function computedRgb(color: string): string | null {
  if (typeof document === 'undefined') return null

  const probe = document.createElement('span')
  probe.style.color = color
  // Must be in the document for `getComputedStyle` to resolve anything.
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()

  return resolved || null
}

/**
 * @param variable a CSS custom property name, e.g. `--muted-foreground`
 * @param alpha 0–1
 * @returns an `rgba(...)` string, or an opaque fallback if the variable is unset
 */
export function themeColor(variable: string, alpha = 1): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(variable).trim()
  if (!raw) return `rgba(128, 128, 128, ${alpha})`

  // Bare HSL components are the theme's storage format; anything else is
  // already a colour and passes through the same probe unchanged.
  const candidate = /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(raw) ? `hsl(${raw})` : raw
  const rgb = computedRgb(candidate)

  const match = rgb?.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
  if (!match) return `rgba(128, 128, 128, ${alpha})`

  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`
}
