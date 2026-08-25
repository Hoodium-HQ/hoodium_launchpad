/**
 * Configuration — spec 004 section 9.
 *
 * One schema, validated at boot, **no defaults for anything environment-identifying**.
 * A default is how production gets misidentified as staging.
 *
 * `.env` files are loaded only when APP_ENV=local. Staging and production read from
 * their platform's secret store (004 section 9).
 */
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'
import { Decimal } from '../lib/money.js'

/**
 * Robinhood Chain ids are supplied by configuration rather than hard-coded because
 * 004 section 10 open question 1 ("does the testnet still run, and what is its chain id?")
 * is unresolved. They are required in every environment so the mainnet guard
 * (004 section 3) always has both sides of the comparison — a guard that cannot name the
 * mainnet id cannot prove staging is not pointed at it.
 */
const ChainIds = z.object({
  ROBINHOOD_MAINNET_CHAIN_ID: z.coerce.number().int().positive(),
  ROBINHOOD_TESTNET_CHAIN_ID: z.coerce.number().int().positive(),
})

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

/**
 * A configured value that will take part in money arithmetic. It stays a string
 * all the way to `new Decimal(...)`: AL-N4 rejects `Number` for money, and
 * `z.coerce.number()` here would launder a double straight into the cost guard.
 */
const decimalString = (fallback: string, opts: { max?: string } = {}) =>
  z
    .string()
    .default(fallback)
    .refine((s) => {
      try {
        const d = new Decimal(s)
        return d.isFinite() && d.gte(0) && (opts.max === undefined || d.lte(opts.max))
      } catch {
        return false
      }
    }, `must be a non-negative decimal${opts.max ? ` no greater than ${opts.max}` : ''}`)

const EnvSchema = z
  .object({
    // ── Identity (004 section 9: no defaults) ────────────────────────────────────────
    APP_ENV: z.enum(['local', 'staging', 'production']),
    CHAIN_ID: z.coerce.number().int().positive(),

    // ── Chain access (001 design section 5) ──────────────────────────────────────────
    RPC_PRIMARY: z.string().url(),
    RPC_FALLBACK: z.string().url(),
    RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

    /**
     * Start a local node when the configured loopback RPC has nothing on it
     * (dev/local-chain.ts). On by default when absent, and only ever consulted
     * under `APP_ENV=local`.
     *
     * Deliberately has no `.default(true)`: an absent value has to stay
     * distinguishable from a set one, so the refinement below can refuse
     * `LOCAL_CHAIN_AUTOSTART=true` in a deployed environment instead of shrugging
     * at it. A deployed process whose RPC is down has an incident, not a chore.
     */
    LOCAL_CHAIN_AUTOSTART: boolish.optional(),

    // ── Storage ───────────────────────────────────────────────────────────────
    MONGO_URI: z.string().min(1),
    MONGO_DB_NAME: z.string().min(1).default('hoodium'),

    // ── Custody (004 section 4) ──────────────────────────────────────────────────────
    KMS_KEY_ID: z.string().optional(),

    // ── Operations ────────────────────────────────────────────────────────────
    KILL_SWITCH: boolish.default(false),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SENTRY_DSN: z.string().url().optional(),

    // ── API ───────────────────────────────────────────────────────────────────
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

    /**
     * The origin users sign in against. It becomes the `domain` and `uri` inside
     * the EIP-4361 message (WA-1.7), so it is a security parameter, not cosmetic:
     * a wrong value here means signatures issued for another site would verify.
     * No default, for the same reason APP_ENV has none.
     */
    APP_ORIGIN: z.string().url(),
    SESSION_TTL_DAYS: z.coerce.number().positive().max(7).default(7),

    // ── Protocol addresses (001 design section 4) ────────────────────────────────────
    QUOTE_TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    QUOTE_TOKEN_SYMBOL: z.string().default('USDG'),
    QUOTE_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(36).default(6),
    POSITION_MANAGER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    UNISWAP_V3_FACTORY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

    /**
     * Launchpad factory (spec 002). Optional: Auto LP is the wedge and ships
     * first (specs/README.md), so the backend must run perfectly well with no
     * launchpad deployed. Absent means launchpad indexing is simply off.
     */
    LAUNCHPAD_FACTORY_ADDRESS: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),

    // ── Launchpad metadata pinning (LP-1.7) ───────────────────────────────────

    /**
     * Pinata credential for pinning launch metadata and artwork.
     *
     * Optional, and absent means the pinning route refuses with 503 rather than
     * pretending: the launch form falls back to accepting an IPFS URI the creator
     * pinned themselves. A silent no-op here would produce tokens whose on-chain
     * `metadataURI` points at nothing, which is worse than no upload button.
     */
    PINATA_JWT: z.string().optional(),
    PINATA_API_URL: z.string().url().default('https://api.pinata.cloud'),

    /**
     * Where indexed metadata and artwork are read back from.
     *
     * Read server-side only. The browser never contacts a gateway directly —
     * WA-N2's `img-src` admits our origin alone, and hot-linking would hand the
     * gateway a log of who viewed which token (see market/token-images.ts).
     */
    IPFS_GATEWAY_URL: z.string().url().default('https://gateway.pinata.cloud'),

    // ── Market / pool discovery (003 R7) ──────────────────────────────────────

    /**
     * Uniswap's hosted GraphQL gateway, and the chain slug it knows this network
     * by. The gateway already indexes Robinhood Chain, so pool TVL and 24h volume
     * are read from it rather than reconstructed by indexing every `Swap` on
     * every pool — weeks of work for numbers that already exist.
     *
     * Optional, and absent means the market surface is simply off: it is a
     * third-party read, and nothing else in this process may depend on it.
     */
    UNISWAP_GATEWAY_URL: z.string().url().default('https://interface.gateway.uniswap.org/v1/graphql'),
    UNISWAP_CHAIN_SLUG: z.string().optional(),

    /**
     * RPC for market reads specifically.
     *
     * `RPC_PRIMARY` is the chain this process *transacts* on, and the mainnet
     * guard pins it. The market surface describes whichever chain
     * `UNISWAP_CHAIN_SLUG` names, which during development is a different chain
     * entirely — reading pool state over the local node then produces nonsense,
     * because those pools do not exist there.
     *
     * Read-only and never signed against, so it is deliberately outside the
     * guard. Unset means market reads use `RPC_PRIMARY`, which is correct once
     * both refer to the same chain.
     */
    MARKET_RPC_URL: z.string().url().optional(),
    /** Uniswap v4 StateView — typed pool-state reads without raw `extsload`. */
    UNISWAP_V4_STATE_VIEW: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),

    /**
     * Uniswap v4 singleton. v4 has no per-pool contract: state is read out of the
     * PoolManager with `extsload`, keyed by poolId.
     *
     * Needed because the gateway never serves 24h volume for v4 pools on this
     * chain, so their fee-per-day is computed from on-chain fee growth instead.
     * Without it every v4 pool ranks last on a null APR — and v4 is what the
     * positions on this chain actually use.
     */
    UNISWAP_V4_POOL_MANAGER: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    UNISWAP_V4_POSITION_MANAGER: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),

    /** Symbols treated as the stable side when grouping and filtering pools. */
    MARKET_QUOTE_SYMBOLS: z
      .string()
      .default('USDG,USDC,USDT,DAI')
      .transform((s) => s.split(',').map((q) => q.trim().toUpperCase()).filter(Boolean)),
    MARKET_MIN_TVL_USD: z.coerce.number().nonnegative().default(10_000),
    /** Serve straight from cache below this age. */
    MARKET_CACHE_TTL_MS: z.coerce.number().int().positive().default(2 * 60 * 1000),
    /** Above the TTL but below this, serve stale and refresh in the background. */
    MARKET_CACHE_STALE_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),

    // ── Indexer (001 design section 5) ───────────────────────────────────────────────
    INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
    INDEXER_CONFIRMATIONS: z.coerce.number().int().positive().default(32),
    INDEXER_REORG_BUFFER_BLOCKS: z.coerce.number().int().positive().default(64),
    INDEXER_LOG_RANGE: z.coerce.number().int().positive().default(2_000),
    INDEXER_POLL_MS: z.coerce.number().int().positive().default(6_000),

    // ── Monitor / alert thresholds (AL-2.1, AL-3.1, AL-5.3) ───────────────────
    MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    EXPOSURE_THRESHOLD_PCT: z.coerce.number().min(0).max(100).default(68),
    EMERGENCY_THRESHOLD_PCT: z.coerce.number().min(0).max(100).default(85),
    RANGE_PROXIMITY_PCT: z.coerce.number().min(0).max(100).default(10),
    ALERT_DEDUPE_HOURS: z.coerce.number().positive().default(6),

    // ── Rebalance evaluation (R4, R5 · design section 6) ─────────────────────────────

    /**
     * AL-4.1's third condition. Off means the Evaluator still decides and still
     * records — a wallet only ever reaches the executor with this on *and* a
     * session key granted (AL-1.3), neither of which exists in this phase.
     */
    AUTOMATION_ENABLED: boolish.default(false),
    /**
     * AL-5.5. Cannot currently be turned off; see the refinement below.
     */
    SHADOW_MODE: boolish.default(true),

    /** AL-5.3 — refuse to rebalance a position rebalanced this recently. */
    REBALANCE_COOLDOWN_HOURS: z.coerce.number().positive().default(4),
    /** How far below price the replacement range reaches, in percent. */
    REBALANCE_DEPTH_PCT: z.coerce.number().gt(0).lt(100).default(15),
    /**
     * Ceiling on the base-token share a replacement may open with. Above zero the
     * range is placed one tick-spacing step above price so it earns from the
     * first block, which costs some starting exposure; when the pool's spacing is
     * too coarse to stay under this, the plan falls back to opening out of range.
     * Zero disables the offset entirely.
     */
    REBALANCE_MAX_BASE_PCT: z.coerce.number().min(0).max(50).default(16),
    /** Slippage tolerance the exit swap would be quoted at. */
    REBALANCE_SLIPPAGE_PCT: z.coerce.number().min(0).max(50).default(2.5),
    /**
     * Flat gas estimate for one full rebalance (decrease + collect + burn + swap
     * + mint), in quote-token units.
     *
     * A configured constant rather than a computed figure because converting gas
     * to quote needs a native-token price, and there is no oracle here — AL-2.2
     * forbids estimating from USD values, and inventing a price feed to satisfy a
     * cost guard would be a worse lie than a number an operator can measure and
     * set. It is recorded on every decision, so it is auditable after the fact.
     */
    REBALANCE_GAS_COST_QUOTE: decimalString('0.50'),
    /**
     * `P(further adverse move)` from design section 6. design section 9 open question 3: "fixed
     * constant in v1, or derived from realized volatility? Start with a constant;
     * revisit once shadow data exists."
     */
    ADVERSE_MOVE_PROBABILITY: decimalString('0.35', { max: '1' }),

    // ── Telegram alert delivery (AL-3.5, AL-3.8) ──────────────────────────────

    /**
     * Bot credential from @BotFather. Unlike the VAPID keypair this replaced,
     * there is no public half: nothing here may ever reach the browser, and the
     * logger denylist covers it by name (lib/redact.ts).
     */
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    /** The bot's `@name`, without the `@` — it forms the `t.me` deep link. */
    TELEGRAM_BOT_USERNAME: z
      .string()
      .regex(/^[A-Za-z0-9_]{5,32}$/, 'a bot username is 5-32 characters of [A-Za-z0-9_], without the @')
      .optional(),
    /**
     * Agreed with Telegram at `setWebhook` and presented back on every update.
     * Without it the webhook is the one public write in the API, so it refuses
     * to serve at all when this is unset.
     */
    TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),
  })
  .merge(ChainIds)
  .superRefine((env, ctx) => {
    // 004 section 4 — production keys are KMS-wrapped, never plaintext outside the process.
    if (env.APP_ENV === 'production' && !env.KMS_KEY_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KMS_KEY_ID'],
        message: 'KMS_KEY_ID is required when APP_ENV=production',
      })
    }
    // Telegram is the only external delivery channel (AL-3.5). Deployed
    // environments must be configured or alerts silently degrade to in-app only.
    const deployed = env.APP_ENV === 'staging' || env.APP_ENV === 'production'
    if (deployed && !(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_BOT_TOKEN'],
        message:
          'TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME are required when APP_ENV is staging or production',
      })
    }
    /*
     * A configured bot with no webhook secret cannot receive `/start`, so linking
     * is impossible and every user is stuck at "waiting for Telegram". Caught at
     * boot rather than discovered by the first person who tries to connect.
     */
    if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message: 'TELEGRAM_WEBHOOK_SECRET is required whenever TELEGRAM_BOT_TOKEN is set — the link flow needs it',
      })
    }
    /*
     * There is no Executor. design section 1 splits deciding from executing, and only the
     * deciding half is built (T4.x); T5.7 is what broadcasts. Booting with
     * SHADOW_MODE=false would leave a system that believes it is executing and
     * silently is not — the failure mode where a user goes to sleep trusting an
     * automation that was never wired up. Refuse instead.
     *
     * AL-5.4 independently requires a 7-day shadow period before any first
     * execution, so this is not the only gate, just the earliest one.
     */
    if (!env.SHADOW_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SHADOW_MODE'],
        message:
          'SHADOW_MODE=false requires the Executor (Phase 5, T5.7), which is not implemented. ' +
          'The Evaluator would approve rebalances that nothing broadcasts.',
      })
    }
    if (env.EMERGENCY_THRESHOLD_PCT < env.EXPOSURE_THRESHOLD_PCT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMERGENCY_THRESHOLD_PCT'],
        message: 'EMERGENCY_THRESHOLD_PCT must be ≥ EXPOSURE_THRESHOLD_PCT (AL-5.3)',
      })
    }
    /*
     * dev/local-chain.ts already refuses to spawn anything outside `local`, so
     * this cannot fire in practice. It exists so the misconfiguration is named
     * at boot rather than sitting in a deployed environment's variable list
     * looking like it does something.
     */
    if (env.LOCAL_CHAIN_AUTOSTART === true && env.APP_ENV !== 'local') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOCAL_CHAIN_AUTOSTART'],
        message: `LOCAL_CHAIN_AUTOSTART is a local-only development switch; APP_ENV is ${env.APP_ENV}`,
      })
    }
    if (env.ROBINHOOD_TESTNET_CHAIN_ID === env.ROBINHOOD_MAINNET_CHAIN_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ROBINHOOD_TESTNET_CHAIN_ID'],
        message: 'testnet and mainnet chain ids must differ — otherwise the mainnet guard cannot tell them apart',
      })
    }
  })

export type AppEnv = 'local' | 'staging' | 'production'
export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

/**
 * Parse and validate configuration. Throws with the full list of problems — a
 * process that boots half-configured is the failure mode 004 section 3 exists to prevent.
 */
export function loadEnv(source?: NodeJS.ProcessEnv): Env {
  const fromProcess = source === undefined

  // Only `local` reads a .env file (004 section 9). At this point APP_ENV may itself
  // still be in the file, so load when it is absent too — dotenv does not
  // override variables that are already set, so an explicitly configured
  // process is unaffected.
  let loadedDotenv = false
  if (fromProcess && (process.env.APP_ENV === undefined || process.env.APP_ENV === 'local')) {
    loadDotenv()
    loadedDotenv = true
  }

  const parsed = EnvSchema.safeParse(fromProcess ? process.env : source)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`FATAL: invalid configuration\n${problems}`)
  }

  // A .env that declares itself staging or production is the copy-pasted-config
  // accident 004 section 3 is about, one layer earlier. Refuse it.
  if (loadedDotenv && parsed.data.APP_ENV !== 'local') {
    throw new Error(
      `FATAL: a .env file set APP_ENV=${parsed.data.APP_ENV}. ` +
        '.env files exist only for local (004 section 9); staging and production read from their secret store.',
    )
  }

  return parsed.data
}

/** Load once and memoise. Every module reads config through this. */
export function env(): Env {
  if (!cached) cached = loadEnv()
  return cached
}

/** Test seam — lets a suite install a fixture config without touching process.env. */
export function setEnvForTesting(value: Env | null): void {
  cached = value
}

export function isDeployed(e: Env): boolean {
  return e.APP_ENV === 'staging' || e.APP_ENV === 'production'
}
