/**
 * Sign-In With Ethereum — EIP-4361. WA-1.6, WA-1.7, WA-1.9.
 *
 * The message is **composed by the server** and stored verbatim; verification
 * compares the signature against the stored bytes rather than against a message
 * rebuilt from client input. That removes the whole class of parsing bugs, and
 * more importantly it makes domain binding real: a client cannot assert a domain
 * because it never supplies one.
 *
 * Signature checking goes through viem's `verifyMessage` on a public client,
 * which tries EOA recovery first and falls back to an on-chain ERC-1271
 * `isValidSignature` call for smart-contract accounts (WA-1.9).
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { AuthChallengeModel, type AuthChallengeDoc } from '../db/models/auth.js'
import type { ChainClient } from '../chain/rpc.js'
import type { Env } from '../config/env.js'

/** How long a user has to sign after asking. Long enough for a hardware wallet. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

const STATEMENT =
  'Sign in to Hoodium to view your positions and alerts. ' +
  'This signature proves you control this address. It costs no gas, authorises no transaction, ' +
  'and gives Hoodium no ability to move your funds.'

export interface IssuedChallenge {
  nonce: string
  message: string
  expiresAt: Date
}

/** EIP-4361 nonce: at least 8 alphanumeric characters. 16 bytes of entropy here. */
function newNonce(): string {
  return randomBytes(16).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22)
}

/** Exactly the EIP-4361 ABNF field order. Verifiers and wallets both rely on it. */
export function buildSiweMessage(input: {
  domain: string
  address: string
  statement: string
  uri: string
  chainId: number
  nonce: string
  issuedAt: Date
  expiresAt: Date
}): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    '',
    input.statement,
    '',
    `URI: ${input.uri}`,
    'Version: 1',
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
  ].join('\n')
}

/**
 * Addresses are checksummed inside the message because EIP-4361 requires it, but
 * stored lowercase because every index in this codebase is lowercase.
 */
export async function issueChallenge(
  env: Env,
  walletAddress: string,
  checksumAddress: string,
): Promise<IssuedChallenge> {
  const origin = new URL(env.APP_ORIGIN)
  const nonce = newNonce()
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)

  const message = buildSiweMessage({
    domain: origin.host,
    address: checksumAddress,
    statement: STATEMENT,
    uri: env.APP_ORIGIN,
    chainId: env.CHAIN_ID,
    nonce,
    issuedAt,
    expiresAt,
  })

  await AuthChallengeModel.create({
    nonce,
    address: walletAddress.toLowerCase(),
    chainId: env.CHAIN_ID,
    domain: origin.host,
    uri: env.APP_ORIGIN,
    message,
    issuedAt,
    expiresAt,
  })

  return { nonce, message, expiresAt }
}

export class ChallengeError extends Error {
  constructor(readonly reason: 'unknown' | 'expired' | 'consumed' | 'bad_signature') {
    super(`sign-in challenge rejected: ${reason}`)
    this.name = 'ChallengeError'
  }
}

/**
 * Redeem a challenge. The consume is a filtered `findOneAndUpdate`, so two
 * concurrent requests carrying the same nonce cannot both win — the same
 * single-winner pattern the execution state machine uses (001/design section 3).
 * WA-1.7's "single-use" is enforced by the database, not by a read-then-write.
 */
export async function consumeChallenge(nonce: string): Promise<AuthChallengeDoc> {
  const now = new Date()
  const claimed = await AuthChallengeModel.findOneAndUpdate(
    { nonce, consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } },
    { returnDocument: 'after' },
  )

  if (!claimed) {
    // Distinguish the cases for the log, but never for the client — telling an
    // attacker which nonces exist is free reconnaissance.
    const existing = await AuthChallengeModel.findOne({ nonce }).lean()
    if (!existing) throw new ChallengeError('unknown')
    if (existing.consumedAt) throw new ChallengeError('consumed')
    throw new ChallengeError('expired')
  }

  return claimed
}

/**
 * Verify a signature over the stored message.
 *
 * @throws ChallengeError('bad_signature') — the challenge is already consumed at
 * this point, so a failed attempt burns the nonce. That is deliberate: it makes
 * signature guessing cost a round trip per attempt.
 */
export async function verifyChallengeSignature(
  chain: ChainClient,
  challenge: AuthChallengeDoc,
  signature: string,
): Promise<void> {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new ChallengeError('bad_signature')

  const valid = await chain.call('verifyMessage', (client) =>
    client.verifyMessage({
      address: challenge.address as Address,
      message: challenge.message,
      signature: signature as Hex,
    }),
  )

  if (!valid) throw new ChallengeError('bad_signature')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}
