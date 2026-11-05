import { afterEach, describe, expect, test } from 'bun:test'
import { init } from './env.server'

const envNames = ['AUTH_SECRET', 'AUTH_URL', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const
const originalEnv = envNames.map(name => process.env[name])

afterEach(() => {
  envNames.forEach((name, index) => {
    if (originalEnv[index] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[index]
  })
})

describe('environment validation', () => {
  test('rejects missing or short authentication secrets', () => {
    delete process.env.AUTH_SECRET
    expect(() => init()).toThrow('AUTH_SECRET')
    process.env.AUTH_SECRET = 'short'
    expect(() => init()).toThrow('AUTH_SECRET')
  })

  test('accepts a strong authentication secret', () => {
    process.env.AUTH_SECRET = 'a'.repeat(32)
    expect(() => init()).not.toThrow()
  })

  test('requires a complete HTTPS OIDC configuration', () => {
    process.env.AUTH_SECRET = 'a'.repeat(32)
    process.env.OIDC_ISSUER = 'https://login.example.test/issuer'
    expect(() => init()).toThrow('OIDC requires')
    process.env.AUTH_URL = 'https://habit.example.test'
    process.env.OIDC_CLIENT_ID = 'client'
    process.env.OIDC_CLIENT_SECRET = 'secret'
    expect(() => init()).not.toThrow()
    process.env.OIDC_ISSUER = 'http://login.example.test/issuer'
    expect(() => init()).toThrow('OIDC_ISSUER must use HTTPS')
  })
})
