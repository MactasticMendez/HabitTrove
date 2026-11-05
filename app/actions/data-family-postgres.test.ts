import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { CoinsData, Habit, HabitsData, User } from '@/lib/types'

const databaseName = '/habittrove_test_family_actions'
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL &&
  new URL(process.env.DATABASE_URL).pathname === databaseName

if (!enabled) test.skip('Family server actions require the isolated family-actions PostgreSQL fixture', () => {})
else {
  let signedInId: string | undefined = 'dual'
  let selectedFamily: string | undefined = 'A'
  let sessionActorOverride: User | undefined
  mock.module('server-only', () => ({}))
  const { closeDatabase, currentDatabaseClient, withStorageTransaction } = await import('@/lib/db/client')
  const { readAuthDocument, readDocument, writeAuthDocument, writeDocument } = await import('@/lib/db/repository')
  const { getDefaultSettings } = await import('@/lib/types')
  const { saltAndHashPassword, verifyPassword } = await import('@/lib/password')
  const sharp = (await import('sharp')).default
  mock.module('@/lib/server-helpers', () => ({
    getCurrentUser: async () => sessionActorOverride ?? (await readAuthDocument())?.users.find(user => user.id === signedInId),
    saltAndHashPassword, verifyPassword,
  }))
  mock.module('next/headers', () => ({ cookies: async () => ({
    get: (key: string) => key === 'habittrove-family' && selectedFamily ? { value: selectedFamily } : undefined,
    set: (key: string, value: string) => { if (key === 'habittrove-family') selectedFamily = value },
  }) }))
  const actions = await import('./data')
  const familyActions = await import('./family')
  const { withFamilyScope } = await import('@/lib/family-scope')
  const { issueHouseholdInvite, previewStoredRemoval, removeStoredMember } = await import('@/lib/family-store')
  const password = 'synthetic-family-actions-password'
  const hash = saltAndHashPassword(password)
  const permissions = [{ habit: { write: true, interact: true }, wishlist: { write: true, interact: true }, coins: { write: true, interact: true } }]
  const users: User[] = ['admin', 'ownerA', 'ownerB', 'managerA', 'dual', 'peerA', 'onlyB', 'noFamily'].map(id => ({
    id, username: id, email: `${id.toLowerCase()}@example.test`, password: hash, authVersion: 0,
    isAdmin: id === 'admin', permissions,
    ...(id === 'managerA' ? { managedUserIds: ['onlyB'] } : {}),
  }))
  const account = (id: string) => users.find(user => user.id === id)!
  const habit = (id: string, userIds = ['dual']): Habit => ({ id, name: id, description: '',
    frequency: 'FREQ=DAILY', coinReward: 3, completions: [], userIds, createdBy: userIds[0] })
  const reward = (id: string, userIds = ['dual'], coinCost = 8) => ({ id, name: id, description: '', coinCost, userIds, targetCompletions: 1 })
  const now = () => new Date().toISOString()
  let owner: Pool
  let directory: string
  let cwd: ReturnType<typeof spyOn>
  const as = (id: string | undefined, family: string | undefined = 'A') => { signedInId = id; selectedFamily = family }
  const scoped = <T>(family: string, operation: () => Promise<T>) => withFamilyScope(account('admin'), operation, family)
  async function removeMembership(family: 'A' | 'B', id: string) {
    const actor = account(family === 'A' ? 'ownerA' : 'ownerB')
    const preview = await previewStoredRemoval(actor, family, id)
    await removeStoredMember(actor, family, id, preview.revision)
  }

  describe('family-aware server actions with real PostgreSQL and the restricted runtime login', () => {
    beforeAll(async () => {
      const runtime = new URL(process.env.DATABASE_URL!)
      const migration = new URL(process.env.DATABASE_MIGRATION_URL!)
      if (runtime.hostname !== '127.0.0.1' || runtime.port !== '15432' || runtime.pathname !== databaseName ||
          runtime.host !== migration.host || migration.pathname !== databaseName || runtime.username === migration.username) {
        throw new Error('Family action tests require their dedicated local database and separate restricted runtime login')
      }
      owner = new Pool({ connectionString: migration.href })
      if (!(await owner.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name) {
        await owner.query(await fs.readFile(new URL('../../lib/db/family-schema.sql', import.meta.url), 'utf8'))
      }
      const role = decodeURIComponent(runtime.username)
      if (!/^[a-zA-Z0-9_]+$/.test(role)) throw new Error('Unexpected fixture runtime role')
      await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON habittrove.families,habittrove.family_memberships,habittrove.family_manager_assignments,habittrove.family_permissions,habittrove.family_preferences,habittrove.family_settings,habittrove.household_invitations,habittrove.family_audit,habittrove.family_legacy_adoptions,habittrove.family_document_revisions TO "${role}"`)
      await owner.query(`GRANT SELECT ON habittrove.family_configuration,habittrove.global_wallet_totals TO "${role}"`)
      await owner.query(`GRANT USAGE ON SEQUENCE habittrove.coin_ledger_family_order TO "${role}"`)
      await owner.query(`REVOKE SELECT,UPDATE ON SEQUENCE habittrove.coin_ledger_family_order FROM "${role}"`)
      directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'habittrove-family-actions-')))
      await fs.mkdir(path.join(directory, 'data'))
      await fs.writeFile(path.join(directory, 'data', 'auth.json'), 'stale JSON must not be used')
      cwd = spyOn(process, 'cwd').mockReturnValue(directory)
    })
    beforeEach(async () => {
      as('dual')
      sessionActorOverride = undefined
      await owner.query('UPDATE habittrove.family_configuration SET enabled=false')
      await owner.query('TRUNCATE habittrove.users,habittrove.families,habittrove.habits,habittrove.wishlist_items,habittrove.coin_ledger,habittrove.global_wallet_totals,habittrove.attachments CASCADE')
      await owner.query('DELETE FROM habittrove.documents')
      await withStorageTransaction(async () => {
        await writeAuthDocument({ users: structuredClone(users) })
        await writeDocument('habits', { habits: [] })
        await writeDocument('wishlist', { items: [] })
        await writeDocument('coins', { balance: 0, transactions: [] })
        const settings = getDefaultSettings()
        settings.system.timezone = 'UTC'
        settings.system.autoBackupEnabled = false
        await writeDocument('settings', settings)
      })
      await owner.query("INSERT INTO habittrove.families(id,name) VALUES('A','Family A'),('B','Family B')")
      await owner.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('A','ownerA','owner'),('B','ownerB','owner'),('A','managerA','manager'),('A','dual','member'),('B','dual','member'),('A','peerA','member'),('B','onlyB','member')")
      await owner.query("INSERT INTO habittrove.family_manager_assignments VALUES('A','managerA','dual')")
      await owner.query("INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) SELECT m.family_id,m.user_id,r.resource,true,true FROM habittrove.family_memberships m CROSS JOIN (VALUES('habit'),('wishlist'),('coins')) r(resource)")
      await owner.query("INSERT INTO habittrove.family_document_revisions(family_id,kind) SELECT f.id,k.kind FROM habittrove.families f CROSS JOIN (VALUES('habits'),('wishlist')) k(kind)")
      await owner.query("INSERT INTO habittrove.family_settings(family_id,settings) VALUES('A','{\"timezone\":\"UTC\",\"weekStartDay\":0}'),('B','{\"timezone\":\"Asia/Tokyo\",\"weekStartDay\":1}')")
      await owner.query('UPDATE habittrove.family_configuration SET enabled=true')
      for (const family of ['A', 'B']) await scoped(family, async () => {
        await writeDocument('habits', { habits: family === 'A' ? [habit('habit-a'), habit('shared-a', ['dual', 'peerA']),
          { ...habit('anytime-a'), schedule: { type: 'anytime', recordingPolicy: 'both' } }] : [habit('habit-b'), habit('private-b', ['onlyB'])] })
        await writeDocument('wishlist', { items: family === 'A' ? [reward('reward-a'), reward('peer-reward', ['peerA'], 3)] : [reward('reward-b', ['dual'], 5)] })
        await writeDocument('coins', { balance: 0, transactions: [{ id: `credit-${family}`, userId: 'dual', amount: family === 'A' ? 4 : 6,
          type: 'MANUAL_ADJUSTMENT', description: `Private origin ${family}`, timestamp: now() }] })
      })
    })
    afterAll(async () => {
      cwd?.mockRestore()
      await closeDatabase()
      await owner?.end()
      if (directory) await fs.rm(directory, { recursive: true, force: true })
    })

    test('the actual runtime identity is restricted and cannot write the global summary directly', async () => {
      const identity = await withStorageTransaction(async () => (await currentDatabaseClient()!.query('SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
      expect(identity).toEqual({ name: decodeURIComponent(new URL(process.env.DATABASE_URL!).username), rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false })
      const sequence = await withStorageTransaction(async () => (await currentDatabaseClient()!.query(`SELECT
        has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','USAGE') AS usage,
        has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','SELECT') AS select,
        has_sequence_privilege(current_user,'habittrove.coin_ledger_family_order','UPDATE') AS update`)).rows[0])
      expect(sequence).toEqual({ usage: true, select: false, update: false })
      await expect(withStorageTransaction(async () => { await currentDatabaseClient()!.query("UPDATE habittrove.global_wallet_totals SET balance=999 WHERE user_id='dual'") })).rejects.toThrow('permission denied')
    })

    test('the owner sees both wallet origins while a delegated manager sees the combined total without the other family history', async () => {
      for (const family of ['A', 'B']) {
        as('dual', family)
        const coins = await actions.loadCoinsData()
        expect(coins.balance).toBe(10)
        expect(coins.transactions.map(row => row.id).sort()).toEqual(['credit-A', 'credit-B'])
      }
      as('managerA')
      const overview = await actions.loadFamilyOverview()
      expect(overview.members.find(member => member.id === 'dual')?.balance).toBe(10)
      expect(overview.members.flatMap(member => member.habits).map(item => item.id)).not.toContain('habit-b')
      expect(JSON.stringify(overview)).not.toContain('Private origin B')
      expect(JSON.stringify(await actions.loadCoinsData())).not.toContain('credit-B')
    })

    test('concurrent A redemption spends the combined wallet once and makes a later B reward unaffordable', async () => {
      as('managerA')
      const requests = [randomUUID(), randomUUID()]
      const attempts = await Promise.allSettled(requests.map(request => actions.redeemFamilyReward('dual', 'reward-a', request)))
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const debits = (await owner.query("SELECT user_id,amount::text,family_id,request_id FROM habittrove.coin_ledger WHERE type='WISH_REDEMPTION'")).rows
      expect(debits).toHaveLength(1)
      expect(debits[0]).toEqual({ user_id: 'dual', amount: '-8', family_id: 'A', request_id: requests[attempts.findIndex(result => result.status === 'fulfilled')] })
      await actions.redeemFamilyReward('dual', 'reward-a', debits[0].request_id)
      as('dual', 'B')
      expect((await actions.loadCoinsData()).balance).toBe(2)
      await expect(actions.removeCoins({ amount: 5, description: 'B reward', type: 'WISH_REDEMPTION', relatedItemId: 'reward-b' })).rejects.toThrow('Insufficient')
      expect((await owner.query('SELECT count(*) AS n FROM habittrove.coin_ledger')).rows[0].n).toBe('3')
    })

    test('an ordinary family owner has no implicit oversight of another member', async () => {
      as('ownerA')
      expect((await actions.loadFamilyOverview()).members.map(member => member.id)).toEqual(['ownerA'])
      expect((await actions.loadHabitsData()).habits).toEqual([])
      await expect(actions.redeemFamilyReward('dual', 'reward-a', randomUUID())).rejects.toThrow()
      await expect(actions.recordHabitCompletion('anytime-a', now(), undefined, { beneficiaryId: 'dual', requestId: randomUUID() })).rejects.toThrow()
    })

    test('selected-family permissions override permissive legacy global permissions', async () => {
      await owner.query("UPDATE habittrove.family_permissions SET can_write=false,can_interact=false WHERE family_id='A' AND user_id='dual'")
      expect(account('dual').permissions?.[0].habit.interact).toBe(true)
      await expect(actions.recordHabitCompletion('habit-a', now())).rejects.toThrow()
      await expect(actions.addCoins({ amount: 1, description: 'Forbidden adjustment' })).rejects.toThrow()
      const wishlist = await actions.loadWishlistData()
      await expect(actions.saveWishlistItems({ ...wishlist, items: wishlist.items.map(item => ({ ...item, name: 'Forbidden rename' })) })).rejects.toThrow()
      as('dual', 'B')
      expect((await actions.recordHabitCompletion('habit-b', now())).rewarded).toBe(true)
    })

    test('directory, assignments, approvers and forged item IDs remain inside the selected family', async () => {
      const directory = await actions.loadUsersPublicData()
      expect(directory.users.map(user => user.id).sort()).toEqual(['dual', 'managerA', 'ownerA', 'peerA'])
      expect(JSON.stringify(directory)).not.toContain('onlyB')
      await expect(actions.recordHabitCompletion('private-b', now())).rejects.toThrow()
      const current = await actions.loadHabitsData()
      for (const patch of [{ userIds: ['dual', 'onlyB'] }, { requiresApproval: true, approverIds: ['onlyB'] }]) {
        await expect(actions.saveHabitsData({ ...current, habits: current.habits.map(item => item.id === 'habit-a' ? { ...item, ...patch } : item) })).rejects.toThrow()
      }
      await expect(actions.saveHabitsData({ ...current, habits: [...current.habits, habit('private-b')] })).rejects.toThrow()
      await expect(actions.savePersonalFolders([{ id: 'forged', name: 'Hidden B', itemIds: ['private-b'] }])).rejects.toThrow()
    })

    test('family tags prevent equal-revision cross-family replay and stale editors cannot overwrite new data', async () => {
      const aHabits = await actions.loadHabitsData()
      const aRewards = await actions.loadWishlistData()
      expect(aHabits.familyId).toBe('A')
      expect(aRewards.familyId).toBe('A')
      as('dual', 'B')
      const bHabits = await actions.loadHabitsData()
      const bRewards = await actions.loadWishlistData()
      if (aHabits.revision === undefined || aRewards.revision === undefined) throw new Error('Family revisions are required')
      expect(bHabits.revision).toBe(aHabits.revision)
      expect(bRewards.revision).toBe(aRewards.revision)
      await expect(actions.saveHabitsData(aHabits)).rejects.toThrow()
      await expect(actions.saveWishlistItems(aRewards)).rejects.toThrow()
      const saved = await actions.saveHabitsData({ ...bHabits, habits: bHabits.habits.map(item => ({ ...item, name: 'New B name' })) })
      expect(saved.revision).toBeGreaterThan(bHabits.revision!)
      await expect(actions.saveHabitsData(bHabits)).rejects.toThrow('reload')
      const rewardSaved = await actions.saveWishlistItems({ ...bRewards, items: bRewards.items.map(item => ({ ...item, name: 'New B reward' })) })
      expect(rewardSaved.familyId).toBe('B')
      await expect(actions.saveWishlistItems(bRewards)).rejects.toThrow('reload')
    })

    test('folders, status and notification state stay in a family while personal display follows only its user', async () => {
      const date = now().slice(0, 10)
      await actions.savePersonalFolders([{ id: 'a-folder', name: 'A folder', itemIds: ['habit-a'] }])
      await actions.saveStatusDays([{ date, status: 'rest' }])
      await actions.updateLastNotificationReadTimestamp('dual', now())
      const meA = (await actions.loadUsersPublicData()).users.find(user => user.id === 'dual')!
      expect(meA.personalFolders?.map(folder => folder.id)).toEqual(['a-folder'])
      expect(meA.statusDays).toEqual([{ date, status: 'rest' }])
      expect(meA.lastNotificationReadTimestamp).toBeDefined()
      const settingsA = await actions.loadSettings()
      expect(settingsA.system.timezone).toBe('UTC')
      expect(settingsA.system.weekStartDay).toBe(0)
      await actions.saveSettings({ ...settingsA, ui: { ...settingsA.ui, useGrouping: false }, system: { ...settingsA.system, language: 'fr' } })
      as('dual', 'B')
      const meB = (await actions.loadUsersPublicData()).users.find(user => user.id === 'dual')!
      expect(meB.personalFolders).toEqual([])
      expect(meB.statusDays).toEqual([])
      expect(meB.lastNotificationReadTimestamp).toBeUndefined()
      const settingsB = await actions.loadSettings()
      expect(settingsB.system.timezone).toBe('Asia/Tokyo')
      expect(settingsB.system.weekStartDay).toBe(1)
      expect(settingsB.system.language).toBe('fr')
      expect(settingsB.ui.useGrouping).toBe(false)
      as('onlyB', 'B')
      expect((await actions.loadSettings()).system.language).not.toBe('fr')
      expect((await actions.loadSettings()).ui.useGrouping).toBe(getDefaultSettings().ui.useGrouping)
    })

    test('shared calendar changes require an owner and cannot cross the selected family', async () => {
      as('ownerA')
      const current = await actions.loadSettings()
      await actions.saveSettings({ ...current, system: { ...current.system, timezone: 'Europe/London', weekStartDay: 6 } })
      as('dual')
      const changed = await actions.loadSettings()
      expect(changed.system.timezone).toBe('Europe/London')
      await expect(actions.saveSettings({ ...changed, system: { ...changed.system, timezone: 'America/Chicago' } })).rejects.toThrow()
      as('dual', 'B')
      expect((await actions.loadSettings()).system.timezone).toBe('Asia/Tokyo')
    })

    test('revocation blocks stale writes while leaving every family preserves the identity wallet and history', async () => {
      const stale = await actions.loadHabitsData()
      await removeMembership('A', 'dual')
      await expect(actions.saveHabitsData(stale)).rejects.toThrow()
      await expect(actions.recordHabitCompletion('habit-a', now())).rejects.toThrow()
      as('dual', 'B')
      expect((await actions.loadCoinsData()).balance).toBe(10)
      await removeMembership('B', 'dual')
      as('dual', undefined)
      selectedFamily = undefined
      expect((await actions.loadCoinsData()).balance).toBe(10)
      expect((await actions.loadCoinsData()).transactions.map(row => row.id).sort()).toEqual(['credit-A', 'credit-B'])
      expect((await actions.loadHabitsData()).habits).toEqual([])
      expect((await actions.loadWishlistData()).items).toEqual([])
      expect((await actions.loadUsersPublicData()).users.map(user => user.id)).toEqual(['dual'])
      await expect(actions.addCoins({ amount: 1, description: 'No family' })).rejects.toThrow()
      expect((await owner.query('SELECT count(*) AS n FROM habittrove.coin_ledger')).rows[0].n).toBe('2')
      expect(await fs.readFile(path.join(directory, 'data', 'auth.json'), 'utf8')).toBe('stale JSON must not be used')
    })

    test('new-account invite acceptance uses the stored email and consumes the offer only once', async () => {
      const invite = await issueHouseholdInvite(account('ownerA'), 'A', 'new-local@example.test', 'member', 'managerA')
      as(undefined)
      const results = await Promise.allSettled([1, 2].map(() => actions.acceptFamilyInvite(invite.token, 'newlocal', password)))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const newUser = (await readAuthDocument())!.users.find(user => user.username === 'newlocal')!
      expect(newUser.email).toBe('new-local@example.test')
      expect(newUser.isAdmin).toBe(false)
      expect(verifyPassword(password, newUser.password!)).toBe(true)
      expect((await owner.query('SELECT family_id,role FROM habittrove.family_memberships WHERE user_id=$1', [newUser.id])).rows).toEqual([{ family_id: 'A', role: 'member' }])
      expect((await owner.query('SELECT member_id FROM habittrove.family_manager_assignments WHERE manager_id=$1 AND member_id=$2', ['managerA', newUser.id])).rowCount).toBe(1)
      expect((await readAuthDocument())!.users.find(user => user.id === 'dual')?.password).toBe(hash)
    })

    test('existing-account invite acceptance preserves credentials and verifies the signed-in email', async () => {
      const invite = await issueHouseholdInvite(account('ownerA'), 'A', 'onlyb@example.test', 'member')
      await expect(actions.acceptFamilyInvite(invite.token, 'replacement', 'different-synthetic-password')).rejects.toThrow()
      as('dual')
      await expect(familyActions.acceptExistingHouseholdInvite(invite.token)).rejects.toThrow('email')
      as('onlyB', 'B')
      await familyActions.acceptExistingHouseholdInvite(invite.token)
      const existing = (await readAuthDocument())!.users.find(user => user.id === 'onlyB')!
      expect(existing.password).toBe(hash)
      expect(existing.username).toBe('onlyB')
      expect(existing.authVersion).toBe(0)
      expect((await owner.query("SELECT family_id FROM habittrove.family_memberships WHERE user_id='onlyB' AND active ORDER BY family_id")).rows).toEqual([{ family_id: 'A' }, { family_id: 'B' }])
      await expect(familyActions.acceptExistingHouseholdInvite(invite.token)).rejects.toThrow()
    })

    test('any-time request retries append one completion and credit its selected beneficiary once', async () => {
      as('managerA')
      const requestId = randomUUID()
      const timestamp = now()
      await Promise.all([1, 2].map(() => actions.recordHabitCompletion('anytime-a', timestamp, undefined, { beneficiaryId: 'dual', requestId })))
      const stored = await scoped('A', async () => (await readDocument<HabitsData>('habits'))!.habits.find(item => item.id === 'anytime-a')!)
      expect(stored.completions).toEqual([timestamp])
      expect(stored.completionRecords?.[0]?.beneficiaryId).toBe('dual')
      const credits = (await owner.query("SELECT user_id,amount::text,family_id FROM habittrove.coin_ledger WHERE type='HABIT_COMPLETION'")).rows
      expect(credits).toEqual([{ user_id: 'dual', amount: '3', family_id: 'A' }])
      as('dual', 'B')
      expect((await actions.loadCoinsData()).balance).toBe(13)
    })

    test('undo reverses each preserved co-assignee award once after both recipients have spent their coins', async () => {
      const completionId = randomUUID()
      const timestamp = now()
      await scoped('A', async () => {
        const habits = (await readDocument<HabitsData>('habits'))!
        const shared = habits.habits.find(item => item.id === 'shared-a')!
        shared.completions = [timestamp]
        shared.completionRecords = [{ id: completionId, actorId: 'dual', rewardedUserIds: ['dual', 'peerA'], rewardAmount: 3, rewardTarget: 1 }]
        await writeDocument('habits', habits)
        const coins = (await readDocument<CoinsData>('coins'))!
        await writeDocument('coins', { ...coins, transactions: [...['dual', 'peerA'].map(userId => ({ id: `shared-award-${userId}`, userId, completionId, relatedItemId: 'shared-a', amount: 3, type: 'HABIT_COMPLETION' as const, description: 'Preserved shared award', timestamp })), ...coins.transactions] })
      })
      await actions.removeCoins({ amount: 13, description: 'Spent combined credits' })
      as('peerA')
      await actions.removeCoins({ amount: 3, description: 'Spent shared credit' })
      as('dual')
      const results = await Promise.allSettled([1, 2].map(() => actions.undoHabitCompletion('shared-a', 0, timestamp)))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rows = (await owner.query('SELECT user_id,amount::text,type FROM habittrove.coin_ledger WHERE completion_id=$1 ORDER BY type,user_id', [completionId])).rows
      expect(rows).toEqual([
        { user_id: 'dual', amount: '3', type: 'HABIT_COMPLETION' }, { user_id: 'peerA', amount: '3', type: 'HABIT_COMPLETION' },
        { user_id: 'dual', amount: '-3', type: 'HABIT_UNDO' }, { user_id: 'peerA', amount: '-3', type: 'HABIT_UNDO' },
      ])
      expect((await actions.loadCoinsData()).balance).toBe(-3)
      as('peerA')
      expect((await actions.loadCoinsData()).balance).toBe(-3)
      expect((await owner.query("SELECT family_id FROM habittrove.coin_ledger WHERE id='credit-B'")).rows).toEqual([{ family_id: 'B' }])
    })

    test('legacy fractional coins survive completion, undo and cross-family reward redemption exactly', async () => {
      await owner.query("UPDATE habittrove.documents SET metadata=jsonb_set(metadata,'{balance}','0.5') WHERE kind='coins'")
      await owner.query(`INSERT INTO habittrove.coin_ledger(id,ordinal,user_id,amount,type,occurred_at,attributes,family_id)
        SELECT 'legacy-fraction',100,user_id,0.5,type,occurred_at,attributes,family_id FROM habittrove.coin_ledger WHERE id='credit-B'`)
      expect((await actions.loadCoinsData()).balance).toBe(10.5)
      const timestamp = now()
      const completion = await actions.recordHabitCompletion('habit-a', timestamp)
      expect(completion.coins.balance).toBe(13.5)
      expect((await actions.undoHabitCompletion('habit-a', completion.completionIndex, timestamp)).coins.balance).toBe(10.5)
      as('managerA')
      await actions.redeemFamilyReward('dual', 'reward-a', randomUUID())
      as('dual', 'B')
      expect((await actions.loadCoinsData()).balance).toBe(2.5)
      expect((await owner.query("SELECT amount::text,family_id FROM habittrove.coin_ledger WHERE id='legacy-fraction'")).rows).toEqual([{ amount: '0.5', family_id: 'B' }])
      expect((await owner.query("SELECT balance::text FROM habittrove.global_wallet_totals WHERE user_id='dual'")).rows[0].balance).toBe('2.5')
    })

    test('stale and revoked selected cookies show no family data until the user explicitly selects a remaining family', async () => {
      const stale = await actions.loadHabitsData()
      selectedFamily = 'unknown-family'
      const unknown = await familyActions.loadFamilyState()
      expect(unknown.selectedFamilyId).toBeUndefined()
      expect(unknown.members).toEqual([])
      expect(unknown.families.map(family => family.id)).toEqual(['A', 'B'])
      expect((await actions.loadHabitsData()).habits).toEqual([])
      expect((await actions.loadWishlistData()).items).toEqual([])
      expect((await actions.loadCoinsData()).balance).toBe(10)
      await expect(actions.saveHabitsData(stale)).rejects.toThrow()
      await removeMembership('A', 'dual')
      selectedFamily = 'A'
      expect((await actions.loadHabitsData()).habits).toEqual([])
      expect((await actions.loadWishlistData()).items).toEqual([])
      expect(await actions.loadPendingApprovals()).toEqual([])
      expect((await actions.loadFamilyOverview()).members).toEqual([])
      expect((await actions.loadUsersPublicData()).users.map(user => user.id)).toEqual(['dual'])
      expect((await actions.loadCoinsData()).balance).toBe(10)
      const revoked = await familyActions.loadFamilyState()
      expect(revoked.selectedFamilyId).toBeUndefined()
      expect(revoked.members).toEqual([])
      expect(revoked.families.map(family => family.id)).toEqual(['B'])
      await expect(actions.recordHabitCompletion('habit-a', now())).rejects.toThrow()
      await expect(actions.saveStatusDays([])).rejects.toThrow()
      await expect(actions.addCoins({ amount: 1, description: 'Revoked selector' })).rejects.toThrow()
      await familyActions.selectFamily('B')
      expect(selectedFamily).toBe('B')
      expect((await actions.loadHabitsData()).habits.map(item => item.id)).toEqual(['habit-b'])
    })

    test('global avatar uploads can be assigned to zero-family accounts without inheriting the selected family', async () => {
      const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer()
      const upload = async () => {
        const form = new FormData()
        form.set('avatar', new File([bytes], 'avatar.png', { type: 'image/png' }))
        return actions.uploadAvatar(form)
      }
      as('admin', 'B')
      const assignedPath = await upload()
      await actions.updateUser('noFamily', { avatarPath: assignedPath })
      const createdPath = await upload()
      const form = new FormData()
      for (const [key, value] of Object.entries({ username: 'createdavatar', email: 'created-avatar@example.test', password, avatarPath: createdPath })) form.set(key, value)
      const created = await actions.createUser(form)
      for (const [userId, avatarPath] of [['noFamily', assignedPath], [created.id, createdPath]]) {
        const filename = path.basename(avatarPath)
        expect((await owner.query('SELECT owner_id,family_id,path,sha256 FROM habittrove.attachments WHERE id=$1', [`avatar:${filename}`])).rows).toEqual([{
          owner_id: userId, family_id: null, path: `avatars/${filename}`, sha256: createHash('sha256').update(bytes).digest('hex'),
        }])
        expect(await fs.readFile(path.join(directory, 'data', 'avatars', filename))).toEqual(bytes)
        expect((await owner.query('SELECT count(*) AS n FROM habittrove.family_memberships WHERE user_id=$1', [userId])).rows[0].n).toBe('0')
      }
      expect((await readAuthDocument())!.users.find(user => user.id === created.id)?.avatarPath).toBe(createdPath)
      await expect(actions.updateUser('dual', { avatarPath: assignedPath })).rejects.toThrow('already assigned')
      as('noFamily', 'A')
      const selfPath = await upload()
      await actions.updateUser('noFamily', { avatarPath: selfPath })
      expect((await readAuthDocument())!.users.find(user => user.id === 'noFamily')?.avatarPath).toBe(selfPath)
      expect((await owner.query('SELECT owner_id,family_id FROM habittrove.attachments WHERE id=$1', [`avatar:${path.basename(selfPath)}`])).rows).toEqual([{ owner_id: 'noFamily', family_id: null }])
    })

    test('deleting an identity with active or removed family history is blocked without losing its ledger', async () => {
      const before = (await owner.query('SELECT id,user_id,amount::text,family_id FROM habittrove.coin_ledger ORDER BY id')).rows
      as('admin')
      await expect(actions.deleteUser('dual')).rejects.toThrow('family history')
      await removeMembership('A', 'dual')
      await removeMembership('B', 'dual')
      as('dual')
      await expect(actions.deleteUser('dual')).rejects.toThrow('family history')
      expect((await readAuthDocument())!.users.some(user => user.id === 'dual')).toBe(true)
      expect((await owner.query('SELECT id,user_id,amount::text,family_id FROM habittrove.coin_ledger ORDER BY id')).rows).toEqual(before)
      expect((await actions.loadCoinsData()).balance).toBe(10)
    })

    test('public family management requires the actor email and blocks mutations in demo mode', async () => {
      as('ownerA')
      await owner.query("UPDATE habittrove.users SET email=NULL WHERE id='ownerA'")
      await expect(familyActions.loadFamilyState()).rejects.toThrow('Email is required')
      await expect(familyActions.renameFamily('A', 'Email bypass')).rejects.toThrow('Email is required')
      await expect(familyActions.createHouseholdInvite('A', 'blocked@example.test', 'member')).rejects.toThrow('Email is required')
      await owner.query("UPDATE habittrove.users SET email='ownera@example.test' WHERE id='ownerA'")
      const demo = process.env.DEMO
      process.env.DEMO = 'true'
      try {
        await expect(familyActions.renameFamily('A', 'Demo bypass')).rejects.toThrow('demo mode')
        await expect(familyActions.selectFamily('A')).rejects.toThrow('demo mode')
        await expect(familyActions.updateFamilyMembership('A', 'dual', { role: 'manager' })).rejects.toThrow('demo mode')
        await expect(familyActions.createHouseholdInvite('A', 'blocked@example.test', 'member')).rejects.toThrow('demo mode')
      } finally {
        if (demo === undefined) delete process.env.DEMO
        else process.env.DEMO = demo
      }
      expect((await owner.query("SELECT name FROM habittrove.families WHERE id='A'")).rows[0].name).toBe('Family A')
      expect((await owner.query('SELECT count(*) AS n FROM habittrove.household_invitations')).rows[0].n).toBe('0')
    })

    test('selected-family directories keep a nonmember site administrator in the separate identity carrier only', async () => {
      as('admin')
      const a = await actions.loadUsersPublicData()
      expect(a.users.map(user => user.id).sort()).toEqual(['dual', 'managerA', 'ownerA', 'peerA'])
      expect(a.currentUser?.id).toBe('admin')
      expect(a.currentUser?.isAdmin).toBe(true)
      expect(a.currentUser?.email).toBe('admin@example.test')
      expect(a.users.some(user => user.id === 'admin')).toBe(false)
      expect(JSON.stringify(a)).not.toContain('onlyB')
      expect(JSON.stringify(a)).not.toContain('noFamily')
      expect(JSON.stringify(a)).not.toContain(hash)
      selectedFamily = 'B'
      const b = await actions.loadUsersPublicData()
      expect(b.users.map(user => user.id).sort()).toEqual(['dual', 'onlyB', 'ownerB'])
      expect(b.currentUser?.id).toBe('admin')
      expect(b.users.some(user => user.id === 'ownerA')).toBe(false)
      as('dual')
      const member = await actions.loadUsersPublicData()
      expect(member.users.map(user => user.id).sort()).toEqual(['dual', 'managerA', 'ownerA', 'peerA'])
      expect(member.currentUser).toBeUndefined()
      expect(member.users.find(user => user.id === 'dual')?.isAdmin).toBe(false)
    })

    test('a no-family identity retains its own profile and global wallet without a global member directory', async () => {
      await owner.query(`INSERT INTO habittrove.coin_ledger(id,ordinal,user_id,amount,type,occurred_at,attributes,family_id)
        SELECT 'no-family-credit',101,'noFamily',2,type,occurred_at,attributes,family_id FROM habittrove.coin_ledger WHERE id='credit-A'`)
      as('noFamily', 'B')
      const before = await actions.loadUsersPublicData()
      expect(before.users.map(user => user.id)).toEqual(['noFamily'])
      expect(before.currentUser).toBeUndefined()
      expect(before.users[0].email).toBe('nofamily@example.test')
      expect(before.users[0].managedUserIds).toEqual([])
      expect((await actions.loadCoinsData()).balance).toBe(2)
      expect((await actions.loadCoinsData()).transactions.map(row => row.id)).toEqual(['no-family-credit'])
      const updated = await actions.updateUser('noFamily', { username: 'nofamilyprofile' })
      expect(updated.username).toBe('nofamilyprofile')
      expect((await actions.loadUsersPublicData()).users[0].username).toBe('nofamilyprofile')
      await expect(actions.loadAdministrationUsers()).rejects.toThrow('Administrator')
    })

    test('the administration directory requires fresh global administrator authority independently of the selector', async () => {
      as('admin', 'unknown-family')
      const administrators = await actions.loadAdministrationUsers()
      expect(administrators.users.map(user => user.id).sort()).toEqual(users.map(user => user.id).sort())
      expect(administrators.currentUser).toBeUndefined()
      expect(JSON.stringify(administrators)).not.toContain(hash)
      as('ownerA')
      await expect(actions.loadAdministrationUsers()).rejects.toThrow('Administrator')
      as('dual', 'B')
      await expect(actions.loadAdministrationUsers()).rejects.toThrow('Administrator')
      sessionActorOverride = structuredClone(account('admin'))
      await owner.query("UPDATE habittrove.users SET is_admin=true WHERE id='ownerB'")
      await owner.query("UPDATE habittrove.users SET is_admin=false,auth_version=1 WHERE id='admin'")
      await expect(actions.loadAdministrationUsers()).rejects.toThrow('Administrator')
      await expect(actions.loadUsersPublicData()).rejects.toThrow('Unauthorized')
    })

    test('family ownership and a forged session admin flag cannot become global administrator authority', async () => {
      as('ownerA')
      await familyActions.updateFamilyMembership('A', 'dual', { role: 'owner' })
      as('dual')
      const owner = (await actions.loadUsersPublicData()).users.find(user => user.id === 'dual')!
      expect(owner.isAdmin).toBe(false)
      await expect(actions.loadAdministrationUsers()).rejects.toThrow('Administrator')
      sessionActorOverride = { ...structuredClone(account('ownerA')), isAdmin: true }
      as('ownerA')
      const scoped = await actions.loadUsersPublicData()
      expect(scoped.users.find(user => user.id === 'ownerA')?.isAdmin).toBe(false)
      expect(scoped.currentUser).toBeUndefined()
      expect(scoped.users.some(user => user.id === 'onlyB')).toBe(false)
      await expect(actions.loadAdministrationUsers()).rejects.toThrow('Administrator')
      await expect(actions.updateUser('ownerA', { isAdmin: true })).rejects.toThrow('permissions')
      expect((await readAuthDocument())!.users.find(user => user.id === 'ownerA')?.isAdmin).toBe(false)
    })

    for (const scenario of ['no-family', 'revoked-selection', 'invalid-selection'] as const) {
      test(`personal UI and language remain writable with ${scenario} while all shared settings stay protected`, async () => {
        const actorId = scenario === 'no-family' ? 'noFamily' : 'dual'
        if (scenario === 'revoked-selection') await removeMembership('A', 'dual')
        as(actorId, scenario === 'invalid-selection' ? 'unknown-family' : 'A')
        if (scenario === 'no-family') selectedFamily = undefined
        const instanceBefore = (await owner.query("SELECT metadata,revision FROM habittrove.documents WHERE kind='settings'")).rows
        const familiesBefore = (await owner.query('SELECT family_id,settings FROM habittrove.family_settings ORDER BY family_id')).rows
        const othersBefore = (await owner.query('SELECT id,attributes FROM habittrove.users WHERE id<>$1 ORDER BY id', [actorId])).rows
        const initial = await actions.loadSettings()
        await actions.saveSettings({ ...initial, ui: { useGrouping: false, useNumberFormatting: false }, system: { ...initial.system, language: 'fr' } })
        const fresh = await actions.loadSettings()
        expect(fresh.ui).toEqual({ useGrouping: false, useNumberFormatting: false })
        expect(fresh.system.language).toBe('fr')
        expect((await readAuthDocument())!.users.find(user => user.id === actorId)?.personalSettings).toEqual({ ui: { useGrouping: false, useNumberFormatting: false }, language: 'fr' })
        for (const forbidden of [
          { ...fresh, system: { ...fresh.system, timezone: 'Europe/Paris' } },
          { ...fresh, system: { ...fresh.system, weekStartDay: fresh.system.weekStartDay === 0 ? 1 as const : 0 as const } },
          { ...fresh, system: { ...fresh.system, autoBackupEnabled: !fresh.system.autoBackupEnabled } },
          { ...fresh, profile: { avatarPath: '/data/avatars/forbidden.png' } },
        ]) await expect(actions.saveSettings(forbidden)).rejects.toThrow()
        expect((await owner.query("SELECT metadata,revision FROM habittrove.documents WHERE kind='settings'")).rows).toEqual(instanceBefore)
        expect((await owner.query('SELECT family_id,settings FROM habittrove.family_settings ORDER BY family_id')).rows).toEqual(familiesBefore)
        expect((await owner.query('SELECT id,attributes FROM habittrove.users WHERE id<>$1 ORDER BY id', [actorId])).rows).toEqual(othersBefore)
        as('onlyB', 'B')
        expect((await actions.loadSettings()).system.language).toBe('en')
        expect((await actions.loadSettings()).system.timezone).toBe('Asia/Tokyo')
      })
    }

    test('the no-family personal-settings path never becomes an instance-settings path even for a site administrator', async () => {
      as('admin', 'unknown-family')
      const before = (await owner.query("SELECT metadata,revision FROM habittrove.documents WHERE kind='settings'")).rows
      const initial = await actions.loadSettings()
      await actions.saveSettings({ ...initial, ui: { ...initial.ui, useGrouping: false }, system: { ...initial.system, language: 'fr' } })
      const fresh = await actions.loadSettings()
      expect(fresh.ui.useGrouping).toBe(false)
      expect(fresh.system.language).toBe('fr')
      for (const forbidden of [
        { ...fresh, system: { ...fresh.system, timezone: 'Europe/Paris' } },
        { ...fresh, system: { ...fresh.system, autoBackupEnabled: !fresh.system.autoBackupEnabled } },
        { ...fresh, profile: { avatarPath: '/data/avatars/forbidden.png' } },
      ]) await expect(actions.saveSettings(forbidden)).rejects.toThrow()
      expect((await owner.query("SELECT metadata,revision FROM habittrove.documents WHERE kind='settings'")).rows).toEqual(before)
    })

    test('personal-settings fallback rejects a stale or nonexistent identity before reading or writing preferences', async () => {
      as('noFamily', 'unknown-family')
      const initial = await actions.loadSettings()
      sessionActorOverride = structuredClone(account('noFamily'))
      await owner.query("UPDATE habittrove.users SET auth_version=1 WHERE id='noFamily'")
      await expect(actions.loadSettings()).rejects.toThrow('Unauthorized')
      await expect(actions.saveSettings({ ...initial, ui: { ...initial.ui, useGrouping: false } })).rejects.toThrow('Unauthorized')
      sessionActorOverride = { ...structuredClone(account('noFamily')), id: 'forged-identity', isAdmin: true }
      await expect(actions.loadSettings()).rejects.toThrow('Unauthorized')
      await expect(actions.saveSettings({ ...initial, system: { ...initial.system, language: 'fr' } })).rejects.toThrow('Unauthorized')
      expect((await readAuthDocument())!.users.find(user => user.id === 'noFamily')?.personalSettings).toBeUndefined()
    })

    test('a site administrator edits only its own global wallet notes without supplying selected-family members transactions', async () => {
      for (const family of ['A', 'B']) await scoped(family, async () => {
        const coins = (await readDocument<CoinsData>('coins'))!
        await writeDocument('coins', { ...coins, transactions: [{ id: `admin-credit-${family}`, userId: 'admin', amount: family === 'A' ? 2 : 5,
          type: 'MANUAL_ADJUSTMENT', description: `Admin own ${family}`, timestamp: now() }, ...coins.transactions] })
      })
      const othersBefore = (await owner.query("SELECT id,amount::text,attributes,family_id FROM habittrove.coin_ledger WHERE user_id<>'admin' ORDER BY id")).rows
      as('admin')
      const own = await actions.loadCoinsData()
      expect(own.balance).toBe(7)
      expect(own.transactions.map(row => row.id).sort()).toEqual(['admin-credit-A', 'admin-credit-B'])
      const edited = await actions.saveCoinsData({ ...own, transactions: own.transactions.map(row => ({ ...row, note: `Private note ${row.id}` })) })
      expect(edited.transactions.map(row => [row.id, row.note]).sort()).toEqual([
        ['admin-credit-A', 'Private note admin-credit-A'], ['admin-credit-B', 'Private note admin-credit-B'],
      ])
      expect(edited.balance).toBe(7)
      expect((await owner.query("SELECT id,amount::text,attributes,family_id FROM habittrove.coin_ledger WHERE user_id<>'admin' ORDER BY id")).rows).toEqual(othersBefore)
      expect((await owner.query("SELECT id,user_id,amount::text,family_id FROM habittrove.coin_ledger WHERE user_id='admin' ORDER BY id")).rows).toEqual([
        { id: 'admin-credit-A', user_id: 'admin', amount: '2', family_id: 'A' }, { id: 'admin-credit-B', user_id: 'admin', amount: '5', family_id: 'B' },
      ])
    })

    test('admin mutation responses contain only its pooled own ledger even when the selected family has other wallets', async () => {
      await owner.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('A','admin','member')")
      await scoped('B', async () => {
        const coins = (await readDocument<CoinsData>('coins'))!
        await writeDocument('coins', { ...coins, transactions: [{ id: 'admin-foreign-origin', userId: 'admin', amount: 5,
          type: 'MANUAL_ADJUSTMENT', description: 'Admin own B history', timestamp: now() }, ...coins.transactions] })
      })
      as('admin')
      const ownOnly = (data: CoinsData, balance: number) => {
        expect(data.balance).toBe(balance)
        expect(data.transactions.every(row => row.userId === 'admin')).toBe(true)
        expect(data.transactions.some(row => row.id === 'admin-foreign-origin')).toBe(true)
        expect(data.transactions.some(row => row.id === 'credit-A' || row.id === 'credit-B')).toBe(false)
      }
      ownOnly(await actions.addCoins({ amount: 1, description: 'Admin own A adjustment' }), 6)
      const timestamp = now()
      const completion = await actions.recordHabitCompletion('habit-a', timestamp)
      ownOnly(completion.coins, 9)
      ownOnly((await actions.undoHabitCompletion('habit-a', completion.completionIndex, timestamp)).coins, 6)
      ownOnly(await actions.removeCoins({ amount: 1, description: 'Undo manual adjustment' }), 5)
      expect((await owner.query("SELECT id,amount::text,family_id FROM habittrove.coin_ledger WHERE user_id='dual' ORDER BY id")).rows).toEqual([
        { id: 'credit-A', amount: '4', family_id: 'A' }, { id: 'credit-B', amount: '6', family_id: 'B' },
      ])
    })

    for (const familiesEnabled of [true, false]) {
      test(`an administrator password reset rejects an actor-version race before changing another identity credentials${familiesEnabled ? '' : ' with families disabled'}`, async () => {
        if (!familiesEnabled) await owner.query('UPDATE habittrove.family_configuration SET enabled=false')
        as('admin')
        const authStore = await import('@/lib/auth-store')
        const originalRead = authStore.readAuthData
        let raced = false
        const before = (await readAuthDocument())!.users.find(user => user.id === 'onlyB')!
        if (before.password === undefined || before.authVersion === undefined) throw new Error('Target credentials must be initialized')
        const reading = spyOn(authStore, 'readAuthData').mockImplementation(async () => {
          const snapshot = await originalRead()
          if (!raced && !currentDatabaseClient()) {
            raced = true
            // Commit an actor change after requireUser captured the session, before the final target write.
            await owner.query("UPDATE habittrove.users SET auth_version=auth_version+1 WHERE id='admin'")
          }
          return snapshot
        })
        try {
          await expect(actions.updateUserPassword('onlyB', 'new-synthetic-target-password')).rejects.toThrow()
        } finally {
          reading.mockRestore()
        }
        expect(raced).toBe(true)
        const after = (await readAuthDocument())!.users.find(user => user.id === 'onlyB')!
        expect(after.password).toBe(before.password)
        expect(after.authVersion).toBe(before.authVersion)
        expect((await owner.query("SELECT is_admin,auth_version FROM habittrove.users WHERE id='admin'")).rows).toEqual([{ is_admin: true, auth_version: 1 }])
      })
    }
  })
}
