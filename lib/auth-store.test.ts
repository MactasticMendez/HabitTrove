import { expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { saltAndHashPassword } from './password'

mock.module('server-only', () => ({}))
const { authenticateLocalUser } = await import('./auth-store')

test('locks a username after repeated wrong local passwords', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-login-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  const username = `user${randomUUID().replace(/-/g, '').slice(0, 12)}`
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [{
      id: 'test-user', username, email: 'user@example.com', password: saltAndHashPassword('correct-password-123'),
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
