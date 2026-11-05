import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const helpersPath = fileURLToPath(new URL('./server-helpers.ts', import.meta.url))
const authPath = fileURLToPath(new URL('../auth.ts', import.meta.url))
const passwordPath = fileURLToPath(new URL('./password.ts', import.meta.url))

async function freshProcess(script: string, demo = false) {
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', HABITTROVE_STORAGE: 'legacy-json', DATABASE_URL: '',
      DEMO: demo ? 'true' : 'false', AUTHENTIK_ISSUER: '', AUTHENTIK_CLIENT_ID: '', AUTHENTIK_CLIENT_SECRET: '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Isolated session regression failed: ${stderr}`)
  expect(exitCode).toBe(0)
}

function identityScript(scenario: 'matching' | 'revoked-after-auth' | 'missing-version' | 'demo') {
  return `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import { mock } from 'bun:test';
    mock.module('server-only', () => ({}));
    const { saltAndHashPassword } = await import(${JSON.stringify(passwordPath)});
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-session-freshness-'));
    const originalDirectory = process.cwd();
    const scenario = ${JSON.stringify(scenario)};
    const actor = { id: 'session-user', username: 'SyntheticAdmin', email: 'session@example.test', isAdmin: true,
      ...(scenario === 'demo' ? {} : { password: saltAndHashPassword('synthetic-session-password'), authVersion: 0 }) };
    await fs.mkdir(path.join(directory, 'data'));
    const save = () => fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [actor] }));
    await save();
    mock.module('@/auth', () => ({ auth: async () => {
      // JWT validation has already accepted version zero; commit revocation before the helper's account read.
      if (scenario === 'revoked-after-auth') { actor.authVersion = 1; await save(); }
      return { user: { id: actor.id, ...(scenario === 'missing-version' ? {} : { authVersion: 0 }) } };
    } }));
    try {
      process.chdir(directory);
      const { getCurrentUser } = await import(${JSON.stringify(helpersPath)});
      const current = await getCurrentUser();
      if (scenario === 'revoked-after-auth' || scenario === 'missing-version') {
        assert.equal(current === undefined, true, 'an unversioned or revoked verified session must not acquire fresh identity authority');
      } else {
        assert.equal(current?.id, 'session-user');
        assert.equal(current?.isAdmin, true);
        assert.equal(current?.authVersion, 0, 'carry the verified version even when a legacy demo account has no stored version');
      }
      if (scenario === 'revoked-after-auth') {
        const stored = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).users[0];
        assert.equal(stored.authVersion, 1);
        assert.equal(stored.isAdmin, true);
      }
    } finally { process.chdir(originalDirectory); await fs.rm(directory, { recursive: true, force: true }); }
  `
}

test('a matching verified session retains its version and current identity', async () => {
  await freshProcess(identityScript('matching'))
})

test('revocation committed after auth verification cannot be replaced with the newer database authority', async () => {
  await freshProcess(identityScript('revoked-after-auth'))
})

test('a real credential session missing its verified version fails closed', async () => {
  await freshProcess(identityScript('missing-version'))
})

test('a versioned demo session still accepts a credentialless legacy account', async () => {
  await freshProcess(identityScript('demo'), true)
})

test('the Auth.js session callback carries the verified JWT version without inventing a missing version', async () => {
  await freshProcess(`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import { mock } from 'bun:test';
    let configuration;
    mock.module('server-only', () => ({}));
    mock.module('next-auth', () => ({ default: config => {
      configuration = config;
      return { handlers: {}, signIn: () => {}, signOut: () => {}, auth: () => {} };
    } }));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-session-callback-'));
    const originalDirectory = process.cwd();
    try {
      process.chdir(directory);
      await import(${JSON.stringify(authPath)});
      const config = typeof configuration === 'function' ? await configuration(undefined) : configuration;
      assert.equal(typeof config.callbacks.session, 'function');
      const carried = await config.callbacks.session({ session: { user: {}, expires: '2099-01-01T00:00:00Z' }, token: { id: 'session-user', authVersion: 7 } });
      assert.equal(carried.user.id, 'session-user');
      assert.equal(carried.user.authVersion, 7, 'the session must retain the JWT version already validated by auth');
      const legacy = await config.callbacks.session({ session: { user: {}, expires: '2099-01-01T00:00:00Z' }, token: { id: 'session-user' } });
      assert.equal(legacy.user.authVersion, undefined, 'missing token versions must not become a valid zero version');
    } finally { process.chdir(originalDirectory); await fs.rm(directory, { recursive: true, force: true }); }
  `)
})
