import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

mock.module('server-only', () => ({}))
const config = await import('./admin-config')

const envNames = ['AUTH_SECRET', 'AUTH_URL', 'AUTHENTIK_ISSUER', 'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
let directory: string
let cwdSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-admin-config-'))
  cwdSpy = spyOn(process, 'cwd').mockReturnValue(directory)
  process.env.AUTH_SECRET = 'a'.repeat(40)
  process.env.AUTH_URL = 'https://habit.example.test'
  process.env.AUTHENTIK_ISSUER = 'https://auth.example.test/application/o/habittrove/'
  process.env.AUTHENTIK_CLIENT_ID = 'environment-client'
  process.env.AUTHENTIK_CLIENT_SECRET = 'environment-secret'
  delete process.env.OIDC_ISSUER
  delete process.env.OIDC_CLIENT_ID
  delete process.env.OIDC_CLIENT_SECRET
})

afterEach(async () => {
  cwdSpy.mockRestore()
  for (const name of envNames) {
    const value = originalEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await fs.rm(directory, { recursive: true, force: true })
})

test('uses the existing environment provider until an admin override is saved', async () => {
  expect(await config.readEffectiveOidcConfig()).toEqual({
    providerId: 'authentik',
    issuer: 'https://auth.example.test/application/o/habittrove/',
    clientId: 'environment-client',
    clientSecret: 'environment-secret',
  })
  expect(config.getApplicationLogLevel()).toBe('info')
})

test('disables OIDC sign-in when saved configuration is damaged', async () => {
  await fs.mkdir(path.join(directory, 'data'))
  await fs.writeFile(path.join(directory, 'data', 'admin-config.json'), '{invalid json')
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await config.readStartupOidcConfig()).toBeUndefined()
    expect(error).toHaveBeenCalledWith('Saved OIDC configuration could not be loaded; OIDC sign-in is disabled')
  } finally {
    error.mockRestore()
  }
})

test('encrypts the provider secret and keeps it out of the admin response', async () => {
  await config.saveOidcConfig({
    enabled: true,
    issuer: 'https://auth.example.test/application/o/new/',
    clientId: 'new-client',
    clientSecret: 'new-secret-value',
  })
  const file = path.join(directory, 'data', 'admin-config.json')
  const raw = await fs.readFile(file, 'utf8')
  expect(raw).not.toContain('new-secret-value')
  expect(JSON.parse(raw).legacyIssuer).toBe('https://auth.example.test/application/o/habittrove/')
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  expect(await config.readEffectiveOidcConfig()).toEqual({
    providerId: 'oidc',
    issuer: 'https://auth.example.test/application/o/new/',
    clientId: 'new-client',
    clientSecret: 'new-secret-value',
  })
  const summary = await config.getAdminConfigSummary()
  expect(summary.oidc.secretConfigured).toBe(true)
  expect(JSON.stringify(summary)).not.toContain('new-secret-value')
  expect(summary.oidc.source).toBe('admin')
  expect(summary.oidc.callbackUrl).toBe('https://habit.example.test/api/auth/callback/oidc')
  delete process.env.AUTHENTIK_ISSUER
  expect(await config.getLegacyOidcIssuer()).toBe('https://auth.example.test/application/o/habittrove/')
})

test('uses generic OIDC environment settings ahead of legacy Authentik settings', async () => {
  process.env.OIDC_ISSUER = 'https://login.example.test/issuer'
  process.env.OIDC_CLIENT_ID = 'generic-client'
  process.env.OIDC_CLIENT_SECRET = 'generic-secret'
  expect(await config.readEffectiveOidcConfig()).toEqual({
    providerId: 'oidc', issuer: 'https://login.example.test/issuer',
    clientId: 'generic-client', clientSecret: 'generic-secret',
  })
})

test('retains a secret when omitted and can disable OIDC without changing the log level', async () => {
  await config.saveLogLevel('warn')
  await config.saveOidcConfig({
    enabled: true,
    issuer: 'https://auth.example.test/application/o/habittrove/',
    clientId: 'environment-client',
    clientSecret: '',
  })
  expect((await config.readEffectiveOidcConfig())?.clientSecret).toBe('environment-secret')
  expect(config.getApplicationLogLevel()).toBe('warn')
  await config.saveOidcConfig({ enabled: false, issuer: '', clientId: '', clientSecret: '' })
  expect(await config.readEffectiveOidcConfig()).toBeUndefined()
  expect(config.getApplicationLogLevel()).toBe('warn')
})

test('requires a fresh secret for a different provider identity', async () => {
  await expect(config.saveOidcConfig({
    enabled: true,
    issuer: 'https://different.example.test/application/o/habittrove/',
    clientId: 'environment-client',
    clientSecret: '',
  })).rejects.toThrow('new client secret')
  await expect(config.saveOidcConfig({
    enabled: true,
    issuer: 'https://auth.example.test/application/o/habittrove/',
    clientId: 'different-client',
    clientSecret: '',
  })).rejects.toThrow('new client secret')
})

test('rejects unsafe issuers, bad log levels, and a missing callback base URL', async () => {
  await expect(config.saveLogLevel('silent')).rejects.toThrow()
  await expect(config.saveOidcConfig({
    enabled: true, issuer: 'http://127.0.0.1/', clientId: 'client', clientSecret: 'secret',
  })).rejects.toThrow()
  delete process.env.AUTH_URL
  await expect(config.saveOidcConfig({
    enabled: true, issuer: 'https://auth.example.test/', clientId: 'client', clientSecret: 'secret',
  })).rejects.toThrow('AUTH_URL')
})

test('applies the saved application log threshold without a restart', async () => {
  const { log } = await import('./logger')
  const info = spyOn(console, 'info').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await config.saveLogLevel('error')
    log('info', 'hidden message')
    log('error', 'visible message')
    expect(info).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith('[HabitTrove] visible message')
  } finally {
    info.mockRestore()
    error.mockRestore()
  }
})
