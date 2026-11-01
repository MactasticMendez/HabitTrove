import { describe, expect, test } from 'bun:test'
import { createAuthentikLinkIntent, verifyAuthentikLinkIntent } from './authentik-link'

const secret = 'a'.repeat(32)

describe('Authentik account link intent', () => {
  test('accepts a signed intent within five minutes', () => {
    const token = createAuthentikLinkIntent('user-1', 2, 'user@example.com', secret, 1000)
    expect(verifyAuthentikLinkIntent(token, secret, 2000)).toEqual({
      userId: 'user-1', authVersion: 2, email: 'user@example.com', expiresAt: 301000,
    })
  })

  test('rejects tampering, a different key, and an expired intent', () => {
    const token = createAuthentikLinkIntent('user-1', 2, 'user@example.com', secret, 1000)
    expect(verifyAuthentikLinkIntent(`${token}x`, secret, 2000)).toBeNull()
    expect(verifyAuthentikLinkIntent(token, 'b'.repeat(32), 2000)).toBeNull()
    expect(verifyAuthentikLinkIntent(token, secret, 301000)).toBeNull()
  })
})
