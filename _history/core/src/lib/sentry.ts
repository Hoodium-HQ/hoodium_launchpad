/**
 * Sentry — T1.5.
 *
 * Wired through the same scrubber as the logger (AL-N3): an exception message can
 * carry a credential just as easily as a log line, and Sentry is a third party.
 */
import * as Sentry from '@sentry/node'
import { scrub, scrubString } from './redact.js'
import { componentLogger } from './logger.js'

export function initSentry(cfg: { dsn?: string; environment: string; release?: string }): void {
  const log = componentLogger('sentry')
  if (!cfg.dsn) {
    log.info('SENTRY_DSN not set — error reporting disabled')
    return
  }

  Sentry.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    release: cfg.release,
    // Money-moving code paths are low-volume; sample everything that errors.
    tracesSampleRate: cfg.environment === 'production' ? 0.1 : 0,
    beforeSend(event) {
      if (event.message) event.message = scrubString(event.message)
      if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>
      if (event.contexts) event.contexts = scrub(event.contexts) as typeof event.contexts
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = scrubString(ex.value)
      }
      if (event.request?.headers) {
        delete event.request.headers.authorization
        delete event.request.headers.cookie
      }
      return event
    },
    beforeBreadcrumb(crumb) {
      if (crumb.message) crumb.message = scrubString(crumb.message)
      if (crumb.data) crumb.data = scrub(crumb.data) as Record<string, unknown>
      return crumb
    },
  })

  log.info({ environment: cfg.environment }, 'sentry initialised')
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(err, context ? { extra: scrub(context) as Record<string, unknown> } : undefined)
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  try {
    await Sentry.flush(timeoutMs)
  } catch {
    // Shutdown path — a failed flush must not block process exit.
  }
}
