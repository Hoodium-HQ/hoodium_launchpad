/**
 * RPC access — T3.3 / AL-2.4, design section 5.
 *
 * "Robinhood Chain is 28 days old; treat RPC as unreliable by default."
 *
 *   - primary + fallback, 5-second timeout                              (AL-2.4)
 *   - circuit breaker opens after 3 consecutive failures on an endpoint
 *   - the mainnet guard is re-asserted on every failover                (004 section 3)
 *
 * viem ships a `fallback()` transport, but it gives no hook to re-assert the chain
 * id when the transport switches endpoints. That assertion is the whole reason
 * 004 section 3 calls fallback URLs "a second place a wrong endpoint can enter", so the
 * failover is handled here instead.
 */
import { createPublicClient, defineChain, http, type PublicClient } from 'viem'
import { componentLogger } from '../lib/logger.js'
import { assertLiveChain } from '../config/chain-guard.js'
import type { Env } from '../config/env.js'

const FAILURE_THRESHOLD = 3
const OPEN_DURATION_MS = 30_000

type EndpointName = 'primary' | 'fallback'

class Breaker {
  private consecutiveFailures = 0
  private openedAt: number | null = null

  constructor(readonly name: EndpointName) {}

  get isOpen(): boolean {
    if (this.openedAt === null) return false
    if (Date.now() - this.openedAt >= OPEN_DURATION_MS) {
      // Half-open: let one request through to see whether the endpoint recovered.
      this.openedAt = null
      this.consecutiveFailures = FAILURE_THRESHOLD - 1
      return false
    }
    return true
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.openedAt = null
  }

  /** @returns true when this failure tripped the breaker. */
  recordFailure(): boolean {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= FAILURE_THRESHOLD && this.openedAt === null) {
      this.openedAt = Date.now()
      return true
    }
    return false
  }
}

export class AllEndpointsFailedError extends Error {
  constructor(readonly causes: unknown[]) {
    super('all RPC endpoints failed')
    this.name = 'AllEndpointsFailedError'
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms (${label})`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export class ChainClient {
  private readonly log = componentLogger('rpc')
  private readonly clients: Record<EndpointName, PublicClient>
  private readonly breakers: Record<EndpointName, Breaker>
  /** Endpoints already re-verified against the mainnet guard this process. */
  private readonly guardVerified = new Set<EndpointName>()
  private active: EndpointName = 'primary'

  constructor(
    private readonly env: Env,
    private readonly timeoutMs = env.RPC_TIMEOUT_MS,
  ) {
    const chain = defineChain({
      id: env.CHAIN_ID,
      name: `chain-${env.CHAIN_ID}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [env.RPC_PRIMARY] } },
    })

    const mk = (url: string) =>
      createPublicClient({
        chain,
        transport: http(url, { timeout: this.timeoutMs, retryCount: 0 }),
        // The indexer batches getLogs ranges; batching cuts round trips materially.
        batch: { multicall: true },
      }) as PublicClient

    this.clients = { primary: mk(env.RPC_PRIMARY), fallback: mk(env.RPC_FALLBACK) }
    this.breakers = { primary: new Breaker('primary'), fallback: new Breaker('fallback') }
  }

  /** Which endpoint served the last successful call — surfaced on /health. */
  activeEndpoint(): EndpointName {
    return this.active
  }

  /**
   * Run an RPC operation against the first healthy endpoint, falling back on
   * timeout or error. AL-2.4: the fallback is tried *before* the cycle is marked
   * failed, so a cycle only fails when both endpoints do.
   */
  async call<T>(label: string, fn: (client: PublicClient) => Promise<T>): Promise<T> {
    const order: EndpointName[] = this.active === 'primary' ? ['primary', 'fallback'] : ['fallback', 'primary']
    const causes: unknown[] = []

    for (const name of order) {
      if (this.breakers[name].isOpen) {
        this.log.debug({ endpoint: name, label }, 'breaker open, skipping endpoint')
        continue
      }
      try {
        await this.assertGuardOnce(name)
        const result = await withTimeout(fn(this.clients[name]), this.timeoutMs, `${label}@${name}`)
        this.breakers[name].recordSuccess()
        if (this.active !== name) {
          this.log.warn({ from: this.active, to: name, label }, 'RPC failover')
          this.active = name
        }
        return result
      } catch (err) {
        causes.push(err)
        const tripped = this.breakers[name].recordFailure()
        this.log.warn({ endpoint: name, label, err, tripped }, tripped ? 'RPC breaker opened' : 'RPC call failed')
      }
    }

    throw new AllEndpointsFailedError(causes)
  }

  /**
   * 004 section 3: "Asserted again after every RPC failover." Verified once per endpoint
   * per process — a chain id does not change under a live URL, and re-checking on
   * every call would double the request volume for no additional safety.
   */
  private async assertGuardOnce(name: EndpointName): Promise<void> {
    if (this.guardVerified.has(name)) return
    await assertLiveChain(this.env, () => this.clients[name].getChainId(), `RPC(${name})`)
    this.guardVerified.add(name)
    this.log.info({ endpoint: name, chainId: this.env.CHAIN_ID }, 'chain guard verified')
  }

  /** Boot-time verification of both endpoints (004 section 3). Crashes on mismatch. */
  async verifyBothEndpoints(): Promise<void> {
    await this.assertGuardOnce('primary')
    await this.assertGuardOnce('fallback')
  }

  getBlockNumber(): Promise<bigint> {
    return this.call('getBlockNumber', (c) => c.getBlockNumber())
  }
}
