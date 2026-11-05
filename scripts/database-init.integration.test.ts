import { describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertDatabaseTarget } from '../lib/db/client'
import { verifyPassword } from '../lib/password'

const runtimeUrl = process.env.HABITTROVE_INIT_TEST_DATABASE_URL
const adminUrl = process.env.HABITTROVE_INIT_TEST_ADMIN_URL
const raceUrl = process.env.HABITTROVE_INIT_RACE_TEST_DATABASE_URL
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!runtimeUrl && !!adminUrl && !!raceUrl
const script = fileURLToPath(new URL('./database.mjs', import.meta.url))
const credentials = { INITIAL_ADMIN_EMAIL: 'initial-owner@example.test', INITIAL_ADMIN_PASSWORD: 'private-initial-password-for-fixture' }

function assertScratchTarget(url: string) {
  assertDatabaseTarget(url, true)
  if (!/^\/habittrove_test_[a-z0-9_]+$/.test(new URL(url).pathname)) throw new Error('Init tests require an explicit scratch database')
}
function environment(url: string, override: Record<string, string> = {}) {
  return { ...process.env, DATABASE_URL: url, HABITTROVE_TEST_DATABASE: '1', HABITTROVE_STORAGE: 'postgres', ...credentials, ...override }
}
function init(url: string, directory: string, override: Record<string, string> = {}) {
  return spawnSync('node', [script, 'init', '--allow-test-database'], { cwd: directory, env: environment(url, override), encoding: 'utf8', timeout: 20_000 })
}
async function concurrentInit(url: string, directory: string) {
  return new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn('node', [script, 'init', '--allow-test-database'], { cwd: directory, env: environment(url), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes.toString() })
    child.stderr.on('data', bytes => { output += bytes.toString() })
    child.once('error', reject)
    child.once('close', status => resolve({ status, output }))
  })
}
async function counts(client: Client) {
  return (await client.query(`SELECT (SELECT count(*)::int FROM habittrove.users) AS users,
    (SELECT count(*)::int FROM habittrove.documents) AS documents,
    (SELECT count(*)::int FROM habittrove.setting_sections) AS settings,
    (SELECT count(*)::int FROM habittrove.migration_batches) AS batches`)).rows[0]
}

describe.skipIf(!enabled)('offline init against isolated, pre-migrated PostgreSQL with the restricted runtime role', () => {
  test('rejects invalid credentials, rolls back failed initialization, initializes once and refuses account overwrite', async () => {
    assertScratchTarget(runtimeUrl!); assertScratchTarget(adminUrl!)
    const runtimeTarget = new URL(runtimeUrl!), adminTarget = new URL(adminUrl!)
    if (runtimeTarget.hostname !== adminTarget.hostname || runtimeTarget.port !== adminTarget.port || runtimeTarget.pathname !== adminTarget.pathname) throw new Error('Init test admin and runtime targets differ')
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-init-'))
    const runtime = new Client({ connectionString: runtimeUrl }), admin = new Client({ connectionString: adminUrl })
    await runtime.connect(); await admin.connect()
    try {
      expect((await runtime.query('SELECT current_user AS role')).rows[0].role).toBe('habittrove_test_runtime')
      expect(await counts(runtime)).toEqual({ users: 0, documents: 0, settings: 0, batches: 0 })
      await fs.mkdir(path.join(directory, 'data'))
      const original = '{"users":[{"id":"unchanged-legacy-source"}]}'
      await fs.writeFile(path.join(directory, 'data', 'auth.json'), original)
      const invalid = init(runtimeUrl!, directory, { INITIAL_ADMIN_PASSWORD: 'too-short' })
      expect(invalid.status).not.toBe(0)
      expect(invalid.stdout + invalid.stderr).toContain('INITIAL_ADMIN_PASSWORD must be 12-128 characters')
      expect(invalid.stdout + invalid.stderr).not.toContain('too-short')
      expect(await counts(runtime)).toEqual({ users: 0, documents: 0, settings: 0, batches: 0 })
      await admin.query("ALTER TABLE habittrove.setting_sections ADD CONSTRAINT init_fixture_failure CHECK(name <> 'system')")
      try {
        const failed = init(runtimeUrl!, directory)
        expect(failed.status).not.toBe(0)
        expect(await counts(runtime)).toEqual({ users: 0, documents: 0, settings: 0, batches: 0 })
        expect(failed.stdout + failed.stderr).not.toContain(credentials.INITIAL_ADMIN_PASSWORD)
        expect(failed.stdout + failed.stderr).not.toContain(credentials.INITIAL_ADMIN_EMAIL)
      } finally { await admin.query('ALTER TABLE habittrove.setting_sections DROP CONSTRAINT init_fixture_failure') }
      const initialized = init(runtimeUrl!, directory)
      expect(initialized.status).toBe(0)
      expect(initialized.stdout).toContain('HabitTrove initialized')
      expect(initialized.stdout + initialized.stderr).not.toContain(credentials.INITIAL_ADMIN_PASSWORD)
      expect(initialized.stdout + initialized.stderr).not.toContain(credentials.INITIAL_ADMIN_EMAIL)
      expect(await counts(runtime)).toEqual({ users: 1, documents: 5, settings: 3, batches: 1 })
      const before = (await runtime.query('SELECT * FROM habittrove.users')).rows
      expect(before[0].username).toBe('admin')
      expect(verifyPassword(credentials.INITIAL_ADMIN_PASSWORD, before[0].password_hash)).toBe(true)
      expect((await runtime.query('SELECT count(*)::int AS identities FROM habittrove.oidc_identities')).rows[0].identities).toBe(0)
      const denied = init(runtimeUrl!, directory, { INITIAL_ADMIN_PASSWORD: 'different-password-that-must-not-replace' })
      expect(denied.status).not.toBe(0)
      expect((await runtime.query('SELECT * FROM habittrove.users')).rows).toEqual(before)
      expect(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).toBe(original)
      expect(await fs.readdir(directory)).toEqual(['data'])
    } finally { await runtime.end(); await admin.end(); await fs.rm(directory, { recursive: true, force: true }) }
  }, 30_000)

  test('concurrent init creates exactly one administrator and one bootstrap batch', async () => {
    assertScratchTarget(raceUrl!)
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'habittrove-init-race-'))
    const client = new Client({ connectionString: raceUrl })
    await client.connect()
    try {
      expect(await counts(client)).toEqual({ users: 0, documents: 0, settings: 0, batches: 0 })
      const results = await Promise.all([concurrentInit(raceUrl!, directory), concurrentInit(raceUrl!, directory)])
      expect(results.filter(result => result.status === 0)).toHaveLength(1)
      expect(results.filter(result => result.status !== 0)).toHaveLength(1)
      for (const result of results) {
        expect(result.output).not.toContain(credentials.INITIAL_ADMIN_EMAIL)
        expect(result.output).not.toContain(credentials.INITIAL_ADMIN_PASSWORD)
      }
      expect(await counts(client)).toEqual({ users: 1, documents: 5, settings: 3, batches: 1 })
    } finally { await client.end(); await fs.rm(directory, { recursive: true, force: true }) }
  }, 30_000)
})
