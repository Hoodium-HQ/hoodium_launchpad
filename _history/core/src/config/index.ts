/**
 * Configuration and the mainnet guard (004 section 3, section 9).
 *
 * Barrel for `@hoodium/core/config`. Consumers import from the subpath, never
 * from a file inside it — that keeps the package's surface a decision rather
 * than an accident of file layout.
 */
export * from './chain-guard.js'
export * from './env.js'
