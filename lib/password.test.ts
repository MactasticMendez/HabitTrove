import { expect, test } from 'bun:test'
import { saltAndHashPassword, saltAndHashPasswordAsync, verifyPassword, verifyPasswordAsync } from './password'

test('asynchronous password hashing preserves the existing stored format and verifier compatibility', async () => {
  const password = 'synthetic-compatible-password'
  const salt = '0123456789abcdef0123456789abcdef'
  const hash = await saltAndHashPasswordAsync(password, salt)
  expect(hash).toBe(saltAndHashPassword(password, salt))
  expect(verifyPassword(password, hash)).toBe(true)
  expect(await verifyPasswordAsync(password, hash)).toBe(true)
  expect(await verifyPasswordAsync('incorrect-password', hash)).toBe(false)
})

test('asynchronous password hashes use independent random salts and reject empty passwords', async () => {
  const [first, second] = await Promise.all([saltAndHashPasswordAsync('synthetic-password'), saltAndHashPasswordAsync('synthetic-password')])
  expect(first).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/)
  expect(second).not.toBe(first)
  await expect(saltAndHashPasswordAsync('')).rejects.toThrow('Password must not be empty')
})
