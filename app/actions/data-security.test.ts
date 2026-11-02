import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { User } from '@/lib/types'
import { saltAndHashPassword, verifyPassword } from '@/lib/password'
import sharp from 'sharp'

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
    await expect(actions.saveHabitsData({ habits: [{ ...shared, position: 0 }] })).rejects.toThrow('Only interaction fields')
    await expect(actions.saveHabitsData({ habits: [{ ...shared, id: 'foreign' }] })).rejects.toThrow('another user')
    await actions.recordHabitCompletion('shared', new Date().toISOString())
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'habits.json'), 'utf8'))
    expect(saved.habits.find((habit: { id: string }) => habit.id === 'foreign').name).toBe('Foreign')
    expect(saved.habits.find((habit: { id: string }) => habit.id === 'shared').completions).toHaveLength(1)
  })

  test('saves a writer-controlled custom order without changing completions', async () => {
    await expect(actions.reorderHabitItems(['shared'], false)).rejects.toThrow('write permission for habit')
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await expect(actions.reorderHabitItems(['foreign'], false)).rejects.toThrow('inaccessible item')
    currentUser = admin
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'data', 'habits.json'), 'utf8'))
    stored.habits[0].name = 'Edited by another session'
    await fs.writeFile(path.join(directory, 'data', 'habits.json'), JSON.stringify(stored))
    await actions.reorderHabitItems(['foreign', 'shared'], false)
    const saved = await actions.loadHabitsData()
    expect(saved.habits.map(habit => [habit.id, habit.name, habit.position, habit.completions]))
      .toEqual([['shared', 'Edited by another session', 1, []], ['foreign', 'Foreign', 0, []]])
  })

  test('lets assigned members check off task steps without editing another task', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0] = {
      ...stored.habits[0], isTask: true, frequency: new Date().toISOString(),
      checklist: [{ id: 'step-1', text: 'Prepare', completed: false }],
    }
    stored.habits[1] = {
      ...stored.habits[1], isTask: true, frequency: new Date().toISOString(),
      checklist: [{ id: 'step-2', text: 'Private', completed: false }],
    }
    await fs.writeFile(habitFile, JSON.stringify(stored))
    expect((await actions.toggleTaskChecklistItem('shared', 'step-1', true)).checklist?.[0].completed).toBe(true)
    await expect(actions.toggleTaskChecklistItem('foreign', 'step-2', true)).rejects.toThrow('not allowed')
    await expect(actions.toggleTaskChecklistItem('shared', 'missing', true)).rejects.toThrow('not allowed')
    expect((await actions.loadHabitsData()).habits[0].checklist?.[0].completed).toBe(true)
  })

  test('holds approval submissions and pays only the completing account after a chosen approver accepts', async () => {
    currentUser = admin
    const existing = await actions.loadHabitsData()
    await actions.saveHabitsData({ habits: existing.habits.map(item => item.id === 'shared'
      ? { ...item, requiresApproval: true, approverIds: ['other', 'member'] } : item) })
    const stored = (await actions.loadHabitsData()).habits.find(item => item.id === 'shared')!
    expect(stored.createdBy).toBeUndefined()
    currentUser = member
    const form = new FormData()
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .withExif({ IFD0: { Copyright: 'secret-location-marker' } }).png().toBuffer()
    expect(image.includes(Buffer.from('secret-location-marker'))).toBe(true)
    form.set('evidence', new File([image], 'proof.png', { type: 'image/png' }))
    const submitted = await actions.recordHabitCompletion('shared', new Date().toISOString(), form)
    expect(submitted.pending).toBe(true)
    expect(submitted.rewarded).toBe(false)
    expect(submitted.coins.transactions.filter(tx => tx.type === 'HABIT_COMPLETION')).toHaveLength(0)
    const completionId = submitted.habit.completionRecords![0]!.id
    expect(await fs.readdir(path.join(directory, 'data', 'evidence'))).toEqual([`${completionId}.webp`])
    const storedImage = await fs.readFile(path.join(directory, 'data', 'evidence', `${completionId}.webp`))
    expect(storedImage.toString('ascii', 0, 4)).toBe('RIFF')
    expect(storedImage.includes(Buffer.from('secret-location-marker'))).toBe(false)
    expect(await actions.loadPendingApprovals()).toHaveLength(1)
    currentUser = admin
    expect(await actions.loadPendingApprovals()).toHaveLength(0)
    await expect(actions.reviewHabitCompletion('shared', completionId, 'approve')).rejects.toThrow('Approval is not allowed')
    currentUser = other
    expect(await actions.loadPendingApprovals()).toHaveLength(1)
    const reviewed = await actions.reviewHabitCompletion('shared', completionId, 'approve')
    expect(reviewed.approved).toBe(true)
    expect(reviewed.habit?.id).toBe('shared')
    expect((await actions.loadPendingApprovals())).toHaveLength(0)
    await expect(actions.reviewHabitCompletion('shared', completionId, 'approve')).rejects.toThrow('no longer pending')
    const coins = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(coins.transactions[0]).toMatchObject({ userId: 'member', amount: 2, completionId })
  })

  test('does not disclose a habit to an approver who is not assigned to it', async () => {
    currentUser = admin
    const existing = await actions.loadHabitsData()
    await actions.saveHabitsData({ habits: existing.habits.map(item => item.id === 'shared'
      ? { ...item, description: 'Private notes', userIds: ['member'], requiresApproval: true,
        approverIds: ['other'] } : item) })
    currentUser = member
    const submitted = await actions.recordHabitCompletion('shared', new Date().toISOString())
    const completionId = submitted.habit.completionRecords![0]!.id
    currentUser = other
    expect((await actions.loadHabitsData()).habits.some(item => item.id === 'shared')).toBe(false)
    expect((await actions.loadPendingApprovals())[0].completionId).toBe(completionId)
    const reviewed = await actions.reviewHabitCompletion('shared', completionId, 'approve')
    expect(reviewed.approved).toBe(true)
    expect(reviewed.habit).toBeNull()
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'data', 'habits.json'), 'utf8'))
    expect(saved.habits.find((item: { id: string }) => item.id === 'shared').completionRecords[0].approval).toBe('approved')
    const coins = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(coins.transactions[0]).toMatchObject({ userId: 'member', amount: 2, completionId })
  })

  test('rejecting a submission allows resubmission without a coin award', async () => {
    currentUser = admin
    const existing = await actions.loadHabitsData()
    await actions.saveHabitsData({ habits: existing.habits.map(item => item.id === 'shared'
      ? { ...item, requiresApproval: true, approverIds: ['member'] } : item) })
    currentUser = member
    const first = await actions.recordHabitCompletion('shared', new Date().toISOString())
    await actions.reviewHabitCompletion('shared', first.habit.completionRecords![0]!.id, 'reject')
    expect((await actions.loadPendingApprovals())).toHaveLength(0)
    const second = await actions.recordHabitCompletion('shared', new Date().toISOString())
    expect(second.pending).toBe(true)
    expect(second.habit.completionRecords?.[0]?.approval).toBe('rejected')
    expect(second.habit.completionRecords?.[1]?.approval).toBe('pending')
  })

  test('allows a listed approver to approve their own completion', async () => {
    currentUser = admin
    const existing = await actions.loadHabitsData()
    await actions.saveHabitsData({ habits: existing.habits.map(item => item.id === 'shared'
      ? { ...item, requiresApproval: true, approverIds: ['member'] } : item) })
    currentUser = member
    const submitted = await actions.recordHabitCompletion('shared', new Date().toISOString())
    const reviewed = await actions.reviewHabitCompletion('shared', submitted.habit.completionRecords![0]!.id, 'approve')
    expect(reviewed.approved).toBe(true)
    expect(reviewed.coins.transactions[0]).toMatchObject({ userId: 'member', amount: 2 })
  })

  test('keeps recurring tasks open until their occurrence goal and honors a temporary boost', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    stored.habits[0] = {
      ...stored.habits[0], isTask: true, frequency: yesterday, taskRepeat: 'daily',
      taskGoalOccurrences: 2, completions: [yesterday], completionRecords: [null],
      coinBoost: { multiplier: 2, startsAt: '2000-01-01T00:00:00.000Z',
        until: '2099-01-01T00:00:00.000Z' },
    }
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const result = await actions.recordHabitCompletion('shared', new Date().toISOString())
    expect(result.habit.archived).toBe(true)
    expect(result.rewardAmount).toBe(4)
    expect(result.coins.transactions[0]).toMatchObject({ userId: 'member', amount: 4 })
  })

  test('rejects an invalid or oversized evidence image', async () => {
    currentUser = admin
    const existing = await actions.loadHabitsData()
    await actions.saveHabitsData({ habits: existing.habits.map(item => item.id === 'shared'
      ? { ...item, requiresApproval: true, approverIds: ['member'] } : item) })
    currentUser = member
    const invalid = new FormData()
    invalid.set('evidence', new File(['<html>'], 'fake.png', { type: 'image/png' }))
    await expect(actions.recordHabitCompletion('shared', new Date().toISOString(), invalid)).rejects.toThrow('Invalid evidence image')
    const oversized = new FormData()
    oversized.set('evidence', new File([new Uint8Array(2_000_001)], 'large.png', { type: 'image/png' }))
    await expect(actions.recordHabitCompletion('shared', new Date().toISOString(), oversized)).rejects.toThrow('Invalid evidence image')
    expect((await actions.loadHabitsData()).habits[0].completions).toHaveLength(0)
  })

  test('preserves pin, task, and archive flags when an edit omits them', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0] = { ...stored.habits[0], pinned: true, isTask: true, archived: true, frequency: new Date().toISOString() }
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const { pinned, isTask, archived, ...edited } = stored.habits[0]
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await actions.saveHabitsData({ habits: [{ ...edited, name: 'Renamed task' }] })
    const saved = (await actions.loadHabitsData()).habits.find(habit => habit.id === 'shared')!
    expect({ pinned: saved.pinned, isTask: saved.isTask, archived: saved.archived, name: saved.name })
      .toEqual({ pinned: true, isTask: true, archived: true, name: 'Renamed task' })
  })

  test('credits only the recorder and only they can reverse their shared completion', async () => {
    const timestamp = new Date().toISOString()
    const completed = await actions.recordHabitCompletion('shared', timestamp)
    expect(completed.rewarded).toBe(true)
    expect(completed.habit.completionRecords?.[0]?.actorId).toBe('member')
    expect(completed.habit.completionRecords?.[0]?.rewardedUserIds).toEqual(['member'])
    const coinFile = path.join(directory, 'data', 'coins.json')
    const credits = JSON.parse(await fs.readFile(coinFile, 'utf8')).transactions
      .filter((tx: { type: string }) => tx.type === 'HABIT_COMPLETION')
    expect(credits.map((tx: { userId: string }) => tx.userId)).toEqual(['member'])
    expect(credits.every((tx: { actorId: string }) => tx.actorId === 'member')).toBe(true)

    currentUser = { ...other, permissions: member.permissions }
    await expect(actions.undoHabitCompletion('shared', 0, timestamp)).rejects.toThrow('Only the person')
    await expect(actions.saveHabitsData({ habits: [{ ...completed.habit, completions: [] }] }))
      .rejects.toThrow('Use the completion action')
    currentUser = { ...other, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await expect(actions.saveHabitsData({ habits: [{ ...completed.habit, completions: [] }] }))
      .rejects.toThrow('Use the completion action')
    await expect(actions.addCoins({ amount: 2, description: 'Extra', type: 'HABIT_COMPLETION', relatedItemId: 'shared' }))
      .rejects.toThrow('managed by completion actions')

    currentUser = member
    const undone = await actions.undoHabitCompletion('shared', 0, timestamp)
    expect(undone.habit.completions).toEqual([])
    const debits = JSON.parse(await fs.readFile(coinFile, 'utf8')).transactions
      .filter((tx: { type: string }) => tx.type === 'HABIT_UNDO')
    expect(debits.map((tx: { userId: string }) => tx.userId)).toEqual(['member'])
    expect(debits.every((tx: { amount: number }) => tx.amount === -2)).toBe(true)
    await expect(actions.undoHabitCompletion('shared', 0, timestamp)).rejects.toThrow('Completion has changed')
  })

  test('preserves completion ownership through edits and reverses historical group credits', async () => {
    const timestamp = new Date().toISOString()
    const habitFile = path.join(directory, 'data', 'habits.json')
    const coinFile = path.join(directory, 'data', 'coins.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].completions = [timestamp]
    stored.habits[0].completionRecords = [{ id: 'old-completion', actorId: 'member', rewardedUserIds: ['member', 'other'] }]
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const oldCoins = JSON.parse(await fs.readFile(coinFile, 'utf8'))
    oldCoins.balance += 4
    oldCoins.transactions.unshift(...['member', 'other'].map(userId => ({
      id: `award-${userId}`, userId, actorId: 'member', completionId: 'old-completion', amount: 2,
      type: 'HABIT_COMPLETION', relatedItemId: 'shared', description: 'Old shared award', timestamp,
    })))
    await fs.writeFile(coinFile, JSON.stringify(oldCoins))
    const completed = (await actions.loadHabitsData()).habits[0]
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await expect(actions.saveHabitsData({ habits: [{ ...completed, completionRecords: [{ id: 'forged', actorId: 'other' }] }] }))
      .rejects.toThrow('Use the completion action')
    const { completionRecords: _omitted, ...withoutRecords } = completed
    await actions.saveHabitsData({ habits: [{ ...withoutRecords, name: 'Renamed', userIds: ['member'], coinReward: 5, targetCompletions: 2 }] })
    const saved = (await actions.loadHabitsData()).habits[0]
    expect(saved.completionRecords?.[0]?.actorId).toBe('member')
    await actions.undoHabitCompletion('shared', 0, timestamp)
    const transactions = JSON.parse(await fs.readFile(coinFile, 'utf8')).transactions
    expect(transactions.filter((tx: { type: string; amount: number }) =>
      tx.type === 'HABIT_UNDO' && tx.amount === -2).map((tx: { userId: string }) => tx.userId).sort())
      .toEqual(['member', 'other'])
  })

  test('keeps legacy shared completions readable but denies member undo without an actor', async () => {
    const timestamp = new Date().toISOString()
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].completions = [timestamp]
    await fs.writeFile(habitFile, JSON.stringify(stored))
    expect((await actions.loadHabitsData()).habits[0].completions).toEqual([timestamp])
    await expect(actions.undoHabitCompletion('shared', 0, timestamp)).rejects.toThrow('Only the person')
    await expect(actions.saveHabitsData({ habits: [{ ...stored.habits[0], completions: [] }] }))
      .rejects.toThrow('Use the completion action')
  })

  test('credits only the target-reaching recorder and lets them undo the reward', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].targetCompletions = 2
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const first = await actions.recordHabitCompletion('shared', new Date().toISOString())
    expect(first.rewarded).toBe(false)
    currentUser = { ...other, permissions: member.permissions }
    const second = await actions.recordHabitCompletion('shared', new Date(Date.now() + 1).toISOString())
    expect(second.rewarded).toBe(true)
    expect(second.habit.completionRecords?.[1]?.rewardedUserIds).toEqual(['other'])
    expect((await actions.loadCoinsData()).transactions.filter(tx => tx.type === 'HABIT_COMPLETION').map(tx => tx.userId))
      .toEqual(['other'])
    currentUser = member
    await expect(actions.undoHabitCompletion('shared', second.completionIndex, second.completionTimestamp))
      .rejects.toThrow('Only the person')
    currentUser = { ...other, permissions: member.permissions }
    const undone = await actions.undoHabitCompletion('shared', second.completionIndex, second.completionTimestamp)
    expect(undone.habit.completions).toHaveLength(1)
    expect(undone.rewardReversed).toBe(true)
  })

  test('does not award a second time on the same day when the daily target changes', async () => {
    const first = await actions.recordHabitCompletion('shared', new Date().toISOString())
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await actions.saveHabitsData({ habits: [{ ...first.habit, targetCompletions: 2 }] })
    const second = await actions.recordHabitCompletion('shared', new Date(Date.now() + 1).toISOString())
    expect(second.targetReached).toBe(true)
    expect(second.rewarded).toBe(false)
    expect(second.habit.completionRecords?.[1]?.rewardedUserIds).toBeUndefined()
    const transactions = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8')).transactions
    expect(transactions.filter((tx: { type: string }) => tx.type === 'HABIT_COMPLETION')).toHaveLength(1)
    await actions.undoHabitCompletion('shared', 1, second.completionTimestamp)
    expect((await actions.loadCoinsData()).transactions.filter(tx => tx.type === 'HABIT_UNDO')).toHaveLength(0)
    await actions.undoHabitCompletion('shared', 0, first.completionTimestamp)
    const reversed = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8')).transactions
    expect(reversed.filter((tx: { type: string }) => tx.type === 'HABIT_UNDO')).toHaveLength(1)
  })

  test('lets an administrator recover a completion after its recorder is unassigned', async () => {
    const completed = await actions.recordHabitCompletion('shared', new Date().toISOString())
    currentUser = { ...other, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await actions.saveHabitsData({ habits: [{ ...completed.habit, userIds: ['other'] }] })
    currentUser = member
    await expect(actions.undoHabitCompletion('shared', 0, completed.completionTimestamp))
      .rejects.toThrow('Habit interaction is not allowed')
    currentUser = admin
    const undone = await actions.undoHabitCompletion('shared', 0, completed.completionTimestamp)
    expect(undone.rewardReversed).toBe(true)
    expect((await actions.loadCoinsData()).transactions.filter(tx => tx.type === 'HABIT_UNDO')).toHaveLength(1)
  })

  test('prevents stale administrator saves and manual reward actions from changing managed history', async () => {
    currentUser = admin
    const stale = (await actions.loadHabitsData()).habits.find(habit => habit.id === 'shared')!
    currentUser = member
    await actions.recordHabitCompletion('shared', new Date().toISOString())
    currentUser = admin
    await expect(actions.saveHabitsData({ habits: [stale] })).rejects.toThrow('Use the completion action')
    await expect(actions.addCoins({ amount: 2, description: 'Extra', type: 'HABIT_COMPLETION', relatedItemId: 'shared' }))
      .rejects.toThrow('managed by completion actions')
    await expect(actions.removeCoins({ amount: 2, description: 'Extra', type: 'HABIT_UNDO', relatedItemId: 'shared' }))
      .rejects.toThrow('managed by completion actions')
  })

  test('rejects a completion that would exceed the stored history limit', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].completions = Array.from({ length: 20_000 }, (_, index) =>
      new Date(Date.now() - (index + 1) * 60_000).toISOString())
    await fs.writeFile(habitFile, JSON.stringify(stored))
    await expect(actions.recordHabitCompletion('shared', new Date().toISOString()))
      .rejects.toThrow('Habit completion limit reached')
    expect((await actions.loadHabitsData()).habits[0].completions).toHaveLength(20_000)
  })

  test('serializes concurrent shared completions and does not create zero-value rewards', async () => {
    const timestamp = new Date().toISOString()
    const results = await Promise.allSettled([
      actions.recordHabitCompletion('shared', timestamp), actions.recordHabitCompletion('shared', timestamp),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const coins = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(coins.transactions.filter((tx: { type: string }) => tx.type === 'HABIT_COMPLETION')).toHaveLength(1)

    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].completions = []
    stored.habits[0].completionRecords = []
    stored.habits[0].coinReward = 0
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const zero = await actions.recordHabitCompletion('shared', new Date().toISOString())
    expect(zero.rewarded).toBe(true)
    const after = JSON.parse(await fs.readFile(path.join(directory, 'data', 'coins.json'), 'utf8'))
    expect(after.transactions.filter((tx: { type: string }) => tx.type === 'HABIT_COMPLETION')).toHaveLength(1)
  })

  test('restores habit history if writing shared coin rewards fails', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const coinFile = path.join(directory, 'data', 'coins.json')
    const habitsBefore = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    const coinsBefore = JSON.parse(await fs.readFile(coinFile, 'utf8'))
    const originalRename = fs.rename.bind(fs)
    const renameSpy = spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (destination === coinFile) throw new Error('coin write failed')
      return originalRename(source, destination)
    })
    try {
      await expect(actions.recordHabitCompletion('shared', new Date().toISOString()))
        .rejects.toThrow('coin write failed')
    } finally {
      renameSpy.mockRestore()
    }
    expect(JSON.parse(await fs.readFile(habitFile, 'utf8'))).toEqual(habitsBefore)
    expect(JSON.parse(await fs.readFile(coinFile, 'utf8'))).toEqual(coinsBefore)
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
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].completions = ['2026-01-01T12:00:00Z']
    await fs.writeFile(habitFile, JSON.stringify(stored))
    await actions.addCoins({
      amount: 2, description: 'Completed', type: 'HABIT_COMPLETION', relatedItemId: 'shared',
    })
    await expect(actions.addCoins({
      amount: 2, description: 'Replay', type: 'HABIT_COMPLETION', relatedItemId: 'shared',
    })).rejects.toThrow('No uncredited habit completion')
    stored.habits[0].completions = []
    await fs.writeFile(habitFile, JSON.stringify(stored))
    await actions.removeCoins({
      amount: 2, description: 'Undo', type: 'HABIT_UNDO', relatedItemId: 'shared',
    })
    await expect(actions.removeCoins({
      amount: 2, description: 'Replay undo', type: 'HABIT_UNDO', relatedItemId: 'shared',
    })).rejects.toThrow('No habit reward to undo')
  })

  test('reverses the original legacy solo reward after the configured amount changes', async () => {
    const timestamp = new Date().toISOString()
    const habitFile = path.join(directory, 'data', 'habits.json')
    const coinFile = path.join(directory, 'data', 'coins.json')
    for (const changedReward of [0, 5]) {
      const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
      stored.habits[0] = { ...stored.habits[0], userIds: ['member'], completions: [timestamp], completionRecords: undefined, coinReward: changedReward }
      await fs.writeFile(habitFile, JSON.stringify(stored))
      await fs.writeFile(coinFile, JSON.stringify({ balance: 4, transactions: [
        { id: 'award', userId: 'member', amount: 2, type: 'HABIT_COMPLETION', relatedItemId: 'shared', description: 'Old award', timestamp },
        { id: 'tx1', userId: 'member', amount: 2, type: 'MANUAL_ADJUSTMENT', description: 'Test', timestamp },
      ] }))
      const undone = await actions.undoHabitCompletion('shared', 0, timestamp)
      expect(undone.rewardReversed).toBe(true)
      expect((await actions.loadCoinsData()).transactions[0].amount).toBe(-2)
    }
  })

  test('prevents concurrent duplicate habit rewards', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].completions = [new Date().toISOString()]
    await fs.writeFile(habitFile, JSON.stringify(stored))
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
    await expect(actions.saveHabitsData({ habits: [{ ...shared, completions: [new Date().toISOString(), new Date().toISOString()] }] })).rejects.toThrow('Use the completion action')
  })

  test('rejects new completions on already archived habits while preserving task rewards', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    stored.habits[0].archived = true
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const archived = (await actions.loadHabitsData()).habits[0]
    await expect(actions.saveHabitsData({ habits: [{ ...archived, completions: [new Date().toISOString()] }] }))
      .rejects.toThrow('Use the completion action')
    await expect(actions.recordHabitCompletion('shared', new Date().toISOString()))
      .rejects.toThrow('Cannot complete an archived habit')
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    await expect(actions.saveHabitsData({ habits: [{ ...archived, completions: [new Date().toISOString()] }] }))
      .rejects.toThrow('Use the completion action')
    expect(JSON.parse(await fs.readFile(habitFile, 'utf8')).habits[0].completions).toEqual([])

    stored.habits[0].completions = ['2026-11-01T12:00:00.000Z']
    await fs.writeFile(habitFile, JSON.stringify(stored))
    const completedArchive = (await actions.loadHabitsData()).habits[0]
    await expect(actions.saveHabitsData({ habits: [{ ...completedArchive, completions: ['2026-11-02T12:00:00.000Z'] }] }))
      .rejects.toThrow('Use the completion action')

    stored.habits[0] = { ...stored.habits[0], id: 'task', isTask: true, archived: false, completions: [], frequency: new Date().toISOString(), targetCompletions: 1 }
    await fs.writeFile(habitFile, JSON.stringify(stored))
    currentUser = member
    await actions.recordHabitCompletion('task', new Date().toISOString())
    expect((await actions.loadCoinsData()).transactions[0].type).toBe('TASK_COMPLETION')
    expect((await actions.loadHabitsData()).habits.find((habit: { id: string }) => habit.id === 'task')?.archived).toBe(true)
    const completedTask = (await actions.loadHabitsData()).habits.find((habit: { id: string }) => habit.id === 'task')!
    await actions.undoHabitCompletion('task', 0, completedTask.completions[0])
    expect((await actions.loadHabitsData()).habits.find((habit: { id: string }) => habit.id === 'task')?.archived).toBe(false)
    expect((await actions.loadCoinsData()).transactions[0].type).toBe('TASK_UNDO')
  })

  test('preserves unchanged legacy crowded schedules during another habit save', async () => {
    const habitFile = path.join(directory, 'data', 'habits.json')
    const stored = JSON.parse(await fs.readFile(habitFile, 'utf8'))
    const crowdedTimes = `FREQ=DAILY;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(',')};BYMINUTE=${Array.from({ length: 11 }, (_, i) => i).join(',')}`
    stored.habits[0].frequency = crowdedTimes
    stored.habits[1].userIds = ['member']
    await fs.writeFile(habitFile, JSON.stringify(stored))
    currentUser = { ...member, permissions: [{ ...member.permissions![0], habit: { write: true, interact: true } }] }
    const visible = (await actions.loadHabitsData()).habits
    const updated = visible.map(habit => habit.id === 'foreign'
      ? { ...habit, name: 'Renamed' } : habit)
    await actions.saveHabitsData({ habits: updated })
    expect(JSON.parse(await fs.readFile(habitFile, 'utf8')).habits[1].name).toBe('Renamed')
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
