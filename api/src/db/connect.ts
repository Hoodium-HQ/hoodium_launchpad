import mongoose from 'mongoose'
import { componentLogger } from '../lib/logger.js'
import { models } from './models.js'

const log = componentLogger('db')

export async function connectDb(uri: string, dbName: string): Promise<void> {
  mongoose.set('strictQuery', true)
  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 20,
  })
  log.info({ db: mongoose.connection.db?.databaseName }, 'mongo connected')
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect()
}

/** Idempotent; every boot calls it, so the constraints exist wherever this runs. */
export async function ensureIndexes(): Promise<void> {
  for (const model of models) await model.syncIndexes()
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1
}
