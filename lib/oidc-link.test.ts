import { describe, expect, test } from 'bun:test'
import { createOidcLinkIntent, verifyOidcLinkIntent } from './oidc-link'

const secret = 'a'.repeat(32)

describe('OIDC account link intent', () => {
  test('accepts a signed intent within five minutes', () => {
    const token = createOidcLinkIntent('user-1', 2, 'user@example.test', secret, 1000)
    expect(verifyOidcLinkIntent(token, secret, 2000)).toEqual({
      userId: 'user-1', authVersion: 2, email: 'user@example.test', expiresAt: 301000,
    })
  })

  test('rejects tampering, a different key, and an expired intent', () => {
    const token = createOidcLinkIntent('user-1', 2, 'user@example.test', secret, 1000)
    expect(verifyOidcLinkIntent(`${token}x`, secret, 2000)).toBeNull()
    expect(verifyOidcLinkIntent(token, 'b'.repeat(32), 2000)).toBeNull()
    expect(verifyOidcLinkIntent(token, secret, 301000)).toBeNull()
  })
})
