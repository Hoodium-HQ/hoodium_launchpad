/**
 * `@hoodium/core` — the server-side foundation shared by the Hoodium API
 * (`hoodium_backend`) and the worker (`hoodium_worker`).
 *
 * Everything in here is code both processes need and neither owns: the
 * configuration schema and the mainnet guard, the Mongoose models, the RPC
 * client, alert delivery, and position reads.
 *
 * It lives in one package for one reason above all others. Two processes write
 * the same database, and `004 section 3` calls the mainnet guard "the single
 * most important control in this document" — a second copy of either the
 * schemas or the guard is a second place for them to drift apart, and drift
 * would surface as corrupted data or a process pointed at the wrong chain.
 *
 * Server-only, and deliberately separate from `@hoodium/shared`: that package
 * is consumed by the browser and may not pull mongoose, pino, or dotenv into a
 * bundle.
 *
 * Prefer the subpath imports (`@hoodium/core/db`) over this root barrel; they
 * make each consumer's dependencies legible at a glance.
 */
export * from './config/index.js'
export * from './lib/index.js'
export * from './db/index.js'
export * from './chain/index.js'
export * from './notify/index.js'
export * from './positions/index.js'
export * from './launchpad/index.js'
