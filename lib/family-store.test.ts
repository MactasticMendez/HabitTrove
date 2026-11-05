import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { Client } from 'pg'
import { closeDatabase, currentDatabaseClient, withStorageTransaction } from './db/client'
import { getDefaultSettings, type HabitsData, type User, type WishlistData } from './types'
import { readDocument, writeDocument } from './db/repository'
mock.module('server-only', () => ({}))
const store = await import('./family-store')
const scope = await import('./family-scope')
const actorStore = await import('./family-actor')
const { validateRuntimeStorage } = await import('./env.server')
const enabled = process.env.HABITTROVE_TEST_DATABASE === '1' && !!process.env.DATABASE_URL &&
  new URL(process.env.DATABASE_URL).pathname === '/habittrove_test_family_backend'
const admin: User = { id: 'admin', username: 'Site admin', isAdmin: true }
const a: User = { id: 'a', username: 'Owner A' }
const b: User = { id: 'b', username: 'Owner B' }
const dual: User = { id: 'dual', username: 'Two families', email: 'dual@example.test' }
const guest: User = { id: 'guest', username: 'Invited', email: 'guest@example.test' }
let migration: Client
const q = (text: string, values: unknown[] = []) => currentDatabaseClient()!.query(text, values)

describe.skipIf(!enabled)('explicit family backend (dedicated local restricted-role database)', () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_MIGRATION_URL!)
    if (target.hostname !== '127.0.0.1' || target.port !== '15432' || target.pathname !== '/habittrove_test_family_backend') throw new Error('Tests require the dedicated local family fixture')
    migration = new Client({ connectionString: target.toString() })
    await migration.connect()
    if (!(await migration.query("SELECT to_regclass('habittrove.family_configuration') AS name")).rows[0].name) {
      await migration.query('BEGIN')
      await migration.query(await readFile(new URL('./db/family-schema.sql', import.meta.url), 'utf8'))
      await migration.query('COMMIT')
    }
    await migration.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON habittrove.families,habittrove.family_memberships,habittrove.family_manager_assignments,habittrove.family_permissions,habittrove.family_preferences,habittrove.family_settings,habittrove.household_invitations,habittrove.family_audit,habittrove.family_legacy_adoptions,habittrove.family_document_revisions TO "Mac89Habittrove"; GRANT SELECT ON habittrove.family_configuration,habittrove.global_wallet_totals TO "Mac89Habittrove"`)
  })
  beforeEach(async () => {
    await migration.query(`TRUNCATE habittrove.users,habittrove.families,habittrove.habits,habittrove.wishlist_items,habittrove.coin_ledger,habittrove.global_wallet_totals,habittrove.attachments CASCADE`)
    for (const user of [admin, a, b, dual, guest]) await migration.query('INSERT INTO habittrove.users(id,ordinal,username,email,is_admin,attributes) VALUES($1,0,$2,$3,$4,$5)', [user.id, user.username, user.email ?? `${user.id}@example.test`, user.isAdmin ?? false, JSON.stringify({ fields: {}, present: ['email', 'isAdmin'] })])
    await migration.query("INSERT INTO habittrove.documents(kind,metadata) VALUES('auth','{\"fields\":{},\"present\":[\"users\"]}') ON CONFLICT(kind) DO UPDATE SET metadata=EXCLUDED.metadata")
    await migration.query("UPDATE habittrove.schema_version SET version=2 WHERE singleton")
    await migration.query("UPDATE habittrove.family_configuration SET enabled=true")
    await migration.query("INSERT INTO habittrove.families(id,name) VALUES('A','Family A'),('B','Family B')")
    await migration.query("INSERT INTO habittrove.family_document_revisions(family_id,kind) SELECT f.id,k.kind FROM habittrove.families f CROSS JOIN (VALUES('habits'),('wishlist')) k(kind)")
    await migration.query("INSERT INTO habittrove.family_memberships(family_id,user_id,role) VALUES('A','a','owner'),('B','b','owner'),('A','dual','manager'),('B','dual','member')")
    await migration.query("INSERT INTO habittrove.family_manager_assignments VALUES('A','a','dual')")
    await migration.query("INSERT INTO habittrove.habits(id,ordinal,name,created_by,coin_reward,attributes,family_id) VALUES('ha',0,'A habit','a',1,'{}','A'),('hb',1,'B habit','b',1,'{}','B')")
    await migration.query("INSERT INTO habittrove.habit_assignees(habit_id,ordinal,user_id,family_id) VALUES('ha',0,'dual','A'),('hb',0,'dual','B')")
    await migration.query("INSERT INTO habittrove.coin_ledger(id,ordinal,user_id,actor_id,amount,type,occurred_at,attributes,family_id) VALUES('la',0,'dual','a',4,'MANUAL_ADJUSTMENT',now(),'{}','A'),('lb',1,'dual','b',6,'MANUAL_ADJUSTMENT',now(),'{}','B')")
  })
  afterAll(async () => { await closeDatabase(); await migration?.end() })

  test('fresh role, two-family scope and pooled transaction-local context deny forged selectors', async () => {
    await scope.withFamilyScope(dual, async (context) => {
      expect(context?.role).toBe('manager')
      expect((await q('SELECT id FROM habittrove.habits ORDER BY id')).rows.map((row) => row.id)).toEqual(['ha'])
      await scope.withFamilyScope(dual, async (nested) => {
        expect(nested?.role).toBe('member')
        expect((await q('SELECT id FROM habittrove.habits')).rows.map((row) => row.id)).toEqual(['hb'])
      }, 'B')
      expect((await q('SELECT id FROM habittrove.habits')).rows.map((row) => row.id)).toEqual(['ha'])
    }, 'A')
    await expect(scope.withFamilyScope(a, async () => undefined, 'B')).rejects.toThrow('access denied')
    await withStorageTransaction(async () => {
      expect((await q('SELECT id FROM habittrove.habits')).rowCount).toBe(0)
      expect((await q("SELECT current_setting('habittrove.actor_id',true) AS actor")).rows[0].actor ?? '').toBe('')
    })
    await migration.query("UPDATE habittrove.family_memberships SET active=false WHERE family_id='A' AND user_id='dual'")
    await expect(scope.withFamilyScope(dual, async () => undefined, 'A')).rejects.toThrow('access denied')
  })
  test('default family scope matches selector name ordering for dual members and administrators without membership', async () => {
    await migration.query("UPDATE habittrove.families SET name=CASE id WHEN 'A' THEN 'Zulu household' ELSE 'Alpha household' END")
    for (const user of [dual, admin]) {
      const state = await store.readFamilyState(user)
      expect(state.selectedFamilyId).toBe('B')
      await scope.withFamilyScope(user, async (context) => {
        expect(context?.familyId).toBe(state.selectedFamilyId!)
        if (user.id === dual.id) expect((await q('SELECT id FROM habittrove.habits')).rows.map((row) => row.id)).toEqual(['hb'])
      }, undefined, { readOnly: true })
      expect((await store.readFamilyState(user, 'missing-family')).selectedFamilyId).toBeUndefined()
      await expect(scope.withFamilyScope(user, async () => undefined, 'missing-family')).rejects.toThrow('access denied')
      await expect(scope.withFamilyScope(user, async () => undefined, '')).rejects.toThrow('access denied')
    }
    expect((await store.readFamilyState(guest)).selectedFamilyId).toBeUndefined()
    await scope.withFamilyScope(guest, async (context) => expect(context).toBeUndefined(), undefined, { readOnly: true })
  })
  test('stale explicit family selectors return no selection while absent selectors default only authorized families', async () => {
    expect((await store.readFamilyState(dual)).selectedFamilyId).toBe('A')
    const nonexistent = await store.readFamilyState(dual, 'missing-family')
    expect(nonexistent.families.map((family) => family.id)).toEqual(['A', 'B'])
    expect(nonexistent.selectedFamilyId).toBeUndefined()
    expect(nonexistent.members).toEqual([])
    const preview = await store.previewStoredRemoval(a, 'A', 'dual')
    await store.removeStoredMember(a, 'A', 'dual', preview.revision)
    const revoked = await store.readFamilyState(dual, 'A')
    expect(revoked.families.map((family) => family.id)).toEqual(['B'])
    expect(revoked.selectedFamilyId).toBeUndefined()
    expect(revoked.members).toEqual([])
    expect((await store.readFamilyState(dual)).selectedFamilyId).toBe('B')
    expect((await store.readFamilyState(dual, 'B')).selectedFamilyId).toBe('B')
    const second = await store.previewStoredRemoval(b, 'B', 'dual')
    await store.removeStoredMember(b, 'B', 'dual', second.revision)
    expect(await store.readFamilyState(dual, 'B')).toEqual({ families: [], members: [], familiesEnabled: true })
    expect((await store.readFamilyState(dual)).selectedFamilyId).toBeUndefined()
    expect(await store.readGlobalWalletBalance(dual)).toBe(10)
  })
  test('provisioning initializes scoped documents, shared calendar defaults and owner resource defaults', async () => {
    const family = await store.provisionFamily(admin, 'New household', 'a')
    expect((await migration.query('SELECT kind,revision FROM habittrove.family_document_revisions WHERE family_id=$1 ORDER BY kind', [family.id])).rows).toEqual([{ kind: 'habits', revision: '1' }, { kind: 'wishlist', revision: '1' }])
    const settings = (await migration.query('SELECT settings FROM habittrove.family_settings WHERE family_id=$1', [family.id])).rows[0].settings
    expect(typeof settings.timezone).toBe('string')
    expect(settings.weekStartDay).toBe(1)
    expect(settings.autoBackupEnabled).toBeUndefined()
    expect((await migration.query('SELECT count(*) AS n FROM habittrove.family_permissions WHERE family_id=$1 AND user_id=$2 AND can_write AND can_interact', [family.id, 'a'])).rows[0].n).toBe('3')
  })
  test('scoped actors never inherit global permissions, delegations or preferences across families', async () => {
    await migration.query("UPDATE habittrove.users SET attributes=$1 WHERE id='dual'", [{ fields: { personalFolders: [{ id: 'global', name: 'Global', itemIds: [] }], personalSettings: { language: 'fr' } }, present: ['permissions','managedUserIds','personalFolders','statusDays'] }])
    await migration.query("INSERT INTO habittrove.permissions(user_id,ordinal,resource,can_write,can_interact) VALUES('dual',0,'habit',true,true)")
    await migration.query("INSERT INTO habittrove.manager_assignments(manager_id,member_id,ordinal) VALUES('dual','b',0)")
    await migration.query("INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) VALUES('A','dual','habit',false,true),('B','dual','wishlist',true,false)")
    await scope.withFamilyScope(dual, async () => {
      await expect(actorStore.saveFamilyPreferences(dual, [] as unknown as Partial<import('./family-actor').FamilyPreferences>)).rejects.toThrow('Invalid family preferences')
      await actorStore.saveFamilyPreferences(dual, { folders: [{ id: 'folder-a', name: 'A only', itemIds: [] }], statusDays: [{ date: '2026-01-01', status: 'rest' }], lastNotificationReadTimestamp: '2026-01-01T00:00:00Z' })
      const selected = await actorStore.getFamilyScopedUser(dual)
      expect(selected.permissions?.[0]).toEqual({ habit: { write: false, interact: true }, wishlist: { write: false, interact: false }, coins: { write: false, interact: false } })
      expect(selected.managedUserIds).toEqual([])
      expect(selected.personalFolders?.map((folder) => folder.id)).toEqual(['folder-a'])
      const directory = await actorStore.readFamilyDirectory(dual)
      expect(directory.users.map((user) => user.id)).toEqual(['a', 'dual'])
      expect(directory.users.find((user) => user.id === 'a')?.permissions?.[0].habit).toEqual({ write: false, interact: false })
      expect(directory.users.find((user) => user.id === 'a')?.managedUserIds).toEqual(['dual'])
      expect(directory.users.find((user) => user.id === 'a')?.personalSettings).toBeUndefined()
      expect(directory.users.find((user) => user.id === 'dual')?.personalSettings?.language).toBe('fr')
    }, 'A')
    await scope.withFamilyScope(dual, async () => {
      const selected = await actorStore.getFamilyScopedUser(dual)
      expect(selected.permissions?.[0].habit).toEqual({ write: false, interact: false })
      expect(selected.permissions?.[0].wishlist).toEqual({ write: true, interact: false })
      expect(selected.personalFolders).toEqual([])
      expect(selected.statusDays).toEqual([])
      expect(selected.lastNotificationReadTimestamp).toBeUndefined()
    }, 'B', { readOnly: true })
    await scope.withFreshFamilyActor(dual, async () => { await expect(actorStore.getFamilyScopedUser(dual)).rejects.toThrow('Selected family') })
  })
  test('family calendar settings are separate while personal UI and language follow the identity', async () => {
    const base = getDefaultSettings()
    await scope.withFamilyScope(a, async () => {
      await actorStore.saveFamilySettings(a, { ...base, system: { ...base.system, timezone: 'UTC', weekStartDay: 0 } }, base)
    }, 'A')
    await scope.withFamilyScope(dual, async () => {
      const current = await actorStore.readFamilySettings(dual, base)
      expect(current.system.timezone).toBe('UTC')
      await expect(actorStore.saveFamilySettings(dual, { ...current, system: { ...current.system, timezone: 'Europe/London' } }, base)).rejects.toThrow('owner')
    }, 'A').catch(() => undefined)
    await scope.withFamilyScope(dual, async () => {
      const current = await actorStore.readFamilySettings(dual, base)
      await actorStore.saveFamilySettings(dual, { ...current, ui: { useGrouping: false, useNumberFormatting: true }, system: { ...current.system, language: 'fr' } }, base)
    }, 'A')
    await scope.withFamilyScope(dual, async () => {
      const current = await actorStore.readFamilySettings(dual, base)
      expect(current.ui.useGrouping).toBe(false)
      expect(current.system.language).toBe('fr')
      expect(current.system.autoBackupEnabled).toBe(base.system.autoBackupEnabled)
    }, 'B', { readOnly: true })
  })
  test('new local invitation bridge binds stored email and rolls the new identity back on failure', async () => {
    const invite = await store.issueHouseholdInvite(a, 'A', 'new-local@example.test', 'member')
    const create = async (email: string) => {
      const account: User = { id: 'new-local', username: 'New local', email, password: 'test-only-hash', isAdmin: false }
      await q('INSERT INTO habittrove.users(id,ordinal,username,email,password_hash,is_admin,attributes) VALUES($1,9,$2,$3,$4,false,$5)', [account.id, account.username, email, account.password, { fields: {}, present: [] }])
      return account
    }
    await expect(store.withHouseholdInviteEmail(invite.token, async (email) => { await create(email); throw new Error('creation failed') })).rejects.toThrow('creation failed')
    expect((await migration.query("SELECT id FROM habittrove.users WHERE id='new-local'")).rowCount).toBe(0)
    await expect(store.withHouseholdInviteEmail(invite.token, async (email) => {
      const account = await create(email)
      await q("UPDATE habittrove.users SET is_admin=true WHERE id='new-local'")
      return account
    })).rejects.toThrow('new local member')
    expect((await migration.query("SELECT id FROM habittrove.users WHERE id='new-local'")).rowCount).toBe(0)
    const account = await store.withHouseholdInviteEmail(invite.token, create)
    expect(account.email).toBe('new-local@example.test')
    expect((await migration.query("SELECT role FROM habittrove.family_memberships WHERE family_id='A' AND user_id='new-local'")).rows[0].role).toBe('member')
    await expect(store.withHouseholdInviteEmail(invite.token, create)).rejects.toThrow('unavailable')
    await scope.withFreshFamilyActor(dual, async () => expect(await actorStore.readCurrentGlobalWalletBalance(dual)).toBe(10), { readOnly: true })
    await scope.withFamilyScope(a, async () => expect(await actorStore.readCurrentGlobalWalletBalance(a, 'dual')).toBe(10), 'A', { readOnly: true })
  })
  test('global avatars remain visible across families and after leaving, while evidence stays family private', async () => {
    await scope.withFamilyScope(dual, async () => {
      await q("INSERT INTO habittrove.attachments(id,owner_id,path,mime_type,family_id) VALUES('dual-avatar','dual','avatars/dual.png','image/png','B')")
    }, 'A')
    expect((await migration.query("SELECT family_id FROM habittrove.attachments WHERE id='dual-avatar'")).rows[0].family_id).toBeNull()
    await migration.query("INSERT INTO habittrove.attachments(id,habit_id,owner_id,path,mime_type,family_id) VALUES('b-evidence','hb','dual','evidence/b.png','image/png','B')")
    await scope.withFamilyScope(a, async () => expect((await q('SELECT id FROM habittrove.attachments ORDER BY id')).rows.map((row) => row.id)).toEqual(['dual-avatar']), 'A', { readOnly: true })
    await scope.withFamilyScope(b, async () => expect((await q("SELECT id FROM habittrove.attachments WHERE id='dual-avatar'")).rowCount).toBe(1), 'B', { readOnly: true })
    await scope.withFreshFamilyActor(guest, async () => {
      expect((await q("SELECT id FROM habittrove.attachments WHERE id='dual-avatar'")).rowCount).toBe(0)
      await q("INSERT INTO habittrove.attachments(id,owner_id,path,mime_type) VALUES('guest-avatar','guest','avatars/guest.png','image/png')")
      expect((await q("SELECT id FROM habittrove.attachments WHERE id='guest-avatar'")).rowCount).toBe(1)
      expect((await q("UPDATE habittrove.attachments SET mime_type='image/jpeg' WHERE id='guest-avatar'")).rowCount).toBe(1)
    })
    await scope.withFamilyScope(a, async () => expect((await q("UPDATE habittrove.attachments SET mime_type='image/jpeg' WHERE id='dual-avatar'")).rowCount).toBe(0), 'A')
    for (const [owner, familyId] of [[a, 'A'], [b, 'B']] as const) {
      const preview = await store.previewStoredRemoval(owner, familyId, 'dual')
      await store.removeStoredMember(owner, familyId, 'dual', preview.revision)
    }
    await withStorageTransaction(async () => {
      await scope.withFreshFamilyActor(dual, async () => {
        expect((await q("SELECT id FROM habittrove.attachments ORDER BY id")).rows.map((row) => row.id)).toEqual(['dual-avatar'])
        expect((await q('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
      }, { readOnly: true })
    }, { readOnly: true })
    await scope.withFamilyScope(a, async () => expect((await q("SELECT id FROM habittrove.attachments WHERE id='dual-avatar'")).rowCount).toBe(0), 'A', { readOnly: true })
    await scope.withFreshFamilyActor(dual, async () => expect((await q("DELETE FROM habittrove.attachments WHERE id='dual-avatar'")).rowCount).toBe(1))
  })
  test('global wallet summary combines families while ledger origins stay private', async () => {
    expect(await store.readGlobalWalletBalance(dual, dual.id, 'A')).toBe(10)
    expect(await store.readGlobalWalletBalance(a, dual.id, 'A')).toBe(10)
    await scope.withFamilyScope(a, async () => expect((await q('SELECT id FROM habittrove.coin_ledger ORDER BY id')).rows.map((row) => row.id)).toEqual(['la']), 'A')
    await scope.withFamilyScope(dual, async () => expect((await q('SELECT id FROM habittrove.coin_ledger ORDER BY id')).rows.map((row) => row.id)).toEqual(['la', 'lb']), 'A')
    await expect(store.readGlobalWalletBalance(b, dual.id, 'B')).rejects.toThrow('access denied')
    await scope.withFamilyScope(a, async () => {
      await expect(q("UPDATE habittrove.global_wallet_totals SET balance=999 WHERE user_id='dual'")).rejects.toThrow()
    }, 'A').catch(() => undefined)
  })
  test('owners manage membership but cannot remove the last owner or grant cross-family delegation', async () => {
    await expect(store.previewStoredRemoval(a, 'A', 'a')).rejects.toThrow('last active')
    await expect(store.updateStoredMembership(a, 'A', 'a', { role: 'member' })).rejects.toThrow()
    await expect(store.updateStoredMembership(a, 'A', 'dual', { managedUserIds: ['b'] })).rejects.toThrow('Active family')
    await expect(store.updateStoredMembership(dual, 'A', 'a', { role: 'member' })).rejects.toThrow('owner access')
    await store.updateStoredMembership(a, 'A', 'dual', { role: 'owner' })
    await store.updateStoredMembership(a, 'A', 'a', { role: 'member' })
    await expect(store.updateStoredMembership(a, 'A', 'dual', { role: 'member' })).rejects.toThrow('owner access')
    expect((await store.readFamilyState(dual, 'A')).members.find((member) => member.id === 'dual')?.role).toBe('owner')
  })
  test('concurrent owner demotions preserve exactly one active owner', async () => {
    await store.updateStoredMembership(a, 'A', 'dual', { role: 'owner' })
    const results = await Promise.allSettled([
      store.updateStoredMembership(a, 'A', 'a', { role: 'member' }),
      store.updateStoredMembership(dual, 'A', 'dual', { role: 'member' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await migration.query("SELECT count(*) AS n FROM habittrove.family_memberships WHERE family_id='A' AND active AND role='owner'")).rows[0].n).toBe('1')
  })
  test('membership removal withdraws pending work, archives orphaned items and retains global coins/history', async () => {
    await migration.query("INSERT INTO habittrove.habit_approvers(habit_id,ordinal,user_id,family_id) VALUES('ha',0,'dual','A')")
    await migration.query("INSERT INTO habittrove.completions(habit_id,ordinal,record_kind,id,beneficiary_id,approval,family_id) VALUES('ha',0,'record','pending','dual','pending','A')")
    await migration.query("INSERT INTO habittrove.attachments(id,habit_id,completion_id,path,mime_type,family_id) VALUES('e','ha','pending','evidence/e.png','image/png','A')")
    const preview = await store.previewStoredRemoval(a, 'A', 'dual')
    expect(preview.archivedItemIds).toEqual(['ha'])
    expect(preview.withdrawnSubmissionIds).toEqual(['pending'])
    await expect(store.removeStoredMember(a, 'A', 'dual', 'stale')).rejects.toThrow('preview removal')
    await store.removeStoredMember(a, 'A', 'dual', preview.revision)
    expect(await store.readGlobalWalletBalance(dual, 'dual', 'B')).toBe(10)
    const row = (await migration.query("SELECT archived,(SELECT voided FROM habittrove.completions WHERE id='pending') AS voided FROM habittrove.habits WHERE id='ha'")).rows[0]
    expect(row).toEqual({ archived: true, voided: true })
    expect((await migration.query("SELECT user_id FROM habittrove.habit_approvers WHERE habit_id='ha'")).rows[0].user_id).toBe('a')
    expect((await migration.query("SELECT inaccessible FROM habittrove.attachments WHERE id='e'")).rows[0].inaccessible).toBe(true)
    expect((await migration.query('SELECT count(*) AS n FROM habittrove.coin_ledger')).rows[0].n).toBe('2')
    const second = await store.previewStoredRemoval(b, 'B', 'dual')
    await store.removeStoredMember(b, 'B', 'dual', second.revision)
    expect((await store.readFamilyState(dual)).families).toEqual([])
    expect(await store.readGlobalWalletBalance(dual)).toBe(10)
  })
  test('removal flags survive DTO projection and resave, including ordinary actor-only submissions and reused resource IDs', async () => {
    await scope.withFamilyScope(a, async () => {
      await writeDocument('habits', { habits: [{ id: 'ha', name: 'Actor-only task', description: '', frequency: 'daily', coinReward: 1, createdBy: 'a', userIds: ['dual'], approverIds: ['dual'], requiresApproval: true,
        completions: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'], completionRecords: [
          { id: 'actor-pending', actorId: 'dual', approval: 'pending', evidenceId: 'actor-evidence' },
          { id: 'beneficiary-pending', actorId: 'a', beneficiaryId: 'dual', approval: 'pending', evidenceId: 'beneficiary-evidence' },
          { id: 'historical-approved', actorId: 'dual', approval: 'approved', rewardedUserIds: ['dual'], rewardAmount: 1 },
        ] }, { id: 'still-active', name: 'Another persons task', description: '', frequency: 'daily', coinReward: 1, userIds: ['a'], completions: ['2026-01-01T00:00:00Z'], completionRecords: [{ id: 'actor-pending', actorId: 'a', approval: 'pending', evidenceId: 'unrelated-evidence' }] }] })
      await writeDocument('wishlist', { items: [
        { id: 'ha', name: 'Same ID shared reward', description: '', coinCost: 1, userIds: ['dual', 'a'] },
        { id: 'reward-only', name: 'Removed members reward', description: '', coinCost: 1, userIds: ['dual'] },
      ] })
    }, 'A')
    for (const [id, completion] of [['actor-evidence', 'actor-pending'], ['beneficiary-evidence', 'beneficiary-pending']]) await migration.query('INSERT INTO habittrove.attachments(id,habit_id,completion_id,path,mime_type,family_id) VALUES($1,$2,$3,$4,$5,$6)', [id, 'ha', completion, `evidence/${id}.png`, 'image/png', 'A'])
    await migration.query("INSERT INTO habittrove.attachments(id,habit_id,completion_id,path,mime_type,family_id) VALUES('unrelated-evidence','still-active','actor-pending','evidence/unrelated-evidence.png','image/png','A')")
    const impact = await store.previewStoredRemoval(a, 'A', 'dual')
    expect(impact.archivedHabitIds).toEqual(['ha'])
    expect(impact.archivedRewardIds).toEqual(['reward-only'])
    expect(impact.withdrawnSubmissionIds).toEqual(['actor-pending', 'beneficiary-pending'])
    await store.removeStoredMember(a, 'A', 'dual', impact.revision)
    await scope.withFamilyScope(a, async () => {
      expect((await q("SELECT id FROM habittrove.attachments WHERE habit_id='ha'")).rowCount).toBe(0)
      expect((await q("SELECT current_setting('habittrove.evidence_maintenance',true) AS value")).rows[0].value ?? '').toBe('')
      const habits = (await readDocument<HabitsData>('habits'))!
      const wishlist = (await readDocument<WishlistData>('wishlist'))!
      expect(habits.habits[0].archived).toBe(true)
      expect(habits.habits[0].completionRecords?.slice(0, 2).map((record) => ({ id: record?.id, voided: record?.voided, approval: record?.approval }))).toEqual([
        { id: 'actor-pending', voided: true, approval: 'rejected' }, { id: 'beneficiary-pending', voided: true, approval: 'rejected' },
      ])
      expect(wishlist.items.find((item) => item.id === 'ha')?.archived).toBeUndefined()
      expect(wishlist.items.find((item) => item.id === 'reward-only')?.archived).toBe(true)
      await writeDocument('habits', habits)
      await writeDocument('wishlist', wishlist)
      expect(await readDocument<HabitsData>('habits')).toEqual(habits)
      expect(await readDocument<WishlistData>('wishlist')).toEqual(wishlist)
    }, 'A')
    expect((await migration.query("SELECT inaccessible FROM habittrove.attachments WHERE family_id='A' AND habit_id='ha' ORDER BY id")).rows.every((row) => row.inaccessible)).toBe(true)
    expect((await migration.query("SELECT needs_review FROM habittrove.completions WHERE family_id='A' AND habit_id='ha' AND approval='rejected'")).rows.every((row) => row.needs_review)).toBe(true)
    expect((await migration.query("SELECT inaccessible FROM habittrove.attachments WHERE id='unrelated-evidence'")).rows[0].inaccessible).toBe(false)
    expect((await migration.query("SELECT user_id FROM habittrove.completion_recipients WHERE family_id='A' AND habit_id='ha'")).rows.map((row) => row.user_id)).toEqual(['dual'])
  })
  test('stored invitations enforce email, one use, inviter freshness and safe anonymous metadata', async () => {
    const { token } = await store.issueHouseholdInvite(a, 'A', 'GUEST@example.test', 'member', 'a')
    const safe = await store.readPublicHouseholdInvite(token)
    expect(safe).toMatchObject({ familyName: 'Family A', maskedEmail: 'g***@example.test', role: 'member' })
    expect(JSON.stringify(safe)).not.toContain('guest@example.test')
    await expect(store.acceptStoredHouseholdInvite(b, token)).rejects.toThrow('invited email')
    const outcomes = await Promise.allSettled([store.acceptStoredHouseholdInvite(guest, token), store.acceptStoredHouseholdInvite(guest, token)])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(await store.readPublicHouseholdInvite(token)).toBeUndefined()
    expect((await store.readFamilyState(guest, 'A')).members.find((member) => member.id === 'guest')).toMatchObject({ role: 'member', active: true })
    const another = await store.issueHouseholdInvite(a, 'A', 'b@example.test', 'manager')
    await store.updateStoredMembership(a, 'A', 'dual', { role: 'owner' })
    await store.updateStoredMembership(a, 'A', 'a', { role: 'member' })
    await expect(store.acceptStoredHouseholdInvite(b, another.token)).rejects.toThrow('unavailable')
  })
  test('revoked and expired offers cannot be accepted; managers cannot invite or provision', async () => {
    const revoked = await store.issueHouseholdInvite(a, 'A', 'guest@example.test', 'member')
    const [invite] = await store.readHouseholdInvites(a, 'A')
    await store.revokeStoredInvite(a, 'A', invite.tokenHash)
    await expect(store.acceptStoredHouseholdInvite(guest, revoked.token)).rejects.toThrow('unavailable')
    const expired = await store.issueHouseholdInvite(a, 'A', 'guest@example.test', 'member')
    await migration.query('UPDATE habittrove.household_invitations SET expires_at=now()-interval \'1 second\'')
    await expect(store.acceptStoredHouseholdInvite(guest, expired.token)).rejects.toThrow('unavailable')
    await expect(store.issueHouseholdInvite(dual, 'A', 'guest@example.test', 'member')).rejects.toThrow('owner access')
    await expect(store.provisionFamily(a, 'Unauthorised')).rejects.toThrow('administrator')
    await expect(store.provisionFamily({ ...a, isAdmin: true }, 'Forged admin')).rejects.toThrow('administrator')
  })
  test('new membership receives established resource permissions and rejoining preserves customized permissions', async () => {
    const first = await store.issueHouseholdInvite(a, 'A', 'guest@example.test', 'member')
    await store.acceptStoredHouseholdInvite(guest, first.token)
    const permissions = (await migration.query("SELECT resource,can_write,can_interact FROM habittrove.family_permissions WHERE family_id='A' AND user_id='guest' ORDER BY resource")).rows
    expect(permissions).toEqual(['coins', 'habit', 'wishlist'].map((resource) => ({ resource, can_write: true, can_interact: true })))
    await migration.query("UPDATE habittrove.family_permissions SET can_write=false,can_interact=false WHERE family_id='A' AND user_id='guest' AND resource='coins'")
    const preview = await store.previewStoredRemoval(a, 'A', 'guest')
    await store.removeStoredMember(a, 'A', 'guest', preview.revision)
    const second = await store.issueHouseholdInvite(a, 'A', 'guest@example.test', 'member')
    await store.acceptStoredHouseholdInvite(guest, second.token)
    expect((await migration.query("SELECT can_write,can_interact FROM habittrove.family_permissions WHERE family_id='A' AND user_id='guest' AND resource='coins'")).rows[0]).toEqual({ can_write: false, can_interact: false })
  })
  test('adoption materializes absent and empty legacy permissions as explicit deny rows accepted by enabled startup', async () => {
    // Complete the isolated fixture's operational metadata; the adopted identities
    // deliberately retain absent/empty legacy permissions rather than defaults.
    await migration.query("CREATE SEQUENCE IF NOT EXISTS habittrove.coin_ledger_family_order AS bigint INCREMENT BY -1 MINVALUE -9223372036854775808 MAXVALUE -1 START WITH -1")
    await migration.query("INSERT INTO habittrove.family_settings(family_id) SELECT id FROM habittrove.families ON CONFLICT DO NOTHING")
    await migration.query("INSERT INTO habittrove.documents(kind,metadata) SELECT kind,'{\"fields\":{},\"present\":[]}' FROM unnest(ARRAY['habits','wishlist','coins','settings']) kind ON CONFLICT DO NOTHING")
    await migration.query("INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) SELECT family_id,user_id,resource,false,false FROM habittrove.family_memberships CROSS JOIN unnest(ARRAY['habit','wishlist','coins']) resource ON CONFLICT DO NOTHING")
    await migration.query("UPDATE habittrove.users SET attributes=jsonb_set(attributes,'{present}',(attributes->'present') || '[\"permissions\"]') WHERE id='guest'")
    const mapping = { familyId: 'A', userIds: ['admin', 'guest'], habitIds: [], wishlistIds: [], ledgerIds: [], managers: [] }
    const preview = await store.previewLegacyFamilyAdoption(admin, mapping)
    await store.applyLegacyFamilyAdoption(admin, { ...mapping, expectedSourceHash: preview.sourceHash })
    for (const userId of ['admin', 'guest']) expect((await migration.query("SELECT resource,can_write,can_interact FROM habittrove.family_permissions WHERE family_id='A' AND user_id=$1 ORDER BY resource", [userId])).rows).toEqual(['coins', 'habit', 'wishlist'].map((resource) => ({ resource, can_write: false, can_interact: false })))
    await scope.withFamilyScope(admin, async () => {
      const selected = await actorStore.getFamilyScopedUser(admin)
      expect(selected.isAdmin).toBe(true)
      expect(selected.permissions?.[0].habit).toEqual({ write: false, interact: false })
    }, 'A', { readOnly: true })
    await expect(validateRuntimeStorage()).resolves.toBeUndefined()
  })
  test('legacy delegation omissions are visible and every touching relation participates in mapping preview hash', async () => {
    const mapping = { familyId: 'A', userIds: ['a', 'dual'], habitIds: [], wishlistIds: [], ledgerIds: [], managers: [] }
    await migration.query("INSERT INTO habittrove.manager_assignments(manager_id,member_id,ordinal) VALUES('a','dual',0)")
    const preview = await store.previewLegacyFamilyAdoption(admin, mapping)
    expect(preview.legacyManagerAssignments).toEqual([{ managerId: 'a', memberId: 'dual' }])
    expect(preview.discardedLegacyManagerAssignments).toEqual([{ managerId: 'a', memberId: 'dual' }])
    await migration.query("INSERT INTO habittrove.manager_assignments(manager_id,member_id,ordinal) VALUES('b','dual',0)")
    await expect(store.applyLegacyFamilyAdoption(admin, { ...mapping, expectedSourceHash: preview.sourceHash })).rejects.toThrow('source changed')
    const refreshed = await store.previewLegacyFamilyAdoption(admin, mapping)
    expect(refreshed.legacyManagerAssignments).toHaveLength(2)
    expect(refreshed.sourceHash).not.toBe(preview.sourceHash)
  })
  test('explicit legacy adoption rejects ambiguous mappings and stale hashes without duplicating money', async () => {
    await migration.query("INSERT INTO habittrove.habits(id,ordinal,name,coin_reward,attributes) VALUES('old',2,'Legacy',0.25,'{}')")
    await migration.query("INSERT INTO habittrove.habit_assignees(habit_id,ordinal,user_id) VALUES('old',0,'dual')")
    await migration.query("INSERT INTO habittrove.coin_ledger(id,ordinal,user_id,amount,type,occurred_at,attributes) VALUES('old-coin',2,'dual',0.25,'HABIT_COMPLETION',now(),'{}')")
    await migration.query("INSERT INTO habittrove.permissions(user_id,ordinal,resource,can_write,can_interact) VALUES('dual',0,'habit',false,false)")
    await migration.query("INSERT INTO habittrove.family_permissions(family_id,user_id,resource,can_write,can_interact) VALUES('A','dual','habit',true,true)")
    const mapping = { familyId: 'A', userIds: ['dual'], habitIds: ['old'], wishlistIds: [], ledgerIds: ['old-coin'], managers: [] }
    await expect(store.previewLegacyFamilyAdoption(a, mapping)).rejects.toThrow('administrator')
    await expect(store.previewLegacyFamilyAdoption(admin, { ...mapping, userIds: [] })).rejects.toThrow('explicitly mapped')
    await migration.query("INSERT INTO habittrove.documents(kind,metadata) VALUES('habits','{\"fields\":{\"legacyMarker\":\"kept\",\"familyId\":\"transport-only\"},\"present\":[]}') ON CONFLICT(kind) DO UPDATE SET metadata=EXCLUDED.metadata")
    const preview = await store.previewLegacyFamilyAdoption(admin, mapping)
    await expect(store.applyLegacyFamilyAdoption(admin, { ...mapping, expectedSourceHash: 'stale' })).rejects.toThrow('source changed')
    await store.applyLegacyFamilyAdoption(admin, { ...mapping, expectedSourceHash: preview.sourceHash })
    expect(await store.readGlobalWalletBalance(dual, 'dual', 'B')).toBe(10.25)
    expect((await migration.query("SELECT metadata->'fields' AS fields FROM habittrove.family_document_revisions WHERE family_id='A' AND kind='habits'")).rows[0].fields).toEqual({ legacyMarker: 'kept' })
    expect((await migration.query("SELECT can_write,can_interact FROM habittrove.family_permissions WHERE family_id='A' AND user_id='dual' AND resource='habit'")).rows[0]).toEqual({ can_write: false, can_interact: false })
    await expect(store.applyLegacyFamilyAdoption(admin, { ...mapping, expectedSourceHash: preview.sourceHash })).rejects.toThrow('previously adopted')
    expect((await migration.query("SELECT count(*) AS n FROM habittrove.coin_ledger WHERE id='old-coin'")).rows[0].n).toBe('1')
  })
  test('cross-family item/membership constraints reject forged assignee and event ownership', async () => {
    await expect(scope.withFamilyScope(a, async () => { await q("INSERT INTO habittrove.habit_assignees(habit_id,ordinal,user_id,family_id) VALUES('ha',9,'b','A')") }, 'A')).rejects.toThrow()
    await expect(scope.withFamilyScope(a, async () => { await q("INSERT INTO habittrove.coin_ledger(id,ordinal,user_id,related_item_id,amount,type,occurred_at,attributes,family_id) VALUES('forged',9,'a','hb',1,'HABIT_COMPLETION',now(),'{}','A')") }, 'A')).rejects.toThrow('different family')
    await expect(scope.withFamilyScope(a, async () => { await q("INSERT INTO habittrove.completions(habit_id,ordinal,record_kind,family_id) VALUES('hb',9,'null','A')") }, 'A')).rejects.toThrow()
  })
})
