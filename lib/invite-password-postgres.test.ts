import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL &&
  new URL(process.env.DATABASE_URL).pathname === '/habittrove_test_invite_kdf'

if (!enabled) test.skip('invitation password PostgreSQL proof requires its isolated local fixture', () => {})
else {
  mock.module('server-only', () => ({}))
  const { closeDatabase, withStorageTransaction } = await import('./db/client')
  const { writeAuthDocument, writeDocument } = await import('./db/repository')
  const { migrateFamilyDatabase } = await import('./family-backup')
  const { saltAndHashPassword } = await import('./password')
  const { getDefaultSettings } = await import('./types')
  const password = 'synthetic-invitation-password'
  const storedPassword = saltAndHashPassword(password)
  const users = [
    { id: 'admin', username: 'Administrator', email: 'admin@example.test', isAdmin: true, password: storedPassword, authVersion: 0 },
    { id: 'recovery', username: 'Recovery', email: 'recovery@example.test', isAdmin: true, password: storedPassword, authVersion: 0 },
    { id: 'existing', username: 'Existing', email: 'existing@example.test', isAdmin: false, password: storedPassword, authVersion: 4 },
  ]
  let owner: Pool
  const hashToken = (token: string) => createHash('sha256').update(JSON.stringify(token)).digest('hex')
  async function offer(token: string, email = 'new@example.test', state: 'live' | 'expired' | 'consumed' | 'revoked' = 'live'): Promise<void> {
    await owner.query(`INSERT INTO habittrove.household_invitations(token_hash,family_id,email,role,created_by,expires_at,consumed_at,revoked_at)
      VALUES($1,'A',$2,'member','admin',$3,$4,$5)`, [hashToken(token), email,
      new Date(Date.now() + (state === 'expired' ? -86400000 : 86400000)),
      state === 'consumed' ? new Date() : null, state === 'revoked' ? new Date() : null])
  }
  async function runIsolated(assertions: string): Promise<void> {
    const script = `
      import {mock} from 'bun:test';import assert from 'node:assert/strict';import pg from 'pg';
      mock.module('server-only',()=>({}));
      mock.module('@/lib/server-helpers',()=>({getCurrentUser:async()=>undefined}));
      mock.module('next/headers',()=>({cookies:async()=>({get:()=>undefined})}));
      const passwords=await import('./lib/password.ts');
      const originalSync=passwords.saltAndHashPassword,originalAsync=passwords.saltAndHashPasswordAsync,verify=passwords.verifyPassword;
      let syncCalls=0,asyncCalls=0,active=0,maxActive=0,hashHook;
      mock.module('@/lib/password',()=>({...passwords,saltAndHashPassword:(...args)=>{syncCalls++;return originalSync(...args)},
        saltAndHashPasswordAsync:async(...args)=>{asyncCalls++;active++;maxActive=Math.max(maxActive,active);try{if(hashHook)await hashHook();return await originalAsync(...args)}finally{active--}}}));
      const actions=await import('./app/actions/data.ts');
      const auth=await import('./lib/auth-store.ts');
      const family=await import('./lib/family-store.ts');
      const {currentDatabaseClient,closeDatabase}=await import('./lib/db/client.ts');
      const owner=new pg.Pool({connectionString:process.env.DATABASE_MIGRATION_URL});
      const password='synthetic-invitation-password';syncCalls=0;asyncCalls=0;
      try {${assertions}} finally {await closeDatabase();await owner.end();}
    `
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (exitCode !== 0) throw new Error(`PostgreSQL invitation password check failed: ${stderr}`)
    expect(exitCode).toBe(0)
  }

  describe('bounded invitation password hashing with restricted PostgreSQL runtime', () => {
    beforeAll(async () => {
      const runtime = new URL(process.env.DATABASE_URL!)
      const migration = new URL(process.env.DATABASE_MIGRATION_URL!)
      if (runtime.hostname !== '127.0.0.1' || runtime.port !== '15432' || migration.pathname !== runtime.pathname || migration.host !== runtime.host) throw new Error('Invitation tests require their dedicated local fixture')
      owner = new Pool({ connectionString: migration.href })
      await migrateFamilyDatabase()
    })
    beforeEach(async () => {
      await owner.query('UPDATE habittrove.family_configuration SET enabled=false WHERE singleton')
      await owner.query('TRUNCATE habittrove.users,habittrove.families,habittrove.habits,habittrove.wishlist_items,habittrove.coin_ledger,habittrove.global_wallet_totals,habittrove.attachments,habittrove.authentication_throttles,habittrove.job_leases CASCADE')
      await withStorageTransaction(async () => {
        await writeAuthDocument({ users })
        await writeDocument('habits', { habits: [] })
        await writeDocument('wishlist', { items: [] })
        await writeDocument('coins', { balance: 0, transactions: [] })
        await writeDocument('settings', getDefaultSettings())
      })
      await owner.query("INSERT INTO habittrove.families(id,name) VALUES('A','Synthetic family')")
      await owner.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('A','admin','owner'),('A','recovery','owner')")
      await owner.query('UPDATE habittrove.family_configuration SET enabled=true WHERE singleton')
    })
    afterAll(async () => { await closeDatabase(); await owner?.end() })

    test('unknown, expired, consumed, revoked and existing-account offers do not hash or allocate trackers', async () => {
      await offer('B'.repeat(43), 'expired@example.test', 'expired')
      await offer('C'.repeat(43), 'consumed@example.test', 'consumed')
      await offer('D'.repeat(43), 'revoked@example.test', 'revoked')
      await offer('E'.repeat(43), 'existing@example.test')
      await offer('F'.repeat(43), 'new@example.test')
      await runIsolated(`
        for(const token of ['nonsense',...'ABCDE'.split('').map(x=>x.repeat(43))])await assert.rejects(()=>actions.acceptFamilyInvite(token,'newmember',password));
        await assert.rejects(()=>actions.acceptFamilyInvite('F'.repeat(43),'Existing',password));
        assert.equal(syncCalls,0);assert.equal(asyncCalls,0);
        assert.equal(Number((await owner.query('SELECT count(*) FROM habittrove.authentication_throttles')).rows[0].count),0);
        assert.equal(Number((await owner.query('SELECT count(*) FROM habittrove.job_leases')).rows[0].count),0);
      `)
    })
    test('shared occupied verification leases prevent KDF work even for a live stored offer', async () => {
      await offer('G'.repeat(43))
      for (let index = 0; index < 4; index++) await owner.query("INSERT INTO habittrove.job_leases VALUES($1,'other-worker',clock_timestamp()+interval '60 seconds')", [`password-verification:${index}`])
      await runIsolated(`
        await assert.rejects(()=>actions.acceptFamilyInvite('G'.repeat(43),'newmember',password),/Too many password requests/);
        assert.equal(syncCalls,0);assert.equal(asyncCalls,0);
        assert.equal(Number((await owner.query('SELECT count(*) FROM habittrove.authentication_throttles')).rows[0].count),0);
      `)
    })
    test('valid concurrent offers derive at most four asynchronous compatible credentials and consume once', async () => {
      for (let index = 0; index < 9; index++) await offer(String.fromCharCode(72 + index).repeat(43), `new${index}@example.test`)
      await runIsolated(`
        let release;const held=new Promise(resolve=>{release=resolve});let rejected=0;
        hashHook=async()=>{assert.equal(currentDatabaseClient(),undefined);await held};
        const tokens=Array.from({length:9},(_,index)=>String.fromCharCode(72+index).repeat(43));
        const pending=Promise.allSettled(tokens.map((token,index)=>actions.acceptFamilyInvite(token,'newmember'+index,password).catch(error=>{rejected++;throw error})));
        for(let index=0;index<2000 && (asyncCalls<4 || rejected<5);index++)await new Promise(resolve=>setTimeout(resolve,1));
        assert.equal(asyncCalls,4);assert.equal(rejected,5);assert.equal(maxActive,4);
        assert.equal(Number((await owner.query("SELECT count(*) FROM habittrove.job_leases WHERE name LIKE 'password-verification:%'")).rows[0].count),4);
        release();const outcomes=await pending;assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,4);
        const created=(await auth.readAuthData()).users.filter(user=>user.username.startsWith('newmember'));
        assert.equal(created.length,4);for(const user of created)assert.equal(verify(password,user.password),true);
        const accepted=outcomes.findIndex(x=>x.status==='fulfilled');const before=asyncCalls;
        await assert.rejects(()=>actions.acceptFamilyInvite(tokens[accepted],'replacement',password));
        assert.equal(asyncCalls,before);assert.equal(syncCalls,0);
        assert.equal(Number((await owner.query('SELECT count(*) FROM habittrove.authentication_throttles')).rows[0].count),0);
      `)
    })
    test('revocation or a new matching account during KDF rolls acceptance back without overwriting credentials', async () => {
      await offer('R'.repeat(43), 'race@example.test')
      await runIsolated(`
        const administrator=(await auth.readAuthData()).users.find(user=>user.id==='admin');
        hashHook=async()=>{assert.equal(currentDatabaseClient(),undefined);await family.revokeStoredInvite(administrator,'A',(await owner.query("SELECT token_hash FROM habittrove.household_invitations WHERE email='race@example.test'")).rows[0].token_hash)};
        await assert.rejects(()=>actions.acceptFamilyInvite('R'.repeat(43),'newmember',password));
        assert.equal((await auth.readAuthData()).users.length,3);assert.equal(asyncCalls,1);assert.equal(syncCalls,0);
      `)
      await offer('S'.repeat(43), 'collision@example.test')
      await runIsolated(`
        const existingHash=originalSync('preexisting-race-credentials');
        hashHook=async()=>{assert.equal(currentDatabaseClient(),undefined);await auth.updateAuthData(data=>data.users.push({id:'raced-existing',username:'Raced',email:'collision@example.test',password:existingHash,authVersion:4}))};
        await assert.rejects(()=>actions.acceptFamilyInvite('S'.repeat(43),'newmember',password));
        const data=await auth.readAuthData();assert.equal(data.users.length,4);
        assert.equal(data.users.find(user=>user.id==='raced-existing').password,existingHash);
        assert.equal(data.users.some(user=>user.username==='newmember'),false);assert.equal(asyncCalls,1);assert.equal(syncCalls,0);
      `)
    })
    test('valid-token retry throttles persist in PostgreSQL and block the eleventh derivation', async () => {
      await offer('T'.repeat(43))
      await runIsolated(`
        hashHook=async()=>{throw new Error('synthetic KDF failure')};
        for(let attempt=0;attempt<10;attempt++)await assert.rejects(()=>actions.acceptFamilyInvite('T'.repeat(43),'newmember',password),/synthetic KDF failure/);
        await assert.rejects(()=>actions.acceptFamilyInvite('T'.repeat(43),'newmember',password),/Too many invitation attempts/);
        const rows=(await owner.query('SELECT attempts FROM habittrove.authentication_throttles')).rows;
        assert.equal(rows.length,1);assert.equal(rows[0].attempts,10);assert.equal(asyncCalls,10);assert.equal(syncCalls,0);
      `)
      await runIsolated(`
        await assert.rejects(()=>actions.acceptFamilyInvite('T'.repeat(43),'newmember',password),/Too many invitation attempts/);
        assert.equal(asyncCalls,0);assert.equal(syncCalls,0);
      `)
    })
  })
}
