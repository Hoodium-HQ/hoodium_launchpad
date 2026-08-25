/**
 * Shared field definitions. Addresses are stored lowercase everywhere so that
 * `{ walletAddress: 1 }` index lookups never miss on checksum casing.
 */
import { Schema } from 'mongoose'

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const HASH_RE = /^0x[0-9a-f]{64}$/

export function address(opts: { required?: boolean; index?: boolean } = {}) {
  return {
    type: String,
    required: opts.required ?? false,
    ...(opts.index ? { index: true } : {}),
    lowercase: true,
    trim: true,
    validate: {
      validator: (v: string | null) => v == null || ADDRESS_RE.test(v.toLowerCase()),
      message: (p: { value: string }) => `"${p.value}" is not a 20-byte hex address`,
    },
  } as const
}

export function hash32(opts: { required?: boolean } = {}) {
  return {
    type: String,
    required: opts.required ?? false,
    lowercase: true,
    trim: true,
    validate: {
      validator: (v: string | null) => v == null || HASH_RE.test(v.toLowerCase()),
      message: (p: { value: string }) => `"${p.value}" is not a 32-byte hex hash`,
    },
  } as const
}

/** Block numbers exceed 2^53 on no chain we will ever see, but they are integers. */
export function blockNumber(opts: { required?: boolean } = {}) {
  return {
    type: Number,
    required: opts.required ?? false,
    min: 0,
    validate: {
      validator: (v: number | null) => v == null || Number.isInteger(v),
      message: 'block numbers must be integers',
    },
  } as const
}

export const chainId = { type: Number, required: true } as const

/** Token metadata embedded on positions — denormalised, it never changes. */
export const TokenSchema = new Schema(
  {
    address: address({ required: true }),
    symbol: { type: String, required: true },
    decimals: { type: Number, required: true, min: 0, max: 36 },
  },
  { _id: false },
)
