import { describe, expect, mock, test } from 'bun:test'

mock.module('@/auth', () => ({ auth: async () => ({ user: { id: 'test-user' } }) }))
mock.module('server-only', () => ({}))

const { saltAndHashPassword, verifyPassword } = await import('./server-helpers')

describe('password verification', () => {
  test('accepts a valid scrypt hash and rejects a wrong password', () => {
    const hash = saltAndHashPassword('correct-password')
    expect(verifyPassword('correct-password', hash)).toBe(true)
    expect(verifyPassword('wrong-password', hash)).toBe(false)
  })

  test('rejects malformed hashes without throwing', () => {
    expect(verifyPassword('password', 'not-a-hash')).toBe(false)
    expect(verifyPassword('password', '00:zz')).toBe(false)
  })

  test('rejects passwordless accounts', () => {
    expect(verifyPassword(undefined, undefined)).toBe(false)
    expect(verifyPassword('password', undefined)).toBe(false)
  })
})
