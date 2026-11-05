import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { closeDatabase, currentDatabaseClient, migrateDatabase, withStorageTransaction } from './db/client'
import { readAdminDocument, readAuthDocument, writeAdminDocument, writeAuthDocument, writeDocument } from './db/repository'
import { saltAndHashPassword } from './password'
import { Pool } from 'pg'
import { randomBytes } from 'crypto'

mock.module('server-only', () => ({}))
const { acquirePasswordVerification, clearAuthenticationAttempts, reserveAuthenticationAttempt } = await import('./auth-throttle')
const auth = await import('./auth-store')
const config = await import('./admin-config')
const { validateRuntimeStorage } = await import('./env.server')
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL &&
  new URL(process.env.DATABASE_URL).pathname === '/habittrove_test_auth'
const password = 'test-correct-password-123'
const account = { id: 'auth-admin', username: 'Admin', email: 'admin@example.test', isAdmin: true,
  password: saltAndHashPassword(password), authVersion: 3 }
const envNames = ['AUTH_SECRET', 'AUTH_URL', 'AUTHENTIK_ISSUER', 'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET'] as const
const original = Object.fromEntries(envNames.map(name => [name, process.env[name]]))

async function checkFreshStartup(fails: boolean, databaseUrl = process.env.DATABASE_URL!): Promise<void> {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module('server-only',()=>({}));
    const config = await import('./lib/admin-config.ts');
    const {closeDatabase} = await import('./lib/db/client.ts');
    try {
      if (process.env.EXPECT_STARTUP_FAILURE === '1') {
        await assert.rejects(() => config.getActiveOidcConfig());
        await assert.rejects(() => config.initializeAdminConfiguration());
      } else {
        assert.equal(await config.getActiveOidcConfig(), undefined);
        await config.initializeAdminConfiguration();
        assert.equal(config.getApplicationLogLevel(), 'info');
        assert.equal(await config.readSmtpConfig(), undefined);
        const auth = await import('./lib/auth-store.ts');
        assert.equal((await auth.authenticateLocalUser('Admin', 'test-correct-password-123'))?.id, 'auth-admin');
      }
    } finally { await closeDatabase(); }
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl, EXPECT_STARTUP_FAILURE: fails ? '1' : '0' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Startup behavior check failed: ${stderr}`)
}

async function checkAdministratorWriteRace(scenario: string): Promise<void> {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    mock.module('server-only',()=>({}));
    const client = await import('./lib/db/client.ts');
    const store = await import('./lib/auth-store.ts');
    const repository = await import('./lib/db/repository.ts');
    const config = await import('./lib/admin-config.ts');
    const {saltAndHashPassword} = await import('./lib/password.ts');
    const originalTransaction = client.withStorageTransaction;
    const originalVerify = store.verifyStepUpPassword;
    const originalUpdate = store.updateAuthData;
    const scenario = process.env.ADMIN_WRITE_RACE;
    const replacementHash = saltAndHashPassword('changed-password-after-step-up');
    let armed = false;
    let committedRace = false;
    // Commit the competing write immediately before the action's first write transaction.
    mock.module('@/lib/db/client',()=>({...client,withStorageTransaction:async (operation,options={})=>{
      if (armed && !options.readOnly) {
        armed = false;
        await originalUpdate(data=>{
          const actor = data.users.find(user=>user.id==='auth-admin');
          const other = data.users.find(user=>user.id==='auth-backup');
          assert.ok(actor && other);
          if (scenario==='log-demoted') actor.isAdmin=false;
          if (scenario==='name-version') actor.authVersion++;
          if (scenario==='smtp-password') actor.password=replacementHash;
          if (scenario==='oidc-email') actor.email='changed@example.test';
          if (scenario==='oidc-only' || scenario==='oidc-linked') {
            other.authentikSubject='newly-linked-subject';
            other.oidcIssuer='https://original.example.test/issuer';
            if (scenario==='oidc-only') delete other.password;
          }
        });
        committedRace=true;
      }
      return originalTransaction(operation,options);
    }}));
    mock.module('@/lib/auth-store',()=>({...store,verifyStepUpPassword:async (user,password)=>{
      assert.equal(client.currentDatabaseClient(),undefined);
      const valid=await originalVerify(user,password);
      assert.equal(valid,true);
      if(scenario!=='success') armed=true;
      return valid;
    }}));
    mock.module('@/lib/server-helpers',()=>({getCurrentUser:async()=>{
      const user=(await repository.readAuthDocument()).users.find(user=>user.id==='auth-admin');
      if(scenario==='log-demoted' || scenario==='name-version') armed=true;
      return user;
    }}));
    const actions=await import('./app/actions/admin.ts');
    const smtp={enabled:false,host:'',port:587,secure:false,from:'',username:'',password:'',currentPassword:'test-correct-password-123'};
    const oidc={enabled:scenario==='oidc-linked',issuer:'https://new.example.test/issuer',clientId:'new-client',clientSecret:'new-secret',currentPassword:'test-correct-password-123'};
    try {
      if(scenario==='success') {
        await actions.updateApplicationLogLevel('warn');
        assert.equal(config.getApplicationLogLevel(),'warn');
        assert.equal((await actions.updateOidcDisplayName('Family login')).oidc.displayName,'Family login');
        await actions.updateSmtpSettings(smtp);
        await actions.updateOidcProvider({...oidc,enabled:false});
      } else {
        const before=await repository.readAdminDocument();
        const action=scenario==='log-demoted'?()=>actions.updateApplicationLogLevel('error'):
          scenario==='name-version'?()=>actions.updateOidcDisplayName('Changed'):
          scenario==='smtp-password'?()=>actions.updateSmtpSettings(smtp):()=>actions.updateOidcProvider(oidc);
        const expected=scenario==='oidc-only'?/Set local passwords/:
          scenario==='oidc-linked'?/Unlink existing OIDC accounts/:/Administrator access required/;
        await assert.rejects(action,expected);
        assert.equal(committedRace,true);
        assert.deepEqual(await repository.readAdminDocument(),before);
      }
    } finally {await client.closeDatabase();}
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(), env: { ...process.env, ADMIN_WRITE_RACE: scenario }, stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Administrator write race check failed (${scenario}): ${stderr}`)
}

describe.skipIf(!enabled)('PostgreSQL auth integration (isolated auth test database)', () => {
  beforeAll(async () => {
    process.env.AUTH_SECRET = 'test-only-secret-'.repeat(3)
    process.env.AUTH_URL = 'https://habit.example.test'
    process.env.AUTHENTIK_ISSUER = 'https://original.example.test/issuer'
    process.env.AUTHENTIK_CLIENT_ID = 'original-client'
    process.env.AUTHENTIK_CLIENT_SECRET = 'original-secret'
    await migrateDatabase()
  })
  beforeEach(async () => {
    await withStorageTransaction(async () => {
      for (const table of ['authentication_throttles', 'job_leases', 'admin_configuration']) {
        await currentDatabaseClient()!.query(`DELETE FROM ${table}`)
      }
      await currentDatabaseClient()!.query("DELETE FROM documents WHERE kind='admin'")
      await writeAuthDocument({ users: [account] })
      await writeDocument('habits', { habits: [] })
      await writeDocument('wishlist', { items: [] })
      await writeDocument('coins', { balance: 0, transactions: [] })
      await writeDocument('settings', { system: { timezone: 'UTC' } })
    })
  })
  afterAll(async () => {
    for (const name of envNames) {
      if (original[name] === undefined) delete process.env[name]
      else process.env[name] = original[name]
    }
    await closeDatabase()
  })

  test('validates initialized storage using the restricted runtime identity', async () => {
    await expect(validateRuntimeStorage()).resolves.toBeUndefined()
  })
  test('rejects predefined-role membership and effective database/schema ownership or CREATE privileges', async () => {
    const runtimeUrl = process.env.DATABASE_URL!
    const runtime = new URL(runtimeUrl)
    const migration = new URL(process.env.DATABASE_MIGRATION_URL!)
    if (runtime.pathname !== '/habittrove_test_auth' || migration.pathname !== runtime.pathname || migration.host !== runtime.host) {
      throw new Error('Privilege tests require the isolated auth database')
    }
    const suffix = randomBytes(8).toString('hex')
    const login = `habittrove_auth_login_${suffix}`
    const ownerRole = `habittrove_auth_owner_${suffix}`
    const ownedSchema = `habittrove_auth_schema_${suffix}`
    const temporaryPassword = randomBytes(32).toString('hex')
    const admin = new Pool({ connectionString: migration.href })
    const databaseOwner = (await admin.query(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1`, ['habittrove_test_auth'])).rows[0].owner as string
    const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`
    const qLogin = quoteIdentifier(login), qOwner = quoteIdentifier(ownerRole), qSchema = quoteIdentifier(ownedSchema)
    const predefined = ['pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files', 'pg_execute_server_program', 'pg_monitor']
    let createdLogin = false
    let createdOwner = false
    try {
      await admin.query(`CREATE ROLE ${qLogin} LOGIN NOINHERIT PASSWORD '${temporaryPassword}'`)
      createdLogin = true
      await admin.query(`CREATE ROLE ${qOwner} NOLOGIN`)
      createdOwner = true
      await admin.query(`GRANT CONNECT ON DATABASE habittrove_test_auth TO ${qLogin}`)
      await admin.query(`GRANT USAGE ON SCHEMA habittrove TO ${qLogin}`)
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA habittrove TO ${qLogin}`)
      const temporaryUrl = new URL(runtimeUrl)
      temporaryUrl.username = login
      temporaryUrl.password = temporaryPassword
      await closeDatabase()
      process.env.DATABASE_URL = temporaryUrl.href
      await expect(validateRuntimeStorage()).resolves.toBeUndefined()
      for (const role of predefined) {
        await admin.query(`GRANT ${quoteIdentifier(role)} TO ${qLogin}`)
        try {
          await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed')
        } finally { await admin.query(`REVOKE ${quoteIdentifier(role)} FROM ${qLogin}`) }
      }
      await admin.query(`GRANT CREATE ON DATABASE habittrove_test_auth TO ${qLogin}`)
      try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
      finally { await admin.query(`REVOKE CREATE ON DATABASE habittrove_test_auth FROM ${qLogin}`) }
      await admin.query(`GRANT CREATE ON SCHEMA habittrove TO ${qLogin}`)
      try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
      finally { await admin.query(`REVOKE CREATE ON SCHEMA habittrove FROM ${qLogin}`) }
      await admin.query(`GRANT ${qOwner} TO ${qLogin}`)
      await admin.query(`ALTER DATABASE habittrove_test_auth OWNER TO ${qOwner}`)
      try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
      finally { await admin.query(`ALTER DATABASE habittrove_test_auth OWNER TO ${quoteIdentifier(databaseOwner)}`) }
      await admin.query(`CREATE SCHEMA ${qSchema} AUTHORIZATION ${qOwner}`)
      try { await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed') }
      finally { await admin.query(`DROP SCHEMA ${qSchema}`) }
      await admin.query(`REVOKE ${qOwner} FROM ${qLogin}`)
      await expect(validateRuntimeStorage()).resolves.toBeUndefined()
    } finally {
      await closeDatabase()
      process.env.DATABASE_URL = runtimeUrl
      await admin.query(`ALTER DATABASE habittrove_test_auth OWNER TO ${quoteIdentifier(databaseOwner)}`)
      await admin.query(`DROP SCHEMA IF EXISTS ${qSchema}`)
      if (createdLogin) {
        for (const role of predefined) await admin.query(`REVOKE ${quoteIdentifier(role)} FROM ${qLogin}`)
        if (createdOwner) await admin.query(`REVOKE ${qOwner} FROM ${qLogin}`)
        await admin.query(`REVOKE ALL ON DATABASE habittrove_test_auth FROM ${qLogin}`)
        await admin.query(`REVOKE ALL ON SCHEMA habittrove FROM ${qLogin}`)
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA habittrove FROM ${qLogin}`)
        await admin.query(`DROP ROLE ${qLogin}`)
      }
      if (createdOwner) await admin.query(`DROP ROLE ${qOwner}`)
      await admin.end()
    }
  })
  test('never bootstraps a default account into an empty database', async () => {
    await writeAuthDocument({ users: [] })
    await expect(auth.readAuthData()).rejects.toThrow('not initialized')
    await expect(validateRuntimeStorage()).rejects.toThrow('startup validation failed')
    expect((await readAuthDocument())?.users).toEqual([])
  })
  test('build-time provider evaluation does not connect or freeze the runtime provider', async () => {
    const originalUrl = process.env.DATABASE_URL!
    const originalPhase = process.env.NEXT_PHASE
    await closeDatabase()
    const unavailable = new URL(originalUrl)
    unavailable.port = '1'
    process.env.DATABASE_URL = unavailable.href
    process.env.NEXT_PHASE = 'phase-production-build'
    try {
      expect(await config.getActiveOidcConfig()).toBeUndefined()
    } finally {
      if (originalPhase === undefined) delete process.env.NEXT_PHASE
      else process.env.NEXT_PHASE = originalPhase
      process.env.DATABASE_URL = originalUrl
    }
    expect((await config.getActiveOidcConfig())?.issuer).toBe('https://original.example.test/issuer')
  })
  test('joins account and admin changes into the outer transaction and rolls them back together', async () => {
    await expect(withStorageTransaction(async () => {
      await auth.updateAuthData(data => { data.users[0].authVersion!++ })
      await config.saveLogLevel('error')
      throw new Error('rollback test')
    })).rejects.toThrow('rollback test')
    expect((await auth.readAuthData()).users[0].authVersion).toBe(3)
    expect(await readAdminDocument()).toBeUndefined()
    expect(config.getApplicationLogLevel()).toBe('info')
  })
  test('serializes concurrent account changes without losing updates', async () => {
    await Promise.all(Array.from({ length: 8 }, () => auth.updateAuthData(data => { data.users[0].authVersion!++ })))
    expect((await auth.readAuthData()).users[0].authVersion).toBe(11)
  })
  test('authenticates stored credentials and refuses a stale step-up identity', async () => {
    expect((await auth.authenticateLocalUser(account.username, password))?.id).toBe(account.id)
    await auth.updateAuthData(data => { data.users[0].authVersion!++ })
    expect(await auth.verifyStepUpPassword(account, password)).toBe(false)
    await expect(withStorageTransaction(() => auth.verifyStepUpPassword(account, password))).rejects.toThrow('outside storage transactions')
  })
  test('keeps ciphertext and AUTH_SECRET encryption compatible, refreshes log settings, and freezes provider until restart', async () => {
    const active = await config.getActiveOidcConfig()
    if (!active) throw new Error('Expected the initialized environment OIDC provider')
    await config.saveLogLevel('warn')
    expect(config.getApplicationLogLevel()).toBe('warn')
    await config.saveOidcConfig({ enabled: true, issuer: 'https://new.example.test/issuer', clientId: 'new-client', clientSecret: 'new-secret' })
    const stored = await readAdminDocument<{ oidcOverride: { encryptedClientSecret: string } }>()
    expect(JSON.stringify(stored)).not.toContain('new-secret')
    expect(stored?.oidcOverride.encryptedClientSecret.split('.')).toHaveLength(3)
    expect((await config.readEffectiveOidcConfig())?.clientSecret).toBe('new-secret')
    expect(await config.getActiveOidcConfig()).toEqual(active)
    expect(await config.getLegacyOidcIssuer()).toBe('https://original.example.test/issuer')
    expect((await config.getAdminConfigSummary()).oidc.restartRequired).toBe(true)
  })
  test('reserves ten attempts atomically across transactions and keeps step-up separate', async () => {
    const attempts = await Promise.all(Array.from({ length: 14 }, () => reserveAuthenticationAttempt('login', account.id)))
    expect(attempts.filter(Boolean)).toHaveLength(10)
    await closeDatabase()
    expect(await auth.authenticateLocalUser(account.username, password)).toBeNull()
    expect(await auth.verifyStepUpPassword(account, password)).toBe(true)
    await withStorageTransaction(async () => {
      await currentDatabaseClient()!.query("UPDATE authentication_throttles SET expires_at=clock_timestamp() - interval '1 second'")
    })
    expect(await reserveAuthenticationAttempt('login', account.id)).toBe(true)
    await clearAuthenticationAttempts('login', account.id)
    expect((await auth.authenticateLocalUser(account.username, password))?.id).toBe(account.id)
  })
  test('database outage fails closed without reverting to JSON accounts', async () => {
    const originalUrl = process.env.DATABASE_URL!
    await closeDatabase()
    const unavailable = new URL(originalUrl)
    unavailable.port = '1'
    process.env.DATABASE_URL = unavailable.href
    try {
      await expect(auth.readAuthData()).rejects.toThrow()
      await expect(auth.updateAuthData(() => undefined)).rejects.toThrow()
    } finally {
      await closeDatabase()
      process.env.DATABASE_URL = originalUrl
    }
  })
  test('unknown usernames do not allocate shared throttle rows', async () => {
    await auth.authenticateLocalUser('unknown-account', password)
    await withStorageTransaction(async () => {
      expect((await currentDatabaseClient()!.query('SELECT count(*)::int AS count FROM authentication_throttles')).rows[0].count).toBe(0)
    }, { readOnly: true })
  })
  test('obeys globally occupied verification slots and recovers expired leases', async () => {
    await withStorageTransaction(async () => {
      for (let slot = 0; slot < 4; slot++) await currentDatabaseClient()!.query(
        "INSERT INTO job_leases VALUES ($1,'other-worker',clock_timestamp() + interval '60 seconds')", [`password-verification:${slot}`])
    })
    expect(await acquirePasswordVerification()).toBeUndefined()
    await withStorageTransaction(async () => {
      await currentDatabaseClient()!.query("UPDATE job_leases SET expires_at=clock_timestamp() - interval '1 second'")
    })
    const release = await acquirePasswordVerification()
    expect(release).toBeDefined()
    await release!()
  })
  test('damaged saved provider configuration preserves local-admin startup without environment fallback', async () => {
    const damaged = [
      { version: 99, logLevel: 'warn' },
      { version: 1, logLevel: 'warn', oidcOverride: { issuer: 'https://saved.example.test', clientId: 'saved', encryptedClientSecret: 'broken' } },
      { version: 1, logLevel: 'warn', oidcOverride: { issuer: 'https://saved.example.test', clientId: 'saved', encryptedClientSecret: 'AA.AA.AA' } },
    ]
    for (const value of damaged) {
      await writeAdminDocument(value)
      await checkFreshStartup(false)
    }
  })
  test('administrator writes reject committed actor/provider races before the configuration write', async () => {
    for (const scenario of ['log-demoted', 'name-version', 'smtp-password', 'oidc-email', 'oidc-only', 'oidc-linked']) {
      await writeAuthDocument({ users: [account, { ...account, id: 'auth-backup', username: 'Backup', email: 'backup@example.test' }] })
      await checkAdministratorWriteRace(scenario)
    }
  })
  test('administrator writes commit with current authority and refresh the log cache after commit', async () => {
    await checkAdministratorWriteRace('success')
  })
  test('fresh provider startup still rejects database outages and incompatible schema versions', async () => {
    const unavailable = new URL(process.env.DATABASE_URL!)
    unavailable.port = '1'
    await checkFreshStartup(true, unavailable.href)
    const migrationUrl = process.env.DATABASE_MIGRATION_URL!
    const runtime = new URL(process.env.DATABASE_URL!)
    const migration = new URL(migrationUrl)
    if (runtime.pathname !== migration.pathname || runtime.host !== migration.host) throw new Error('Schema check requires the same isolated auth database')
    const owner = new Pool({ connectionString: migrationUrl })
    const previous = (await owner.query('SELECT version FROM habittrove.schema_version WHERE singleton=true')).rows[0].version
    try {
      await owner.query('UPDATE habittrove.schema_version SET version=-1 WHERE singleton=true')
      await checkFreshStartup(true)
    } finally {
      await owner.query('UPDATE habittrove.schema_version SET version=$1 WHERE singleton=true', [previous])
      await owner.end()
    }
  })

})
