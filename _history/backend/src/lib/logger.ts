/**
 * Structured logging — T1.4 / AL-N3 / AL-N7.
 *
 * Every execution decision is logged structurally with inputs, outcome and reason
 * (AL-N7), and no credential ever reaches output (AL-N3). The scrubbing runs as a
 * pino `logMethod` hook so it applies to *every* call site, including ones written
 * later by someone who never read this file.
 */
import pino, { type Logger, type LoggerOptions } from 'pino'
import { scrub } from './redact.js'

let root: Logger | null = null

export function createLogger(opts: { level?: string; pretty?: boolean; destination?: pino.DestinationStream } = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    base: { service: 'hoodium' },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => scrub(a)) as Parameters<typeof method>
        return method.apply(this, scrubbed)
      },
    },
    // Belt-and-braces path redaction on top of the value-shape scrubbing.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.privateKey',
        '*.mnemonic',
        '*.seedPhrase',
      ],
      censor: '[REDACTED]',
    },
  }

  if (opts.destination) return pino(options, opts.destination)
  if (opts.pretty) {
    return pino({
      ...options,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
    })
  }
  return pino(options)
}

/** Process-wide logger. Initialised in `initLogger` during boot. */
export function logger(): Logger {
  if (!root) root = createLogger()
  return root
}

export function initLogger(cfg: { level: string; pretty: boolean }): Logger {
  root = createLogger({ level: cfg.level, pretty: cfg.pretty })
  return root
}

/** Child logger for a long-lived component (indexer, monitor, notifier, api). */
export function componentLogger(component: string): Logger {
  return logger().child({ component })
}
