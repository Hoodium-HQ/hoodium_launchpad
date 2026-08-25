/**
 * MongoDB connection — T1.1, T1.2.
 *
 * Strict schemas, strict queries: a typo in a field name is a thrown error, not a
 * silently-empty result set. Indexes are synced at boot so the unique constraints
 * that the reorg and dedupe strategies depend on (T1.2) actually exist rather than
 * being assumed.
 */
import mongoose from 'mongoose'
import { componentLogger } from '../lib/logger.js'
import './models/index.js'

export async function connectDb(uri: string, dbName: string): Promise<typeof mongoose> {
  const log = componentLogger('db')

  mongoose.set('strictQuery', true)

  /*
   * `sanitizeFilter` is deliberately NOT enabled.
   *
   * It wraps any filter value that is an object with `$`-prefixed keys in `$eq`,
   * which defeats query-selector injection — and also defeats every intentional
   * operator this codebase depends on: the reorg rewind's `{ blockNumber: { $gt } }`,
   * the alert dedupe window's `{ lastSentAt: { $lte } }`, the session lookup's
   * `{ expiresAt: { $gt } }`. With it on, those silently become cast errors.
   *
   * Injection is closed at the boundary instead: every filter value that comes
   * from a request is parsed by a zod schema first, so it is a validated string or
   * number by the time it reaches a query — never a caller-supplied object.
   */

  mongoose.connection.on('disconnected', () => log.warn('mongo disconnected'))
  mongoose.connection.on('reconnected', () => log.info('mongo reconnected'))
  mongoose.connection.on('error', (err) => log.error({ err }, 'mongo error'))

  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 10_000,
    // Money-moving writes need majority acknowledgement; a write that a failover
    // can roll back is a write we would report to a user as done (AL-7.2).
    writeConcern: { w: 'majority' },
    retryWrites: true,
  })

  log.info({ dbName }, 'mongo connected')
  return mongoose
}

/**
 * Create every declared index, including the unique constraints (T1.2).
 *
 * Deliberately *not* `syncIndexes` — that drops indexes absent from the schema,
 * which on a production cluster is a way to lose an index someone added by hand
 * during an incident.
 */
export async function ensureIndexes(): Promise<void> {
  const log = componentLogger('db')
  for (const model of Object.values(mongoose.models)) {
    await model.createIndexes()
    log.debug({ model: model.modelName }, 'indexes ensured')
  }
  log.info({ models: Object.keys(mongoose.models).length }, 'indexes ensured')
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect()
}
