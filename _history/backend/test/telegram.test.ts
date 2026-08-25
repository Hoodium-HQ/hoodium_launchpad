/**
 * T3.9 · AL-3.7, AL-3.9 — Telegram formatting and failure classification.
 *
 * Everything here is pure, so it runs without a bot token or a database. The
 * link lifecycle needs both a real Mongo and its unique indexes and lives in
 * `telegram-link.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { escapeHtml, terminalReason } from '../src/notify/telegram.js'
import { formatTelegramAlert } from '../src/notify/notifier.js'
import { generateLinkToken, hashLinkToken } from '../src/db/models/telegram-link.js'

describe('escapeHtml', () => {
  /*
   * The case that matters. Token symbols are chosen by whoever deployed the
   * token, and the message goes out with `parse_mode: HTML` — an unescaped
   * symbol would let a token name restyle or truncate the alert around it.
   */
  it('neutralises markup in a token symbol', () => {
    expect(escapeHtml('<b>PUMP</b>')).toBe('&lt;b&gt;PUMP&lt;/b&gt;')
  })

  it('escapes ampersands before angle brackets, so escaping is not double-applied', () => {
    expect(escapeHtml('A&B <c>')).toBe('A&amp;B &lt;c&gt;')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('WETH/USDC 0.3%')).toBe('WETH/USDC 0.3%')
  })
})

describe('formatTelegramAlert', () => {
  const base = {
    severity: 'critical',
    title: 'WETH/USDC is out of range',
    body: 'Price moved past the upper boundary.',
    positionKey: '31337:0xpm:1',
    appOrigin: 'https://app.hoodium.xyz',
  }

  it('marks severity so the alert reads in a chat list', () => {
    expect(formatTelegramAlert(base).html.startsWith('🔴')).toBe(true)
    expect(formatTelegramAlert({ ...base, severity: 'warning' }).html.startsWith('🟠')).toBe(true)
  })

  it('falls back to the info mark for an unknown severity rather than rendering "undefined"', () => {
    expect(formatTelegramAlert({ ...base, severity: 'nonsense' }).html.startsWith('🔵')).toBe(true)
  })

  it('deep-links to the position it concerns — WA-6.4', () => {
    expect(formatTelegramAlert(base).link).toEqual({
      text: 'Open position',
      url: 'https://app.hoodium.xyz/positions/31337%3A0xpm%3A1',
    })
  })

  it('links to the app when the alert concerns no single position', () => {
    const message = formatTelegramAlert({ ...base, positionKey: null })
    expect(message.link).toEqual({ text: 'Open Hoodium', url: 'https://app.hoodium.xyz' })
  })

  it('does not produce a double slash when the origin carries a trailing one', () => {
    const message = formatTelegramAlert({ ...base, appOrigin: 'https://app.hoodium.xyz/' })
    expect(message.link?.url).toBe('https://app.hoodium.xyz/positions/31337%3A0xpm%3A1')
  })

  it('escapes the title and body it interpolates', () => {
    const message = formatTelegramAlert({ ...base, title: '<script>x</script>', body: 'a & b' })
    expect(message.html).toContain('&lt;script&gt;')
    expect(message.html).toContain('a &amp; b')
    // The bold wrapper we added ourselves must survive; only the input is escaped.
    expect(message.html).toContain('<b>')
  })
})

describe('terminalReason — AL-3.9', () => {
  /*
   * The distinction this function exists for: a terminal error deactivates the
   * link, a transient one must not. Misfiling a timeout as terminal would
   * silently unsubscribe a user over a network blip.
   */
  it('treats a 403 as a block', () => {
    expect(terminalReason({ error_code: 403, description: 'Forbidden: bot was blocked by the user' })).toBe(
      'blocked',
    )
  })

  it('treats a deactivated account as a deleted chat', () => {
    expect(terminalReason({ error_code: 403, description: 'Forbidden: user is deactivated' })).toBe(
      'chat_deleted',
    )
  })

  it('treats "chat not found" as terminal even though it arrives as a 400', () => {
    expect(terminalReason({ error_code: 400, description: 'Bad Request: chat not found' })).toBe(
      'chat_deleted',
    )
  })

  it('does not deactivate on a rate limit', () => {
    expect(terminalReason({ error_code: 429, description: 'Too Many Requests' })).toBeNull()
  })

  it('does not deactivate on a server error', () => {
    expect(terminalReason({ error_code: 500, description: 'Internal Server Error' })).toBeNull()
  })

  it('does not deactivate on an unrelated 400', () => {
    expect(terminalReason({ error_code: 400, description: "Bad Request: can't parse entities" })).toBeNull()
  })
})

describe('link tokens — AL-3.8', () => {
  it('fits the Telegram deep-link payload: ≤64 chars, base64url alphabet only', () => {
    for (let i = 0; i < 50; i++) {
      const token = generateLinkToken()
      expect(token.length).toBeLessThanOrEqual(64)
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateLinkToken()))
    expect(tokens.size).toBe(500)
  })

  it('hashes deterministically, and the hash does not contain the token', () => {
    const token = generateLinkToken()
    expect(hashLinkToken(token)).toBe(hashLinkToken(token))
    expect(hashLinkToken(token)).not.toContain(token)
    expect(hashLinkToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})
