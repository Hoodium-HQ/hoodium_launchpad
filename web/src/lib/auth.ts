/**
 * The signed-write envelope, copied from `../api/src/auth.ts`.
 *
 * The API has no session store. A write (creator link edits; token chat, which
 * this app does not use) carries an EIP-191 `personal_sign` over a message that
 * binds the action, the chain, the token, the signer, a timestamp and a digest
 * of the payload. The server rebuilds the exact same string and verifies the
 * signature against it, so `buildAuthMessage` here must stay byte-identical to
 * the API's copy — a one-character drift is a 401 on every save.
 *
 * Signatures older than five minutes are refused; the clock skew allowance is
 * one minute the other way.
 */
import { keccak256, toHex } from 'viem'

export const AUTH_MAX_AGE_MS = 5 * 60 * 1000

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

/** The three links the API stores as an off-chain overlay, already normalised. */
export interface LinksPayload {
  x: string | null
  telegram: string | null
  website: string | null
}

/**
 * The digest the API binds a link edit to:
 * `keccak256(toHex(JSON.stringify({ x, telegram, website })))`, key order and
 * all. The values must be what the server will see *after* its own
 * normalisation (bare handles, `null` for empty), which is why the dialog sends
 * handles it has already stripped down to `[A-Za-z0-9_]`.
 */
export function linksPayloadDigest(links: LinksPayload): `0x${string}` {
  return keccak256(toHex(JSON.stringify({ x: links.x, telegram: links.telegram, website: links.website })))
}
