import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

async function checkInviteKdf(assertions: string): Promise<void> {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    process.env.HABITTROVE_STORAGE='legacy-json';process.env.NODE_ENV='test';delete process.env.DEMO;
    mock.module('server-only',()=>({}));
    mock.module('@/lib/server-helpers',()=>({getCurrentUser:async()=>undefined}));
    mock.module('next/headers',()=>({cookies:async()=>({get:()=>undefined})}));
    const passwords=await import('./lib/password.ts');
    const originalSync=passwords.saltAndHashPassword;
    const originalAsync=passwords.saltAndHashPasswordAsync;
    const originalVerify=passwords.verifyPassword;
    let syncCalls=0,asyncCalls=0,active=0,maxActive=0,hashHook;
    mock.module('@/lib/password',()=>({...passwords,
      saltAndHashPassword:(...args)=>{syncCalls++;return originalSync(...args)},
      saltAndHashPasswordAsync:async(...args)=>{
        asyncCalls++;active++;maxActive=Math.max(maxActive,active);
        try {if(hashHook)await hashHook();return await originalAsync(...args)}finally{active--}
      }}));
    const actions=await import('./app/actions/data.ts');
    const auth=await import('./lib/auth-store.ts');
    const {currentDatabaseClient}=await import('./lib/db/client.ts');
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'habittrove-invite-kdf-'));
    const originalCwd=process.cwd();
    const password='synthetic-invitation-password';
    const administrator={id:'admin',username:'Administrator',email:'admin@example.test',isAdmin:true,password:originalSync(password)};
    const hashToken=token=>createHash('sha256').update(token).digest('hex');
    const offer=(token,email='new@example.test',expiresAt=new Date(Date.now()+86400000).toISOString())=>({tokenHash:hashToken(token),email,expiresAt,createdBy:'admin'});
    await fs.mkdir(path.join(directory,'data'));
    async function seed(invites,users=[administrator]){await fs.writeFile(path.join(directory,'data','auth.json'),JSON.stringify({users,invites}));}
    try {
      await seed([]);process.chdir(directory);syncCalls=0;asyncCalls=0;
      ${assertions}
    } finally {process.chdir(originalCwd);await fs.rm(directory,{recursive:true,force:true});}
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Invitation password check failed: ${stderr}`)
  expect(exitCode).toBe(0)
}

test('invalid, expired, consumed, revoked and existing-account legacy invitations never hash a password', async () => {
  await checkInviteKdf(`
    for(const token of ['nonsense','A'.repeat(43)]) {
      await assert.rejects(()=>actions.acceptFamilyInvite(token,'newmember',password));
    }
    assert.equal(syncCalls,0);assert.equal(asyncCalls,0);
    const expired='B'.repeat(43);await seed([offer(expired,'new@example.test','2000-01-01T00:00:00Z')]);
    await assert.rejects(()=>actions.acceptFamilyInvite(expired,'newmember',password));
    const invalidDate='C'.repeat(43);await seed([offer(invalidDate,'new@example.test','invalid-date')]);
    await assert.rejects(()=>actions.acceptFamilyInvite(invalidDate,'newmember',password));
    for(const token of ['D'.repeat(43),'E'.repeat(43)]) {
      await seed([]);await assert.rejects(()=>actions.acceptFamilyInvite(token,'newmember',password));
    }
    const existing='F'.repeat(43);await seed([offer(existing,administrator.email)]);
    await assert.rejects(()=>actions.acceptFamilyInvite(existing,'newmember',password));
    await seed([offer(existing)]);await assert.rejects(()=>actions.acceptFamilyInvite(existing,administrator.username,password));
    assert.equal(syncCalls,0);assert.equal(asyncCalls,0);
  `)
})

test('valid legacy invitations use asynchronous compatible hashes and enforce four concurrent derivations', async () => {
  await checkInviteKdf(`
    const tokens=Array.from({length:9},(_,index)=>String.fromCharCode(71+index).repeat(43));
    await seed(tokens.map((token,index)=>offer(token,'new'+index+'@example.test')));
    let release;const held=new Promise(resolve=>{release=resolve});
    hashHook=async()=>{assert.equal(currentDatabaseClient(),undefined);await held};
    const pending=Promise.allSettled(tokens.map((token,index)=>actions.acceptFamilyInvite(token,'newmember'+index,password)));
    for(let index=0;index<100 && asyncCalls<4;index++)await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal(asyncCalls,4);assert.equal(maxActive,4);release();
    const outcomes=await pending;
    assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,4);
    const created=(await auth.readAuthData()).users.filter(user=>user.id!=='admin');
    assert.equal(created.length,4);for(const user of created)assert.equal(originalVerify(password,user.password),true);
    assert.equal(syncCalls,0);assert.equal(maxActive,4);
  `)
})

test('legacy invitation acceptance rechecks revocation and account collisions after asynchronous hashing', async () => {
  await checkInviteKdf(`
    for(const collision of [false,true]) {
      const token=(collision?'Q':'P').repeat(43);await seed([offer(token)]);
      let entered,release;const started=new Promise(resolve=>{entered=resolve});const held=new Promise(resolve=>{release=resolve});
      hashHook=async()=>{assert.equal(currentDatabaseClient(),undefined);entered();await held};
      const pending=actions.acceptFamilyInvite(token,'newmember',password);await started;
      const existing={id:'existing',username:'Existing',email:'new@example.test',password:originalSync('existing-credentials')};
      await auth.updateAuthData(data=>{if(collision)data.users.push(existing);else data.invites=[]});
      release();await assert.rejects(()=>pending);
      const data=await auth.readAuthData();assert.equal(data.users.some(user=>user.username==='newmember'),false);
      if(collision)assert.equal(data.users.find(user=>user.id==='existing').password,existing.password);
    }
    assert.equal(syncCalls,0);assert.equal(asyncCalls,2);
  `)
})


test('one validated legacy offer cannot trigger more than ten failed password derivations per window', async () => {
  await checkInviteKdf(`
    const token='R'.repeat(43);await seed([offer(token)]);
    hashHook=async()=>{throw new Error('synthetic KDF failure')};
    for(let attempt=0;attempt<10;attempt++)await assert.rejects(()=>actions.acceptFamilyInvite(token,'newmember',password),/synthetic KDF failure/);
    await assert.rejects(()=>actions.acceptFamilyInvite(token,'newmember',password),/Too many invitation attempts/);
    assert.equal(asyncCalls,10);assert.equal(syncCalls,0);
    assert.equal((await auth.readAuthData()).users.length,1);
  `)
})
