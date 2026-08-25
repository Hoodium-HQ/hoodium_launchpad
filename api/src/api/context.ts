import { z } from 'zod'
import type { ChainClient } from '../chain/client.js'
import type { Env } from '../config/env.js'
import type { IndexerStatus } from '../indexer/indexer.js'
import { loadLaunchTerms } from '../services/terms.js'
import type { LaunchTerms } from '../types.js'

export interface AppContext {
  env: Env
  chain: ChainClient
  indexerStatus: () => IndexerStatus
  startedAt: number
}

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .transform((s) => s.toLowerCase())

export const pageSchema = (maxLimit: number, defaultLimit: number) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
  })

export function terms(ctx: AppContext): Promise<LaunchTerms | null> {
  return loadLaunchTerms(ctx.chain, ctx.env.LAUNCHPAD_FACTORY, ctx.env.CHAIN_ID)
}

/** Refused rather than stripped: a stripped link leaves a message that reads as if it said something it did not. */
export const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|me|gg|co|app|link|fun|to)\b)/i

export const handleSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/^@/, ''))
  .refine((s) => s.length === 0 || /^[A-Za-z0-9_]{1,64}$/.test(s), 'letters, numbers and underscores only')
  .transform((s) => (s.length > 0 ? s : null))
  .nullable()

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
