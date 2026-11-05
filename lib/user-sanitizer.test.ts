import { expect, test } from 'bun:test'
import { sanitizeUserData } from './user-sanitizer'
import type { UserData } from './types'

test('public directories keep personal settings private to the viewer, including site-admin views', () => {
  const data: UserData = { users: [
    { id: 'viewer', username: 'Viewer', password: 'private-test-hash', personalSettings: { ui: { useNumberFormatting: true, useGrouping: false }, language: 'fr' } },
    { id: 'other', username: 'Other', email: 'other@example.test', personalSettings: { language: 'en' }, personalFolders: [{ id: 'private', name: 'Private', itemIds: [] }], statusDays: [{ date: '2026-01-01', status: 'rest' }] },
  ] }
  for (const admin of [false, true]) {
    const result = sanitizeUserData(data, 'viewer', admin)
    expect(result.users[0].personalSettings?.language).toBe('fr')
    expect(result.users[1].personalSettings).toBeUndefined()
    expect(result.users[1].personalFolders).toBeUndefined()
    expect(result.users[1].statusDays).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('private-test-hash')
  }
})
