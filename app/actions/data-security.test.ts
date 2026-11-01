import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { User } from '@/lib/types'

let currentUser: User | undefined

mock.module('@/lib/server-helpers', () => ({
  getCurrentUser: async () => currentUser,
  verifyPassword: (password?: string, stored?: string) => password === stored,
  saltAndHashPassword: (password: string) => `hashed:${password}`,
}))

const actions = await import('./data')

const admin: User = { id: 'admin', username: 'admin', isAdmin: true, password: 'secret' }
const member: User = {
  id: 'member', username: 'member', isAdmin: false, password: 'secret',
  permissions: [{
    habit: { write: false, interact: true },
    wishlist: { write: false, interact: true },
    coins: { write: true, interact: true },
  }],
}
const other: User = { id: 'other', username: 'other', isAdmin: false, password: 'secret' }

let directory: string
let cwdSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-security-'))
  await fs.mkdir(path.join(directory, 'data'))
  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [admin, member, other] }))
  await fs.writeFile(path.join(directory, 'data', 'habits.json'), JSON.stringify({ habits: [
    { id: 'shared', name: 'Shared', description: '', frequency: 'daily', coinReward: 2, completions: [], userIds: ['member', 'other'] },
    { id: 'foreign', name: 'Foreign', description: '', frequency: 'daily', coinReward: 3, completions: [], userIds: ['other'] },
  ] }))
  await fs.writeFile(path.join(directory, 'data', 'coins.json'), JSON.stringify({ balance: 2, transactions: [
    { id: 'tx1', userId: 'member', amount: 2, type: 'MANUAL_ADJUSTMENT', description: 'Test', timestamp: '2026-01-01T00:00:00Z' },
  ] }))
  cwdSpy = spyOn(process, 'cwd').mockImplementation(() => directory)
  currentUser = member
})

afterEach(async () => {
  cwdSpy.mockRestore()
  currentUser = undefined
  await fs.rm(directory, { recursive: true, force: true })
})

describe('server action authorization', () => {
  test('rejects unauthenticated avatar uploads', async () => {
    currentUser = undefined
    await expect(actions.uploadAvatar(new FormData())).rejects.toThrow('User not authenticated')
  })

  test('prevents role escalation and changes to another account', async () => {
    await expect(actions.updateUser('member', { isAdmin: true })).rejects.toThrow('Cannot change account permissions')
    await expect(actions.updateUserPassword('other', 'newpass')).rejects.toThrow('Cannot change another user')
    await expect(actions.deleteUser('other')).rejects.toThrow('Cannot delete another user')
    await expect(actions.updateLastNotificationReadTimestamp('other', '2026-01-01T00:00:00Z')).rejects.toThrow('Cannot update another user')
    const auth = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
    expect(auth.users[1].isAdmin).toBe(false)
    expect(auth.users).toHaveLength(3)
  })

  test('allows a member to edit only their own profile fields', async () => {
    const updated = await actions.updateUser('member', { username: 'renamed' })
    expect(updated.username).toBe('renamed')
    expect(updated).not.toHaveProperty('password')
    expect(updated.isAdmin).toBe(false)
  })

  test('allows only admins to create users', async () => {
    const form = new FormData()
    form.set('username', 'newuser')
    form.set('password', 'valid-password-123')
    form.set('isAdmin', 'true')
    await expect(actions.createUser(form)).rejects.toThrow('Administrator access required')
    currentUser = admin
    const created = await actions.createUser(form)
    expect(created.isAdmin).toBe(true)
    expect(created).not.toHaveProperty('password')
  })

  test('requires strong passwords for new and updated accounts', async () => {
    currentUser = admin
    const form = new FormData()
    form.set('username', 'newuser')
    form.set('password', 'short')
    await expect(actions.createUser(form)).rejects.toThrow('at least 12')
    await expect(actions.updateUserPassword('member', 'short')).rejects.toThrow('at least 12')
  })

  test('preserves the last administrator and requires its password', async () => {
    currentUser = admin
    const form = new FormData()
    form.set('username', 'newadmin')
    form.set('isAdmin', 'true')
    await expect(actions.createUser(form)).rejects.toThrow('Administrator accounts require a password')
    await expect(actions.updateUser('admin', { isAdmin: false })).rejects.toThrow('last administrator')
    await expect(actions.updateUserPassword('admin', undefined)).rejects.toThrow('Administrator accounts require a password')
    await expect(actions.deleteUser('admin')).rejects.toThrow('last administrator')
  })

  test('rejects foreign habit IDs and non-interaction edits', async () => {
    const visible = await actions.loadHabitsData()
    const shared = visible.habits[0]
    await expect(actions.saveHabitsData({ habits: [{ ...shared, name: 'Changed' }] })).rejects.toThrow('Only interaction fields')
    await expect(actions.saveHabitsData({ habits: [{ ...shared, id: 'foreign' }] })).rejects.toThrow('another user')
    await actions.saveHabitsData({ habits: [{ ...shared, completions: ['2026-01-01T00:00:00Z'] }] })
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'habits.json'), 'utf8'))
    expect(saved.habits.find((habit: { id: string }) => habit.id === 'foreign').name).toBe('Foreign')
    expect(saved.habits.find((habit: { id: string }) => habit.id === 'shared').completions).toHaveLength(1)
  })

  test('rejects transaction tampering and cross-user credits', async () => {
    const coins = await actions.loadCoinsData()
    await expect(actions.saveCoinsData({ ...coins, transactions: [{ ...coins.transactions[0], amount: 999 }] })).rejects.toThrow('Only transaction notes')
    await expect(actions.addCoins({ amount: 1, description: 'Test', userId: 'other' })).rejects.toThrow('another user')
    await actions.saveCoinsData({ ...coins, transactions: [{ ...coins.transactions[0], note: 'Updated' }] })
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(saved.transactions[0].note).toBe('Updated')
    expect(saved.transactions[0].amount).toBe(2)
  })

  test('allows one reward per completed habit day and a matching undo', async () => {
    const shared = (await actions.loadHabitsData()).habits[0]
    await actions.saveHabitsData({ habits: [{
      ...shared, completions: ['2026-01-01T12:00:00Z'],
    }] })
    await actions.addCoins({
      amount: 2, description: 'Completed', type: 'HABIT_COMPLETION', relatedItemId: 'shared',
    })
    await expect(actions.addCoins({
      amount: 2, description: 'Replay', type: 'HABIT_COMPLETION', relatedItemId: 'shared',
    })).rejects.toThrow('No uncredited habit completion')
    await actions.saveHabitsData({ habits: [{ ...shared, completions: [] }] })
    await actions.removeCoins({
      amount: 2, description: 'Undo', type: 'HABIT_UNDO', relatedItemId: 'shared',
    })
    await expect(actions.removeCoins({
      amount: 2, description: 'Replay undo', type: 'HABIT_UNDO', relatedItemId: 'shared',
    })).rejects.toThrow('No habit reward to undo')
  })

  test('keeps system settings under administrator control', async () => {
    const settings = await actions.loadSettings()
    await expect(actions.saveSettings({
      ...settings,
      system: { ...settings.system, autoBackupEnabled: false },
    })).rejects.toThrow('Only administrators')
    await actions.saveSettings({ ...settings, ui: { ...settings.ui, useGrouping: false } })
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'settings.json'), 'utf8'))
    expect(saved.ui.useGrouping).toBe(false)
    expect(saved.system.autoBackupEnabled).toBe(true)
  })

  test('requires a session and bounded freshness token', async () => {
    currentUser = undefined
    await expect(actions.checkDataFreshness('token')).rejects.toThrow('User not authenticated')
    currentUser = member
    await expect(actions.checkDataFreshness('x'.repeat(129))).rejects.toThrow('Invalid freshness token')
  })

  test('does not replace malformed account data with a default admin', async () => {
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), '{bad json')
    await expect(actions.getUser('admin')).rejects.toThrow()
    expect(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).toBe('{bad json')
  })

  test('requires a strong initial administrator password only for a new store', async () => {
    await fs.unlink(path.join(directory, 'data', 'auth.json'))
    const previous = process.env.INITIAL_ADMIN_PASSWORD
    try {
      delete process.env.INITIAL_ADMIN_PASSWORD
      await expect(actions.loadUsersPublicData()).rejects.toThrow('INITIAL_ADMIN_PASSWORD')
      process.env.INITIAL_ADMIN_PASSWORD = 'a-strong-password'
      const users = await actions.loadUsersPublicData()
      expect(users.users[0].isAdmin).toBe(true)
      expect(users.users[0].hasPassword).toBe(true)
      const stored = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
      expect(stored.users[0].password).not.toBe('a-strong-password')
      expect(stored.users[0].password).toContain(':')
    } finally {
      if (previous === undefined) delete process.env.INITIAL_ADMIN_PASSWORD
      else process.env.INITIAL_ADMIN_PASSWORD = previous
    }
  })
})
