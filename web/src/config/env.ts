/**
 * Frontend configuration.
 *
 * Chain identity has no default — a build that does not state its chain does
 * not build. Everything here is public by definition: only `VITE_`-prefixed
 * variables reach the browser, and no private key or session secret ever
 * appears in frontend configuration.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`FATAL: ${name} is not set. Frontend configuration has no defaults for anything chain-identifying.`)
  }
  return value
}

const raw = import.meta.env

export const env = {
  apiUrl: (raw.VITE_API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, ''),

  chainId: Number.parseInt(required('VITE_CHAIN_ID', raw.VITE_CHAIN_ID), 10),
  chainName: raw.VITE_CHAIN_NAME ?? 'Robinhood Chain',
  rpcUrl: required('VITE_RPC_URL', raw.VITE_RPC_URL),
  explorerUrl: (raw.VITE_EXPLORER_URL ?? '').replace(/\/$/, ''),

  /** Canonical origin, for share links and the sitemap. */
  siteUrl: (raw.VITE_SITE_URL ?? 'https://launchpad.hoodium.app').replace(/\/$/, ''),

  quoteSymbol: raw.VITE_QUOTE_SYMBOL ?? 'USDG',
  quoteDecimals: Number.parseInt(raw.VITE_QUOTE_DECIMALS ?? '6', 10),
  quoteAddress: raw.VITE_QUOTE_ADDRESS ?? '',

  /**
   * Launchpad contracts. All empty until the owner deploys them; an empty
   * factory disables the launch form and says so, rather than encoding calldata
   * to the zero address. The locker and fee vault are optional shortcuts — the
   * locker is discoverable on-chain from the factory, and the vault is shown,
   * never called.
   */
  launchpadFactory: raw.VITE_LAUNCHPAD_FACTORY ?? '',
  locker: raw.VITE_LOCKER ?? '',
  feeVault: raw.VITE_FEE_VAULT ?? '',
  /**
   * `GraduationHelper` — optional periphery. When set, a completing buy whose
   * simulation reverts on the pool's price (someone primed it) is offered as an
   * atomic "fix the pool and buy" through the helper instead of "try later".
   */
  graduationHelper: raw.VITE_GRADUATION_HELPER ?? '',

  /*
   * Reown (WalletConnect) project id — https://dashboard.reown.com. Required:
   * AppKit is the whole connect surface and refuses to construct without one.
   */
  reownProjectId: required('VITE_REOWN_PROJECT_ID', raw.VITE_REOWN_PROJECT_ID),

  isDev: raw.DEV,
} as const

if (!Number.isInteger(env.chainId) || env.chainId <= 0) {
  throw new Error(`FATAL: VITE_CHAIN_ID must be a positive integer, got "${raw.VITE_CHAIN_ID}"`)
}
