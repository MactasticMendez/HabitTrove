import { expect, test } from 'bun:test'

test('foreground delivery reauthorizes, fails closed and discards obsolete in-flight snapshots', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    const item = { id: 'private-item', name: 'Private fixture', frequency: 'FREQ=DAILY', coinReward: 1,
      description: '', completions: [], userIds: ['member'], reminderTime: '00:00' };
    const state = { browser: { remindersEnabled: true }, user: { id: 'member' },
      habits: { familyId: 'A', habits: [item] }, settings: { system: { timezone: 'UTC' } } };
    const storage = new Map();
    globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
    let tick, cleanup, requests = 0, reply = async () => undefined;
    const delivered = [];
    globalThis.window = { isSecureContext: true, setInterval: fn => { tick = fn; return 1 }, clearInterval() {},
      Notification: class { static permission = 'granted'; constructor() {} } };
    const React = await import('react');
    mock.module('react', () => ({ ...React, useEffect: effect => { cleanup = effect() } }));
    mock.module('jotai', () => ({ useAtomValue: atom => state[atom] }));
    mock.module('@/lib/atoms', () => ({ browserSettingsAtom: 'browser', currentUserAtom: 'user', habitsAtom: 'habits', settingsAtom: 'settings' }));
    mock.module('next-intl', () => ({ useTranslations: () => (key, values) => key + JSON.stringify(values ?? {}) }));
    mock.module('@/hooks/use-toast', () => ({ toast: value => delivered.push(value) }));
    mock.module('@/app/actions/data', () => ({ loadReminderData: async family => {
      assert.equal(family, 'A'); requests++; return reply();
    } }));
    const { default: ReminderManager } = await import('./components/ReminderManager');
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const snapshot = { userId: 'member', familyId: 'A', timezone: 'UTC', habits: [item] };
    ReminderManager(); await flush();
    assert.equal(delivered.length, 0, 'revoked access must suppress stale captured item names');
    assert.equal(requests, 1); cleanup();
    reply = async () => snapshot;
    ReminderManager(); await flush(); assert.equal(delivered.length, 1);
    tick(); await flush(); assert.equal(delivered.length, 1, 'authorized reminder stays deduplicated'); cleanup();
    storage.clear(); delivered.length = 0;
    reply = async () => { throw new Error('Synthetic network failure') };
    ReminderManager(); await flush(); assert.equal(delivered.length, 0); assert.equal(storage.size, 0);
    reply = async () => snapshot; tick(); await flush(); assert.equal(delivered.length, 1); cleanup();
    for (const invalid of [{ ...snapshot, userId: 'other' }, { ...snapshot, familyId: 'B' }]) {
      storage.clear(); delivered.length = 0; reply = async () => invalid;
      ReminderManager(); await flush(); assert.equal(delivered.length, 0); assert.equal(storage.size, 0); cleanup();
    }
    storage.clear(); delivered.length = 0;
    let resolve;
    reply = () => new Promise(done => { resolve = done });
    const before = requests; ReminderManager(); tick(); await flush();
    assert.equal(requests, before + 1, 'polls must not overlap');
    cleanup(); resolve(snapshot); await flush();
    assert.equal(delivered.length, 0, 'disabled/switched/unmounted effect must discard an older response');
    assert.equal(storage.size, 0);
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(code).toBe(0)
})
