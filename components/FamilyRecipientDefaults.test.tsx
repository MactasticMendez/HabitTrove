import { expect, test } from 'bun:test'

async function renderInFreshProcess(assertions: string) {
  // Modal atom and portal mocks stay isolated from the action and hook test suites.
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { NextIntlClientProvider } from 'next-intl';
    import messages from './messages/en.json';
    import { getDefaultSettings } from './lib/types';
    const state = {};
    mock.module('jotai', () => ({ useAtom: atom => [state[atom], () => {}] }));
    mock.module('@/lib/atoms', () => ({ settingsAtom: 'settings', usersAtom: 'users', currentUserAtom: 'user', serverSettingsAtom: 'server' }));
    const container = ({ children }) => React.createElement('div', null, children);
    mock.module('@/components/ui/dialog', () => ({ Dialog: container, DialogContent: container, DialogHeader: container, DialogTitle: container, DialogFooter: container }));
    for (const name of ['ModalOverlay', 'EmojiPickerButton', 'DrawingModal']) mock.module('./components/' + name, () => ({ default: () => null }));
    const { default: HabitModal } = await import('./components/AddEditHabitModal');
    const { default: RewardModal } = await import('./components/AddEditWishlistItemModal');
    const member = { id: 'member-one', username: 'Only Member', isAdmin: false };
    function setup(self = false) {
      Object.assign(state, { settings: getDefaultSettings(), users: { users: [member] },
        user: self ? { ...member, isAdmin: true } : { id: 'site-admin', username: 'Site admin', isAdmin: true },
        server: { familiesEnabled: true, familyMember: self } });
    }
    function render(element) {
      return renderToStaticMarkup(React.createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'UTC', messages }, element));
    }
    const habit = (props = {}) => render(React.createElement(HabitModal, { onClose() {}, onSave: async () => {}, isTask: false, ...props }));
    const reward = (props = {}) => render(React.createElement(RewardModal, { isOpen: true, setIsOpen() {}, editingItem: null, setEditingItem() {}, addWishlistItem: async () => {}, editWishlistItem: async () => {}, ...props }));
    const assignment = html => html.match(/<button[^>]*aria-label="Assign[^>]*>/)?.[0] ?? '';
    ${assertions}
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
}

test('nonmember admins start unassigned and can explicitly choose a family with only one member', async () => {
  await renderInFreshProcess(`
    setup();
    for (const html of [habit(), reward()]) {
      assert(assignment(html).includes('Only Member'));
      assert(assignment(html).includes('aria-pressed="false"'));
      assert(!html.includes(messages.AddEditHabitModal.includeSelf));
      assert(!html.includes(messages.AddEditWishlistItemModal.includeSelf));
    }
  `)
})

test('explicit overview recipients and edited item assignments remain selected', async () => {
  await renderInFreshProcess(`
    setup();
    const savedHabit = { id: 'h', name: 'Saved', description: '', frequency: 'FREQ=DAILY', coinReward: 1, completions: [], userIds: [member.id] };
    const savedReward = { id: 'w', name: 'Saved', description: '', coinCost: 1, userIds: [member.id] };
    for (const html of [habit({ initialUserIds: [member.id] }), reward({ initialUserIds: [member.id] }), habit({ habit: savedHabit }), reward({ editingItem: savedReward })]) {
      assert(assignment(html).includes('aria-pressed="true"'));
    }
  `)
})

test('nonmember negative and anytime forms require an explicit owner instead of the first directory member', async () => {
  await renderInFreshProcess(String.raw`
    setup();
    for (const extra of [{ isNegative: true }, { schedule: { type: 'anytime', recordingPolicy: 'both' } }]) {
      const html = habit({ habit: { id: 'draft', name: 'Draft', description: '', frequency: 'FREQ=DAILY', coinReward: 1, completions: [], userIds: [], ...extra } });
      assert.match(html, /id="negative-assignee"[^>]*required=""/);
      assert.match(html, /<option value="" disabled="" selected=""/);
      assert.doesNotMatch(html, /<option value="member-one"[^>]*selected/);
    }
  `)
})

test('a current family member keeps the existing self-recipient default', async () => {
  await renderInFreshProcess(String.raw`
    setup(true);
    for (const html of [habit(), reward()]) assert.match(html, /type="checkbox"[^>]*checked=""/);
    assert(!habit().includes('aria-label="Assign to Only Member"'));
    assert(!reward().includes('aria-label="Assign reward to Only Member"'));
  `)
})
