import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { defineChain } from '@reown/appkit/networks'
import { createAppKit } from '@reown/appkit/react'
import { http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { env } from './env'

/**
 * Robinhood Chain — WA-1.1, WA-1.2.
 *
 * Defined from configuration rather than a hard-coded literal for the same
 * reason the backend does it (004 section 10, open question 1: the testnet id is
 * still unconfirmed). The guard in `useChainGuard` compares the *connected*
 * chain against this, and blocks every action until they agree.
 *
 * Reown's `defineChain` is viem's plus the two CAIP fields AppKit indexes
 * networks by. `caipNetworkId` is derived from the same `env.chainId` as `id` —
 * a literal there would be a second source of truth for the one value the whole
 * mainnet guard turns on.
 */
export const robinhoodChain = defineChain({
  id: env.chainId,
  caipNetworkId: `eip155:${env.chainId}`,
  chainNamespace: 'eip155',
  name: env.chainName,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
  blockExplorers: env.explorerUrl
    ? { default: { name: 'Explorer', url: env.explorerUrl } }
    : undefined,
})

/**
 * WA-1.1 — injected providers and WalletConnect, through Reown AppKit.
 *
 * The adapter owns the wagmi config now. AppKit registers the WalletConnect
 * connector itself from `projectId` and has to be the thing holding its
 * lifecycle: build a config separately and hand it over, and the modal's view of
 * the connection drifts from wagmi's. `injected` is still listed explicitly
 * because the adapter's own injected connector does not set `shimDisconnect`,
 * and without it a disconnect is silently undone by the next page load.
 *
 * `projectId` is required rather than optional now (see config/env.ts): AppKit
 * *is* the connect surface, so unlike the previous setup there is no
 * injected-only path that survives its absence.
 */
const wagmiAdapter = new WagmiAdapter({
  networks: [robinhoodChain],
  projectId: env.reownProjectId,
  connectors: [injected({ shimDisconnect: true })],
  transports: { [robinhoodChain.id]: http(env.rpcUrl) },
  // WA-1.3 — the app works read-only with no wallet connected, so reconnection
  // is best-effort and never gates a render.
  ssr: false,
})

export const wagmiConfig = wagmiAdapter.wagmiConfig

/**
 * The modal is created once, at module scope, because AppKit registers global
 * custom elements — doing this inside a component re-registers them on remount
 * and the second registration throws.
 *
 * Everything under `features` is off deliberately, for three different reasons:
 *
 *  - `analytics` — design.md section 8. No telemetry from a surface where users
 *    sign transactions, which is also why pulse.walletconnect.org is absent from
 *    the CSP rather than merely unused.
 *  - `email` / `socials` — these render inside a secure.walletconnect.org iframe
 *    and need `Cross-Origin-Opener-Policy: same-origin-allow-popups`. The frame
 *    and the header relaxation both exist to serve a custodial flow that
 *    contradicts WA-N1, so neither is worth paying for.
 *  - `swaps` / `onramp` / `send` — third-party endpoints, largely on other
 *    chains. On a single-chain deployment they are dead UI that would still cost
 *    a CSP origin each.
 */
export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  networks: [robinhoodChain],
  defaultNetwork: robinhoodChain,
  projectId: env.reownProjectId,
  metadata: {
    name: 'Hoodium Launchpad',
    description: 'Launch and trade fixed-supply tokens on Robinhood Chain',
    url: env.siteUrl,
    icons: [],
  },
  features: {
    analytics: false,
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
    send: false,
  },
  // WA-1.2 is handled by our own gate, with our own copy. Left to enforce it,
  // AppKit pre-empts that gate with a generic "unsupported network" view that
  // never names Robinhood Chain.
  allowUnsupportedChain: true,
  // Overridden per render from the UI store; see AppProviders.
  themeMode: 'dark',
  themeVariables: {
    '--w3m-font-family': 'Geist, Inter, system-ui, sans-serif',
    '--w3m-accent': '#C3F53C',
    '--w3m-border-radius-master': '2px',
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
