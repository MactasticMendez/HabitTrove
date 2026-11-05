import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import sharp from 'sharp'
import type { Habit, HabitsData, CoinsData, User } from '@/lib/types'
import { getDefaultSettings } from '@/lib/types'
import { saltAndHashPassword, verifyPassword } from '@/lib/password'
import { closeDatabase, withStorageTransaction } from '@/lib/db/client'
import { readAuthDocument, readDocument, writeAuthDocument, writeDocument } from '@/lib/db/repository'
import * as repository from '@/lib/db/repository'
import { captureDatabaseSource } from '@/lib/db-migration'

const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' &&
  !!process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).pathname === '/habittrove_test_actions'

if (!enabled) test.skip('PostgreSQL server-action integration requires its isolated actions database', () => {})
else {
  let signedInId = 'member'
  mock.module('server-only', () => ({}))
  mock.module('@/lib/server-helpers', () => ({
    getCurrentUser: async () => (await readAuthDocument())?.users.find(user => user.id === signedInId),
    saltAndHashPassword,
    verifyPassword,
  }))
  const actions = await import('./data')
  const password = 'synthetic-test-password'
  const permissions = [{ habit: { write: true, interact: true }, wishlist: { write: true, interact: true }, coins: { write: true, interact: true } }]
  const users: User[] = [
    { id: 'admin', username: 'admin', email: 'admin@example.test', isAdmin: true, password: saltAndHashPassword(password) },
    ...['member', 'other'].map(id => ({ id, username: id, email: `${id}@example.test`, permissions, password: saltAndHashPassword(password), authVersion: 0 })),
  ]
  const habit: Habit = { id: 'daily', name: 'Daily', description: '', frequency: 'FREQ=DAILY', coinReward: 3,
    completions: [], userIds: ['member', 'other'], createdBy: 'admin' }
  let directory: string
  let cwd: ReturnType<typeof spyOn>
  let owner: Pool
  const now = () => new Date().toISOString()

  describe('PostgreSQL server actions with the restricted runtime login', () => {
    beforeAll(async () => {
      const runtime = new URL(process.env.DATABASE_URL!)
      const migration = new URL(process.env.DATABASE_MIGRATION_URL!)
      if (runtime.hostname !== '127.0.0.1' || runtime.port !== '15432' || runtime.pathname !== migration.pathname || runtime.host !== migration.host) {
        throw new Error('Server-action tests require the isolated local database')
      }
      owner = new Pool({ connectionString: migration.href })
      directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-pg-actions-')))
      await fs.mkdir(path.join(directory, 'data'))
      await fs.writeFile(path.join(directory, 'data', 'auth.json'), 'stale source must never be read or rewritten')
      cwd = spyOn(process, 'cwd').mockReturnValue(directory)
    })
    beforeEach(async () => {
      signedInId = 'member'
      await owner.query('DELETE FROM habittrove.attachments')
      await withStorageTransaction(async () => {
        await writeDocument('habits', { habits: [] })
        await writeDocument('wishlist', { items: [] })
        await writeDocument('coins', { balance: 0, transactions: [] })
        await writeAuthDocument({ users: structuredClone(users) })
        await writeDocument('habits', { habits: [structuredClone(habit)] })
        await writeDocument('wishlist', { items: [{ id: 'reward', name: 'Treat', description: '', coinCost: 8, userIds: ['member'], targetCompletions: 1 }] })
        await writeDocument('coins', { balance: 30, transactions: [
          { id: 'initial-member', userId: 'member', amount: 10, type: 'MANUAL_ADJUSTMENT', description: 'Seed', timestamp: now() },
          { id: 'initial-other', userId: 'other', amount: 20, type: 'MANUAL_ADJUSTMENT', description: 'Seed', timestamp: now() },
        ] })
        const settings = getDefaultSettings()
        settings.system.timezone = 'UTC'
        settings.system.autoBackupEnabled = false
        await writeDocument('settings', settings)
      })
    })
    afterAll(async () => {
      cwd?.mockRestore()
      await owner?.end()
      await closeDatabase()
      if (directory) await fs.rm(directory, { recursive: true, force: true })
    })

    test('commits a completion and reward once and returns current revisions', async () => {
      const completed = await actions.recordHabitCompletion('daily', now())
      expect(completed.rewarded).toBe(true)
      expect(completed.coins.balance).toBe(13)
      const currentRevision = (await actions.loadCoinsData()).revision
      if (completed.coins.revision === undefined || currentRevision === undefined) throw new Error('Database revisions are required')
      expect(completed.coins.revision).toBe(currentRevision)
      const saved = await actions.loadHabitsData()
      expect(saved.habits[0].completions).toHaveLength(1)
      await expect(actions.recordHabitCompletion('daily', now())).rejects.toThrow()
      expect((await actions.loadCoinsData()).transactions.filter(row => row.type === 'HABIT_COMPLETION')).toHaveLength(1)
      expect(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).toBe('stale source must never be read or rewritten')
    })

    test('a ledger failure rolls back the associated completion and document revisions', async () => {
      const before = await actions.loadHabitsData()
      await owner.query(`CREATE OR REPLACE FUNCTION habittrove.test_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='HABIT_COMPLETION' THEN RAISE EXCEPTION 'synthetic ledger failure'; END IF; RETURN NEW; END $$`)
      await owner.query('CREATE TRIGGER test_reject_completion BEFORE INSERT ON habittrove.coin_ledger FOR EACH ROW EXECUTE FUNCTION habittrove.test_reject_completion()')
      try {
        await expect(actions.recordHabitCompletion('daily', now())).rejects.toThrow('synthetic ledger failure')
        expect(await actions.loadHabitsData()).toEqual(before)
        expect((await actions.loadCoinsData()).balance).toBe(10)
      } finally {
        await owner.query('DROP TRIGGER test_reject_completion ON habittrove.coin_ledger')
        await owner.query('DROP FUNCTION habittrove.test_reject_completion()')
      }
    })

    test('stale habit, reward and note editors cannot overwrite newer data', async () => {
      const oldHabits = await actions.loadHabitsData()
      const saved = await actions.saveHabitsData({ ...oldHabits, habits: oldHabits.habits.map(item => ({ ...item, name: 'Newer name' })) })
      expect(saved.revision).toBeGreaterThan(oldHabits.revision!)
      await expect(actions.saveHabitsData(oldHabits)).rejects.toThrow('reload')
      const oldRewards = await actions.loadWishlistData()
      await actions.saveWishlistItems({ ...oldRewards, items: oldRewards.items.map(item => ({ ...item, name: 'Newer reward' })) })
      await expect(actions.saveWishlistItems(oldRewards)).rejects.toThrow('reload')
      const oldCoins = await actions.loadCoinsData()
      await actions.addCoins({ amount: 1, description: 'Another action' })
      await expect(actions.saveCoinsData(oldCoins)).rejects.toThrow('reload')
      expect((await actions.loadHabitsData()).habits[0].name).toBe('Newer name')
    })

    test('concurrent redemption cannot spend the same wallet or reward limit twice', async () => {
      const results = await Promise.allSettled([1, 2].map(() => actions.removeCoins({ amount: 8, description: 'Redeem', type: 'WISH_REDEMPTION', relatedItemId: 'reward' })))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect((await actions.loadCoinsData()).balance).toBe(2)
      expect((await actions.loadWishlistData()).items[0].archived).toBe(true)
    })

    test('wallet notes and their revision come from the same snapshot during a concurrent edit', async () => {
      const previousRevision = await repository.getDocumentRevision('coins')
      if (previousRevision === undefined) throw new Error('Database revision is required')
      const originalRevision = repository.getDocumentRevision
      let edited = false
      const revisionRead = spyOn(repository, 'getDocumentRevision').mockImplementation(async kind => {
        const revision = await originalRevision(kind)
        if (kind === 'coins' && !edited) {
          edited = true
          await owner.query(`UPDATE habittrove.coin_ledger SET attributes=jsonb_set(attributes,'{fields,note}','"newer note"') WHERE id='initial-member'`)
          await owner.query(`UPDATE habittrove.documents SET revision=revision+1 WHERE kind='coins'`)
        }
        return revision
      })
      let loaded: CoinsData
      try {
        loaded = await actions.loadCoinsData()
      } finally {
        revisionRead.mockRestore()
      }
      expect(edited).toBe(true)
      expect(loaded!.transactions.find(row => row.id === 'initial-member')?.note).toBeUndefined()
      expect(loaded!.revision).toEqual(previousRevision)
      expect((await actions.loadCoinsData()).transactions.find(row => row.id === 'initial-member')?.note).toBe('newer note')
      await expect(actions.saveCoinsData(loaded!)).rejects.toThrow('reload')
    })

    test('any-time retries credit the selected beneficiary once', async () => {
      await withStorageTransaction(async () => {
        const data = (await readAuthDocument())!
        data.users.find(user => user.id === 'member')!.managedUserIds = ['other']
        await writeAuthDocument(data)
        await writeDocument('habits', { habits: [{ ...habit, id: 'action', userIds: ['other'], schedule: { type: 'anytime', recordingPolicy: 'both' } }] })
      })
      const requestId = randomUUID()
      const timestamp = now()
      await Promise.all([1, 2].map(() => actions.recordHabitCompletion('action', timestamp, undefined, { beneficiaryId: 'other', requestId })))
      const stored = (await readDocument<HabitsData>('habits'))!.habits[0]
      expect(stored.completions).toHaveLength(1)
      const ledger = (await readDocument<CoinsData>('coins'))!.transactions.filter(row => row.type === 'HABIT_COMPLETION')
      expect(ledger).toHaveLength(1)
      expect(ledger[0].userId).toBe('other')
    })

    test('password confirmation runs outside the write transaction and preserves the JSON source', async () => {
      await actions.updateUserPassword('member', 'another-synthetic-password', password)
      const account = (await readAuthDocument())!.users.find(user => user.id === 'member')!
      expect(verifyPassword('another-synthetic-password', account.password!)).toBe(true)
      expect(account.authVersion).toBe(1)
      expect(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).toBe('stale source must never be read or rewritten')
    })

    test('evidence recorded by a manager remains exportable for its beneficiary', async () => {
      await withStorageTransaction(async () => {
        const data = (await readAuthDocument())!
        data.users.find(user => user.id === 'member')!.managedUserIds = ['other']
        await writeAuthDocument(data)
        await writeDocument('habits', { habits: [{ ...habit, id: 'evidence-action', userIds: ['other'],
          requiresApproval: true, approverIds: ['admin'], schedule: { type: 'anytime', recordingPolicy: 'both' } }] })
      })
      const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
      const evidence = new FormData()
      evidence.set('evidence', new File([bytes], 'proof.png', { type: 'image/png' }))
      const completed = await actions.recordHabitCompletion('evidence-action', now(), evidence,
        { beneficiaryId: 'other', requestId: randomUUID() })
      expect(completed.pending).toBe(true)
      const captured = await captureDatabaseSource(path.join(directory, 'data'))
      expect(captured.snapshot.attachments?.find(item => item.completion_id === completed.habit.completionRecords?.[0]?.id)?.owner_id).toBe('other')
    })

    test('admin-assigned avatars preserve export ownership and reject sharing a referenced upload', async () => {
      signedInId = 'admin'
      const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
      const upload = new FormData()
      upload.set('avatar', new File([bytes], 'avatar.png', { type: 'image/png' }))
      const avatarPath = await actions.uploadAvatar(upload)
      await actions.updateUser('member', { avatarPath })
      const captured = await captureDatabaseSource(path.join(directory, 'data'))
      expect(captured.snapshot.attachments?.find(item => item.path === avatarPath.slice('/data/'.length))?.owner_id).toBe('member')
      await expect(actions.updateUser('other', { avatarPath })).rejects.toThrow('already assigned')
      const createUpload = new FormData()
      createUpload.set('avatar', new File([bytes], 'avatar.png', { type: 'image/png' }))
      const newAvatarPath = await actions.uploadAvatar(createUpload)
      const account = new FormData()
      for (const [key, value] of Object.entries({ username: 'created', email: 'created@example.test', password, avatarPath: newAvatarPath })) account.set(key, value)
      const created = await actions.createUser(account)
      const afterCreate = await captureDatabaseSource(path.join(directory, 'data'))
      expect(afterCreate.snapshot.attachments?.find(item => item.path === newAvatarPath.slice('/data/'.length))?.owner_id).toBe(created.id)
      await withStorageTransaction(async () => {
        const data = (await readAuthDocument())!
        data.users.find(user => user.id === 'other')!.isAdmin = true
        await writeAuthDocument(data)
      })
      signedInId = 'other'
      await actions.deleteUser('admin')
      expect(await fs.readFile(path.join(directory, 'data', avatarPath.slice('/data/'.length)))).toEqual(bytes)
      expect((await captureDatabaseSource(path.join(directory, 'data'))).snapshot.attachments?.some(item => item.owner_id === 'member')).toBe(true)
      await actions.deleteUser('member')
      expect(await repository.readAttachmentMetadata(`avatar:${path.basename(avatarPath)}`)).toBeUndefined()
      const assetExists = await fs.stat(path.join(directory, 'data', avatarPath.slice('/data/'.length))).then(() => true, () => false)
      expect(assetExists).toBe(false)
    })
  })
}
