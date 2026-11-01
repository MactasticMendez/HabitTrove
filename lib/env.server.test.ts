import { afterEach, describe, expect, test } from 'bun:test'
import { init } from './env.server'

const originalSecret = process.env.AUTH_SECRET

afterEach(() => {
  if (originalSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalSecret
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
})
