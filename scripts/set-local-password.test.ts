import { expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifyPassword } from '../lib/password'

test('sets a local password while preserving account data and a private backup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-recovery-'))
  try {
    await fs.mkdir(path.join(directory, 'data'))
    const original = { users: [{ id: 'admin-id', username: 'admin', isAdmin: true, email: 'admin@example.com' }] }
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify(original))
    const script = fileURLToPath(new URL('./set-local-password.mjs', import.meta.url))
    const result = spawnSync('node', [script, 'admin'], { cwd: directory, input: 'new-recovery-password\n', encoding: 'utf8' })
    expect(result.status).toBe(0)
    const updated = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
    expect(updated.users[0].id).toBe('admin-id')
    expect(updated.users[0].authVersion).toBe(1)
    expect(verifyPassword('new-recovery-password', updated.users[0].password)).toBe(true)
    const backup = (await fs.readdir(path.join(directory, 'data'))).find(file => file.startsWith('auth.json.before-password-'))!
    expect(JSON.parse(await fs.readFile(path.join(directory, 'data', backup), 'utf8'))).toEqual(original)
    expect((await fs.stat(path.join(directory, 'data', backup))).mode & 0o777).toBe(0o600)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
