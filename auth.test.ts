import { expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { NextAuthConfig } from 'next-auth'

let authConfig: NextAuthConfig | ((request: undefined) => NextAuthConfig | Promise<NextAuthConfig>) | undefined
let resolvedConfig: NextAuthConfig | undefined
mock.module('server-only', () => ({}))
mock.module('next-auth', () => ({
  default: (config: NonNullable<typeof authConfig>) => {
    authConfig = config
    return { handlers: {}, signIn: () => {}, signOut: () => {}, auth: () => {} }
  },
}))

const authEnvKeys = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const
const originalAuthEnv = authEnvKeys.map(key => process.env[key])
process.env.OIDC_ISSUER = 'https://auth.example.test/application/o/habittrove/'
process.env.OIDC_CLIENT_ID = 'test-client'
process.env.OIDC_CLIENT_SECRET = 'test-secret'
const { providersFor } = await import('./auth')
resolvedConfig = typeof authConfig === 'function' ? await authConfig(undefined) : authConfig
authEnvKeys.forEach((key, index) => {
  const original = originalAuthEnv[index]
  if (original === undefined) delete process.env[key]
  else process.env[key] = original
})

test('OIDC sign-in uses the linked local account despite Auth.js replacing the profile ID', async () => {
  const previousIssuer = process.env.OIDC_ISSUER
  process.env.OIDC_ISSUER = 'https://auth.example.test/application/o/habittrove/'
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-session-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
      users: [{ id: 'existing-user', username: 'Meadow', email: 'meadow@example.test', oidcSubject: 'subject-1', authVersion: 3 }],
    }))
    const jwt = resolvedConfig?.callbacks?.jwt
    if (!jwt) throw new Error('JWT callback is missing')
    const oidc = resolvedConfig?.providers.find(provider =>
      typeof provider === 'object' && provider.id === 'oidc')
    if (!oidc || typeof oidc === 'function' || !('profile' in oidc) ||
        typeof oidc.profile !== 'function') throw new Error('OIDC profile is missing')
    const linkedProfile = await oidc.profile({ sub: 'subject-1', email: 'meadow@example.test', email_verified: true }, {})
    expect(linkedProfile).toMatchObject({ id: 'subject-1', localUserId: 'existing-user', authVersion: 3 })
    const providerUser = { ...linkedProfile, id: 'authjs-generated-id' }

    const token = await jwt({
      token: {},
      user: providerUser,
      account: { provider: 'oidc', providerAccountId: 'subject-1', type: 'oidc' },
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(token?.id).toBe('existing-user')
    expect(token?.authVersion).toBe(3)

    const wrongSubject = await jwt({
      token: {},
      user: providerUser,
      account: { provider: 'oidc', providerAccountId: 'different-subject', type: 'oidc' },
      profile: undefined,
      trigger: 'signIn',
      isNewUser: false,
    })
    expect(wrongSubject).toBeNull()

    const invalidProviderUser = { id: 'existing-user' }
    const invalid = await jwt({
      token: {},
      user: invalidProviderUser,
      account: { provider: 'oidc', providerAccountId: 'subject-1', type: 'oidc' },
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
    if (previousIssuer === undefined) delete process.env.OIDC_ISSUER
    else process.env.OIDC_ISSUER = previousIssuer
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('generic OIDC sign-in accepts an existing linked account', async () => {
  const previousIssuer = process.env.OIDC_ISSUER
  const previousSecret = process.env.AUTH_SECRET
  const previousUrl = process.env.AUTH_URL
  process.env.OIDC_ISSUER = 'https://auth.example.test/application/o/habittrove/'
  process.env.AUTH_SECRET = 'a'.repeat(40)
  process.env.AUTH_URL = 'https://habit.example.test'
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-generic-oidc-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({
      users: [{ id: 'existing-user', username: 'Meadow', email: 'meadow@example.test', oidcSubject: 'subject-1', authVersion: 3 }],
    }))
    const { saveOidcConfig } = await import('./lib/admin-config')
    await saveOidcConfig({ enabled: true, issuer: 'https://auth.example.test/application/o/habittrove/',
      clientId: 'client', clientSecret: 'secret' })
    delete process.env.OIDC_ISSUER
    const provider = providersFor({
      providerId: 'oidc', issuer: 'https://auth.example.test/application/o/habittrove/',
      clientId: 'client', clientSecret: 'secret',
    }).find(item => typeof item === 'object' && item.id === 'oidc')
    if (!provider || typeof provider === 'function' || !('profile' in provider) || typeof provider.profile !== 'function') {
      throw new Error('Generic OIDC provider is missing')
    }
    expect(provider.checks).toEqual(['pkce', 'state', 'nonce'])
    const linkedProfile = await provider.profile({ sub: 'subject-1', email: 'meadow@example.test', email_verified: true }, {})
    expect(linkedProfile).toMatchObject({ localUserId: 'existing-user' })
    const jwt = resolvedConfig?.callbacks?.jwt
    if (!jwt) throw new Error('JWT callback is missing')
    const token = await jwt({
      token: {}, user: { ...linkedProfile, id: 'authjs-generated-id' },
      account: { provider: 'oidc', providerAccountId: 'subject-1', type: 'oidc' },
      profile: undefined, trigger: 'signIn', isNewUser: false,
    })
    expect(token?.id).toBe('existing-user')
    const { findUserByOidcSubject } = await import('./lib/auth-store')
    expect(await findUserByOidcSubject('subject-1', 'https://different.example.test/issuer')).toBeUndefined()
  } finally {
    if (previousIssuer === undefined) delete process.env.OIDC_ISSUER
    else process.env.OIDC_ISSUER = previousIssuer
    if (previousSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousSecret
    if (previousUrl === undefined) delete process.env.AUTH_URL
    else process.env.AUTH_URL = previousUrl
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
