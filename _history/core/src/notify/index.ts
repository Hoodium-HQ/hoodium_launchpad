/**
 * Alert delivery.
 *
 * Barrel for `@hoodium/core/notify`. Consumers import from the subpath, never
 * from a file inside it — that keeps the package's surface a decision rather
 * than an accident of file layout.
 */
export * from './notifier.js'
export * from './telegram.js'
