import pino, { type Logger, type LoggerOptions } from 'pino'

let root: Logger | null = null

export function initLogger(opts: { level: string; pretty: boolean }): Logger {
  const options: LoggerOptions = {
    level: opts.level,
    base: { service: 'launchpad-api' },
    redact: { paths: ['req.headers.authorization', '*.jwt', '*.PINATA_JWT'], censor: '[redacted]' },
  }
  if (opts.pretty) {
    options.transport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
  }
  root = pino(options)
  return root
}

export function rootLogger(): Logger {
  if (!root) root = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'launchpad-api' } })
  return root
}

export function componentLogger(component: string): Logger {
  return rootLogger().child({ component })
}
