import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { User } from '@/lib/types'
import { saltAndHashPassword, verifyPassword } from '@/lib/password'

let currentUser: User | undefined

mock.module('@/lib/server-helpers', () => ({
  getCurrentUser: async () => currentUser,
  verifyPassword,
  saltAndHashPassword,
}))
mock.module('server-only', () => ({}))

const actions = await import('./data')
const { authenticateLocalUser, linkUserToAuthentikSubject } = await import('@/lib/auth-store')

const admin: User = { id: 'admin', username: 'admin', email: 'admin@example.com', isAdmin: true, password: saltAndHashPassword('secret') }
const member: User = {
  id: 'member', username: 'member', email: 'member@example.com', isAdmin: false, password: saltAndHashPassword('secret'),
  permissions: [{
    habit: { write: false, interact: true },
    wishlist: { write: false, interact: true },
    coins: { write: true, interact: true },
  }],
}
const other: User = { id: 'other', username: 'other', email: 'other@example.com', isAdmin: false, password: saltAndHashPassword('secret') }

let directory: string
let cwdSpy: ReturnType<typeof spyOn>

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-security-'))
  await fs.mkdir(path.join(directory, 'data'))
  await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [admin, member, other] }))
  await fs.writeFile(path.join(directory, 'data', 'habits.json'), JSON.stringify({ habits: [
    { id: 'shared', name: 'Shared', description: '', frequency: 'FREQ=DAILY', coinReward: 2, completions: [], userIds: ['member', 'other'] },
    { id: 'foreign', name: 'Foreign', description: '', frequency: 'FREQ=DAILY', coinReward: 3, completions: [], userIds: ['other'] },
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

  test('limits retained avatar uploads per account', async () => {
    const form = new FormData()
    form.set('avatar', new File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', { type: 'image/png' }))
    for (let index = 0; index < 4; index++) await actions.uploadAvatar(form)
    expect((await fs.readdir(path.join(directory, 'data', 'avatars'))).filter(file => file.startsWith('member-'))).toHaveLength(3)
  })

  test('removes generated avatars when their account is deleted', async () => {
    const avatar = new FormData()
    avatar.set('avatar', new File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', { type: 'image/png' }))
    const memberPath = await actions.uploadAvatar(avatar)
    currentUser = other
    const otherPath = await actions.uploadAvatar(avatar)
    const avatarsDir = path.join(directory, 'data', 'avatars')
    await fs.writeFile(path.join(avatarsDir, 'member-custom.png'), 'unrelated')
    currentUser = admin
    await actions.deleteUser('member')
    expect((await fs.readdir(avatarsDir)).sort()).toEqual(['member-custom.png', path.basename(otherPath)].sort())
    expect(memberPath).toContain('/data/avatars/member-')
    currentUser = member
    await expect(actions.uploadAvatar(avatar)).rejects.toThrow('User not authenticated')
  })

  test('keeps the account when avatar cleanup fails', async () => {
    const avatar = new FormData()
    avatar.set('avatar', new File([new Uint8Array([137, 80, 78, 71])], 'avatar.png', { type: 'image/png' }))
    await actions.uploadAvatar(avatar)
    const unlinkSpy = spyOn(fs, 'unlink').mockRejectedValue(new Error('EACCES'))
    try {
      currentUser = admin
      await expect(actions.deleteUser(member.id)).rejects.toThrow('EACCES')
      const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
      expect(saved.users.some((user: User) => user.id === member.id)).toBe(true)
    } finally {
      unlinkSpy.mockRestore()
    }
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

  test('hides the account directory from signed-out visitors', async () => {
    currentUser = undefined
    expect(await actions.loadUsersPublicData()).toEqual({ users: [] })
  })

  test('requires a legacy account to add email before accessing data or changing other fields', async () => {
    currentUser = { ...member, email: undefined }
    const auth = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
    delete auth.users[1].email
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify(auth))
    expect((await actions.loadHabitsData()).habits).toEqual([])
    expect((await actions.loadUsersPublicData()).users).toHaveLength(1)
    await expect(actions.saveHabitsData({ habits: [] })).rejects.toThrow('Email is required')
    await expect(actions.updateUser('member', { username: 'renamed' })).rejects.toThrow('Email is required')
    await actions.updateUser('member', { email: 'member@example.com' })
    const updated = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
    expect(updated.users[1].email).toBe('member@example.com')
  })

  test('requires the current password and invalidates sessions when changing it', async () => {
    await expect(actions.updateUserPassword('member', 'new-strong-password', 'wrong')).rejects.toThrow('Current password is incorrect')
    await actions.updateUserPassword('member', 'new-strong-password', 'secret')
    const auth = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
    expect(verifyPassword('new-strong-password', auth.users[1].password)).toBe(true)
    expect(auth.users[1].authVersion).toBe(1)
  })

  test('allows authenticated password confirmation during a public login lockout', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(await authenticateLocalUser(member.username, 'wrong-password')).toBeNull()
    }
    expect(await authenticateLocalUser(member.username, 'secret')).toBeNull()
    await actions.updateUserPassword(member.id, 'replacement-password-123', 'secret')
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
    expect(verifyPassword('replacement-password-123', saved.users.find((user: User) => user.id === member.id).password)).toBe(true)
  })

  test('requires an administrator to add the first local password to an Authentik-only account', async () => {
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), JSON.stringify({ users: [admin, { ...member, password: undefined, authentikSubject: 'subject-1' }] }))
    currentUser = { ...member, password: undefined, authentikSubject: 'subject-1' }
    await expect(actions.updateUserPassword('member', 'strong-password-123')).rejects.toThrow('administrator must set')
    currentUser = admin
    await actions.updateUserPassword('member', 'strong-password-123')
    const updated = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).users[1]
    expect(updated.password).toBeDefined()
  })

  test('links only a confirmed email to an unused Authentik subject', async () => {
    currentUser = admin
    await actions.updateUser('member', { email: 'MEMBER@example.com' })
    const linked = await linkUserToAuthentikSubject('member', 1, 'member@example.com', 'opaque-subject', 'https://auth.example.test/issuer')
    expect(linked.authentikSubject).toBe('opaque-subject')
    expect(linked.oidcIssuer).toBe('https://auth.example.test/issuer')
    expect(linked.authVersion).toBe(2)
    const publicUsers = await actions.loadUsersPublicData()
    expect(publicUsers.users.find(user => user.id === 'member')).not.toHaveProperty('oidcIssuer')
    await expect(linkUserToAuthentikSubject('member', 1, 'member@example.com', 'other-subject', 'https://auth.example.test/issuer')).rejects.toThrow('no longer valid')
    await actions.updateUser('admin', { email: 'admin@example.com' })
    await expect(linkUserToAuthentikSubject('admin', 1, 'admin@example.com', 'opaque-subject', 'https://auth.example.test/issuer')).rejects.toThrow('already linked')
  })

  test('binds administrator pre-links to the active OIDC issuer', async () => {
    currentUser = admin
    const { getActiveOidcConfig } = await import('@/lib/admin-config')
    const active = await getActiveOidcConfig()
    if (!active) {
      await expect(actions.updateUser('member', { authentikSubject: 'new-subject' }))
        .rejects.toThrow('Configure OIDC before linking an account')
    } else {
      await actions.updateUser('member', { authentikSubject: 'new-subject' })
      const stored = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
      expect(stored.users[1].oidcIssuer).toBe(active.issuer)
    }
  })

  test('allows only admins to create users', async () => {
    const form = new FormData()
    form.set('username', 'newuser')
    form.set('password', 'valid-password-123')
    form.set('email', 'newuser@example.com')
    form.set('isAdmin', 'true')
    await expect(actions.createUser(form)).rejects.toThrow('Administrator access required')
    currentUser = admin
    form.delete('email')
    await expect(actions.createUser(form)).rejects.toThrow()
    form.set('email', 'newuser@example.com')
    const created = await actions.createUser(form)
    expect(created.isAdmin).toBe(true)
    expect(created).not.toHaveProperty('password')
    await expect(actions.updateUser(created.id, { email: '' })).rejects.toThrow()
  })

  test('requires strong passwords for new and updated accounts', async () => {
    currentUser = admin
    const form = new FormData()
    form.set('username', 'newuser')
    form.set('email', 'newuser@example.com')
    form.set('password', 'short')
    await expect(actions.createUser(form)).rejects.toThrow('at least 12')
    await expect(actions.updateUserPassword('member', 'short')).rejects.toThrow('at least 12')
  })

  test('preserves the last administrator and requires its password', async () => {
    currentUser = admin
    const form = new FormData()
    form.set('username', 'newadmin')
    form.set('email', 'newadmin@example.com')
    form.set('isAdmin', 'true')
    await expect(actions.createUser(form)).rejects.toThrow('Administrator accounts require a password')
    await expect(actions.updateUser('admin', { isAdmin: false })).rejects.toThrow('last administrator')
    await expect(actions.deleteUser('admin')).rejects.toThrow('last administrator')
    form.set('password', 'another-strong-password')
    const secondAdmin = await actions.createUser(form)
    currentUser = secondAdmin as User
    await expect(actions.updateUserPassword('admin', undefined)).rejects.toThrow('Administrator accounts require a password')
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

  test('rejects malformed and oversized coin text before storing a transaction', async () => {
    const coinFile = path.join(directory, 'data', 'coins.json')
    const original = await fs.readFile(coinFile, 'utf8')
    await expect(actions.addCoins({ amount: 1, description: { bad: true } as unknown as string })).rejects.toThrow('Invalid coin description')
    await expect(actions.removeCoins({ amount: 1, description: { bad: true } as unknown as string })).rejects.toThrow('Invalid coin description')
    await expect(actions.addCoins({ amount: 1, description: 'x'.repeat(501) })).rejects.toThrow('Invalid coin description')
    await expect(actions.addCoins({ amount: 1, description: 'Valid', note: 'x'.repeat(10_001) })).rejects.toThrow('Invalid transaction note')
    expect(await fs.readFile(coinFile, 'utf8')).toBe(original)
    await actions.addCoins({ amount: 1, description: 'Valid adjustment' })
    expect((await actions.loadCoinsData()).transactions[0].description).toBe('Valid adjustment')
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

  test('prevents concurrent duplicate habit rewards', async () => {
    const visible = await actions.loadHabitsData()
    await actions.saveHabitsData({ habits: [{ ...visible.habits[0], completions: [new Date().toISOString()] }] })
    const request = () => actions.addCoins({ amount: 2, description: 'Completed', type: 'HABIT_COMPLETION', relatedItemId: 'shared' })
    const results = await Promise.allSettled([request(), request()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const coins = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(coins.transactions.filter((transaction: { type: string }) => transaction.type === 'HABIT_COMPLETION')).toHaveLength(1)
  })

  test('prevents concurrent redemption of the same balance', async () => {
    currentUser = admin
    await actions.saveWishlistItems({ items: [{ id: 'wish', name: 'Reward', description: '', coinCost: 2, userIds: ['member'] }] })
    currentUser = member
    const request = () => actions.removeCoins({ amount: 2, description: 'Redeemed', type: 'WISH_REDEMPTION', relatedItemId: 'wish' })
    const results = await Promise.allSettled([request(), request()])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const coins = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(coins.transactions.filter((transaction: { type: string }) => transaction.type === 'WISH_REDEMPTION')).toHaveLength(1)
  })

  test('keeps redemption limits and archive state under server control', async () => {
    currentUser = admin
    await actions.saveWishlistItems({ items: [{ id: 'wish', name: 'Reward', description: '', coinCost: 2, targetCompletions: 1, userIds: ['member'] }] })
    currentUser = member
    const reward = (await actions.loadWishlistData()).items[0]
    await expect(actions.saveWishlistItems({ items: [{ ...reward, archived: true }] })).rejects.toThrow('write permission')
    await actions.removeCoins({ amount: 2, description: 'Redeemed', type: 'WISH_REDEMPTION', relatedItemId: 'wish' })
    const saved = (await actions.loadWishlistData()).items[0]
    expect(saved.archived).toBe(true)
    await expect(actions.removeCoins({ amount: 2, description: 'Replay', type: 'WISH_REDEMPTION', relatedItemId: 'wish' })).rejects.toThrow('Invalid reward')
  })

  test('requires the resource permission for reward credits and redemption', async () => {
    currentUser = admin
    await actions.saveWishlistItems({ items: [{ id: 'wish', name: 'Reward', description: '', coinCost: 2, userIds: ['member'] }] })
    currentUser = { ...member, permissions: [{ ...member.permissions![0], wishlist: { write: false, interact: false } }] }
    await expect(actions.removeCoins({ amount: 2, description: 'Redeemed', type: 'WISH_REDEMPTION', relatedItemId: 'wish' })).rejects.toThrow('Wishlist interaction')
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: false, interact: false } }] }
    await expect(actions.addCoins({ amount: 2, description: 'Credit', type: 'HABIT_COMPLETION', relatedItemId: 'shared' })).rejects.toThrow('Habit interaction')
  })

  test('rejects interaction-only archive changes and forged completion batches', async () => {
    const shared = (await actions.loadHabitsData()).habits[0]
    await expect(actions.saveHabitsData({ habits: [{ ...shared, archived: true }] })).rejects.toThrow('Only one completion')
    await expect(actions.saveHabitsData({ habits: [{ ...shared, completions: [new Date().toISOString(), new Date().toISOString()] }] })).rejects.toThrow('Only one completion')
  })

  test('rejects new completions on already archived habits while preserving task rewards', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].archived = true
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const archived = (await actions.loadHabitsData()).habits[0]
    await expect(actions.saveHabitsData({ habits: [{ ...archived, completions: [new Date().toISOString()] }] }))
      .rejects.toThrow('Cannot complete an archived habit')
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await expect(actions.saveHabitsData({ habits: [{ ...archived, completions: [new Date().toISOString()] }] }))
      .rejects.toThrow('Cannot complete an archived habit')
    expect(JSON.parse(await fs.readFile(habitFile, 'utf8')).habits[0].completions).toEqual([])

    stored.habits[0].completions = ['2026-11-01T12:00:00.000Z']
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const completedArchive = (await actions.loadHabitsData()).habits[0]
    await expect(actions.saveHabitsData({ habits: [{ ...completedArchive, completions: ['2026-11-02T12:00:00.000Z'] }] }))
      .rejects.toThrow('Cannot complete an archived habit')

    stored.habits[0] = { ...stored.habits[0], id: 'task', isTask: true, archived: false, completions: [], frequency: new Date().toISOString(), targetCompletions: 1 }
    await fs.writeFile(habitFile, JSON.stringify(stored))
    currentUser = member
    const task = (await actions.loadHabitsData()).habits[0]
    await actions.saveHabitsData({ habits: [{ ...task, completions: [new Date().toISOString()], archived: true }] })
    await actions.addCoins({ amount: 2, description: 'Completed task', type: 'TASK_COMPLETION', relatedItemId: 'task' })
    expect((await actions.loadCoinsData()).transactions[0].type).toBe('TASK_COMPLETION')
  })

  test('preserves unchanged legacy crowded schedules during another habit save', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    const crowdedTimes = `FREQ=DAILY;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(',')};BYMINUTE=${Array.from({ length: 11 }, (_, i) => i).join(',')}`
    stored.habits[0].frequency = crowdedTimes
    stored.habits[1].userIds = ['member']
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const visible = (await actions.loadHabitsData()).habits
    const updated = visible.map(habit => habit.id === 'foreign'
      ? { ...habit, completions: [...habit.completions, new Date().toISOString()] } : habit)
    await actions.saveHabitsData({ habits: updated })
    expect(JSON.parse(await fs.readFile(habitFile, 'utf8')).habits[1].completions).toHaveLength(1)
    await expect(actions.saveHabitsData({ habits: updated.map(habit => habit.id === 'shared'
      ? { ...habit, frequency: `${crowdedTimes};BYSECOND=0,1` } : habit) }))
      .rejects.toThrow('Invalid recurrence rule')
  })

  test('does not expose the household coin balance to members', async () => {
    currentUser = other
    expect((await actions.loadCoinsData()).balance).toBe(0)
  })

  test('blocks account mutations in demo mode', async () => {
    const previous = process.env.DEMO
    process.env.DEMO = 'true'
    try {
      currentUser = admin
      await expect(actions.deleteUser('other')).rejects.toThrow('demo mode')
      await expect(actions.updateUserPassword('other', 'strong-password-123')).rejects.toThrow('demo mode')
      await expect(actions.createUser(new FormData())).rejects.toThrow('demo mode')
    } finally {
      if (previous === undefined) delete process.env.DEMO
      else process.env.DEMO = previous
    }
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
    currentUser = admin
    await expect(actions.saveSettings({ ...settings, system: { ...settings.system, language: '../bad' } })).rejects.toThrow('Invalid settings')
  })

  test('retains older settings files that lack a profile section', async () => {
    const settings = await actions.loadSettings()
    await fs.writeFile(path.join(directory, 'data', 'settings.json'), JSON.stringify({ ui: settings.ui, system: settings.system }))
    await actions.saveSettings({ ...settings, ui: { ...settings.ui, useGrouping: false } })
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'settings.json'), 'utf8'))
    expect(saved.ui.useGrouping).toBe(false)
    expect(saved.profile).toEqual({})
  })

  test('requires a session and bounded freshness token', async () => {
    currentUser = undefined
    await expect(actions.checkDataFreshness('token')).rejects.toThrow('User not authenticated')
    currentUser = member
    await expect(actions.checkDataFreshness('x'.repeat(129))).rejects.toThrow('Invalid freshness token')
  })

  test('does not replace malformed account data with a default admin', async () => {
    await fs.writeFile(path.join(directory, 'data', 'auth.json'), '{bad json')
    await expect(actions.loadUsersPublicData()).rejects.toThrow()
    expect(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).toBe('{bad json')
  })

  test('requires a strong initial administrator password only for a new store', async () => {
    currentUser = admin
    await fs.unlink(path.join(directory, 'data', 'auth.json'))
    const previous = process.env.INITIAL_ADMIN_PASSWORD
    const previousEmail = process.env.INITIAL_ADMIN_EMAIL
    const previousDemo = process.env.DEMO
    try {
      process.env.DEMO = 'false'
      delete process.env.INITIAL_ADMIN_PASSWORD
      delete process.env.INITIAL_ADMIN_EMAIL
      await expect(actions.loadUsersPublicData()).rejects.toThrow('INITIAL_ADMIN_PASSWORD')
      process.env.INITIAL_ADMIN_PASSWORD = 'a-strong-password'
      await expect(actions.loadUsersPublicData()).rejects.toThrow('INITIAL_ADMIN_EMAIL')
      process.env.INITIAL_ADMIN_EMAIL = 'admin@example.com'
      const users = await actions.loadUsersPublicData()
      expect(users.users[0].isAdmin).toBe(true)
      expect(users.users[0].hasPassword).toBe(true)
      expect(users.users[0].email).toBe('admin@example.com')
      const stored = JSON.parse(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8'))
      expect(stored.users[0].password).not.toBe('a-strong-password')
      expect(stored.users[0].password).toContain(':')
    } finally {
      if (previous === undefined) delete process.env.INITIAL_ADMIN_PASSWORD
      else process.env.INITIAL_ADMIN_PASSWORD = previous
      if (previousEmail === undefined) delete process.env.INITIAL_ADMIN_EMAIL
      else process.env.INITIAL_ADMIN_EMAIL = previousEmail
      if (previousDemo === undefined) delete process.env.DEMO
      else process.env.DEMO = previousDemo
    }
  })
})
