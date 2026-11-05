import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Client } from 'pg'

const databases = ['habittrove_test_repository', 'habittrove_test_migration', 'habittrove_test_restore', 'habittrove_test_auth', 'habittrove_test_actions', 'habittrove_test_media', 'habittrove_test_init', 'habittrove_test_init_race']
const runtimeRole = 'habittrove_test_runtime'
const tables = ['documents', 'users', 'oidc_identities', 'permissions', 'manager_assignments', 'folders', 'folder_items', 'status_days', 'invitations', 'habits', 'habit_assignees', 'habit_approvers', 'checklist_entries', 'completions', 'completion_recipients', 'slips', 'wishlist_items', 'wishlist_assignees', 'coin_ledger', 'setting_sections', 'admin_configuration', 'migration_batches', 'authentication_throttles', 'job_leases', 'attachments']

function run(command, args, env) {
  const result = spawnSync(command, args, { env, stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error('Isolated database build or test command failed')
}

async function main() {
  const administrator = new URL(process.env.HABITTROVE_TEST_ADMIN_URL ?? '')
  if (process.env.HABITTROVE_TEST_DATABASE !== '1' || administrator.protocol !== 'postgresql:' || administrator.hostname !== '127.0.0.1' || administrator.port !== '15432' || administrator.pathname !== '/postgres' || administrator.search || administrator.hash || !administrator.password || administrator.username === runtimeRole) {
    throw new Error('Use an explicitly enabled, disposable PostgreSQL service at 127.0.0.1:15432/postgres with a separate administrator')
  }
  const password = randomBytes(32).toString('hex')
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${password}`)
  const adminFor = name => { const url = new URL(administrator); url.pathname = `/${name}`; return url.href }
  const runtimeFor = name => { const url = new URL(adminFor(name)); url.username = runtimeRole; url.password = password; return url.href }
  const environmentFor = name => ({ ...process.env, HABITTROVE_TEST_DATABASE: '1', HABITTROVE_STORAGE: 'postgres', DATABASE_URL: runtimeFor(name), DATABASE_MIGRATION_URL: adminFor(name) })
  const admin = new Client({ connectionString: administrator.href })
  await admin.connect()
  try {
    if (!(await admin.query('SHOW server_version')).rows[0].server_version.startsWith('17.11')) throw new Error('The isolated suite requires PostgreSQL 17.11')
    const occupied = await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [databases])
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [runtimeRole])
    if (occupied.rowCount || role.rowCount) throw new Error('Refusing to overwrite existing test databases or runtime role; start a fresh disposable service')
    await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`)
    for (const name of databases) await admin.query(`CREATE DATABASE ${name}`)
  } finally { await admin.end() }

  run('node', ['scripts/build-database.mjs'], process.env)
  for (const name of databases) {
    run('node', ['scripts/database.mjs', 'migrate', '--allow-test-database'], environmentFor(name))
    const owner = new Client({ connectionString: adminFor(name) })
    await owner.connect()
    try {
      await owner.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO "${runtimeRole}"; GRANT USAGE ON SCHEMA habittrove TO "${runtimeRole}"; GRANT SELECT ON habittrove.schema_version TO "${runtimeRole}"; GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.map(table => `habittrove.${table}`).join(',')} TO "${runtimeRole}"`)
    } finally { await owner.end() }
  }
  const suites = [
    ['habittrove_test_repository', 'lib/db/repository.test.ts'],
    ['habittrove_test_migration', 'lib/db-migration.integration.test.ts'],
    ['habittrove_test_init', 'scripts/database-init.integration.test.ts'],
    ['habittrove_test_auth', 'lib/auth-postgres.test.ts'],
    ['habittrove_test_actions', 'app/actions/data-postgres.test.ts'],
    ['habittrove_test_media', 'lib/attachment-store.test.ts'],
  ]
  for (const [name, file] of suites) {
    const env = environmentFor(name)
    if (name === 'habittrove_test_migration') Object.assign(env, {
      HABITTROVE_MIGRATION_TEST_DATABASE_URL: runtimeFor(name), HABITTROVE_MIGRATION_TEST_ADMIN_URL: adminFor(name),
      HABITTROVE_RESTORE_TEST_DATABASE_URL: runtimeFor('habittrove_test_restore'), HABITTROVE_RESTORE_TEST_ADMIN_URL: adminFor('habittrove_test_restore'),
    })
    if (name === 'habittrove_test_init') Object.assign(env, {
      HABITTROVE_INIT_TEST_DATABASE_URL: runtimeFor(name), HABITTROVE_INIT_TEST_ADMIN_URL: adminFor(name),
      HABITTROVE_INIT_RACE_TEST_DATABASE_URL: runtimeFor('habittrove_test_init_race'),
    })
    run('bun', ['test', file], env)
  }
}

try { await main() } catch {
  // Driver errors can include connection credentials; never forward raw errors to CI logs.
  console.error('Isolated PostgreSQL tests failed. Check the disposable service, required version, fresh names, and test output.')
  process.exitCode = 1
}
