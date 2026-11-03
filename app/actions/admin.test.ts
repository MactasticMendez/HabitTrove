import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { User } from '@/lib/types'
import { saltAndHashPassword } from '@/lib/password'

let currentUser: User | undefined
mock.module('server-only', () => ({}))
mock.module('@/lib/server-helpers', () => ({ getCurrentUser: async () => currentUser }))
const actions = await import('./admin')

const admin: User = {
  id: 'admin', username: 'admin', email: 'admin@example.test', isAdmin: true,
  password: saltAndHashPassword('current-password'),
}
let directory: string
let cwdSpy: ReturnType<typeof spyOn>
const originalEnv = {
  AUTH_SECRET: process.env.AUTH_SECRET, AUTH_URL: process.env.AUTH_URL, DEMO: process.env.DEMO,
  AUTHENTIK_ISSUER: process.env.AUTHENTIK_ISSUER,
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-admin-action-'))
  await fs.mkdir(path.join(directory, 'data'))
  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [admin] }))
  cwdSpy = spyOn(process, 'cwd').mockReturnValue(directory)
  currentUser = admin
  process.env.AUTH_SECRET = 'b'.repeat(40)
  process.env.AUTH_URL = 'https://habit.example.test'
  process.env.AUTHENTIK_ISSUER = 'https://auth.example.test/application/o/habittrove/'
  delete process.env.DEMO
})

afterEach(async () => {
  cwdSpy.mockRestore()
  currentUser = undefined
  for (const name of ['AUTH_SECRET', 'AUTH_URL', 'DEMO', 'AUTHENTIK_ISSUER'] as const) {
    const value = originalEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await fs.rm(directory, { recursive: true, force: true })
})

test('blocks members and signed-out visitors from reading or editing admin settings', async () => {
  currentUser = { ...admin, isAdmin: false }
  await expect(actions.loadAdminPanelSettings()).rejects.toThrow('Administrator access required')
  await expect(actions.updateApplicationLogLevel('debug')).rejects.toThrow('Administrator access required')
  await expect(actions.updateOidcDisplayName('Example')).rejects.toThrow('Administrator access required')
  currentUser = undefined
  await expect(actions.updateOidcProvider({
    enabled: false, issuer: '', clientId: '', clientSecret: '', currentPassword: 'current-password',
  })).rejects.toThrow('Administrator access required')
})

test('lets an administrator rename the OIDC button without changing provider credentials', async () => {
  const summary = await actions.updateOidcDisplayName('Meadow’s Auth')
  expect(summary.oidc.displayName).toBe('Meadow’s Auth')
  expect(summary.oidc.source).toBe('none')
  expect(summary.oidc.enabled).toBe(false)
  const raw = await fs.readFile(path.join(directory, 'data', 'admin-config.json'), 'utf8')
  expect(JSON.parse(raw).oidcOverride).toBeUndefined()
})

test('requires the current admin password to change OIDC and never returns the secret', async () => {
  const input = {
    enabled: true,
    issuer: 'https://auth.example.test/application/o/habittrove/',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    currentPassword: 'wrong-password',
  }
  await expect(actions.updateOidcProvider(input)).rejects.toThrow('Current local password is incorrect')
  const summary = await actions.updateOidcProvider({ ...input, currentPassword: 'current-password' })
  expect(summary.oidc.enabled).toBe(true)
  expect(summary.oidc.clientId).toBe('test-client')
  expect(JSON.stringify(summary)).not.toContain('test-secret')
  const raw = await fs.readFile(path.join(directory, 'data', 'admin-config.json'), 'utf8')
  expect(raw).not.toContain('test-secret')
})

test('applies the log level immediately and blocks changes in demo mode', async () => {
  await actions.updateApplicationLogLevel('error')
  expect((await actions.loadAdminPanelSettings()).logLevel).toBe('error')
  process.env.DEMO = 'true'
  await expect(actions.updateApplicationLogLevel('debug')).rejects.toThrow('Administrator access required')
})

test('prevents an issuer change while existing Authentik identities are linked', async () => {
  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
    users: [{ ...admin, authentikSubject: 'subject-1' }],
  }))
  await expect(actions.updateOidcProvider({
    enabled: true,
    issuer: 'https://different.example.test/application/o/habittrove/',
    clientId: 'client',
    clientSecret: 'secret',
    currentPassword: 'current-password',
  })).rejects.toThrow('Unlink existing OIDC accounts')
  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
    users: [{ ...admin, authentikSubject: 'subject-1', oidcIssuer: 'https://other.example.test/issuer' }],
  }))
  await expect(actions.updateOidcProvider({
    enabled: true,
    issuer: process.env.AUTHENTIK_ISSUER!,
    clientId: 'client', clientSecret: 'secret', currentPassword: 'current-password',
  })).rejects.toThrow('Unlink existing OIDC accounts')
  await expect(fs.stat(path.join(directory, 'data', 'admin-config.json'))).rejects.toThrow()
})

test('prevents disabling OIDC while a linked account has no local password', async () => {
  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
    users: [admin, { id: 'oidc-only', username: 'oidc-only', email: 'oidc@example.test',
      authentikSubject: 'subject-2', oidcIssuer: process.env.AUTHENTIK_ISSUER }],
  }))
  await expect(actions.updateOidcProvider({
    enabled: false, issuer: '', clientId: '', clientSecret: '', currentPassword: 'current-password',
  })).rejects.toThrow('Set local passwords for OIDC-only accounts')
  expect((await actions.loadAdminPanelSettings()).oidcOnlyAccountCount).toBe(1)
  await expect(fs.stat(path.join(directory, 'data', 'admin-config.json'))).rejects.toThrow()

  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
    users: [admin, { id: 'oidc-only', username: 'oidc-only', email: 'oidc@example.test',
      password: saltAndHashPassword('second-local-password'),
      authentikSubject: 'subject-2', oidcIssuer: process.env.AUTHENTIK_ISSUER }],
  }))
  const summary = await actions.updateOidcProvider({
    enabled: false, issuer: '', clientId: '', clientSecret: '', currentPassword: 'current-password',
  })
  expect(summary.oidc.enabled).toBe(false)
  expect(summary.oidcOnlyAccountCount).toBe(0)
})
