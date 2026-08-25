/**
 * QR rendering for the Telegram link flow — WA-6.8.
 *
 * Linking crosses devices: the user is on desktop, Telegram is on their phone.
 * Without a QR the flow degrades to retyping a 43-character token by hand, which
 * is where such flows are abandoned.
 *
 * Rendered server-side and returned as a `data:` URI. The token is already in
 * that response, so drawing it here exposes nothing new — and it keeps a QR
 * encoder out of the bundle that renders the trading surfaces (WA-5.1).
 *
 * A URI rather than raw markup because the web app renders it in an `<img>`:
 * inline SVG would mean `dangerouslySetInnerHTML`, which WA-N3 bans outright,
 * and an SVG loaded through `<img>` cannot execute script even in principle.
 */
import QRCode from 'qrcode'

/**
 * `M` corrects ~15% of the symbol. A link QR is read once, from a bright screen,
 * at close range — the higher levels buy robustness this flow never needs and
 * pay for it in module density, which makes the code *harder* to scan on a
 * small rendering.
 */
const ERROR_CORRECTION = 'M' as const

export async function renderQrDataUri(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: ERROR_CORRECTION,
    // Scaled by CSS at the point of use; a fixed pixel width would fight the
    // layout, and SVG stays crisp at whatever size it lands on.
    margin: 2,
    color: {
      // Pure black-on-white regardless of theme. A themed QR is a QR that fails
      // to scan in one of the two themes, and the dialog gives it a white plate.
      dark: '#000000',
      light: '#ffffff',
    },
  })

  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}
