import { expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { NextAuthConfig } from 'next-auth'

let authConfig: NextAuthConfig | undefined
mock.module('server-only', () => ({}))
mock.module('next-auth', () => ({
  default: (config: NextAuthConfig) => {
    authConfig = config
    return { handlers: {}, signIn: () => {}, signOut: () => {}, auth: () => {} }
  },
}))

const authEnvKeys = ['AUTHENTIK_ISSUER', 'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET'] as const
const originalAuthEnv = authEnvKeys.map(key => process.env[key])
process.env.AUTHENTIK_ISSUER = 'https://auth.example.test/application/o/habittrove/'
process.env.AUTHENTIK_CLIENT_ID = 'test-client'
process.env.AUTHENTIK_CLIENT_SECRET = 'test-secret'
await import('./auth')
authEnvKeys.forEach((key, index) => {
  const original = originalAuthEnv[index]
  if (original === undefined) delete process.env[key]
  else process.env[key] = original
})

test('Authentik sign-in uses the linked local account despite Auth.js replacing the profile ID', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-session-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
      users: [{ id: 'existing-user', username: 'Robin', email: 'robin@example.com', authentikSubject: 'subject-1', authVersion: 3 }],
    }))
    const jwt = authConfig?.callbacks?.jwt
    if (!jwt) throw new Error('JWT callback is missing')
    const authentik = authConfig?.providers.find(provider =>
      typeof provider === 'object' && provider.id === 'authentik')
    if (!authentik || typeof authentik === 'function' || !('profile' in authentik) ||
        typeof authentik.profile !== 'function') throw new Error('Authentik profile is missing')
    const linkedProfile = await authentik.profile({ sub: 'subject-1', email: 'robin@example.com', email_verified: true }, {})
    expect(linkedProfile).toMatchObject({ id: 'subject-1', localUserId: 'existing-user', authVersion: 3 })
    const providerUser = { ...linkedProfile, id: 'authjs-generated-id' }

    const token = await jwt({
      token: {},
      user: providerUser,
      account: { provider: 'authentik', providerAccountId: 'subject-1', type: 'oidc' },
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(token?.id).toBe('existing-user')
    expect(token?.authVersion).toBe(3)

    const wrongSubject = await jwt({
      token: {},
      user: providerUser,
      account: { provider: 'authentik', providerAccountId: 'different-subject', type: 'oidc' },
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(wrongSubject).toBeNull()

    const invalidProviderUser = { id: 'existing-user' }
    const invalid = await jwt({
      token: {},
      user: invalidProviderUser,
      account: { provider: 'authentik', providerAccountId: 'subject-1', type: 'oidc' },
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(invalid).toBeNull()

    const localUser = { id: 'existing-user', authVersion: 3 }
    const local = await jwt({
      token: {},
      user: localUser,
      account: null,
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(local?.authVersion).toBe(3)

    const staleLocalUser = { id: 'existing-user', authVersion: 2 }
    const staleLocal = await jwt({
      token: {},
      user: staleLocalUser,
      account: null,
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(staleLocal).toBeNull()

    const unknown = await jwt({
      token: {},
      user: { id: 'unknown-user' },
      account: null,
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(unknown).toBeNull()
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
