import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Pool } from 'pg'
import { randomBytes } from 'node:crypto'
import { closeDatabase, currentDatabaseClient, migrateDatabase, withStorageTransaction } from './db/client'
import { readAuthDocument, readDocument, writeAuthDocument, writeDocument } from './db/repository'
import { getDefaultSettings } from './types'

mock.module('server-only', () => ({}))
const { validateRuntimeStorage } = await import('./env.server')
const { migrateFamilyDatabase } = await import('./family-backup')
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL &&
  new URL(process.env.DATABASE_URL).pathname === '/habittrove_test_family_startup'
let owner: Pool
const actor = { id: 'startup-admin', username: 'Startup admin', email: 'startup@example.test', isAdmin: true, authVersion: 3 }

async function assertNoOperationalScope(): Promise<void> {
  await withStorageTransaction(async () => {
    const state = (await currentDatabaseClient()!.query(`SELECT current_setting('habittrove.site_admin',true) AS admin,
      current_setting('habittrove.actor_id',true) AS actor`)).rows[0]
    expect(state.admin || '').toBe('')
    expect(state.actor || '').toBe('')
  }, { readOnly: true })
}

describe.skipIf(!enabled)('family schema and startup (separate restricted-role local fixture)', () => {
  beforeAll(async () => {
    const runtime = new URL(process.env.DATABASE_URL!)
    const migration = new URL(process.env.DATABASE_MIGRATION_URL!)
    if (runtime.hostname !== '127.0.0.1' || runtime.port !== '15432' || migration.host !== runtime.host || migration.pathname !== runtime.pathname) {
      throw new Error('Family startup tests require the separate local fixture')
    }
    owner = new Pool({ connectionString: migration.href })
    const prepared = (await owner.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name
    if (prepared) {
      await owner.query('UPDATE habittrove.family_configuration SET enabled=false WHERE singleton')
      await owner.query('TRUNCATE habittrove.families CASCADE')
    }
    await owner.query('UPDATE habittrove.schema_version SET version=1 WHERE singleton')
    await owner.query('TRUNCATE habittrove.users,habittrove.habits,habittrove.wishlist_items,habittrove.coin_ledger,habittrove.attachments CASCADE')
    await owner.query('DELETE FROM habittrove.documents')
    await withStorageTransaction(async () => {
      await writeAuthDocument({ users: [actor] })
      await writeDocument('habits', { habits: [{ id: 'legacy-habit', name: 'Preserved', description: '', frequency: 'daily', coinReward: 1, completions: [], userIds: [actor.id] }] })
      await writeDocument('wishlist', { items: [] })
      await writeDocument('coins', { balance: 1, transactions: [{ id: 'legacy-coin', amount: 1, userId: actor.id, type: 'MANUAL_ADJUSTMENT', description: 'Preserved', timestamp: '2026-01-01T00:00:00Z' }] })
      await writeDocument('settings', getDefaultSettings())
    })
  })
  afterAll(async () => { await closeDatabase(); await owner?.end() })

  test('preserves initialized Stage A behavior on schema version 1 without enabling families', async () => {
    await expect(validateRuntimeStorage()).resolves.toBeUndefined()
    expect((await readDocument<{ habits: { id: string }[] }>('habits'))?.habits[0].id).toBe('legacy-habit')
  })
  test('accepts prepared version 2 while disabled without mapping or seeding domain rows', async () => {
    const prepared = (await owner.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name
    if (prepared) await owner.query('UPDATE habittrove.schema_version SET version=2 WHERE singleton')
    await migrateFamilyDatabase()
    await expect(migrateDatabase()).resolves.toBeUndefined()
    await expect(validateRuntimeStorage()).resolves.toBeUndefined()
    expect((await owner.query('SELECT family_id FROM habittrove.habits WHERE id=$1', ['legacy-habit'])).rows[0].family_id).toBeNull()
    expect((await owner.query('SELECT enabled FROM habittrove.family_configuration')).rows[0].enabled).toBe(false)
  })
  test('audits SET ROLE-reachable NOINHERIT ACLs while preserving a benign reader group', async () => {
    await owner.query('UPDATE habittrove.schema_version SET version=2 WHERE singleton')
    await migrateFamilyDatabase()
    const originalUrl = process.env.DATABASE_URL!
    const suffix = randomBytes(8).toString('hex')
    const login = `startup_login_${suffix}`, parent = `startup_reader_${suffix}`
    const qLogin = `"${login}"`, qParent = `"${parent}"`
    const password = randomBytes(32).toString('hex')
    let loginCreated = false, parentCreated = false
    try {
      await owner.query(`CREATE ROLE ${qLogin} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`)
      loginCreated = true
      await owner.query(`CREATE ROLE ${qParent} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
      parentCreated = true
      await owner.query(`GRANT CONNECT ON DATABASE habittrove_test_family_startup TO ${qLogin}`)
      await owner.query(`GRANT USAGE ON SCHEMA habittrove TO ${qLogin},${qParent}`)
      await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA habittrove TO ${qLogin}`)
      await owner.query(`GRANT SELECT ON habittrove.documents,habittrove.family_configuration,habittrove.global_wallet_totals TO ${qParent}`)
      await owner.query(`GRANT ${qParent} TO ${qLogin}`)
      const membership = (await owner.query(`SELECT inherit_option,set_option FROM pg_auth_members
        WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1) AND roleid=(SELECT oid FROM pg_roles WHERE rolname=$2)`, [login, parent])).rows[0]
      expect(membership.inherit_option).toBe(false)
      expect(membership.set_option).toBe(true)
      const target = new URL(originalUrl)
      target.username = login
      target.password = password
      await closeDatabase()
      process.env.DATABASE_URL = target.href
      await expect(validateRuntimeStorage()).resolves.toBeUndefined()
      await withStorageTransaction(async () => {
        await currentDatabaseClient()!.query(`SET LOCAL ROLE ${qParent}`)
        expect((await currentDatabaseClient()!.query('SELECT current_user AS name')).rows[0].name).toBe(parent)
        expect((await currentDatabaseClient()!.query('SELECT count(*)::int AS count FROM habittrove.family_configuration')).rows[0].count).toBe(1)
      }, { readOnly: true })
      const cases = [
        { grant: `CREATE ON SCHEMA habittrove`, check: "has_schema_privilege(current_user,'habittrove','CREATE')" },
        { grant: `CREATE ON DATABASE habittrove_test_family_startup`, check: "has_database_privilege(current_user,current_database(),'CREATE')" },
        { grant: `UPDATE ON habittrove.family_configuration`, check: "has_table_privilege(current_user,'habittrove.family_configuration','UPDATE')" },
        { grant: `UPDATE ON habittrove.global_wallet_totals`, check: "has_table_privilege(current_user,'habittrove.global_wallet_totals','UPDATE')" },
        { grant: `UPDATE(enabled) ON habittrove.family_configuration`, check: "has_any_column_privilege(current_user,'habittrove.family_configuration','UPDATE')" },
        { grant: `UPDATE(balance) ON habittrove.global_wallet_totals`, check: "has_any_column_privilege(current_user,'habittrove.global_wallet_totals','UPDATE')" },
      ]
      for (const item of cases) {
        await owner.query(`GRANT ${item.grant} TO ${qParent}`)
        try {
          await withStorageTransaction(async () => {
            expect((await currentDatabaseClient()!.query(`SELECT ${item.check} AS allowed`)).rows[0].allowed).toBe(false)
            await currentDatabaseClient()!.query(`SET LOCAL ROLE ${qParent}`)
            expect((await currentDatabaseClient()!.query(`SELECT ${item.check} AS allowed`)).rows[0].allowed).toBe(true)
          }, { readOnly: true })
          await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed')
        } finally { await owner.query(`REVOKE ${item.grant} FROM ${qParent}`) }
      }
      await expect(validateRuntimeStorage()).resolves.toBeUndefined()
    } finally {
      await closeDatabase()
      process.env.DATABASE_URL = originalUrl
      if (loginCreated && parentCreated) await owner.query(`REVOKE ${qParent} FROM ${qLogin}`)
      for (const [role, created] of [[qLogin, loginCreated], [qParent, parentCreated]] as const) {
        if (!created) continue
        await owner.query(`REVOKE ALL ON DATABASE habittrove_test_family_startup FROM ${role}`)
        await owner.query(`REVOKE ALL ON SCHEMA habittrove FROM ${role}`)
        await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA habittrove FROM ${role}`)
        await owner.query(`DROP ROLE ${role}`)
      }
    }
  })
  test('rejects enabled families on version 1 and unsupported schema versions', async () => {
    await owner.query('UPDATE habittrove.family_configuration SET enabled=true WHERE singleton')
    await owner.query('UPDATE habittrove.schema_version SET version=1 WHERE singleton')
    try { await expect(withStorageTransaction(async () => undefined, { readOnly: true })).rejects.toThrow('family schema preparation required') }
    finally { await owner.query('UPDATE habittrove.family_configuration SET enabled=false WHERE singleton') }
    await owner.query('UPDATE habittrove.schema_version SET version=3 WHERE singleton')
    try { await expect(withStorageTransaction(async () => undefined, { readOnly: true })).rejects.toThrow('schema migration required') }
    finally { await owner.query('UPDATE habittrove.schema_version SET version=2 WHERE singleton') }
  })
  test('rejects an incomplete version 2 marker and missing forced RLS', async () => {
    await owner.query('DELETE FROM habittrove.family_configuration')
    try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
    finally { await owner.query('INSERT INTO habittrove.family_configuration VALUES(true,false)') }
    await owner.query('GRANT UPDATE ON habittrove.family_configuration TO "Mac89Habittrove"')
    try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
    finally { await owner.query('REVOKE UPDATE ON habittrove.family_configuration FROM "Mac89Habittrove"') }
    await owner.query('ALTER TABLE habittrove.habits NO FORCE ROW LEVEL SECURITY')
    try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
    finally { await owner.query('ALTER TABLE habittrove.habits FORCE ROW LEVEL SECURITY') }
  })
  test('validates enabled storage without HTTP identity or an empty-context DTO read', async () => {
    await owner.query("INSERT INTO habittrove.families(id,name) VALUES('startup-family','Startup family')")
    await owner.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('startup-family',$1,'owner')", [actor.id])
    await owner.query("INSERT INTO habittrove.family_document_revisions(family_id,kind) VALUES('startup-family','habits'),('startup-family','wishlist')")
    await owner.query("INSERT INTO habittrove.family_settings(family_id,settings) VALUES('startup-family','{}')")
    await owner.query("INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) SELECT 'startup-family',$1,resource,true,true FROM unnest(ARRAY['habit','wishlist','coins']) resource", [actor.id])
    await owner.query("UPDATE habittrove.habits SET family_id='startup-family'")
    await owner.query("UPDATE habittrove.habit_assignees SET family_id='startup-family'")
    await owner.query("UPDATE habittrove.coin_ledger SET family_id='startup-family'")
    await owner.query('UPDATE habittrove.family_configuration SET enabled=true WHERE singleton')
    await withStorageTransaction(async () => {
      expect((await currentDatabaseClient()!.query('SELECT id FROM habittrove.habits')).rows).toEqual([])
    }, { readOnly: true })
    await expect(readDocument('habits')).rejects.toThrow('Validated family context required')
    await expect(validateRuntimeStorage()).resolves.toBeUndefined()
    expect((await readAuthDocument())?.users).toEqual([actor])
    await assertNoOperationalScope()
  })
  test('sees hidden unmapped ledger origins and restores scope after denial', async () => {
    await owner.query("UPDATE habittrove.coin_ledger SET family_id=NULL WHERE id='legacy-coin'")
    try {
      await withStorageTransaction(async () => {
        expect((await currentDatabaseClient()!.query('SELECT id FROM habittrove.coin_ledger')).rows).toEqual([])
      }, { readOnly: true })
      await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed')
    } finally { await owner.query("UPDATE habittrove.coin_ledger SET family_id='startup-family' WHERE id='legacy-coin'") }
    await assertNoOperationalScope()
  })
  test('rejects missing global and household document metadata without recreating it', async () => {
    const metadata = (await owner.query("DELETE FROM habittrove.documents WHERE kind='settings' RETURNING metadata,revision")).rows[0]
    try {
      await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed')
      expect((await owner.query("SELECT 1 FROM habittrove.documents WHERE kind='settings'")).rowCount).toBe(0)
    } finally { await owner.query("INSERT INTO habittrove.documents(kind,metadata,revision) VALUES('settings',$1,$2)", [metadata.metadata, metadata.revision]) }
    const familyMetadata = (await owner.query("DELETE FROM habittrove.family_document_revisions WHERE family_id='startup-family' AND kind='habits' RETURNING metadata,revision")).rows[0]
    try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
    finally { await owner.query("INSERT INTO habittrove.family_document_revisions(family_id,kind,metadata,revision) VALUES('startup-family','habits',$1,$2)", [familyMetadata.metadata, familyMetadata.revision]) }
    const settings = (await owner.query("DELETE FROM habittrove.family_settings WHERE family_id='startup-family' RETURNING settings")).rows[0].settings
    try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
    finally { await owner.query("INSERT INTO habittrove.family_settings(family_id,settings) VALUES('startup-family',$1)", [settings]) }
    const permission = (await owner.query("DELETE FROM habittrove.family_permissions WHERE family_id='startup-family' AND resource='habit' RETURNING user_id,can_write,can_interact")).rows[0]
    try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
    finally { await owner.query("INSERT INTO habittrove.family_permissions VALUES('startup-family',$1,'habit',$2,$3)", [permission.user_id, permission.can_write, permission.can_interact]) }
    await expect(validateRuntimeStorage()).resolves.toBeUndefined()
    await assertNoOperationalScope()
  })
})
