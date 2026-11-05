import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore, Provider } from 'jotai'
import { NextIntlClientProvider } from 'next-intl'
import { currentUserIdAtom, serverSettingsAtom, usersAtom } from '@/lib/atoms'
import { getDefaultServerSettings } from '@/lib/types'
import messages from '@/messages/en.json'

mock.module('server-only', () => ({}))
const { default: SettingsPage } = await import('./page')
const { default: Navigation } = await import('@/components/Navigation')
const { default: HabitList } = await import('@/components/HabitList')
const { default: UserForm } = await import('@/components/UserForm')

function render(role?: 'member' | 'manager' | 'owner' | 'site-admin', isAdmin = false, familiesEnabled = true, outsider = false) {
  const store = createStore()
  store.set(serverSettingsAtom, { ...getDefaultServerSettings(), familiesEnabled, familyRole: role, familyMember: !!role && !outsider })
  const actor = { id: 'actor', username: 'Actor', email: 'actor@example.test', isAdmin, managedUserIds: [], hasPassword: true, hasAuthentik: false,
    personalFolders: [{ id: 'stale', name: 'Other household folder', itemIds: [] }] }
  store.set(usersAtom, outsider ? { users: [{ id: 'member', username: 'Member', hasPassword: true, hasAuthentik: false }], currentUser: actor } : { users: [actor] })
  store.set(currentUserIdAtom, 'actor')
  return renderToStaticMarkup(<Provider store={store}><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <SettingsPage /><Navigation viewPort="main" />{outsider && <><HabitList /><UserForm userId="actor" onCancel={() => {}} onSuccess={() => {}} /></>}
  </NextIntlClientProvider></Provider>)
}

test('all family members can open membership and personal language without owner or infrastructure privileges', () => {
  for (const role of ['member', 'manager'] as const) {
    const html = render(role)
    expect(html).toContain('href="/family"')
    expect(html).toContain('id="language-select"')
    expect(html).not.toContain('id="timezone"')
    expect(html).not.toContain('id="auto-backup"')
    expect(html).not.toContain('settings-tab-admin')
  }
})

test('family owners manage family calendar settings without site-admin controls', () => {
  const html = render('owner')
  expect(html).toContain('Family calendar settings')
  expect(html).toContain('id="timezone"')
  expect(html).toContain('<option value="UTC" selected="">UTC</option>')
  expect(html).toContain('id="weekStartDay"')
  expect(html).not.toContain('id="auto-backup"')
  expect(html).not.toContain('settings-tab-admin')
})

test('site administrators retain infrastructure backup controls and selected family calendar settings', () => {
  const html = render('site-admin', true)
  expect(html).toContain('settings-tab-admin')
  expect(html).toContain('id="auto-backup"')
  expect(html).toContain('id="timezone"')
})

test('accounts without a family retain personal settings and a membership entry without household controls', () => {
  const html = render()
  expect(html).toContain('href="/family"')
  expect(html).toContain('id="language-select"')
  expect(html).not.toContain('id="timezone"')
  expect(html).not.toContain('id="status-date"')
})

test('disabled-family installations keep the legacy family navigation gate', () => {
  expect(render(undefined, false, false)).not.toContain('href="/family"')
  expect(render(undefined, true, false)).toContain('href="/family"')
})

test('selected-family nonmember administrators retain identity and admin settings without personal household controls', () => {
  const html = render('site-admin', true, true, true)
  expect(html).toContain('settings-tab-admin')
  expect(html).toContain('id="auto-backup"')
  expect(html).toContain('id="timezone"')
  expect(html).toContain('href="/family"')
  expect(html).not.toContain('id="status-date"')
  expect(html).not.toContain('id="folder-name"')
  expect(html).not.toContain('Other household folder')
  expect(html).toContain('value="Actor"')
  expect(html).toContain(messages.UserForm.saveChangesButton)
  expect(html).not.toContain(messages.UserForm.createUserButton)
  expect(html).toContain('id="site-administrator"')
  expect(html).not.toContain('id="habit-write"')
  expect(html).not.toContain(messages.UserForm.managedFamilyMembers)
})
