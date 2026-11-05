import { describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const runtime = process.env.HABITTROVE_FAMILY_GENERIC_TEST_DATABASE_URL
const migration = process.env.HABITTROVE_FAMILY_GENERIC_TEST_ADMIN_URL
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!runtime && !!migration
const cli = fileURLToPath(new URL('../scripts/database.mjs', import.meta.url))
describe.skipIf(!enabled)('configured generic runtime login for offline family preparation', () => {
  test('supports quoted restricted names and rejects privileged attributes, memberships and schema authority', async () => {
    if (new URL(runtime!).pathname !== '/habittrove_test_family_backup_generic' || new URL(migration!).pathname !== '/habittrove_test_family_backup_generic') throw new Error('Runtime tests require their dedicated scratch database')
    const name = decodeURIComponent(new URL(runtime!).username), quoted = `"${name.replace(/"/g, '""')}"`
    const admin = new Client({ connectionString: migration }), app = new Client({ connectionString: runtime })
    const run = () => spawnSync('node', [cli, 'prepare-family', '--allow-test-database'], { env: { ...process.env, DATABASE_URL: runtime!, DATABASE_MIGRATION_URL: migration! }, encoding: 'utf8', timeout: 30_000 })
    await admin.connect()
    try {
      expect(run().status).toBe(0)
      await app.connect()
      expect((await app.query('SELECT current_user AS role')).rows[0].role).toBe(name)
      expect((await app.query(`SELECT has_table_privilege(current_user,'habittrove.family_configuration','SELECT') AS config_read,
        has_table_privilege(current_user,'habittrove.family_configuration','UPDATE') AS config_write,
        has_table_privilege(current_user,'habittrove.global_wallet_totals','UPDATE') AS wallet_write,
        has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','USAGE') AS sequence_use`)).rows[0]).toEqual({ config_read: true, config_write: false, wallet_write: false, sequence_use: true })
      expect(run().status).toBe(0)
      await admin.query(`GRANT CREATE ON SCHEMA habittrove TO ${quoted}`)
      try { expect(run().status).not.toBe(0) }
      finally { await admin.query(`REVOKE CREATE ON SCHEMA habittrove FROM ${quoted}`) }
      await admin.query(`ALTER ROLE ${quoted} CREATEDB`)
      try { expect(run().status).not.toBe(0) }
      finally { await admin.query(`ALTER ROLE ${quoted} NOCREATEDB`) }
      await admin.query(`GRANT pg_read_all_data TO ${quoted}`)
      try { expect(run().status).not.toBe(0) }
      finally { await admin.query(`REVOKE pg_read_all_data FROM ${quoted}`) }
      expect(run().status).toBe(0)
      await admin.query(`GRANT UPDATE(enabled) ON habittrove.family_configuration TO ${quoted}`)
      try {
        expect(run().status).toBe(0)
        expect((await app.query("SELECT has_any_column_privilege(current_user,'habittrove.family_configuration','UPDATE') AS writable")).rows[0].writable).toBe(false)
      } finally { await admin.query(`REVOKE UPDATE(enabled) ON habittrove.family_configuration FROM ${quoted}`) }
      const parent = 'family_backup_privilege_parent'
      await admin.query(`CREATE ROLE ${parent} NOLOGIN`)
      try {
        await admin.query(`ALTER ROLE ${quoted} NOINHERIT`)
        await admin.query(`GRANT UPDATE ON habittrove.global_wallet_totals TO ${parent}`)
        await admin.query(`GRANT ${parent} TO ${quoted}`)
        expect((await app.query("SELECT has_table_privilege(current_user,'habittrove.global_wallet_totals','UPDATE') AS effective")).rows[0].effective).toBe(false)
        expect(run().status).not.toBe(0)
        await admin.query(`REVOKE UPDATE ON habittrove.global_wallet_totals FROM ${parent}`)
        await admin.query(`GRANT UPDATE(balance) ON habittrove.global_wallet_totals TO ${parent}`)
        expect((await app.query("SELECT has_any_column_privilege(current_user,'habittrove.global_wallet_totals','UPDATE') AS effective")).rows[0].effective).toBe(false)
        expect(run().status).not.toBe(0)
      } finally {
        await admin.query(`REVOKE ${parent} FROM ${quoted}`)
        await admin.query(`ALTER ROLE ${quoted} INHERIT`)
        await admin.query(`REVOKE UPDATE ON habittrove.global_wallet_totals FROM ${parent}`)
        await admin.query(`REVOKE UPDATE(balance) ON habittrove.global_wallet_totals FROM ${parent}`)
        await admin.query(`DROP ROLE ${parent}`)
      }
      expect(run().status).toBe(0)
    } finally { await app.end(); await admin.end() }
  }, 30_000)
})
