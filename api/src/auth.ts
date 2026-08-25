/**
 * Stateless write authentication.
 *
 * This service has no session store, so writes (token chat, creator link edits)
 * carry an EIP-191 signature over a message that binds the action, the chain,
 * the token, the signer and a timestamp. Replay is bounded by the 5-minute
 * window and, for chat, by the per-address rate limit; a signature for one
 * token or one action cannot be reused for another because both are in the
 * signed text.
 *
 * `buildAuthMessage` is pure and dependency-free so the web can copy it.
 */
import { verifyMessage } from 'viem'

export const AUTH_MAX_AGE_MS = 5 * 60 * 1000
export const AUTH_MAX_SKEW_MS = 60 * 1000

export type AuthAction = 'chat' | 'links' | 'pin'

export interface AuthMessageInput {
  action: AuthAction
  chainId: number
  address: string
  /** Token address for chat/links; empty for pin. */
  token?: string | null
  issuedAt: number
  /** Short digest of the payload (e.g. the chat body) so the text is bound too. */
  payload?: string | null
}

export function buildAuthMessage(input: AuthMessageInput): string {
  const lines = [
    'Hoodium Launchpad',
    `action: ${input.action}`,
    `chain: ${input.chainId}`,
    `address: ${input.address.toLowerCase()}`,
    `token: ${(input.token ?? '').toLowerCase()}`,
    `issued: ${input.issuedAt}`,
  ]
  if (input.payload) lines.push(`payload: ${input.payload}`)
  return lines.join('\n')
}

export type AuthFailure = 'expired' | 'future' | 'bad_signature' | 'malformed'

export async function verifySignedRequest(
  input: AuthMessageInput & { signature: string },
  now: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: AuthFailure }> {
  if (!Number.isFinite(input.issuedAt)) return { ok: false, reason: 'malformed' }
  if (input.issuedAt > now + AUTH_MAX_SKEW_MS) return { ok: false, reason: 'future' }
  if (now - input.issuedAt > AUTH_MAX_AGE_MS) return { ok: false, reason: 'expired' }
  if (!/^0x[0-9a-fA-F]+$/.test(input.signature)) return { ok: false, reason: 'malformed' }

  try {
    const valid = await verifyMessage({
      address: input.address as `0x${string}`,
      message: buildAuthMessage(input),
      signature: input.signature as `0x${string}`,
    })
    return valid ? { ok: true } : { ok: false, reason: 'bad_signature' }
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
}
