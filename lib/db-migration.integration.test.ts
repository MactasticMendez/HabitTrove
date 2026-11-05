import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'
import { captureLegacySource, captureDatabaseSource, importDatabaseSource, verifyDatabaseSource, verifySavedManifest, withProtectedAssetCapture, writeSnapshotDirectory } from './db-migration'
import { closeDatabase, currentDatabaseClient, migrateDatabase, withStorageTransaction } from './db/client'
import { exportDatabaseSnapshot, type DatabaseSnapshot } from './db/repository'
import { verifyPassword } from './password'

mock.module('server-only', () => ({}))

const enabled = !!process.env.HABITTROVE_MIGRATION_TEST_DATABASE_URL && process.env.HABITTROVE_TEST_DATABASE === '1'
const originalEnvironment = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL }
describe.skipIf(!enabled)('isolated PostgreSQL migration, snapshot, backup and recovery drill', () => {
  afterAll(async () => {
    await closeDatabase()
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  test('imports/replays without loss, reverse exports, backs up database data and recovers local login without touching stale JSON', async () => {
    const { runBackup } = await import('./backup')
    process.env.DATABASE_URL = process.env.HABITTROVE_MIGRATION_TEST_DATABASE_URL!
    process.env.DATABASE_MIGRATION_URL = process.env.HABITTROVE_MIGRATION_TEST_ADMIN_URL ?? process.env.DATABASE_URL
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-pg-drill-'))
    const dataDirectory = path.join(directory, 'data')
    await fs.mkdir(dataDirectory)
    const evidenceId = '33333333-3333-4333-8333-333333333333'
    const externalSecret = 'isolated-recovery-test-secret-over-32-characters'
    const key = Buffer.from(hkdfSync('sha256', externalSecret, 'HabitTrove admin config v1', 'OIDC client secret', 32))
    const iv = Buffer.alloc(12, 7)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update('isolated-provider-secret', 'utf8'), cipher.final()])
    const encryptedClientSecret = [iv, cipher.getAuthTag(), ciphertext].map(value => value.toString('base64url')).join('.')
    const fixture: DatabaseSnapshot = {
      auth: { users: [{ id: 'old-id', username: 'Recovery', password: 'hash-to-preserve', isAdmin: true, avatarPath: '/data/avatars/old-id.png', authentikSubject: 'preserved-subject', oidcIssuer: 'https://issuer.invalid', managedUserIds: [] }] },
      habits: { habits: [{ id: 'timestamp-1234', name: 'Legacy', description: '', frequency: 'daily', coinReward: 0.25, userIds: ['old-id'], completions: ['2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '2024-01-03T00:00:00Z'], completionRecords: [null, { id: 'voided', actorId: 'deleted-actor', voided: true, rewardAmount: 0.25 }, { id: 'pending', actorId: 'old-id', approval: 'pending', evidenceId, evidenceMime: 'image/png' }] }] },
      wishlist: { items: [] }, coins: { balance: 0.75, transactions: [{ id: 'ledger-old', userId: 'deleted-user', actorId: 'deleted-actor', amount: 0.75, type: 'MANUAL_ADJUSTMENT', description: 'legacy', timestamp: '2024-01-01T00:00:00Z', relatedItemId: 'deleted-item' }] },
      settings: { ui: { useNumberFormatting: true, useGrouping: true }, system: { timezone: 'UTC', weekStartDay: 1, language: 'en', autoBackupEnabled: true }, profile: {} }, adminConfig: { version: 1, logLevel: 'info', oidcOverride: { issuer: 'https://issuer.invalid', clientId: 'isolated-client', encryptedClientSecret } },
    }
    for (const [key, filename] of Object.entries({ auth: 'auth', habits: 'habits', wishlist: 'wishlist', coins: 'coins', settings: 'settings', adminConfig: 'admin-config' })) await fs.writeFile(path.join(dataDirectory, `${filename}.json`), JSON.stringify(fixture[key as keyof DatabaseSnapshot]))
    await fs.mkdir(path.join(dataDirectory, 'avatars')); await fs.mkdir(path.join(dataDirectory, 'evidence'))
    await fs.writeFile(path.join(dataDirectory, 'avatars', 'old-id.png'), 'avatar-bytes')
    await fs.writeFile(path.join(dataDirectory, 'evidence', `${evidenceId}.png`), 'evidence-bytes')
    const cwd = spyOn(process, 'cwd').mockReturnValue(directory)
    try {
      await migrateDatabase()
      const privileges = await withStorageTransaction(async () => (await currentDatabaseClient()!.query(`SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls,
        has_schema_privilege(current_user, 'habittrove', 'CREATE') AS schema_create,
        has_table_privilege(current_user, 'habittrove.schema_version', 'UPDATE') AS schema_update
        FROM pg_roles WHERE rolname=current_user`)).rows[0], { readOnly: true })
      expect(privileges).toEqual({ role: 'Mac89Habittrove', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false, schema_create: false, schema_update: false })
      const source = await captureLegacySource(dataDirectory)
      fixture.attachments = source.snapshot.attachments
      expect(await importDatabaseSource(source)).toBe('imported')
      expect(await importDatabaseSource(source)).toBe('verified')
      await verifyDatabaseSource(source)
      expect(await exportDatabaseSnapshot()).toEqual(fixture)
      const databaseScript = fileURLToPath(new URL('../scripts/database.mjs', import.meta.url))
      const nodeVerify = spawnSync('node', [databaseScript, 'verify', dataDirectory, '--allow-test-database'], { cwd: directory, encoding: 'utf8', env: process.env })
      expect(nodeVerify.status).toBe(0)
      expect(nodeVerify.stdout).toContain('snapshot verified')
      const reverse = await withProtectedAssetCapture(() => captureDatabaseSource(dataDirectory))
      const exported = await writeSnapshotDirectory(path.join(directory, 'reverse'), reverse)
      await verifySavedManifest(path.join(directory, 'reverse'), exported)
      expect(exported.snapshot).toEqual(fixture)
      source.snapshot.coins.balance = 123
      await expect(importDatabaseSource(source)).rejects.toThrow('changed after validation')
      source.snapshot.coins.balance = 0.75
      // Poison the previous JSON store: PostgreSQL must remain the sole authority for backup and recovery.
      const stale = JSON.stringify({ users: [{ id: 'stale', username: 'Recovery', password: 'stale' }] })
      await fs.writeFile(path.join(dataDirectory, 'auth.json'), stale)
      await fs.writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ system: { autoBackupEnabled: false } }))
      await runBackup({ scheduled: true }); await runBackup({ scheduled: true })
      const files = await fs.readdir(path.join(directory, 'backups'))
      expect(files.filter(name => name.endsWith('.zip'))).toHaveLength(1)
      const archive = path.join(directory, 'backups', files[0])
      const auth = spawnSync('unzip', ['-p', archive, 'auth.json'], { encoding: 'utf8' })
      expect(auth.status).toBe(0); expect(JSON.parse(auth.stdout)).toEqual(fixture.auth)
      const manifest = JSON.parse(spawnSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }).stdout)
      expect(manifest.version).toBe(1); expect(Object.keys(manifest.assets)).toHaveLength(2)
      expect(spawnSync('unzip', ['-p', archive, `evidence/${evidenceId}.png`], { encoding: 'utf8' }).stdout).toBe('evidence-bytes')
      const restoreDirectory = path.join(directory, 'backup-restore')
      expect(spawnSync('unzip', ['-q', archive, '-d', restoreDirectory], { encoding: 'utf8' }).status).toBe(0)
      const backupSource = await captureLegacySource(restoreDirectory)
      await verifySavedManifest(restoreDirectory, backupSource)
      if (process.env.HABITTROVE_RESTORE_TEST_DATABASE_URL) {
        const runtime = process.env.DATABASE_URL, migration = process.env.DATABASE_MIGRATION_URL
        await closeDatabase()
        try {
          process.env.DATABASE_URL = process.env.HABITTROVE_RESTORE_TEST_DATABASE_URL
          process.env.DATABASE_MIGRATION_URL = process.env.HABITTROVE_RESTORE_TEST_ADMIN_URL ?? process.env.DATABASE_URL
          await migrateDatabase()
          expect(await importDatabaseSource(backupSource)).toBe('imported')
          await verifyDatabaseSource(backupSource)
          const restored = await exportDatabaseSnapshot()
          expect(restored).toEqual(fixture)
          const stored = (restored.adminConfig as { oidcOverride: { encryptedClientSecret: string } }).oidcOverride.encryptedClientSecret
          const [storedIv, tag, encrypted] = stored.split('.').map(part => Buffer.from(part, 'base64url'))
          const decipher = createDecipheriv('aes-256-gcm', key, storedIv); decipher.setAuthTag(tag)
          expect(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')).toBe('isolated-provider-secret')
          expect(JSON.stringify(exported.manifest)).not.toContain(externalSecret)
        } finally { await closeDatabase(); process.env.DATABASE_URL = runtime; process.env.DATABASE_MIGRATION_URL = migration }
      }


      const script = fileURLToPath(new URL('../scripts/set-local-password.mjs', import.meta.url))
      const recovery = spawnSync('node', [script, 'Recovery', '--allow-test-database'], { cwd: directory, input: 'new-recovery-password\n', encoding: 'utf8', env: process.env })
      expect(recovery.status).toBe(0)
      const updated = await exportDatabaseSnapshot()
      expect(updated.auth.users[0].id).toBe('old-id')
      expect(updated.auth.users[0].authVersion).toBe(1)
      expect(verifyPassword('new-recovery-password', updated.auth.users[0].password!)).toBe(true)
      expect(updated.auth.users[0].authentikSubject).toBe('preserved-subject')
      expect(updated.coins).toEqual(fixture.coins)
      expect(await fs.readFile(path.join(dataDirectory, 'auth.json'), 'utf8')).toBe(stale)
      const recoveryFile = (await fs.readdir(path.join(directory, 'backups'))).find(name => name.startsWith('auth-before-password-'))!
      expect((await fs.stat(path.join(directory, 'backups', recoveryFile))).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await fs.readFile(path.join(directory, 'backups', recoveryFile), 'utf8'))).toEqual(fixture.auth)
      await expect(importDatabaseSource(source)).rejects.toThrow()
      await expect(verifyDatabaseSource(source)).rejects.toThrow()
    } finally { cwd.mockRestore(); await fs.rm(directory, { recursive: true, force: true }) }
  }, 30000)
})
