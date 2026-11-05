import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const runtime = process.env.HABITTROVE_FAMILY_EMPTY_TEST_DATABASE_URL
const migration = process.env.HABITTROVE_FAMILY_EMPTY_TEST_ADMIN_URL
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!runtime && !!migration
const cli = fileURLToPath(new URL('../scripts/database.mjs', import.meta.url))
describe.skipIf(!enabled)('explicit fresh-family installation path', () => {
  test('prepare + init requires reviewed allow-empty activation, then creates the first family', async () => {
    if (new URL(runtime!).pathname !== '/habittrove_test_family_backup_empty' || new URL(migration!).pathname !== '/habittrove_test_family_backup_empty') throw new Error('Fresh activation requires its dedicated scratch target')
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-empty-family-'))
    const environment = { ...process.env, DATABASE_URL: runtime!, DATABASE_MIGRATION_URL: migration!, INITIAL_ADMIN_EMAIL: 'fresh-admin@example.test', INITIAL_ADMIN_PASSWORD: 'fresh-private-initial-password' }
    const run = (args: string[]) => spawnSync('node', [cli, ...args, '--allow-test-database'], { cwd: directory, env: environment, encoding: 'utf8', timeout: 30_000 })
    const admin = new Client({ connectionString: migration })
    await admin.connect()
    try {
      expect(run(['prepare-family']).status).toBe(0)
      expect(run(['init']).status).toBe(0)
      const normal = JSON.parse(run(['preview-family-activation']).stdout)
      expect(normal.canActivate).toBe(false)
      expect(normal.issues.empty_installation).toBe(1)
      expect(run(['activate-family', '--expected-source-hash', normal.sourceHash]).status).not.toBe(0)
      const reviewed = JSON.parse(run(['preview-family-activation', '--allow-empty']).stdout)
      expect(reviewed.canActivate).toBe(true)
      const activated = run(['activate-family', '--allow-empty', '--expected-source-hash', reviewed.sourceHash])
      expect(activated.status).toBe(0)
      expect(activated.stdout).not.toContain(environment.INITIAL_ADMIN_EMAIL)
      expect(activated.stdout).not.toContain(environment.INITIAL_ADMIN_PASSWORD)
      const file = path.join(directory, 'first-family.json')
      await fs.writeFile(file, JSON.stringify({ name: 'First family' }))
      expect(run(['create-family', file]).status).toBe(0)
      expect((await admin.query('SELECT count(*)::int AS count FROM habittrove.families')).rows[0].count).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS count FROM habittrove.family_document_revisions')).rows[0].count).toBe(2)
      expect((await admin.query('SELECT count(*)::int AS count FROM habittrove.family_permissions')).rows[0].count).toBe(3)
    } finally { await admin.end(); await fs.rm(directory, { recursive: true, force: true }) }
  }, 30_000)
})
