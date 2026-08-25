/**
 * On-chain position reads.
 *
 * Barrel for `@hoodium/core/positions`. Consumers import from the subpath, never
 * from a file inside it — that keeps the package's surface a decision rather
 * than an accident of file layout.
 */
export * from './discovery.js'
export * from './feemath.js'
export * from './fee-reader.js'
export * from './accounting.js'
export * from './fees.js'
export * from './performance.js'
