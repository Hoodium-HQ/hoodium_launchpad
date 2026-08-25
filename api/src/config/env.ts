/**
 * Environment — validated once at boot, fail fast.
 *
 * Nothing environment-identifying has a default that could silently point at the
 * wrong place: RPC_URL and MONGO_URI are required. The factory address is the
 * one deliberate exception — the contracts are not deployed yet, so an empty or
 * zero address means "idle": the indexer does nothing and the API serves empty
 * lists rather than crashing the deploy.
 */
import { z } from 'zod'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'no', 'off', ''].includes(v.trim().toLowerCase())))

const optionalAddress = z
  .string()
  .trim()
  .default('')
  .transform((s, ctx) => {
    if (s === '' || s.toLowerCase() === ZERO_ADDRESS) return null
    if (!ADDRESS_RE.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a 20-byte hex address' })
      return z.NEVER
    }
    return s.toLowerCase()
  })

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  )

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: bool.default(false),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_DB_NAME: z.string().default('hoodium_launchpad'),

  RPC_URL: z.string().url('RPC_URL must be a URL'),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),

  LAUNCHPAD_FACTORY: optionalAddress,
  USDG_ADDRESS: optionalAddress,
  USDG_DECIMALS: z.coerce.number().int().min(0).max(36).default(6),
  TOKEN_DECIMALS: z.coerce.number().int().min(0).max(36).default(18),

  INDEXER_ENABLED: bool.default(true),
  INDEXER_POLL_MS: z.coerce.number().int().min(250).default(4000),
  INDEXER_START_BLOCK: z.coerce.number().int().min(0).default(0),
  GETLOGS_MAX_RANGE: z.coerce.number().int().min(1).max(100_000).default(2000),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(32),
  INDEXER_REORG_BUFFER_BLOCKS: z.coerce.number().int().min(1).default(64),
  /** How often the rolling 24h/7d aggregates are refreshed, in ms. */
  STATS_REFRESH_MS: z.coerce.number().int().min(1000).default(30_000),

  PINATA_JWT: z
    .string()
    .optional()
    .transform((s) => (s && s.trim().length > 0 ? s.trim() : undefined)),
  PINATA_API_URL: z.string().url().default('https://api.pinata.cloud'),
  IPFS_GATEWAY_URL: z.string().url().default('https://gateway.pinata.cloud'),

  CORS_ORIGINS: csv.transform((list) => (list.length > 0 ? list : ['https://launchpad.hoodium.app'])),
  APP_ORIGIN: z.string().url().default('https://launchpad.hoodium.app'),
})

export type Env = z.infer<typeof envSchema>

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid environment:\n  ${issues.join('\n  ')}`)
    this.name = 'EnvError'
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return parsed.data
}

export function factoryConfigured(env: Env): env is Env & { LAUNCHPAD_FACTORY: string } {
  return env.LAUNCHPAD_FACTORY !== null
}
