import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertDatabaseTarget, closeDatabase, withStorageTransaction } from '../lib/db/client'
import { usesPostgres } from '../lib/storage-mode'
import { readAuthDocument, writeAuthDocument } from '../lib/db/repository'

export async function setDatabasePassword(username: string, passwordHash: string, allowTestDatabase = false) {
  if (!usesPostgres() || !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  assertDatabaseTarget(process.env.DATABASE_URL, allowTestDatabase && process.env.HABITTROVE_TEST_DATABASE === '1')
  try {
    await withStorageTransaction(async () => {
      const data = await readAuthDocument()
      if (!data || !Array.isArray(data.users)) throw new Error('Invalid account data')
      const user = data.users.find(candidate => candidate.username === username)
      if (!user) throw new Error('User not found')
      const directory = path.join(process.cwd(), 'backups')
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await fs.lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe recovery backup directory')
      await fs.chmod(directory, 0o700)
      // Keep the previous credential document private for account recovery; do not touch stale JSON.
      await fs.writeFile(path.join(directory, `auth-before-password-${randomUUID()}.json`), JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 })
      user.password = passwordHash
      user.authVersion = (user.authVersion ?? 0) + 1
      await writeAuthDocument(data)
    })
  } finally { await closeDatabase() }
}
