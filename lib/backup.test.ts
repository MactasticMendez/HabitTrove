import { expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { ZipArchive } from 'archiver'

mock.module('server-only', () => ({}))

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

test('discards an archive with a warning without rotating older backups', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-backup-warning-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  const originalDirectory = ZipArchive.prototype.directory
  const directorySpy = spyOn(ZipArchive.prototype, 'directory').mockImplementation(function (this: ZipArchive, source: string, destination: string | false) {
    this.emit('warning', Object.assign(new Error('file vanished'), { code: 'ENOENT' }))
    return originalDirectory.call(this, source, destination)
  })
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), '{"users":[]}')
    await fs.mkdir(path.join(directory, 'backups'))
    for (let index = 0; index < 7; index++) {
      await fs.writeFile(path.join(directory, 'backups', `backup-old-${index}.zip`), 'previous backup')
    }
    const { runBackup } = await import('./backup')
    await expect(runBackup()).rejects.toThrow('file vanished')
    expect((await fs.readdir(path.join(directory, 'backups'))).sort())
      .toEqual(Array.from({ length: 7 }, (_, index) => `backup-old-${index}.zip`))
  } finally {
    directorySpy.mockRestore()
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('rejects a symlinked backup directory instead of writing account data through it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-backup-symlink-'))
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-backup-outside-'))
  const cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  try {
    await fs.mkdir(path.join(directory, 'data'))
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), '{"users":[]}')
    await fs.symlink(other, path.join(directory, 'backups'))
    const { runBackup } = await import('./backup')
    await expect(runBackup()).rejects.toThrow('Unsafe backup directory')
    expect(await fs.readdir(other)).toHaveLength(0)
  } finally {
    cwdSpy.mockRestore()
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(other, { recursive: true, force: true })
  }
})
