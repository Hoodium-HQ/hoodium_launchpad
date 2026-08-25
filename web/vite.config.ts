import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  /*
   * The API and the RPC each live on a different port, and `'self'` in a CSP does
   * not cover a different port. Derive both origins from configuration so the
   * policy tracks the actual setup instead of a hard-coded host that silently
   * blocks every request the moment someone changes it.
   */
  const originOf = (value: string | undefined, fallback: string) => {
    try {
      return new URL(value ?? fallback).origin
    } catch {
      return new URL(fallback).origin
    }
  }
  const apiOrigin = originOf(env.VITE_API_URL, 'http://localhost:8080')
  const rpcOrigin = originOf(env.VITE_RPC_URL, 'http://127.0.0.1:8545')

  /*
   * Same-origin API in development. Set `API_PROXY_TARGET` (not `VITE_`-prefixed
   * — it never reaches the bundle) and point `VITE_API_URL` at the dev server
   * itself; `/api` and `/health` are forwarded, so the browser sees one origin
   * and neither CORS nor the CSP has to be widened for local work.
   */
  const proxyTarget = loadEnv(mode, process.cwd(), 'API_PROXY_TARGET').API_PROXY_TARGET
  const proxy = proxyTarget
    ? { '/api': { target: proxyTarget, changeOrigin: true }, '/health': { target: proxyTarget, changeOrigin: true } }
    : undefined

  /*
   * Reown AppKit's origins.
   *
   * `.org` is not a synonym for the `.com` entries that used to be here — Reown
   * migrated the relay and the wallet registry to walletconnect.org, and a policy
   * naming only `.com` blocks every connection while looking like it allows them.
   * Both are listed because deep links minted by older wallets still point at the
   * `.com` hosts.
   *
   * `api.web3modal.org` is the wallet registry: the list of wallets in the modal,
   * and their icons. It is load-bearing, not decorative — without it the modal
   * renders empty.
   *
   * Deliberately absent: `pulse.walletconnect.org` (telemetry — design.md section
   * 8, and `features.analytics` is off), and `secure.walletconnect.org` (the
   * email/social custodial frame, also off). Both being blocked is the intended
   * state, not an oversight to fix when a violation appears in the console.
   */
  const reownConnect = [
    'https://*.walletconnect.com',
    'wss://*.walletconnect.com',
    'https://*.walletconnect.org',
    'wss://*.walletconnect.org',
    'https://api.web3modal.org',
  ]

  /*
   * One source of truth for `connect-src`. The meta policy in index.html and the
   * dev-server header are both enforced, and the browser applies the *intersection*
   * — an origin missing from either one is blocked, however permissive the other
   * is. Keeping them in sync by hand is exactly how the API origin ended up
   * allowed in the header and denied in the meta tag.
   */
  const connectSrc = [...new Set(["'self'", apiOrigin, rpcOrigin, ...reownConnect])].join(' ')

  /*
   * Wallet icons in the connect modal are served from the registry and its CDN.
   * These are the one third-party image source in the app — unlike token logos
   * (below) they cannot be proxied, because the URLs are minted by the registry
   * at modal-open time and are not ours to rewrite.
   */
  const walletIconSrc = [
    'https://explorer-api.walletconnect.com',
    'https://api.web3modal.org',
    'https://imagedelivery.net',
  ]

  /*
   * `frame-src` covers Verify, the origin-attestation iframe AppKit opens so a
   * wallet can show the user which site is actually requesting the signature.
   * Blocking it degrades that warning to "cannot verify", which is worse for the
   * user than the third-party frame is.
   */
  const frameSrc = [
    "'self'",
    'https://verify.walletconnect.com',
    'https://verify.walletconnect.org',
  ].join(' ')

  /*
   * Token logos are proxied by the backend so no third-party image host is ever
   * contacted (WA-N2, WA-N3) — but the backend is a different origin from the
   * page, and `'self'` is the page's origin alone. Without the API origin here,
   * the proxy is blocked by the very policy it exists to satisfy.
   *
   * In production, where the API is served from the same origin, this collapses
   * back to `'self'` and the Set removes the duplicate.
   */
  const imgSrc = [...new Set(["'self'", apiOrigin, ...walletIconSrc, 'data:', 'blob:'])].join(' ')

  return {
  plugins: [
    react(),
    {
      // index.html carries the production floor; the origins come from config.
      name: 'hoodium-csp-origins',
      transformIndexHtml: (html: string) =>
        html
          .replaceAll('%CSP_CONNECT_SRC%', connectSrc)
          .replaceAll('%CSP_IMG_SRC%', imgSrc)
          .replaceAll('%CSP_FRAME_SRC%', frameSrc),
    },
  ],
  resolve: {
    // Aliases carried over from the reference frontend (design-system section 1).
    alias: { '@': path.resolve(__dirname, './src') },
  },
  preview: { proxy },
  server: {
    port: 5173,
    proxy,
    headers: {
      // WA-N2 — strict CSP. Dev mirrors production so a violation surfaces here
      // rather than after deploy. `unsafe-inline`/`unsafe-eval` on script-src are
      // dev-only concessions to Vite's HMR client; see index.html for the
      // production policy, which drops both.
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        // Token images are creator-supplied (WA-N3) and proxied through the backend.
        `img-src ${imgSrc}`,
        // AppKit's stylesheet points at fonts.googleapis.com. Left blocked: the
        // fallback is the system font stack, which is what `--w3m-font-family`
        // already asks for, so allowing a third-party font host would buy nothing
        // and cost an origin on a signing surface.
        "font-src 'self' data:",
        // ws:/wss: are dev-only, for Vite's HMR socket.
        `connect-src ${connectSrc} ws: wss:`,
        `frame-src ${frameSrc}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // WA-5.1: the chain stack is large and not needed to render a first
          // paint, so it is split off the critical path.
          chain: ['wagmi', 'viem', '@reown/appkit', '@reown/appkit-adapter-wagmi'],
          chart: ['lightweight-charts'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
  }
})
