import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

async function checkOidcReturnPaths(assertions: string): Promise<void> {
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    const calls=[];
    mock.module('server-only',()=>({}));
    mock.module('@/auth',()=>({signIn:async (...args)=>{calls.push(args)},signOut:async()=>{}}));
    mock.module('@/lib/admin-config',()=>({getActiveOidcConfig:async()=>({providerId:'oidc'})}));
    mock.module('@/lib/server-helpers',()=>({getCurrentUser:async()=>undefined}));
    mock.module('@/lib/auth-store',()=>({verifyStepUpPassword:async()=>false}));
    const {signInWithAuthentik}=await import('./app/actions/user');
    ${assertions}
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`OIDC return-path check failed: ${stderr}`)
  expect(exitCode).toBe(0)
}

test('OIDC login defaults to home and preserves a bounded internal invite path', async () => {
  await checkOidcReturnPaths(`
    await signInWithAuthentik();
    assert.deepEqual(calls,[['oidc',{redirectTo:'/'}]]);
    calls.length=0;
    const target='/invite/'+'aB_9-'.repeat(9);
    await signInWithAuthentik(target);
    assert.deepEqual(calls,[['oidc',{redirectTo:target}]]);
  `)
})

test('OIDC login refuses external, encoded, ambiguous and unbounded redirects', async () => {
  await checkOidcReturnPaths(`
    for(const target of ['https://example.test/invite/token','//example.test','/settings','/invite/short',
      '/invite/'+'a'.repeat(129),'/invite/'+'a'.repeat(43)+'?next=//example.test',
      '/invite/'+'a'.repeat(43)+'#fragment','/invite/'+'a'.repeat(43)+'/',
      '/invite/%2f%2fexample.test','/invite/../settings',String.fromCharCode(92)+'example.test',null,{}]) {
      await assert.rejects(()=>signInWithAuthentik(target),/Invalid sign-in return path/);
    }
    assert.equal(calls.length,0);
  `)
})
