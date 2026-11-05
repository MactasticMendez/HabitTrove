import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '@/messages/en.json'
import type { FamilyRole, FamilyState } from '@/lib/family-types'

mock.module('server-only', () => ({}))
const { default: FamilyMembershipSettings } = await import('./FamilyMembershipSettings')

function renderMembership(role: FamilyRole | 'site-admin', isSiteAdmin = false, hasFamily = true) {
  const state: FamilyState = {
    familiesEnabled: true,
    selectedFamilyId: hasFamily ? 'family-one' : undefined,
    families: hasFamily ? [{ id: 'family-one', name: '<script>family</script>', role, memberCount: 2 }] : [],
    members: hasFamily ? [
      { id: 'owner', username: 'Owner', role: 'owner', active: true, managedUserIds: [] },
      { id: 'member', username: '<script>member</script>', role: 'member', active: true, managedUserIds: [] },
    ] : [],
  }
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <FamilyMembershipSettings state={state} isSiteAdmin={isSiteAdmin} onChanged={async () => {}} />
  </NextIntlClientProvider>)
}

test('ordinary members and managers can inspect membership without owner controls', () => {
  for (const role of ['member', 'manager'] as const) {
    const html = renderMembership(role)
    expect(html).toContain('Family members and roles')
    expect(html).toContain('combined coin balance across all their families')
    expect(html).not.toContain('membership-role-')
    expect(html).not.toContain('invite-email')
    expect(html).not.toContain('family-name')
  }
})

test('owners manage roles but receive no automatic member assignments', () => {
  const html = renderMembership('owner')
  expect(html).toContain('membership-role-owner')
  expect(html).toContain('invite-role')
  expect(html).toContain('Owner status alone does not grant access')
  expect(html).toContain('No members assigned for management.')
  expect(html).not.toContain('checked=""')
  expect(html).not.toContain('another-family-name')
})

test('only site administrators see family creation, including without membership', () => {
  expect(renderMembership('site-admin', true)).toContain('another-family-name')
  expect(renderMembership('site-admin', true, false)).toContain('new-family-name')
  expect(renderMembership('member', false, false)).not.toContain('new-family-name')
})

test('family and member names are escaped as text', () => {
  const html = renderMembership('member')
  expect(html).toContain('&lt;script&gt;family&lt;/script&gt;')
  expect(html).toContain('&lt;script&gt;member&lt;/script&gt;')
  expect(html).not.toContain('<script>')
})
