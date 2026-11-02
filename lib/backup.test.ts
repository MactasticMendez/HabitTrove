import { expect, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

test('creates a ZIP backup containing the data directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-backup-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), '{"users":[]}')
    const { runBackup } = await import('./backup')
    await runBackup()
    const backupFiles = await fs.readdir(path.join(directory, 'backups'))
    expect(backupFiles).toHaveLength(1)
    const zip = await fs.readFile(path.join(directory, 'backups', backupFiles[0]))
    expect(zip.subarray(0, 2).toString()).toBe('PK')
    expect(zip.includes(Buffer.from('auth.json'))).toBe(true)
    expect((await fs.stat(path.join(directory, 'backups', backupFiles[0]))).mode & 0o777).toBe(0o600)
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('does not create a backup when the setting is disabled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-backup-disabled-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'settings.json'), JSON.stringify({ system: { autoBackupEnabled: false } }))
    const { runBackup } = await import('./backup')
    await runBackup()
    await expect(fs.readdir(path.join(directory, 'backups'))).rejects.toThrow()
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
