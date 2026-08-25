/**
 * One RPC endpoint, one viem public client, a chain-id check at boot.
 *
 * Deliberately smaller than the core package's failover client: this service has
 * a single RPC_URL. viem's transport handles retries and the timeout; what is
 * added here is the chain-id assertion (the wrong endpoint must fail loudly,
 * never index the wrong chain into the right database) and a tiny `call` wrapper
 * that names each call for logs.
 */
import { createPublicClient, defineChain, http, type PublicClient } from 'viem'
import { componentLogger } from '../lib/logger.js'

export class ChainMismatchError extends Error {
  constructor(expected: number, actual: number, url: string) {
    super(`RPC ${url} reports chain ${actual}, expected ${expected}`)
    this.name = 'ChainMismatchError'
  }
}

export interface ChainClientOptions {
  rpcUrl: string
  chainId: number
  timeoutMs: number
}

export class ChainClient {
  readonly client: PublicClient
  readonly chainId: number
  private readonly log = componentLogger('chain')
  private readonly url: string

  constructor(opts: ChainClientOptions) {
    this.chainId = opts.chainId
    this.url = opts.rpcUrl
    const chain = defineChain({
      id: opts.chainId,
      name: `chain-${opts.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    })
    this.client = createPublicClient({
      chain,
      transport: http(opts.rpcUrl, { timeout: opts.timeoutMs, retryCount: 2, retryDelay: 300 }),
    })
  }

  /** Assert the endpoint serves the configured chain. Throws; never warns. */
  async verify(): Promise<void> {
    const actual = await this.client.getChainId()
    if (actual !== this.chainId) throw new ChainMismatchError(this.chainId, actual, this.url)
    this.log.info({ chainId: actual, url: redactUrl(this.url) }, 'rpc verified')
  }

  async call<T>(name: string, fn: (client: PublicClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.client)
    } catch (err) {
      this.log.debug({ err, call: name }, 'rpc call failed')
      throw err
    }
  }

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }
}

/** Strip a key that may be embedded in the path — never log an RPC credential. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? '/…' : ''}`
  } catch {
    return '[invalid url]'
  }
}
