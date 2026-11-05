import { expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { saltAndHashPassword } from './password'
import { sanitizeUserData } from './user-sanitizer'

mock.module('server-only', () => ({}))
const { authenticateLocalUser, readAuthData, verifyStepUpPassword } = await import('./auth-store')

test('locks a username after repeated wrong local passwords', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-login-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  const username = `user${randomUUID().replace(/-/g, '').slice(0, 12)}`
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [{
      id: 'test-user', username, email: 'user@example.test', password: saltAndHashPassword('correct-password-123'),
    }] }))
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await authenticateLocalUser(username, 'wrong-password')).toBeNull()
    }
    expect(await authenticateLocalUser(username, 'correct-password-123')).toBeNull()
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('unknown usernames cannot fill the account failure tracker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-login-flood-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  const username = `user${randomUUID().replace(/-/g, '').slice(0, 12)}`
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [{
      id: randomUUID(), username, email: 'user@example.test', password: saltAndHashPassword('correct-password-123'),
    }] }))
    for (let index = 0; index < 1001; index++) {
      expect(await authenticateLocalUser(`unknown${index}`, '')).toBeNull()
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await authenticateLocalUser(username, 'wrong-password')).toBeNull()
    }
    expect(await authenticateLocalUser(username, 'correct-password-123')).toBeNull()
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('bounds concurrent password verification for unknown usernames', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-login-concurrency-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [] }))
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      authenticateLocalUser(`unknown${index}`, 'wrong-password')))
    expect(results).toEqual(Array.from({ length: 100 }, () => null))
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('step-up password failures are throttled separately from public sign-in', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-step-up-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  const user = {
    id: randomUUID(), username: `user${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    email: 'user@example.test', password: saltAndHashPassword('correct-password-123'),
  }
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [user] }))
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await verifyStepUpPassword(user, 'wrong-password')).toBe(false)
    }
    expect(await verifyStepUpPassword(user, 'correct-password-123')).toBe(false)
    expect((await authenticateLocalUser(user.username, 'correct-password-123'))?.id).toBe(user.id)
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('rejects unrecognized subject fields before account data reaches the public directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-identity-schema-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  const file = path.join(directory, 'data', 'auth.json')
  const user = { id: 'test-user', username: 'Member', retainedMetadata: 'preserved' }
  try {
    await fs.mkdir(path.dirname(file))
    for (const field of ['externalSubject', 'externalSUBJECT']) {
      const raw = JSON.stringify({ users: [{ ...user, [field]: 'private-subject' }] })
      await fs.writeFile(file, raw)
      await expect(readAuthData().then(data => sanitizeUserData(data, user.id, true)))
        .rejects.toThrow('convert the account data to use oidcSubject')
      expect(await fs.readFile(file, 'utf8')).toBe(raw)
    }
    await fs.writeFile(file, JSON.stringify({ users: [{ ...user, oidcSubject: 'private-subject' }] }))
    const data = await readAuthData()
    expect(data.users[0]).toMatchObject({ retainedMetadata: 'preserved', oidcSubject: 'private-subject' })
    const sanitized = sanitizeUserData(data, user.id, true)
    expect(sanitized.users[0]).toMatchObject({ retainedMetadata: 'preserved', hasOidc: true })
    expect(JSON.stringify(sanitized)).not.toContain('private-subject')
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
