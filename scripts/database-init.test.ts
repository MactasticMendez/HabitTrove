import { describe, expect, test } from 'bun:test'
import { createInitialDatabaseSnapshot } from './database'
import { verifyPassword } from '../lib/password'

const credentials = { INITIAL_ADMIN_EMAIL: 'OWNER@example.com', INITIAL_ADMIN_PASSWORD: 'initial-password-for-test' }

test('fresh-install snapshot contains exactly one new local admin and existing default documents', () => {
  const snapshot = createInitialDatabaseSnapshot(credentials)
  expect(snapshot.auth.users).toHaveLength(1)
  const account = snapshot.auth.users[0]
  expect(account).toMatchObject({ username: 'admin', email: 'owner@example.com', isAdmin: true, authVersion: 0 })
  expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(account.password).not.toBe(credentials.INITIAL_ADMIN_PASSWORD)
  expect(verifyPassword(credentials.INITIAL_ADMIN_PASSWORD, account.password)).toBe(true)
  expect(account.authentikSubject).toBeUndefined()
  expect(account.oidcIssuer).toBeUndefined()
  expect(snapshot.habits).toEqual({ habits: [] })
  expect(snapshot.wishlist).toEqual({ items: [] })
  expect(snapshot.coins).toEqual({ balance: 0, transactions: [] })
  expect(snapshot.settings.system.autoBackupEnabled).toBe(true)
  expect(snapshot.settings.system.timezone).toBeTruthy()
  expect(snapshot.adminConfig).toBeUndefined()
  expect(createInitialDatabaseSnapshot(credentials).auth.users[0].id).not.toBe(account.id)
  expect(createInitialDatabaseSnapshot(credentials).auth.users[0].password).not.toBe(account.password)
})

describe('init credential validation uses the existing new-password and email requirements', () => {
  test.each([undefined, '', 'too-short', 'x'.repeat(129)])('rejects an invalid initial password without echoing it', password => {
    expect(() => createInitialDatabaseSnapshot({ ...credentials, INITIAL_ADMIN_PASSWORD: password })).toThrow('INITIAL_ADMIN_PASSWORD must be 12-128 characters')
  })
  test.each([undefined, '', 'invalid-address', 'x'.repeat(250) + '@example.com'])('rejects an invalid initial email', email => {
    expect(() => createInitialDatabaseSnapshot({ ...credentials, INITIAL_ADMIN_EMAIL: email })).toThrow('INITIAL_ADMIN_EMAIL must be a valid email')
  })
})
