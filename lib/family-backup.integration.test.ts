import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCipheriv, createDecipheriv, createHash, hkdfSync } from 'node:crypto'
import { closeDatabase, currentDatabaseClient, withStorageTransaction } from './db/client'
import { importDatabaseSnapshot, type DatabaseSnapshot } from './db/repository'
import { captureDatabaseSource } from './db-migration'
import { getDefaultSettings } from './types'
import { saltAndHashPassword, verifyPassword } from './password'
import { activateFamilyDatabase, captureFamilyDatabaseSource, createFamilyBackupSource, migrateFamilyDatabase, previewFamilyActivation, readFamilySource, restoreFamilyDatabase, verifyFamilyDatabase, withFamilyOperationalScope } from './family-backup'

mock.module('server-only', () => ({}))
const sourceUrl = process.env.HABITTROVE_FAMILY_BACKUP_TEST_DATABASE_URL
const sourceAdminUrl = process.env.HABITTROVE_FAMILY_BACKUP_TEST_ADMIN_URL
const targetUrl = process.env.HABITTROVE_FAMILY_RESTORE_TEST_DATABASE_URL
const targetAdminUrl = process.env.HABITTROVE_FAMILY_RESTORE_TEST_ADMIN_URL
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!sourceUrl && !!sourceAdminUrl && !!targetUrl && !!targetAdminUrl
const original = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL }
const cli = fileURLToPath(new URL('../scripts/database.mjs', import.meta.url))
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function command(args: string[], cwd: string) {
  return spawnSync('node', [cli, ...args, '--allow-test-database'], { cwd, env: process.env, encoding: 'utf8', timeout: 30_000 })
}
async function targetCounts(client: Client) {
  return (await client.query(`SELECT (SELECT count(*)::int FROM habittrove.users) users,
    (SELECT count(*)::int FROM habittrove.documents) documents,(SELECT count(*)::int FROM habittrove.coin_ledger) ledger,
    (SELECT count(*)::int FROM habittrove.global_wallet_totals) wallets,(SELECT enabled FROM habittrove.family_configuration WHERE singleton) enabled`)).rows[0]
}

describe.skipIf(!enabled)('complete family backup and isolated offline restoration', () => {
  afterAll(async () => {
    await closeDatabase()
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  test('prepares/maps/activates explicitly; scheduled no-session archive restores all family data, assets and global coins exactly', async () => {
    for (const url of [sourceUrl!, sourceAdminUrl!, targetUrl!, targetAdminUrl!]) if (!/^\/habittrove_test_family_(backup_source|backup_restore)$/.test(new URL(url).pathname)) throw new Error('Family backup tests require their dedicated fresh targets')
    process.env.DATABASE_URL = sourceUrl!; process.env.DATABASE_MIGRATION_URL = sourceAdminUrl!
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-family-drill-'))
    const data = path.join(directory, 'data')
    await fs.mkdir(data, { mode: 0o700 }); await fs.mkdir(path.join(data, 'avatars')); await fs.mkdir(path.join(data, 'evidence'))
    const evidence = '11111111-1111-4111-8111-111111111111', withdrawn = '22222222-2222-4222-8222-222222222222'
    const avatar = Buffer.from('global-avatar'), activePhoto = Buffer.from('active-evidence'), removedPhoto = Buffer.from('removed-evidence')
    await fs.writeFile(path.join(data, 'avatars', 'admin.png'), avatar)
    await fs.writeFile(path.join(data, 'evidence', `${evidence}.png`), activePhoto)
    await fs.writeFile(path.join(data, 'evidence', `${withdrawn}.png`), removedPhoto)
    const externalKey = 'separate-private-family-recovery-key-over-32-characters'
    const key = Buffer.from(hkdfSync('sha256', externalKey, 'HabitTrove admin config v1', 'OIDC client secret', 32))
    const iv = Buffer.alloc(12, 5), cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update('retained-provider-secret'), cipher.final()])
    const encryptedClientSecret = [iv, cipher.getAuthTag(), ciphertext].map(item => item.toString('base64url')).join('.')
    const password = saltAndHashPassword('fixture-local-login-password')
    const permissions = [{ habit: { write: true, interact: true }, wishlist: { write: true, interact: true }, coins: { write: true, interact: true } }]
    const fixture: DatabaseSnapshot = {
      auth: { users: [{ id: 'admin', username: 'Admin', isAdmin: true, password, email: 'owner@example.test', avatarPath: '/data/avatars/admin.png', authentikSubject: 'issuer-subject-preserved', oidcIssuer: 'https://issuer.example', authVersion: 4 }, { id: 'dual', username: 'Dual', permissions, personalFolders: [{ id: 'old-folder', name: 'Kept', itemIds: ['habit-a', 'habit-b'] }], statusDays: [{ date: '2026-01-01', status: 'rest' }] }, { id: 'removed', username: 'Removed', permissions }, { id: 'bowner', username: 'OwnerB', permissions }] },
      habits: { habits: [{ id: 'habit-a', name: 'A', description: '', frequency: 'FREQ=DAILY', coinReward: 0.25, userIds: ['dual'], approverIds: ['admin'], completions: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'], completionRecords: [null, { id: evidence, actorId: 'dual', approval: 'approved', rewardAmount: 0.25, rewardedUserIds: ['dual'], evidenceId: evidence, evidenceMime: 'image/png' }, { id: withdrawn, actorId: 'removed', approval: 'pending', evidenceId: withdrawn, evidenceMime: 'image/png' }] }, { id: 'habit-b', name: 'B', description: '', frequency: 'FREQ=DAILY', coinReward: 0.5, userIds: ['dual', 'bowner'], completions: ['2026-01-01T00:00:00Z'], completionRecords: [{ id: 'voided-legacy', actorId: 'historical-deleted', voided: true, rewardedUserIds: [], requestId: '33333333-3333-4333-8333-333333333333' }] }] },
      wishlist: { items: [{ id: 'reward-a', name: 'A reward', description: '', coinCost: 0.75, userIds: ['dual'] }, { id: 'reward-b', name: 'B reward', description: '', coinCost: 0.75, userIds: ['dual'] }] },
      coins: { balance: 3.2, transactions: [
        { id: 'credit-a', userId: 'dual', actorId: 'admin', amount: 1.25, type: 'MANUAL_ADJUSTMENT', description: 'A', timestamp: '2026-01-01T00:00:00Z' },
        { id: 'credit-b', userId: 'dual', actorId: 'bowner', amount: 2.5, type: 'MANUAL_ADJUSTMENT', description: 'B', timestamp: '2026-01-01T00:00:00Z' },
        { id: 'spend-b', userId: 'dual', amount: -0.75, type: 'WISH_REDEMPTION', description: 'Combined wallet spend', relatedItemId: 'reward-b', timestamp: '2026-01-02T00:00:00Z' },
        { id: 'removed-credit', userId: 'removed', amount: 0.2, type: 'MANUAL_ADJUSTMENT', description: 'Retained after leaving', timestamp: '2026-01-01T00:00:00Z' },
      ] }, settings: getDefaultSettings(), adminConfig: { version: 1, logLevel: 'info', oidcOverride: { issuer: 'https://issuer.example', clientId: 'retained-client', encryptedClientSecret } },
      attachments: [{ id: 'avatar:admin.png', owner_id: 'admin', path: 'avatars/admin.png', mime_type: 'image/png', sha256: digest(avatar) }, { id: evidence, habit_id: 'habit-a', completion_id: evidence, owner_id: 'dual', path: `evidence/${evidence}.png`, mime_type: 'image/png', sha256: digest(activePhoto) }, { id: withdrawn, habit_id: 'habit-a', completion_id: withdrawn, owner_id: 'removed', path: `evidence/${withdrawn}.png`, mime_type: 'image/png', sha256: digest(removedPhoto) }],
    }
    const sourceAdmin = new Client({ connectionString: sourceAdminUrl }), restoreAdmin = new Client({ connectionString: targetAdminUrl })
    await sourceAdmin.connect(); await restoreAdmin.connect()
    const inventory = (await sourceAdmin.query('SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database ORDER BY datname')).rows
    const cwd = spyOn(process, 'cwd').mockReturnValue(directory)
    try {
      expect(await importDatabaseSnapshot(fixture, 'family-drill-stage-a')).toBe('imported')
      const prepared = command(['prepare-family'], directory)
      expect(prepared.status).toBe(0)
      expect(await migrateFamilyDatabase()).toBe('verified')
      const unmapped = await previewFamilyActivation()
      expect(unmapped.canActivate).toBe(false)
      expect(unmapped.issues.unmapped_habits).toBe(2)
      await expect(activateFamilyDatabase(unmapped.sourceHash)).rejects.toThrow('complete explicit mapping')
      const create = async (name: string, ownerId: string) => {
        const file = path.join(directory, `create-${ownerId}.json`); await fs.writeFile(file, JSON.stringify({ name, ownerId }))
        const result = command(['create-family', file], directory); expect(result.status).toBe(0)
        return JSON.parse(result.stdout).familyId as string
      }
      const a = await create('Family A', 'admin'), b = await create('Family B', 'bowner')
      for (const mapping of [{ familyId: a, userIds: ['admin', 'dual', 'removed'], habitIds: ['habit-a'], wishlistIds: ['reward-a'], ledgerIds: ['credit-a', 'removed-credit'], managers: [] }, { familyId: b, userIds: ['dual', 'bowner'], habitIds: ['habit-b'], wishlistIds: ['reward-b'], ledgerIds: ['credit-b', 'spend-b'], managers: [] }]) {
        const file = path.join(directory, `mapping-${mapping.familyId}.json`)
        await fs.writeFile(file, JSON.stringify(mapping))
        const preview = command(['preview-family-mapping', file], directory); expect(preview.status).toBe(0)
        await fs.writeFile(file, JSON.stringify({ ...mapping, expectedSourceHash: JSON.parse(preview.stdout).sourceHash }))
        expect(command(['apply-family-mapping', file], directory).status).toBe(0)
      }
      await sourceAdmin.query('BEGIN'); await sourceAdmin.query("SELECT set_config('habittrove.site_admin','true',true)")
      await sourceAdmin.query("UPDATE habittrove.family_memberships SET active=false,removed_at='2026-02-01T00:00:00Z' WHERE family_id=$1 AND user_id='removed'", [a])
      await sourceAdmin.query('UPDATE habittrove.attachments SET inaccessible=true WHERE id=$1', [withdrawn])
      await sourceAdmin.query("UPDATE habittrove.completions SET voided=true,approval='rejected',needs_review=true WHERE id=$1", [withdrawn])
      await sourceAdmin.query("UPDATE habittrove.habits SET attributes=jsonb_set(attributes,'{fields,legacyExtension}',to_jsonb('kept-opaque-value'::text),true) WHERE id='habit-a'")
      await sourceAdmin.query("INSERT INTO habittrove.household_invitations(token_hash,family_id,email,role,created_by,expires_at,revoked_at) VALUES($1,$2,'invite@example.test','member','admin','2027-01-01','2026-02-01')", [digest('revoked-invitation'), a])
      await sourceAdmin.query("UPDATE habittrove.family_preferences SET preferences=preferences || '{\"notificationRead\":\"retained-family-a\"}'::jsonb WHERE family_id=$1 AND user_id='dual'", [a])
      await sourceAdmin.query("INSERT INTO habittrove.coin_ledger(id,ordinal,user_id,actor_id,amount,type,occurred_at,attributes,family_id) VALUES('post-prepare-credit',-100,'dual','admin',0.05,'MANUAL_ADJUSTMENT','2026-02-01','{\"fields\":{},\"present\":[]}',$1)", [a])
      await sourceAdmin.query('COMMIT')
      await fs.unlink(path.join(data, 'evidence', `${withdrawn}.png`))
      const preview = await previewFamilyActivation()
      expect(preview.canActivate).toBe(true)
      await sourceAdmin.query("UPDATE habittrove.family_settings SET settings=settings || '{\"timezone\":\"Europe/London\"}'::jsonb WHERE family_id=$1", [b])
      await expect(activateFamilyDatabase(preview.sourceHash)).rejects.toThrow('changed')
      const fresh = await previewFamilyActivation()
      expect(await activateFamilyDatabase(fresh.sourceHash)).toBe('activated')
      const role = await withStorageTransaction(async () => (await currentDatabaseClient()!.query("SELECT current_user AS role,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','SELECT') AS sequence_select,has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','USAGE') AS sequence_usage,has_table_privilege(current_user,'habittrove.family_configuration','UPDATE') AS configuration_write,has_table_privilege(current_user,'habittrove.global_wallet_totals','UPDATE') AS wallet_write FROM pg_roles WHERE rolname=current_user")).rows[0], { readOnly: true })
      expect(role).toEqual({ role: 'habittrove_test_runtime', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false, sequence_select: false, sequence_usage: true, configuration_write: false, wallet_write: false })
      await expect(captureDatabaseSource(data)).rejects.toThrow('version 2')
      const hidden = await withStorageTransaction(async () => (await currentDatabaseClient()!.query('SELECT count(*)::int AS count FROM habittrove.habits')).rows[0].count, { readOnly: true })
      expect(hidden).toBe(0)
      const snapshot = await captureFamilyDatabaseSource(data)
      expect(snapshot.snapshot.tables.habits).toHaveLength(2)
      expect(snapshot.manifest.ledgerTotals).toEqual({ dual: '3.05', removed: '0.2' })
      expect(snapshot.snapshot.tables.family_memberships).toHaveLength(5)
      await verifyFamilyDatabase(snapshot)
      const sequence = await withFamilyOperationalScope(async () => (await currentDatabaseClient()!.query("SELECT nextval('habittrove.coin_ledger_family_order')::text AS next")).rows[0].next)
      expect(BigInt(sequence)).toBeLessThan(BigInt(-100))
      const exportDirectory = path.join(directory, 'reverse-family')
      const exported = command(['export', exportDirectory], directory)
      expect(exported.status).toBe(0)
      expect((await readFamilySource(exportDirectory)).snapshot).toEqual(snapshot.snapshot)
      expect(command(['verify-family', exportDirectory], directory).status).toBe(0)
      const { runBackup } = await import('./backup')
      await runBackup({ scheduled: true }); await runBackup({ scheduled: true })
      const archives = (await fs.readdir(path.join(directory, 'backups'))).filter(name => name.endsWith('.zip'))
      expect(archives).toHaveLength(1)
      const recovered = path.join(directory, 'recovered')
      expect(spawnSync('unzip', ['-q', path.join(directory, 'backups', archives[0]), '-d', recovered]).status).toBe(0)
      const archive = await readFamilySource(recovered)
      expect(archive.snapshot).toEqual(snapshot.snapshot)
      expect(archive.manifest.version).toBe(2)
      expect(archive.assets.get(`evidence/${evidence}.png`)).toEqual(activePhoto)
      expect(archive.assets.has(`evidence/${withdrawn}.png`)).toBe(false)
      expect(JSON.stringify(archive.manifest)).not.toContain(externalKey)
      expect(JSON.stringify(archive.snapshot)).not.toContain(externalKey)
      expect(JSON.stringify(archive.snapshot)).not.toContain('fixture-local-login-password')
      await closeDatabase(); process.env.DATABASE_URL = targetUrl!; process.env.DATABASE_MIGRATION_URL = targetAdminUrl!
      expect(await migrateFamilyDatabase()).toBe('prepared')
      const restoreApp = path.join(directory, 'restore-app'); await fs.mkdir(restoreApp)
      const targetData = path.join(restoreApp, 'data'); await fs.mkdir(targetData)
      await fs.cp(path.join(recovered, 'avatars'), path.join(targetData, 'avatars'), { recursive: true })
      await fs.cp(path.join(recovered, 'evidence'), path.join(targetData, 'evidence'), { recursive: true })
      delete process.env.DATABASE_MIGRATION_URL
      await expect(restoreFamilyDatabase(archive, targetData)).rejects.toThrow('DATABASE_MIGRATION_URL')
      process.env.DATABASE_MIGRATION_URL = targetUrl!
      await expect(restoreFamilyDatabase(archive, targetData)).rejects.toThrow('separate migration identity')
      process.env.DATABASE_MIGRATION_URL = targetAdminUrl!
      const partial = structuredClone(archive.snapshot)
      partial.tables.checklist_entries.push(['missing-habit', '0', 'bad', 'must roll back', 'false', a])
      await expect(restoreFamilyDatabase(createFamilyBackupSource(partial, archive.assets), targetData)).rejects.toThrow()
      expect(await targetCounts(restoreAdmin)).toEqual({ users: 0, documents: 0, ledger: 0, wallets: 0, enabled: false })
      const incomplete = structuredClone(archive.snapshot)
      incomplete.tables.families.push(['orphan-family', 'Incomplete', '1', '2026-01-01 00:00:00+00'])
      await expect(restoreFamilyDatabase(createFamilyBackupSource(incomplete, archive.assets), targetData)).rejects.toThrow('incomplete mapping')
      expect(await targetCounts(restoreAdmin)).toEqual({ users: 0, documents: 0, ledger: 0, wallets: 0, enabled: false })
      await fs.writeFile(path.join(recovered, 'family-database.json'), '{}')
      await expect(readFamilySource(recovered)).rejects.toThrow()
      expect(await targetCounts(restoreAdmin)).toEqual({ users: 0, documents: 0, ledger: 0, wallets: 0, enabled: false })
      const cleanRecovery = path.join(directory, 'clean-recovery')
      expect(spawnSync('unzip', ['-q', path.join(directory, 'backups', archives[0]), '-d', cleanRecovery]).status).toBe(0)
      const preflight = spawnSync('node', [cli, 'dry-run-family', cleanRecovery], { cwd: restoreApp, env: { ...process.env, DATABASE_URL: '', DATABASE_MIGRATION_URL: '' }, encoding: 'utf8' })
      expect(preflight.status).toBe(0)
      expect(JSON.parse(preflight.stdout).version).toBe(2)
      expect(preflight.stdout).not.toContain('owner@example.test')
      const restored = command(['restore-family', cleanRecovery], restoreApp)
      expect(restored.status).toBe(0)
      await verifyFamilyDatabase(archive)
      await expect(restoreFamilyDatabase(archive, targetData)).rejects.toThrow('empty')
      const restoredUser = (await restoreAdmin.query("SELECT password_hash,auth_version FROM habittrove.users WHERE id='admin'")).rows[0]
      expect(verifyPassword('fixture-local-login-password', restoredUser.password_hash)).toBe(true)
      expect(restoredUser.auth_version).toBe(4)
      expect((await restoreAdmin.query('SELECT inaccessible FROM habittrove.attachments WHERE id=$1', [withdrawn])).rows[0].inaccessible).toBe(true)
      const config = (await restoreAdmin.query("SELECT value FROM habittrove.admin_configuration WHERE name='oidcOverride'")).rows[0].value
      const [storedIv, tag, encrypted] = config.encryptedClientSecret.split('.').map((item: string) => Buffer.from(item, 'base64url'))
      const decipher = createDecipheriv('aes-256-gcm', key, storedIv); decipher.setAuthTag(tag)
      expect(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString()).toBe('retained-provider-secret')
      expect((await sourceAdmin.query('SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database ORDER BY datname')).rows).toEqual(inventory)
    } finally { cwd.mockRestore(); await sourceAdmin.end(); await restoreAdmin.end(); await fs.rm(directory, { recursive: true, force: true }) }
  }, 60_000)
})
