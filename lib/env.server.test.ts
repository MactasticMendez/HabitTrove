import { afterEach, describe, expect, test } from 'bun:test'
import { init } from './env.server'

const originalSecret = process.env.AUTH_SECRET
const originalAuthentik = [process.env.AUTH_URL, process.env.AUTHENTIK_ISSUER, process.env.AUTHENTIK_CLIENT_ID, process.env.AUTHENTIK_CLIENT_SECRET]
const oidcNames = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const
const originalOidc = oidcNames.map(name => process.env[name])

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalSecret
  for (const [index, key] of ['AUTH_URL', 'AUTHENTIK_ISSUER', 'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET'].entries()) {
    if (originalAuthentik[index] === undefined) delete process.env[key]
    else process.env[key] = originalAuthentik[index]
  }
  oidcNames.forEach((name, index) => {
    if (originalOidc[index] === undefined) delete process.env[name]
    else process.env[name] = originalOidc[index]
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

  test('requires a complete HTTPS Authentik configuration', () => {
    process.env.AUTH_SECRET = 'a'.repeat(32)
    process.env.AUTHENTIK_ISSUER = 'https://auth.example.com/application/o/habittrove/'
    expect(() => init()).toThrow('Authentik requires')
    process.env.AUTH_URL = 'https://habit.example.com'
    process.env.AUTHENTIK_CLIENT_ID = 'client'
    process.env.AUTHENTIK_CLIENT_SECRET = 'secret'
    expect(() => init()).not.toThrow()
  })

  test('requires a complete HTTPS generic OIDC configuration', () => {
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
