'use server'

import fs from 'fs/promises'
import path from 'path'
import {
  HabitsData,
  Habit,
  HabitCompletionRecord,
  CoinsData,
  CoinTransaction,
  TransactionType,
  WishlistItemType,
  WishlistData,
  Settings,
  DataType,
  DATA_DEFAULTS,
  getDefaultSettings,
  UserData,
  User,
  PersonalFolder,
  StatusDay,
  PublicUser,
  PublicUserData,
  getDefaultWishlistData,
  getDefaultHabitsData,
  getDefaultCoinsData,
  Permission,
  ServerSettings,
  PendingApproval,
  FamilyOverviewData
} from '@/lib/types'
import { checkPermission, d2t, getNow, uuid, isHabitDue } from '@/lib/utils';
import { saltAndHashPassword, saltAndHashPasswordAsync } from '@/lib/password'
import { readAuthData, updateAuthData, verifyStepUpPassword } from '@/lib/auth-store'
import { emailSchema, newPasswordSchema, signInSchema, usernameSchema } from '@/lib/zod';
import _ from 'lodash';
import { getCurrentUser } from '@/lib/server-helpers'
import { prepareDataForHashing, generateCryptoHash } from '@/lib/utils';
import { sanitizeUserData } from '@/lib/user-sanitizer'
import { ALLOWED_AVATAR_EXTENSIONS, ALLOWED_AVATAR_MIME_TYPES } from '@/lib/avatar'
import { PermissionError } from '@/lib/exceptions'
import { z } from 'zod'
import { MAX_COIN_LIMIT } from '@/lib/constants'
import { DateTime } from 'luxon'
import { validateHabit, validateSettings, validateWishlistItem } from '@/lib/security-validation'
import { getActiveOidcConfig, getOidcDisplayName } from '@/lib/admin-config'
import { log } from '@/lib/logger'
import { getTaskProgress, isApprovedCompletion, isCountedCompletion, isTaskScheduledOnDate } from '@/lib/task-schedule'
import sharp from 'sharp'
import { createHash, randomBytes } from 'crypto'
import { getNextAfterCompletionDate } from '@/lib/flexible-schedule'
import { sendFamilyInvitation } from '@/lib/invitation-mail'
import { usesPostgres } from '@/lib/storage-mode'
import { withStorageTransaction } from '@/lib/db/client'
import { readDocument, writeDocument, getDocumentRevision, StaleDocumentError, readAttachmentMetadata, upsertAttachmentMetadata } from '@/lib/db/repository'
import { registerAttachment, scheduleAttachmentRemoval, scheduleHabitEvidenceRemoval } from '@/lib/attachment-store'
import { cookies } from 'next/headers'
import { currentDatabaseClient } from '@/lib/db/client'
import { getFamiliesEnabled, withFamilyScope, withFreshFamilyActor } from '@/lib/family-scope'
import { getFamilyScopedUser, readFamilyDirectory, readFamilySettings, saveFamilySettings,
  savePersonalSettings, saveFamilyPreferences, readCurrentGlobalWalletBalance, requireCurrentFamilyContext } from '@/lib/family-actor'
import { preflightNewHouseholdInvite, withHouseholdInviteEmail } from '@/lib/family-store'
import { acquirePasswordVerification, reserveAuthenticationAttempt, clearAuthenticationAttempts } from '@/lib/auth-throttle'
import { readCompletionLedger } from '@/lib/db/repository'
import type { ReminderData } from '@/lib/reminders'



type ResourceType = 'habit' | 'wishlist' | 'coins'
type ActionType = 'write' | 'interact'

const permissionSchema = z.array(z.object({
  habit: z.object({ write: z.boolean(), interact: z.boolean() }),
  wishlist: z.object({ write: z.boolean(), interact: z.boolean() }),
  coins: z.object({ write: z.boolean(), interact: z.boolean() }),
})).max(1)

let dataWriteQueue: Promise<void> = Promise.resolve()

async function withDataWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  if (usesPostgres()) return withStorageTransaction(operation)
  const prior = dataWriteQueue
  let release: () => void = () => {}
  dataWriteQueue = new Promise<void>(resolve => { release = resolve })
  await prior
  try {
    return await operation()
  } finally {
    release()
  }
}

async function withSelectedFamilyAction<T>(operation: () => Promise<T>, readOnly = false,
  withoutFamily?: (actor: User) => Promise<T>): Promise<T> {
  if (!usesPostgres() || !await getFamiliesEnabled()) return operation()
  const actor = await getCurrentUser()
  if (!actor) return operation()
  const selected = (await cookies()).get('habittrove-family')?.value
  const invoke = () => withFamilyScope(actor, async scope => {
    if (!scope) {
      if (withoutFamily) return withoutFamily(actor)
      throw new PermissionError('Choose or create a family before changing family data')
    }
    return operation()
  }, selected, { readOnly })
  try { return await invoke() }
  catch (error) {
    if (readOnly && withoutFamily && error instanceof Error && ['Family access denied', 'Invalid family'].includes(error.message)) {
      return withFreshFamilyActor(actor, () => withoutFamily(actor), { readOnly: true })
    }
    throw error
  }
}

async function withGlobalIdentityAction<T>(operation: () => Promise<T>, readOnly: boolean): Promise<T> {
  if (!usesPostgres() || !await getFamiliesEnabled()) return operation()
  const actor = await getCurrentUser()
  return actor ? withFreshFamilyActor(actor, operation, { readOnly }) : operation()
}

async function withIdentityWrite<T>(actor: User, operation: () => Promise<T>): Promise<T> {
  return usesPostgres() ? withFreshFamilyActor(actor, operation) : operation()
}

async function getCurrentDataUser(): Promise<User | null> {
  const actor = await getCurrentUser()
  const client = currentDatabaseClient()
  if (!actor || !client || !await getFamiliesEnabled()) return actor ?? null
  const state = (await client.query("SELECT current_setting('habittrove.scope_validated',true) AS valid")).rows[0]
  return state.valid === 'true' ? getFamilyScopedUser(actor) : actor
}

async function readDataUsers(): Promise<UserData> {
  const actor = await requireUser()
  return usesPostgres() && await getFamiliesEnabled() ? readFamilyDirectory(actor) : readAuthData()
}

async function walletBalance(data: CoinsData, actor: User, userId = actor.id): Promise<number> {
  return usesPostgres() && await getFamiliesEnabled()
    ? readCurrentGlobalWalletBalance(actor, userId)
    : data.transactions.filter(row => row.userId === userId).reduce((total, row) => total + row.amount, 0)
}

function validateAvatarPath(avatarPath: unknown): string | undefined {
  if (avatarPath == null || avatarPath === '') return undefined
  if (typeof avatarPath !== 'string' || !/^\/data\/avatars\/[a-zA-Z0-9-]+\.(png|jpe?g|gif|webp|avif)$/.test(avatarPath)) {
    throw new Error('Invalid avatar path')
  }
  return avatarPath
}

async function assignAvatar(data: UserData, avatarPath: string, targetId: string, actor: User): Promise<void> {
  if (!usesPostgres()) return
  const filename = path.basename(avatarPath)
  const attachment = await readAttachmentMetadata(`avatar:${filename}`)
  if (!attachment || attachment.path !== `avatars/${filename}` || (!actor.isAdmin && attachment.owner_id !== actor.id)) {
    throw new PermissionError('Avatar upload is no longer available')
  }
  if (data.users.some(user => user.id !== targetId && user.avatarPath === avatarPath)) {
    throw new PermissionError('Avatar is already assigned; upload a new image')
  }
  await upsertAttachmentMetadata({ ...attachment, owner_id: targetId })
}

function validateOidcSubject(subject: unknown): string | undefined {
  if (subject == null || subject === '') return undefined
  return z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/).parse(subject)
}

function validateEmail(email: unknown): string | undefined {
  return emailSchema.parse(email).toLowerCase()
}

function validateCoinText(description: unknown, note: unknown): void {
  if (typeof description !== 'string' || description.length > 500) {
    throw new Error('Invalid coin description')
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > 10_000)) {
    throw new Error('Invalid transaction note')
  }
}

function isGeneratedAvatarForUser(filename: string, userId: string): boolean {
  if (!filename.startsWith(`${userId}-`)) return false
  const generatedPart = filename.slice(userId.length + 1)
  const extension = path.extname(generatedPart).toLowerCase()
  return ALLOWED_AVATAR_EXTENSIONS.has(extension) &&
    /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generatedPart.slice(0, -extension.length))
}

async function verifyPermission(
  resource: ResourceType,
  action: ActionType
): Promise<User> {
  const user = await requireUser()
  if (!user.isAdmin && !checkPermission(user.permissions, resource, action) &&
      !(action === 'write' && resource !== 'coins' && user.managedUserIds?.length)) {
    throw new PermissionError(`User does not have ${action} permission for ${resource}`)
  }
  return user
}

function familyItemVisible(item: { userIds?: string[] }, user: User): boolean {
  if (user.isAdmin || item.userIds?.includes(user.id)) return true
  const managed = new Set([user.id, ...(user.managedUserIds ?? [])])
  return !!item.userIds?.length && item.userIds.every(id => managed.has(id)) &&
    item.userIds.some(id => id !== user.id)
}

function familyItemEditable(item: { userIds?: string[] }, user: User): boolean {
  if (user.isAdmin || item.userIds?.includes(user.id)) return true
  const managed = new Set([user.id, ...(user.managedUserIds ?? [])])
  return !!item.userIds?.length && item.userIds.every(id => managed.has(id)) &&
    !!user.managedUserIds?.length
}

async function requireUser(): Promise<User> {
  const user = await getCurrentDataUser()
  if (!user) throw new PermissionError('User not authenticated')
  if (!user.email && process.env.DEMO !== 'true') throw new PermissionError('Email is required before using this account')
  return user
}

async function requireAdmin(): Promise<User> {
  const user = await requireUser()
  if (!user.isAdmin) throw new PermissionError('Administrator access required')
  return user
}

function mergeOwnedItems<T extends { id: string; userIds?: string[] }>(
  submitted: T[],
  existing: T[],
  user: User,
  canWrite: boolean,
  interactionFields: (keyof T)[],
  resource: 'habit' | 'wishlist'
): T[] {
  if (!Array.isArray(submitted)) throw new Error('Invalid item list')
  if (user.isAdmin) return submitted

  const existingById = new Map(existing.map(item => [item.id, item]))
  const visible = existing.filter(item => familyItemEditable(item, user))
  const managerOnly = !checkPermission(user.permissions, resource, 'write') && !!user.managedUserIds?.length
  const managed = new Set([user.id, ...(user.managedUserIds ?? [])])
  const managerCanWrite = (item: T) => !!item.userIds?.length && item.userIds.every(id => managed.has(id)) &&
    item.userIds.some(id => id !== user.id)
  const seen = new Set<string>()

  const ownedItems = submitted.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) {
      throw new Error('Invalid item ID')
    }
    seen.add(item.id)
    const stored = existingById.get(item.id)
    if (stored && !familyItemEditable(stored, user)) {
      throw new PermissionError('Cannot change another user\'s item')
    }
    const userIds = item.userIds ?? [user.id]
    if (!Array.isArray(userIds) || !familyItemEditable({ userIds }, user) || userIds.some(id => typeof id !== 'string')) {
      throw new PermissionError('Item must belong to the current user')
    }
    const fullWrite = canWrite && (!managerOnly || managerCanWrite(item) && (!stored || managerCanWrite(stored)))
    if (!fullWrite) {
      if (!stored) throw new PermissionError('Cannot create items with interaction permission')
      const unchanged = (value: T) => Object.fromEntries(
        Object.entries(value).filter(([key, field]) => field !== undefined &&
          (managerOnly || !interactionFields.includes(key as keyof T)))
      )
      if (!_.isEqual(unchanged(item), unchanged(stored))) {
        throw new PermissionError('Only interaction fields may be changed')
      }
    }
    return { ...item, userIds }
  })

  if ((!canWrite || managerOnly) && visible.some(item => !seen.has(item.id) && (!managerOnly || !managerCanWrite(item)))) {
    throw new PermissionError('Cannot delete items with interaction permission')
  }

  return [...existing.filter(item => !familyItemEditable(item, user)), ...ownedItems]
}

function getDefaultData<T>(type: DataType): T {
  return DATA_DEFAULTS[type]() as T;
}

async function assertDocumentRevision(type: Exclude<DataType, 'auth'>, revision: number | undefined, familyId?: string): Promise<void> {
  if ((type === 'habits' || type === 'wishlist') && usesPostgres() && await getFamiliesEnabled()) {
    const context = await requireCurrentFamilyContext(await requireUser())
    if (familyId !== context.familyId) throw new PermissionError('Data belongs to another family; reload before saving')
  }
  if (usesPostgres() && (!Number.isSafeInteger(revision) || revision !== await getDocumentRevision(type))) {
    throw new StaleDocumentError()
  }
}

async function ensureDataDir() {
  const dataDir = path.join(process.cwd(), 'data')
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
}

// --- Backup Debug Action ---
export async function triggerManualBackup(): Promise<{ success: boolean; message: string }> {
  if (process.env.NODE_ENV !== 'development') {
    return { success: false, message: 'Permission denied.' }
  }

  const user = await getCurrentUser()
  if (!user?.isAdmin) {
    return { success: false, message: 'Permission denied.' }
  }

  log('info', 'Manual backup requested')
  try {
    // Import runBackup locally to avoid potential circular dependencies if moved
    const { runBackup } = await import('@/lib/backup')
    await runBackup()
    log('info', 'Manual backup completed')
    return { success: true, message: 'Backup process completed successfully.' }
  } catch (error) {
    log('error', 'Manual backup failed', error)
    return {
      success: false,
      message: `Backup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

async function loadData<T>(type: Exclude<DataType, 'auth'>): Promise<T> {
  if (usesPostgres()) {
    return withStorageTransaction(async () => {
      const stored = await readDocument<T>(type)
      if (stored === undefined) throw new Error(`Database ${type} data is not initialized; run the migration`)
      return { ...stored, revision: await getDocumentRevision(type) }
    }, { readOnly: true })
  }
  await ensureDataDir()
  const filePath = path.join(process.cwd(), 'data', `${type}.json`)

  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const initialData = getDefaultData<T>(type)
  try {
    await fs.writeFile(filePath, JSON.stringify(initialData, null, 2), { flag: 'wx', mode: 0o600 })
    return initialData
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  }
}

async function saveData<T>(type: Exclude<DataType, 'auth'>, data: T): Promise<void> {
  await requireUser()
  if (usesPostgres()) {
    const stored = { ...data } as T & { revision?: number }
    delete stored.revision
    return writeDocument(type, stored)
  }
  await ensureDataDir()
  const filePath = path.join(process.cwd(), 'data', `${type}.json`)
  const temporary = `${filePath}.${process.pid}.${uuid()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/**
 * Calculates the server's global freshness token based on all core data files.
 * This is an expensive operation as it reads all data files.
 */
async function calculateServerFreshnessToken(): Promise<string | null> {
  try {
    const settings = await loadSettings();
    const habits = await loadHabitsData();
    const coins = await loadCoinsData();
    const wishlist = await loadWishlistData();
    const users = await loadUsersPublicData();

    const dataString = prepareDataForHashing(
      settings,
      habits,
      coins,
      wishlist,
      users
    );
    const serverToken = await generateCryptoHash(dataString);
    return serverToken;
  } catch (error) {
    log('error', 'Error calculating server freshness token', error);
    throw error;
  }
}

// Wishlist specific functions
async function loadWishlistDataImpl(): Promise<WishlistData> {
  const user = await getCurrentDataUser()
  if (!user || (!user.email && process.env.DEMO !== 'true')) return getDefaultWishlistData()

  const data = await loadData<WishlistData>('wishlist')
  return {
    ...data,
    items: data.items.filter(x => familyItemVisible(x, user))
  }
}

async function familyAccess(actor: User, memberId?: string): Promise<{ manager: User; members: User[] }> {
  const authData = await readDataUsers()
  const manager = usesPostgres() && await getFamiliesEnabled() ? await getFamilyScopedUser(actor) : authData.users.find(account => account.id === actor.id)
  if (!manager || !manager.isAdmin && !manager.managedUserIds?.length && !await getFamiliesEnabled()) {
    throw new PermissionError('Family manager access required')
  }
  const allowed = authData.users.filter(account => manager.isAdmin || account.id === manager.id || manager.managedUserIds?.includes(account.id))
  if (memberId !== undefined && (typeof memberId !== 'string' || memberId.length > 128 || !allowed.some(account => account.id === memberId))) {
    throw new PermissionError('Family member access is not allowed')
  }
  return { manager, members: allowed }
}

async function loadFamilyOverviewImpl(): Promise<FamilyOverviewData> {
  const user = await requireUser()
  const { manager, members } = await familyAccess(user)
  const habits = await loadData<HabitsData>('habits')
  const wishlist = await loadData<WishlistData>('wishlist')
  const coins = await loadData<CoinsData>('coins')
  const settings = await loadSettings()
  const balances = new Map<string, number>()
  for (const member of members) balances.set(member.id, await walletBalance(coins, manager, member.id))
  const timezone = settings.system.timezone
  const today = getNow({ timezone }).startOf('day')
  return { timezone, weekStartDay: settings.system.weekStartDay, members: members.map(member => {
    const items = habits.habits.filter(item => item.userIds?.includes(member.id) && familyItemVisible(item, manager))
    const due = items.filter(item => !item.archived && item.schedule?.type !== 'anytime' && isHabitDue({ habit: item, date: today, timezone }))
    return {
      id: member.id, username: member.username, avatarPath: member.avatarPath,
      balance: balances.get(member.id) ?? 0,
      status: member.statusDays?.find(day => day.date === today.toISODate())?.status,
      dueToday: due.length,
      completedToday: due.filter(item => item.completions.filter((timestamp, index) =>
        isApprovedCompletion(item, index) && completionDay(timestamp, timezone) === today.toISODate()).length >= (item.targetCompletions ?? 1)).length,
      pendingApprovals: items.reduce((sum, item) => sum + (item.completionRecords?.filter(record =>
        record?.approval === 'pending' && !record.voided && (record.beneficiaryId ?? record.actorId) === member.id).length ?? 0), 0),
      habits: items,
      rewards: wishlist.items.filter(item => item.userIds?.includes(member.id) && familyItemVisible(item, manager)),
    }
  }) }
}

async function redeemFamilyRewardImpl(memberId: string, itemId: string, requestId: string): Promise<void> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    const { manager, members } = await familyAccess(user, memberId)
    if (!manager.isAdmin && memberId === manager.id &&
        (!checkPermission(manager.permissions, 'coins', 'interact') || !checkPermission(manager.permissions, 'wishlist', 'interact'))) {
      throw new PermissionError('Reward redemption permission required')
    }
    if (typeof itemId !== 'string' || !itemId || itemId.length > 200 || !z.string().uuid().safeParse(requestId).success) {
      throw new Error('Invalid family redemption')
    }
    const coins = await loadData<CoinsData>('coins')
    const prior = coins.transactions.find(transaction => transaction.requestId === requestId)
    if (prior) {
      if (prior.actorId !== user.id || prior.userId !== memberId || prior.relatedItemId !== itemId || prior.type !== 'WISH_REDEMPTION') {
        throw new PermissionError('Request ID is already used')
      }
      return
    }
    const wishlist = await loadData<WishlistData>('wishlist')
    const item = wishlist.items.find(candidate => candidate.id === itemId)
    if (!item || !item.userIds?.includes(memberId) || !familyItemEditable(item, manager) || item.archived ||
        item.targetCompletions !== undefined && item.targetCompletions < 1) throw new PermissionError('Reward is not available for this member')
    validateWishlistItem(item)
    const balance = await walletBalance(coins, manager, memberId)
    if (balance < item.coinCost) throw new PermissionError('Insufficient coins')
    const member = members.find(account => account.id === memberId)!
    const transaction: CoinTransaction = { id: uuid(), amount: -item.coinCost, type: 'WISH_REDEMPTION',
      description: `Redeemed reward for ${member.username}: ${item.name}`, timestamp: DateTime.now().toUTC().toISO()!,
      userId: memberId, actorId: user.id, relatedItemId: itemId, requestId }
    const updatedCoins = { balance: usesPostgres() && await getFamiliesEnabled() ? coins.balance - item.coinCost : Math.max(0, coins.balance - item.coinCost), transactions: [transaction, ...coins.transactions] }
    if (!Number.isFinite(updatedCoins.balance) || Math.abs(updatedCoins.balance) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid coin balance')
    const updatedWishlist = { items: wishlist.items.map(candidate => {
      if (candidate.id !== itemId || candidate.targetCompletions === undefined) return candidate
      const remaining = candidate.targetCompletions - 1
      return { ...candidate, targetCompletions: remaining || undefined, archived: remaining === 0 || candidate.archived }
    }) }
    await saveData('wishlist', updatedWishlist)
    try { await saveData('coins', updatedCoins) }
    catch (error) {
      if (!usesPostgres()) await saveData('wishlist', wishlist)
      throw error
    }
  })
}

export async function loadWishlistItems(): Promise<WishlistItemType[]> {
  const data = await loadWishlistData()
  return data.items
}

async function saveWishlistItemsImpl(data: WishlistData): Promise<WishlistData> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('wishlist', 'write')
    const existingData = await loadData<WishlistData>('wishlist')
    await assertDocumentRevision('wishlist', data?.revision, data?.familyId)
    if (!data || !Array.isArray(data.items)) throw new Error('Invalid reward list')
    if (usesPostgres() && await getFamiliesEnabled()) {
      const members = new Set((await readDataUsers()).users.map(account => account.id))
      if (data.items.some(item => item.userIds?.some(id => !members.has(id)))) throw new PermissionError('Reward assignees must belong to the selected family')
    }
    const items = mergeOwnedItems(data.items.map(validateWishlistItem), existingData.items, user, true, [], 'wishlist')
    await saveData('wishlist', { items })
    return loadWishlistData()
  })
}

// Habits specific functions
async function loadHabitsDataImpl(): Promise<HabitsData> {
  const user = await getCurrentDataUser()
  if (!user || (!user.email && process.env.DEMO !== 'true')) return getDefaultHabitsData()
  const data = await loadData<HabitsData>('habits')
  return {
    ...data,
    habits: data.habits.filter(x => familyItemVisible(x, user))
  }
}

async function loadReminderDataImpl(expectedFamilyId?: string): Promise<ReminderData | undefined> {
  if (expectedFamilyId !== undefined && (typeof expectedFamilyId !== 'string' || !expectedFamilyId || expectedFamilyId.length > 128)) {
    throw new Error('Invalid reminder family')
  }
  const user = await getCurrentDataUser()
  if (!user || (!user.email && process.env.DEMO !== 'true')) return undefined
  const data = await loadHabitsDataImpl()
  // Another tab can change the shared family cookie while this page still displays the old family.
  if (data.familyId !== expectedFamilyId) return undefined
  const settings = await loadSettingsImpl()
  return { userId: user.id, familyId: data.familyId, timezone: settings.system.timezone,
    habits: data.habits.filter(habit => habit.userIds?.includes(user.id) && habit.reminderTime &&
      !habit.archived && habit.schedule?.type !== 'anytime') }
}

async function saveHabitsDataImpl(data: HabitsData): Promise<HabitsData> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    const canWrite = !!(user.isAdmin || checkPermission(user.permissions, 'habit', 'write') || user.managedUserIds?.length)
    if (!canWrite) await verifyPermission('habit', 'interact')
    const existingData = await loadData<HabitsData>('habits')
    await assertDocumentRevision('habits', data?.revision, data?.familyId)
    if (!data || !Array.isArray(data.habits)) throw new Error('Invalid habit list')
    const previous = new Map(existingData.habits.map(habit => [habit.id, habit]))
    const validUserIds = new Set((await readDataUsers()).users.map(account => account.id))
    const submitted = data.habits.map(habit => {
      const stored = habit && typeof habit.id === 'string' ? previous.get(habit.id) : undefined
      if (
        (stored && !_.isEqual(habit.completions, stored.completions)) ||
        (!stored && Array.isArray(habit?.completions) && habit.completions.length > 0) ||
        (habit?.completionRecords !== undefined && !_.isEqual(habit.completionRecords, stored?.completionRecords)) ||
        (habit?.slips !== undefined && !_.isEqual(habit.slips, stored?.slips)) ||
        (stored && habit.isNegative !== stored.isNegative && (stored.completions.length > 0 || !!stored.slips?.length))
      ) {
        throw new PermissionError('Use the completion action to change habit history')
      }
      const scheduleTypeChanged = stored && (habit.schedule?.type ?? 'calendar') !== (stored.schedule?.type ?? 'calendar')
      if (scheduleTypeChanged && (stored.completions.length || stored.slips?.length)) {
        throw new PermissionError('Create a new item to change the schedule mode after recording history')
      }
      const recordingPolicyChanged = stored && habit.schedule?.type === 'anytime' &&
        (stored.schedule?.type !== 'anytime' || habit.schedule.recordingPolicy !== stored.schedule.recordingPolicy)
      if (recordingPolicyChanged && !user.isAdmin && stored.createdBy !== user.id) {
        throw new PermissionError('Only the creator may change recording permissions')
      }
      if (stored?.completionRecords?.some(record => record?.approval === 'pending') &&
          (!_.isEqual(habit.schedule, stored.schedule) || habit.frequency !== stored.frequency ||
           habit.taskRepeat !== stored.taskRepeat || (habit.taskRepeatInterval ?? 1) !== (stored.taskRepeatInterval ?? 1) ||
           habit.taskRepeatUntil !== stored.taskRepeatUntil || !_.isEqual(habit.userIds, stored.userIds))) {
        throw new PermissionError('Resolve pending approvals before changing schedules or assignees')
      }
      if (habit.userIds?.some(id => !validUserIds.has(id))) throw new Error('Unknown assigned member')
      const approvalChanged = stored && (
        habit.requiresApproval !== undefined && habit.requiresApproval !== stored.requiresApproval ||
        habit.approverIds !== undefined && !_.isEqual(habit.approverIds, stored.approverIds))
      if (approvalChanged && !user.isAdmin && stored.createdBy !== user.id) {
        throw new PermissionError('Only the creator may change approval settings')
      }
      if (approvalChanged && stored.completionRecords?.some(record => record?.approval === 'pending')) {
        throw new PermissionError('Resolve pending approvals before changing approvers')
      }
      const approverIds = habit.approverIds ?? stored?.approverIds
      if (approverIds?.some(id => !validUserIds.has(id))) throw new Error('Unknown approver')
      const { createdBy: _submittedCreator, ...editableHabit } = habit
      return stored ? {
        ...editableHabit,
        ...(stored.createdBy !== undefined && { createdBy: stored.createdBy }),
        ...(habit.requiresApproval === undefined && stored.requiresApproval !== undefined && { requiresApproval: stored.requiresApproval }),
        ...(habit.approverIds === undefined && stored.approverIds !== undefined && { approverIds: stored.approverIds }),
        ...(habit.pinned === undefined && stored.pinned !== undefined && { pinned: stored.pinned }),
        ...(habit.isTask === undefined && stored.isTask !== undefined && { isTask: stored.isTask }),
        ...(habit.archived === undefined && stored.archived !== undefined && { archived: stored.archived }),
        ...(habit.completionRecords === undefined && stored.completionRecords !== undefined && { completionRecords: stored.completionRecords }),
        ...(habit.slips === undefined && stored.slips !== undefined && { slips: stored.slips }),
      } : { ...editableHabit, createdBy: user.id }
    })
    const habits = mergeOwnedItems(
      submitted.map(habit => validateHabit(habit, previous.get(habit.id)?.frequency)),
      existingData.habits, user, canWrite, ['completions', 'archived'], 'habit')
    if (!user.isAdmin) {
      for (const habit of habits) {
        const stored = previous.get(habit.id)
        if (!stored?.archived) continue
        const unchanged = _.isEqual(habit.completions, stored.completions)
        const undoLast = habit.completions.length === stored.completions.length - 1 &&
          _.isEqual(habit.completions, stored.completions.slice(0, -1))
        if (!unchanged && !undoLast) throw new PermissionError('Cannot complete an archived habit')
      }
    }
    if (!canWrite) validateHabitInteractionChanges(habits, existingData.habits, user.id)
    await saveData('habits', { habits })
    const retainedIds = new Set(habits.map(habit => habit.id))
    for (const removed of existingData.habits.filter(habit => !retainedIds.has(habit.id))) {
      for (const record of removed.completionRecords ?? []) {
        if (!record?.evidenceId || !record.evidenceMime) continue
        try { await scheduleHabitEvidenceRemoval(removed.id, record.evidenceId, record.id, `evidence/${path.basename(evidencePath(record.evidenceId, record.evidenceMime))}`) }
        catch (error) { log('error', 'Could not remove deleted evidence', error) }
      }
    }
    return loadHabitsData()
  })
}

async function reorderHabitItemsImpl(orderedIds: string[], isTask: boolean): Promise<HabitsData> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('habit', 'write')
    if (!user.isAdmin && !checkPermission(user.permissions, 'habit', 'write')) {
      throw new PermissionError('Manual ordering requires habit write permission')
    }
    if (!Array.isArray(orderedIds) || orderedIds.length > 10_000 ||
        orderedIds.some(id => typeof id !== 'string' || !id || id.length > 128) ||
        new Set(orderedIds).size !== orderedIds.length || typeof isTask !== 'boolean') {
      throw new Error('Invalid habit order')
    }
    const existing = await loadData<HabitsData>('habits')
    const movable = existing.habits.filter(habit => !habit.archived && Boolean(habit.isTask) === isTask &&
      familyItemEditable(habit, user))
    const selected = new Set(orderedIds)
    if (movable.length !== orderedIds.length || movable.some(habit => !selected.has(habit.id))) {
      throw new PermissionError('Habit order is out of date or includes an inaccessible item')
    }
    const positions = new Map(orderedIds.map((id, index) => [id, index]))
    const habits = existing.habits.map(habit => positions.has(habit.id)
      ? { ...habit, position: positions.get(habit.id)! } : habit)
    await saveData('habits', { habits })
    return loadHabitsData()
  })
}

async function toggleTaskChecklistItemImpl(habitId: string, itemId: string, completed: boolean): Promise<Habit> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('habit', 'interact')
    if (typeof habitId !== 'string' || habitId.length > 200 || typeof itemId !== 'string' ||
        itemId.length > 128 || typeof completed !== 'boolean') throw new Error('Invalid checklist update')
    const data = await loadData<HabitsData>('habits')
    const habit = data.habits.find(item => item.id === habitId)
    if (!habit?.isTask || habit.archived || !habit.checklist?.some(item => item.id === itemId) ||
        !user.isAdmin && !habit.userIds?.includes(user.id)) {
      throw new PermissionError('Task checklist interaction is not allowed')
    }
    validateHabit(habit, habit.frequency)
    const updated = { ...habit, checklist: habit.checklist.map(item =>
      item.id === itemId ? { ...item, completed } : item) }
    await saveData('habits', { habits: data.habits.map(item => item.id === habitId ? updated : item) })
    return updated
  })
}

function completionDay(timestamp: string, timezone: string): string {
  return DateTime.fromISO(timestamp, { setZone: true }).setZone(timezone).toISODate() ?? ''
}

function checkedCompletionTimestamp(timestamp: unknown): string {
  if (typeof timestamp !== 'string' || timestamp.length > 64) throw new Error('Invalid completion time')
  const date = DateTime.fromISO(timestamp, { setZone: true })
  const time = date.toMillis()
  if (!date.isValid || time < Date.now() - 365 * 24 * 60 * 60 * 1000 || time > Date.now() + 5 * 60 * 1000) {
    throw new PermissionError('Completion date is outside the allowed range')
  }
  return timestamp
}

const evidenceExtensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

function evidencePath(id: string, mime: keyof typeof evidenceExtensions): string {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Object.prototype.hasOwnProperty.call(evidenceExtensions, mime)) {
    throw new Error('Invalid evidence path')
  }
  return path.join(process.cwd(), 'data', 'evidence', `${id}.${evidenceExtensions[mime]}`)
}

async function checkedEvidence(formData: FormData | undefined): Promise<{
  bytes: Buffer
  mime: keyof typeof evidenceExtensions
} | null> {
  if (formData === undefined) return null
  if (!(formData instanceof FormData)) throw new Error('Invalid evidence upload')
  const file = formData.get('evidence')
  if (file === null) return null
  if (!(file instanceof File) || file.size < 1 || file.size > 2_000_000 ||
      !(file.type in evidenceExtensions)) throw new Error('Invalid evidence image')
  const mime = file.type as keyof typeof evidenceExtensions
  const bytes = Buffer.from(await file.arrayBuffer())
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error' })
    const metadata = await image.metadata()
    const expected = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/png' ? 'png' : 'webp'
    if (metadata.format !== expected) throw new Error('Image format mismatch')
    const normalized = await image.rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 }).toBuffer()
    if (normalized.length > 2_000_000) throw new Error('Image too large')
    return { bytes: normalized, mime: 'image/webp' }
  } catch {
    throw new Error('Invalid evidence image')
  }
}

async function saveCompletionAndRewards(
  beforeHabits: HabitsData,
  afterHabits: HabitsData,
  beforeCoins: CoinsData,
  afterCoins: CoinsData,
): Promise<void> {
  if (usesPostgres()) {
    await saveData('habits', afterHabits)
    if (afterCoins !== beforeCoins) await saveData('coins', afterCoins)
    return
  }
  await saveData('habits', afterHabits)
  if (afterCoins === beforeCoins) return
  try {
    await saveData('coins', afterCoins)
  } catch (error) {
    try { await saveData('habits', beforeHabits) } catch (rollbackError) {
      log('error', 'Could not restore habits after a coin write failure', rollbackError)
    }
    throw error
  }
}

async function recordHabitCompletionImpl(habitId: string, timestamp: string, evidence?: FormData,
  options?: { beneficiaryId?: string; requestId?: string }): Promise<{
  habit: Habit
  coins: CoinsData
  rewarded: boolean
  rewardAmount: number
  pending: boolean
  targetReached: boolean
  completionIndex: number
  completionTimestamp: string
}> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    const request = z.object({ beneficiaryId: z.string().min(1).max(128).optional(),
      requestId: z.string().uuid().optional() }).strict().parse(options ?? {})
    if (typeof habitId !== 'string' || habitId.length > 200) throw new Error('Invalid habit ID')
    checkedCompletionTimestamp(timestamp)
    const habits = await loadData<HabitsData>('habits')
    const habit = habits.habits.find(item => item.id === habitId)
    if (!habit) throw new PermissionError('Habit interaction is not allowed')
    validateHabit(habit, habit.frequency)
    const anytime = habit.schedule?.type === 'anytime'
    let beneficiaryId = user.id
    if (anytime && habit.schedule?.type === 'anytime') {
      beneficiaryId = habit.userIds![0]
      if (!request.requestId || request.beneficiaryId && request.beneficiaryId !== beneficiaryId) {
        throw new PermissionError('Invalid any-time completion recipient')
      }
      const actor = usesPostgres() && await getFamiliesEnabled()
        ? user : (await readAuthData()).users.find(account => account.id === user.id)
      const isManager = !!actor && (actor.isAdmin || actor.managedUserIds?.includes(beneficiaryId))
      const isMember = user.id === beneficiaryId && (user.isAdmin || checkPermission(user.permissions, 'habit', 'interact'))
      const policy = habit.schedule.recordingPolicy
      if (!(policy !== 'manager' && isMember || policy !== 'member' && isManager)) {
        throw new PermissionError('Recording this action is not allowed')
      }
      const priorIndex = habit.completionRecords?.findIndex(record => record?.requestId === request.requestId) ?? -1
      if (priorIndex >= 0) {
        const prior = habit.completionRecords![priorIndex]!
        if (prior.actorId !== user.id || prior.beneficiaryId !== beneficiaryId) throw new PermissionError('Request ID is already used')
        return { habit, coins: await visibleCoinsData(await loadData<CoinsData>('coins'), user), rewarded: false,
          rewardAmount: 0, pending: prior.approval === 'pending' && !prior.voided, targetReached: !prior.voided && prior.approval !== 'rejected',
          completionIndex: priorIndex, completionTimestamp: habit.completions[priorIndex] }
      }
    } else {
      await verifyPermission('habit', 'interact')
      if (!habit.userIds?.includes(user.id) && !user.isAdmin || request.beneficiaryId && request.beneficiaryId !== user.id) {
        throw new PermissionError('Habit interaction is not allowed')
      }
    }
    if (habit.isNegative && habit.userIds?.[0] !== user.id) throw new PermissionError('Only the assigned user can record avoidance')
    const photo = await checkedEvidence(evidence)
    if (photo && !habit.requiresApproval) throw new Error('Evidence is only accepted for approval submissions')
    if (habit.archived) throw new PermissionError('Cannot complete an archived habit')
    if (habit.completions.length >= 20_000) throw new Error('Habit completion limit reached')

    const timezone = (await loadSettings()).system.timezone
    const day = completionDay(timestamp, timezone)
    if (habit.isNegative && habit.slips?.some(slip => completionDay(slip.timestamp, timezone) === day)) {
      throw new PermissionError('A slip is already recorded for this day')
    }
    if (habit.schedule?.type === 'afterCompletion') {
      const completionDate = DateTime.fromISO(timestamp, { setZone: true }).setZone(timezone)
      const due = getNextAfterCompletionDate(habit, timezone, completionDate.endOf('day'))
      if (habit.completions.some((value, index) => isApprovedCompletion(habit, index) &&
          completionDay(value, timezone) > day)) throw new PermissionError('Record cycles in date order')
      if (!due || DateTime.fromISO(timestamp, { setZone: true }).setZone(timezone).startOf('day') < due) {
        throw new PermissionError('Item is not due yet')
      }
      if (habit.completionRecords?.some((record, index) => record?.approval === 'pending' && !record.voided &&
          completionDay(habit.completions[index], timezone) !== day)) {
        throw new PermissionError('Resolve the pending cycle before recording another date')
      }
    }
    if (habit.taskRepeat && !isTaskScheduledOnDate(habit, DateTime.fromISO(timestamp, { setZone: true }), timezone)) {
      throw new PermissionError('Task is not scheduled for this day')
    }
    if (habit.taskGoalOccurrences && getTaskProgress(habit, timezone) >= habit.taskGoalOccurrences) {
      throw new PermissionError('Task goal is already complete')
    }
    const count = habit.completions.filter((value, index) =>
      isCountedCompletion(habit, index) && completionDay(value, timezone) === day).length
    const target = habit.targetCompletions ?? 1
    if (!anytime && count >= target) throw new PermissionError('Habit is already completed for this day')

    if (!(await readDataUsers()).users.some(account => account.id === beneficiaryId)) {
      throw new Error('Invalid completing account')
    }
    const recipients = [beneficiaryId]
    const targetReached = anytime || count + 1 === target
    const history = habit.completionRecords ?? habit.completions.map(() => null)
    const alreadyRewarded = !anytime && habit.completions.some((value, index) =>
      isCountedCompletion(habit, index) &&
      completionDay(value, timezone) === day &&
      (history[index] === null || history[index]?.rewardedUserIds !== undefined))
    const pending = !!habit.requiresApproval
    const rewarded = targetReached && !alreadyRewarded && !pending
    const completionTime = DateTime.fromISO(timestamp, { setZone: true })
    const now = DateTime.now()
    const boost = habit.coinBoost
    const rewardAmount = boost && now >= DateTime.fromISO(boost.startsAt) && now <= DateTime.fromISO(boost.until) &&
      completionTime >= DateTime.fromISO(boost.startsAt) ? habit.coinReward * boost.multiplier : habit.coinReward
    const autoArchived = !pending && !!habit.isTask && targetReached &&
      (!habit.taskRepeat && habit.schedule?.type !== 'afterCompletion' || !!habit.taskGoalOccurrences && getTaskProgress(habit, timezone) + 1 >= habit.taskGoalOccurrences)
    const record: HabitCompletionRecord = {
      id: uuid(), actorId: user.id,
      ...(anytime && { beneficiaryId, requestId: request.requestId }),
      ...(rewarded && { rewardedUserIds: recipients }),
      ...(rewarded && { rewardTarget: target }),
      ...((targetReached || pending) && { rewardAmount }),
      ...(pending && { approval: 'pending' as const }),
      ...(photo && { evidenceMime: photo.mime }),
      ...(autoArchived && { autoArchived: true }),
    }
    if (photo) record.evidenceId = record.id
    const updatedHabit: Habit = {
      ...habit,
      completions: [...habit.completions, timestamp],
      completionRecords: [...(habit.completionRecords ?? habit.completions.map(() => null)), record],
      checklist: (habit.taskRepeat || habit.schedule?.type === 'afterCompletion') && targetReached && !pending ? habit.checklist?.map(item => ({ ...item, completed: false })) : habit.checklist,
      archived: autoArchived ? true : habit.archived,
    }
    const coins = await loadData<CoinsData>('coins')
    const transactionType: TransactionType = habit.isTask ? 'TASK_COMPLETION' : 'HABIT_COMPLETION'
    const transactions: CoinTransaction[] = rewarded && rewardAmount > 0
      ? recipients.map(recipientId => ({
          id: uuid(), userId: recipientId, actorId: user.id, completionId: record.id,
          amount: rewardAmount, type: transactionType, relatedItemId: habit.id,
          description: `Completed: ${habit.name}`, timestamp: d2t({ dateTime: getNow({}) }),
        })) : []
    const updatedCoins = transactions.length ? {
      balance: coins.balance + rewardAmount * transactions.length,
      transactions: [...transactions, ...coins.transactions],
    } : coins
    if (!Number.isFinite(updatedCoins.balance) || Math.abs(updatedCoins.balance) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid coin balance')
    if (photo) {
      await fs.mkdir(path.join(process.cwd(), 'data', 'evidence'), { recursive: true, mode: 0o700 })
      await fs.writeFile(evidencePath(record.id, photo.mime), photo.bytes, { flag: 'wx', mode: 0o600 })
    }
    try {
      if (photo) await registerAttachment({ id: record.id, habit_id: habit.id, completion_id: record.id,
        owner_id: record.beneficiaryId ?? record.actorId, path: `evidence/${path.basename(evidencePath(record.id, photo.mime))}`,
        mime_type: photo.mime, bytes: photo.bytes })
      await saveCompletionAndRewards(habits, {
        ...habits, habits: habits.habits.map(item => item.id === habit.id ? updatedHabit : item),
      }, coins, updatedCoins)
    } catch (error) {
      if (photo) await fs.rm(evidencePath(record.id, photo.mime), { force: true })
      throw error
    }
    return {
      habit: updatedHabit, coins: await visibleCoinsData(updatedCoins, user), rewarded,
      rewardAmount: rewarded ? rewardAmount : 0, pending, targetReached,
      completionIndex: updatedHabit.completions.length - 1, completionTimestamp: timestamp,
    }
  })
}

async function recordHabitSlipImpl(habitId: string, timestamp: string): Promise<{ habit: Habit; coins: CoinsData; penalty: number }> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('habit', 'interact')
    if (typeof habitId !== 'string' || habitId.length > 200) throw new Error('Invalid habit ID')
    checkedCompletionTimestamp(timestamp)
    const habits = await loadData<HabitsData>('habits')
    const habit = habits.habits.find(item => item.id === habitId)
    if (!habit?.isNegative || habit.archived || habit.userIds?.[0] !== user.id) {
      throw new PermissionError('Slip recording is not allowed')
    }
    validateHabit(habit, habit.frequency)
    if ((habit.slips?.length ?? 0) >= 20_000) throw new Error('Slip limit reached')
    const timezone = (await loadSettings()).system.timezone
    const day = completionDay(timestamp, timezone)
    if (habit.slips?.some(slip => completionDay(slip.timestamp, timezone) === day) ||
        habit.completions.some((value, index) => isCountedCompletion(habit, index) && completionDay(value, timezone) === day)) {
      throw new PermissionError('This day is already recorded')
    }
    const coins = await loadData<CoinsData>('coins')
    const balance = coins.transactions.filter(transaction => transaction.userId === user.id)
      .reduce((total, transaction) => total + transaction.amount, 0)
    const penalty = Math.min(habit.coinPenalty ?? 0, Math.max(0, balance))
    const slip = { id: uuid(), actorId: user.id, timestamp, penaltyAmount: penalty }
    const updatedHabit = { ...habit, slips: [...(habit.slips ?? []), slip] }
    const updatedCoins = penalty ? {
      balance: Math.max(0, coins.balance - penalty),
      transactions: [{ id: uuid(), userId: user.id, actorId: user.id, completionId: slip.id,
        amount: -penalty, type: 'HABIT_SLIP' as const, relatedItemId: habit.id,
        description: `Slip: ${habit.name}`, timestamp: d2t({ dateTime: getNow({}) }) }, ...coins.transactions],
    } : coins
    await saveCompletionAndRewards(habits, { habits: habits.habits.map(item => item.id === habit.id ? updatedHabit : item) }, coins, updatedCoins)
    return { habit: updatedHabit, coins: await visibleCoinsData(updatedCoins, user), penalty }
  })
}

async function undoHabitSlipImpl(habitId: string, slipId: string): Promise<{ habit: Habit; coins: CoinsData }> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('habit', 'interact')
    if (typeof habitId !== 'string' || habitId.length > 200 || !/^[0-9a-f-]{36}$/i.test(slipId)) {
      throw new Error('Invalid slip')
    }
    const habits = await loadData<HabitsData>('habits')
    const habit = habits.habits.find(item => item.id === habitId)
    const slip = habit?.slips?.find(candidate => candidate.id === slipId)
    if (!habit?.isNegative || !slip || slip.actorId !== user.id || habit.userIds?.[0] !== user.id) {
      throw new PermissionError('Slip undo is not allowed')
    }
    const updatedHabit = { ...habit, slips: habit.slips!.filter(candidate => candidate.id !== slipId) }
    const coins = await loadData<CoinsData>('coins')
    const debit = coins.transactions.find(transaction => transaction.completionId === slipId && transaction.type === 'HABIT_SLIP')
    const refund = debit ? -debit.amount : 0
    if (refund !== slip.penaltyAmount) throw new Error('Slip transaction is inconsistent')
    const updatedCoins = refund ? {
      balance: coins.balance + refund,
      transactions: [{ id: uuid(), userId: user.id, actorId: user.id, completionId: slip.id,
        amount: refund, type: 'HABIT_SLIP_UNDO' as const, relatedItemId: habit.id,
        description: `Undid slip: ${habit.name}`, timestamp: d2t({ dateTime: getNow({}) }) }, ...coins.transactions],
    } : coins
    await saveCompletionAndRewards(habits, { habits: habits.habits.map(item => item.id === habit.id ? updatedHabit : item) }, coins, updatedCoins)
    return { habit: updatedHabit, coins: await visibleCoinsData(updatedCoins, user) }
  })
}

async function undoHabitCompletionImpl(habitId: string, completionIndex: number, expectedTimestamp: string): Promise<{
  habit: Habit
  coins: CoinsData
  rewardReversed: boolean
}> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    if (typeof habitId !== 'string' || habitId.length > 200 || !Number.isSafeInteger(completionIndex) ||
        completionIndex < 0 || typeof expectedTimestamp !== 'string' || expectedTimestamp.length > 64) {
      throw new Error('Invalid completion')
    }
    const habits = await loadData<HabitsData>('habits')
    const habit = habits.habits.find(item => item.id === habitId)
    if (!habit) throw new PermissionError('Habit interaction is not allowed')
    const anytime = habit.schedule?.type === 'anytime'
    const potentialRecord = habit.completionRecords?.[completionIndex]
    if (anytime) {
      const actor = usesPostgres() && await getFamiliesEnabled()
        ? user : (await readAuthData()).users.find(account => account.id === user.id)
      const inScope = !!actor && (actor.isAdmin || habit.userIds?.includes(actor.id) && checkPermission(actor.permissions, 'habit', 'interact') ||
        habit.userIds?.length === 1 && actor.managedUserIds?.includes(habit.userIds[0]))
      if (!inScope) throw new PermissionError('Habit interaction is not allowed')
      if (potentialRecord?.actorId !== user.id && !user.isAdmin) throw new PermissionError('Only the person who recorded a completion may undo it')
    } else {
      await verifyPermission('habit', 'interact')
      if (!habit.userIds?.includes(user.id) && !user.isAdmin) throw new PermissionError('Habit interaction is not allowed')
    }
    validateHabit(habit, habit.frequency)
    if (habit.completions[completionIndex] !== expectedTimestamp) throw new PermissionError('Completion has changed')
    checkedCompletionTimestamp(expectedTimestamp)
    const record = habit.completionRecords?.[completionIndex] ?? null
    if (record?.voided) throw new PermissionError('Completion was already undone')
    if (record?.approval === 'rejected') throw new PermissionError('Completion was rejected')
    if (!user.isAdmin && (record ? record.actorId !== user.id : habit.userIds?.length !== 1 || habit.userIds[0] !== user.id)) {
      throw new PermissionError('Only the person who recorded a completion may undo it')
    }
    const timezone = (await loadSettings()).system.timezone
    const day = completionDay(expectedTimestamp, timezone)
    const latestForDay = habit.completions.findLastIndex((value, index) =>
      isCountedCompletion(habit, index) && completionDay(value, timezone) === day)
    if (!anytime && completionIndex !== latestForDay) throw new PermissionError('Undo the latest completion for this day first')
    if (habit.schedule?.type === 'afterCompletion' && habit.completions.some((value, index) =>
        isCountedCompletion(habit, index) && completionDay(value, timezone) > day)) {
      throw new PermissionError('Undo later cycles before changing this completion')
    }
    const beforeCount = habit.completions.filter((value, index) =>
      isCountedCompletion(habit, index) && completionDay(value, timezone) === day).length
    const target = habit.targetCompletions ?? 1
    const completionRecords = habit.completionRecords ?? habit.completions.map(() => null)
    const updatedHabit: Habit = {
      ...habit,
      completions: anytime ? habit.completions : habit.completions.filter((_, index) => index !== completionIndex),
      completionRecords: anytime ? completionRecords.map((value, index) => {
        if (index !== completionIndex || !value) return value
        const { evidenceId: _evidenceId, evidenceMime: _evidenceMime, ...rest } = value
        return { ...rest, voided: true }
      }) : completionRecords.filter((_, index) => index !== completionIndex),
      archived: habit.isTask && (record?.autoArchived || !record && beforeCount === target) ? false : habit.archived,
    }
    const approvedBefore = habit.completions.filter((value, index) =>
      completionDay(value, timezone) === day && isApprovedCompletion(habit, index)).length
    const approvedAfter = updatedHabit.completions.filter((value, index) =>
      completionDay(value, timezone) === day && isApprovedCompletion(updatedHabit, index)).length
    let rewardedRecord = record
    if (!anytime && !record?.rewardedUserIds && approvedBefore >= target && approvedAfter < target) {
      rewardedRecord = completionRecords.find((candidate, index) =>
        index !== completionIndex && completionDay(habit.completions[index], timezone) === day &&
        candidate?.rewardTarget === target && candidate.rewardedUserIds?.length) ?? null
      if (rewardedRecord) {
        const rewardId = rewardedRecord.id
        updatedHabit.completionRecords = updatedHabit.completionRecords?.map(candidate => {
          if (candidate?.id !== rewardId) return candidate
          const { rewardedUserIds: _recipients, rewardTarget: _rewardTarget,
            autoArchived: _autoArchived, ...rest } = candidate
          return rest
        })
        if (habit.isTask && rewardedRecord.autoArchived) updatedHabit.archived = false
      }
    }
    const coins = await loadData<CoinsData>('coins')
    const transactions: CoinTransaction[] = []
    if (rewardedRecord?.rewardedUserIds) {
      const eventLedger = usesPostgres() && await getFamiliesEnabled()
        ? await readCompletionLedger(habit.id, rewardedRecord.id) : coins.transactions
      for (const recipientId of rewardedRecord.rewardedUserIds) {
        const award = eventLedger.find(tx => tx.completionId === rewardedRecord.id && tx.userId === recipientId &&
          (tx.type === 'HABIT_COMPLETION' || tx.type === 'TASK_COMPLETION') && tx.amount > 0)
        const alreadyReversed = eventLedger.some(tx => tx.completionId === rewardedRecord.id && tx.userId === recipientId &&
          (tx.type === 'HABIT_UNDO' || tx.type === 'TASK_UNDO'))
        if (!award || alreadyReversed) continue
        transactions.push({
          id: uuid(), userId: recipientId, actorId: user.id, completionId: rewardedRecord.id,
          amount: -award.amount, type: award.type === 'TASK_COMPLETION' ? 'TASK_UNDO' : 'HABIT_UNDO',
          relatedItemId: habit.id, description: `Undid completion: ${habit.name}`,
          timestamp: d2t({ dateTime: getNow({}) }),
        })
      }
    } else if (beforeCount === target && !record && habit.userIds?.length === 1) {
      const recipientId = habit.userIds[0]
      const creditType: TransactionType = habit.isTask ? 'TASK_COMPLETION' : 'HABIT_COMPLETION'
      const undoType: TransactionType = habit.isTask ? 'TASK_UNDO' : 'HABIT_UNDO'
      const openAwards: CoinTransaction[] = []
      const legacyLedger = usesPostgres() && await getFamiliesEnabled()
        ? await readCompletionLedger(habit.id, undefined, recipientId) : coins.transactions
      for (const transaction of [...legacyLedger].reverse()) {
        if (transaction.userId !== recipientId || transaction.relatedItemId !== habit.id) continue
        if (transaction.type === creditType) openAwards.push(transaction)
        if (transaction.type === undoType) openAwards.pop()
      }
      const counts = new Map<string, number>()
      for (const value of updatedHabit.completions) {
        const key = completionDay(value, timezone)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const eligibleAfter = [...counts.values()].filter(count => count >= target).length
      const award = openAwards.at(-1)
      if (openAwards.length > eligibleAfter && award) {
        transactions.push({
          id: uuid(), userId: recipientId, actorId: user.id, amount: -award.amount,
          type: undoType, relatedItemId: habit.id, description: `Undid completion: ${habit.name}`,
          timestamp: d2t({ dateTime: getNow({}) }),
        })
      }
    }
    const updatedCoins = transactions.length ? {
      balance: coins.balance + transactions.reduce((total, transaction) => total + transaction.amount, 0),
      transactions: [...transactions, ...coins.transactions],
    } : coins
    if (!Number.isFinite(updatedCoins.balance) || Math.abs(updatedCoins.balance) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid coin balance')
    await saveCompletionAndRewards(habits, {
      ...habits, habits: habits.habits.map(item => item.id === habit.id ? updatedHabit : item),
    }, coins, updatedCoins)
    if (record?.evidenceId && record.evidenceMime) {
      try { await scheduleHabitEvidenceRemoval(habit.id, record.evidenceId, record.id, `evidence/${path.basename(evidencePath(record.evidenceId, record.evidenceMime))}`) }
      catch (error) { log('error', 'Could not remove withdrawn evidence', error) }
    }
    return { habit: updatedHabit, coins: await visibleCoinsData(updatedCoins, user), rewardReversed: transactions.length > 0 }
  })
}

async function loadPendingApprovalsImpl(): Promise<PendingApproval[]> {
  const user = await requireUser()
  const data = await loadData<HabitsData>('habits')
  const pending: PendingApproval[] = []
  for (const habit of data.habits) {
    if (!habit.approverIds?.includes(user.id)) continue
    habit.completionRecords?.forEach((record, index) => {
      if (record?.approval !== 'pending' || record.voided) return
      pending.push({
        habitId: habit.id, habitName: habit.name, isTask: !!habit.isTask,
        completionId: record.id, actorId: record.actorId, beneficiaryId: record.beneficiaryId,
        submittedAt: habit.completions[index], evidenceId: record.evidenceId,
      })
    })
  }
  return pending.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 100)
}

async function reviewHabitCompletionImpl(
  habitId: string,
  completionId: string,
  decision: 'approve' | 'reject',
): Promise<{ habit: Habit | null; coins: CoinsData; approved: boolean }> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    if (typeof habitId !== 'string' || habitId.length > 200 ||
        typeof completionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(completionId) ||
        !['approve', 'reject'].includes(decision)) throw new Error('Invalid review')
    const data = await loadData<HabitsData>('habits')
    const habit = data.habits.find(item => item.id === habitId)
    if (!habit?.approverIds?.includes(user.id)) throw new PermissionError('Approval is not allowed')
    validateHabit(habit, habit.frequency)
    const index = habit.completionRecords?.findIndex(record => record?.id === completionId) ?? -1
    const record = index >= 0 ? habit.completionRecords?.[index] : null
    if (!record || record.voided || record.approval !== 'pending') throw new PermissionError('Completion is no longer pending')
    const accountExists = (await readDataUsers()).users.some(account => account.id === (record.beneficiaryId ?? record.actorId))
    if (!accountExists && decision === 'approve') throw new PermissionError('Completing account no longer exists')
    const timezone = (await loadSettings()).system.timezone
    const day = completionDay(habit.completions[index], timezone)
    const beforeRecords = habit.completionRecords ?? []
    const reviewedRecord: HabitCompletionRecord = {
      ...record, approval: decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: user.id, reviewedAt: DateTime.now().toUTC().toISO()!,
    }
    const afterRecords = beforeRecords.map((value, position) => position === index ? reviewedRecord : value)
    const reviewedHabit: Habit = { ...habit, completionRecords: afterRecords }
    const approvedCount = habit.completions.filter((value, position) =>
      completionDay(value, timezone) === day && isApprovedCompletion(reviewedHabit, position)).length
    const previouslyRewarded = habit.completions.some((value, position) =>
      position !== index && completionDay(value, timezone) === day &&
      (beforeRecords[position] === null || !!beforeRecords[position]?.rewardedUserIds?.length))
    const award = decision === 'approve' && (habit.schedule?.type === 'anytime' ||
      approvedCount >= (habit.targetCompletions ?? 1) && !previouslyRewarded)
    const amount = award ? reviewedRecord.rewardAmount ?? habit.coinReward : 0
    if (award) {
      reviewedRecord.rewardedUserIds = [record.beneficiaryId ?? record.actorId]
      reviewedRecord.rewardTarget = habit.targetCompletions ?? 1
    }
    const autoArchived = award && !!habit.isTask &&
      (!habit.taskRepeat && habit.schedule?.type !== 'afterCompletion' || !!habit.taskGoalOccurrences && getTaskProgress(reviewedHabit, timezone) >= habit.taskGoalOccurrences)
    if (autoArchived) reviewedRecord.autoArchived = true
    const updatedHabit: Habit = {
      ...reviewedHabit,
      archived: autoArchived ? true : habit.archived,
      checklist: award && (habit.taskRepeat || habit.schedule?.type === 'afterCompletion') ? habit.checklist?.map(item => ({ ...item, completed: false })) : habit.checklist,
    }
    const coins = await loadData<CoinsData>('coins')
    const transaction: CoinTransaction | null = award && amount > 0 ? {
      id: uuid(), userId: record.beneficiaryId ?? record.actorId, actorId: record.actorId, completionId: record.id,
      amount, type: habit.isTask ? 'TASK_COMPLETION' : 'HABIT_COMPLETION',
      relatedItemId: habit.id, description: `Completed: ${habit.name}`,
      timestamp: DateTime.now().toUTC().toISO()!,
    } : null
    const updatedCoins = transaction ? {
      balance: coins.balance + amount, transactions: [transaction, ...coins.transactions],
    } : coins
    if (!Number.isFinite(updatedCoins.balance) || Math.abs(updatedCoins.balance) > Number.MAX_SAFE_INTEGER) throw new Error('Invalid coin balance')
    await saveCompletionAndRewards(data, {
      ...data, habits: data.habits.map(item => item.id === habit.id ? updatedHabit : item),
    }, coins, updatedCoins)
    return {
      habit: user.isAdmin || updatedHabit.userIds?.includes(user.id) ? updatedHabit : null,
      coins: await visibleCoinsData(updatedCoins, user),
      approved: decision === 'approve',
    }
  })
}


// Coins specific functions
async function loadCoinsDataImpl(): Promise<CoinsData> {
  try {
    const read = async () => {
      const user = await getCurrentUser()
      if (!user || (!user.email && process.env.DEMO !== 'true')) return getDefaultCoinsData()
      const data = await loadData<CoinsData>('coins')
      return visibleCoinsData(data, user)
    }
    return await (usesPostgres() ? withStorageTransaction(read, { readOnly: true }) : read())
  } catch (error) {
    if (usesPostgres()) throw error
    return getDefaultCoinsData()
  }
}

async function visibleCoinsData(data: CoinsData, user: User): Promise<CoinsData> {
  const revision = usesPostgres() ? await getDocumentRevision('coins') : data.revision
  if (user.isAdmin && !(usesPostgres() && await getFamiliesEnabled())) return { ...data, revision }
  const transactions = data.transactions.filter(transaction => transaction.userId === user.id)
  return { balance: await walletBalance(data, user), transactions, revision }
}

function validateHabitInteractionChanges(submitted: HabitsData['habits'], existing: HabitsData['habits'], userId: string): void {
  const original = new Map(existing.map(habit => [habit.id, habit]))
  let changes = 0
  for (const habit of submitted.filter(item => item.userIds?.includes(userId))) {
    const previous = original.get(habit.id)!
    if (_.isEqual(habit.completions, previous.completions) && habit.archived === previous.archived) continue
    changes++
    const before = previous.completions
    const after = habit.completions
    const appended = after.length === before.length + 1 && _.isEqual(after.slice(0, -1), before)
    const removed = after.length === before.length - 1 && _.isEqual(after, before.slice(0, -1))
    if (!appended && !removed) throw new PermissionError('Only one completion can be changed at a time')
    const changed = appended ? after.at(-1)! : before.at(-1)!
    const changedAt = DateTime.fromISO(changed).toMillis()
    if (changedAt < Date.now() - 365 * 24 * 60 * 60 * 1000 || changedAt > Date.now() + 5 * 60 * 1000) {
      throw new PermissionError('Completion date is outside the allowed range')
    }
    if (habit.archived !== previous.archived &&
        (!habit.isTask || habit.archived !== appended ||
          (appended && after.length < (habit.targetCompletions ?? 1)))) {
      throw new PermissionError('Only a completed task may change archive state')
    }
  }
  if (changes > 1) throw new PermissionError('Only one habit can be changed at a time')
}

async function saveCoinsDataImpl(data: CoinsData): Promise<CoinsData> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('coins', 'write')
    const existingData = await loadData<CoinsData>('coins')
    await assertDocumentRevision('coins', data?.revision)
    const familyMode = usesPostgres() && await getFamiliesEnabled()
    const visible = existingData.transactions.filter(transaction => (!familyMode && user.isAdmin) || transaction.userId === user.id)
    if (!Array.isArray(data.transactions) || data.transactions.length !== visible.length) {
      throw new PermissionError('Only transaction notes may be changed')
    }
    const submittedById = new Map(data.transactions.map(transaction => [transaction.id, transaction]))
    if (submittedById.size !== visible.length || visible.some(transaction => {
      const submitted = submittedById.get(transaction.id)
      if (!submitted || !_.isEqual({ ...submitted, note: undefined }, { ...transaction, note: undefined })) return true
      return submitted.note !== undefined && (typeof submitted.note !== 'string' || submitted.note.length > 10_000)
    })) {
      throw new PermissionError('Only transaction notes may be changed')
    }
    const transactions = existingData.transactions.map(transaction => {
      const submitted = submittedById.get(transaction.id)
      return submitted ? { ...transaction, note: submitted.note } : transaction
    })
    await saveData('coins', { ...existingData, transactions })
    return loadCoinsData()
  })
}

async function addCoinsImpl({
  amount,
  description,
  type = 'MANUAL_ADJUSTMENT',
  relatedItemId,
  note,
  userId,
}: {
  amount: number
  description: string
  type?: TransactionType
  relatedItemId?: string
  note?: string
  userId?: string
}): Promise<CoinsData> {
  return withDataWriteLock(async () => {
    const currentUser = await verifyPermission('coins', type === 'MANUAL_ADJUSTMENT' ? 'write' : 'interact')
    if (!['MANUAL_ADJUSTMENT', 'HABIT_COMPLETION', 'TASK_COMPLETION'].includes(type)) throw new Error('Invalid credit type')
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_COIN_LIMIT) throw new Error('Invalid coin amount')
    validateCoinText(description, note)
    if (!currentUser.isAdmin && userId && userId !== currentUser.id) throw new PermissionError('Cannot change another user\'s coins')
    const targetUserId = userId || currentUser.id
    if (type !== 'MANUAL_ADJUSTMENT' && !currentUser.isAdmin &&
        !checkPermission(currentUser.permissions, 'habit', 'interact')) {
      throw new PermissionError('Habit interaction permission required')
    }
    if (type === 'HABIT_COMPLETION' || type === 'TASK_COMPLETION') {
      const habits = await loadData<HabitsData>('habits')
      if (habits.habits.find(habit => habit.id === relatedItemId)?.completionRecords?.some(Boolean)) {
        throw new PermissionError('Habit rewards are managed by completion actions')
      }
    }
    await validateCoinTransaction(type, relatedItemId, amount, targetUserId)
    const data = await loadData<CoinsData>('coins')
    if (type === 'HABIT_COMPLETION' || type === 'TASK_COMPLETION') {
      await validateHabitRewardBalance(type, relatedItemId!, targetUserId, data.transactions)
    }
    const newTransaction: CoinTransaction = {
      id: uuid(),
      amount,
      type,
      description,
      timestamp: d2t({ dateTime: getNow({}) }),
      ...(relatedItemId && { relatedItemId }),
      ...(note && note.trim() !== '' && { note }),
      userId: targetUserId
    }

    const newData: CoinsData = {
      balance: data.balance + amount,
      transactions: [newTransaction, ...data.transactions]
    }

    await saveData('coins', newData)
    return visibleCoinsData(newData, currentUser)
  })
}

async function validateCoinTransaction(
  type: TransactionType,
  relatedItemId: string | undefined,
  amount: number,
  targetUserId: string
): Promise<void> {
  if (usesPostgres() && await getFamiliesEnabled() && !(await readDataUsers()).users.some(user => user.id === targetUserId)) {
    throw new PermissionError('Coin actions require an active member of the selected family')
  }
  if (type === 'MANUAL_ADJUSTMENT') return
  if (!relatedItemId) throw new Error('Related item is required')
  if (type === 'WISH_REDEMPTION') {
    const wishlist = await loadData<WishlistData>('wishlist')
    const item = wishlist.items.find(item => item.id === relatedItemId && item.userIds?.includes(targetUserId))
    if (!item || item.archived || item.targetCompletions !== undefined && item.targetCompletions < 1 ||
        item.coinCost !== amount) throw new PermissionError('Invalid reward transaction')
    return
  }
  if (!['HABIT_COMPLETION', 'HABIT_UNDO', 'TASK_COMPLETION', 'TASK_UNDO'].includes(type)) {
    throw new Error('Invalid transaction type')
  }
  const habits = await loadData<HabitsData>('habits')
  const habit = habits.habits.find(habit => habit.id === relatedItemId && habit.userIds?.includes(targetUserId))
  if (!habit || habit.coinReward !== amount || Boolean(habit.isTask) !== type.startsWith('TASK_')) {
    throw new PermissionError('Invalid habit transaction')
  }
}

async function validateHabitRewardBalance(
  type: 'HABIT_COMPLETION' | 'TASK_COMPLETION' | 'HABIT_UNDO' | 'TASK_UNDO',
  habitId: string,
  userId: string,
  transactions: CoinTransaction[]
): Promise<void> {
  const habits = await loadData<HabitsData>('habits')
  const habit = habits.habits.find(item => item.id === habitId)
  if (!habit) throw new Error('Habit not found')
  const settings = await loadSettings()
  const timezone = settings.system.timezone
  const completionsByDay = new Map<string, number>()
  for (const completion of habit.completions) {
    const date = DateTime.fromISO(completion, { zone: 'utc' }).setZone(timezone)
    if (!date.isValid) continue
    const day = date.toISODate()!
    completionsByDay.set(day, (completionsByDay.get(day) ?? 0) + 1)
  }
  const target = Math.max(1, habit.targetCompletions ?? 1)
  const eligibleRewards = [...completionsByDay.values()].filter(count => count >= target).length
  const completionType = type.startsWith('TASK_') ? 'TASK_COMPLETION' : 'HABIT_COMPLETION'
  const undoType = type.startsWith('TASK_') ? 'TASK_UNDO' : 'HABIT_UNDO'
  const awarded = transactions.filter(transaction =>
    transaction.userId === userId && transaction.relatedItemId === habitId && transaction.type === completionType
  ).length
  const undone = transactions.filter(transaction =>
    transaction.userId === userId && transaction.relatedItemId === habitId && transaction.type === undoType
  ).length
  const outstanding = awarded - undone

  if (type === completionType && outstanding >= eligibleRewards) {
    throw new PermissionError('No uncredited habit completion')
  }
  if (type === undoType && outstanding <= eligibleRewards) {
    throw new PermissionError('No habit reward to undo')
  }
}

async function loadSettingsImpl(): Promise<Settings> {
  const defaultSettings = getDefaultSettings()

  try {
    const user = await getCurrentDataUser()
    if (!user || (!user.email && process.env.DEMO !== 'true')) return defaultSettings
    const data = await loadData<Settings>('settings')
    for (const section of ['ui', 'system', 'profile'] as const) {
      const value = data[section]
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
        throw new Error('Invalid settings')
      }
    }
    const base = {
      ...defaultSettings, ...data,
      ui: { ...defaultSettings.ui, ...data.ui },
      system: { ...defaultSettings.system, ...data.system },
      profile: { ...defaultSettings.profile, ...data.profile },
    }
    if (usesPostgres() && await getFamiliesEnabled()) {
      const state = (await currentDatabaseClient()!.query("SELECT current_setting('habittrove.scope_validated',true) AS valid")).rows[0]
      if (state.valid === 'true') return readFamilySettings(user, base)
      return { ...base, ui: { ...base.ui, ...user.personalSettings?.ui },
        system: { ...base.system, ...(user.personalSettings?.language ? { language: user.personalSettings.language } : {}) } }
    }
    return base
  } catch (error) {
    if (usesPostgres()) throw error
    return defaultSettings
  }
}

async function saveSettingsImpl(settings: Settings): Promise<void> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    validateSettings(settings)
    const stored = await loadData<Settings>('settings')
    const defaults = getDefaultSettings()
    const existing = validateSettings({
      ...defaults, ...stored,
      ui: { ...defaults.ui, ...stored.ui },
      system: { ...defaults.system, ...stored.system },
      profile: { ...defaults.profile, ...stored.profile },
    })
    if (usesPostgres() && await getFamiliesEnabled()) {
      const global = user.isAdmin ? { ...existing, profile: settings.profile,
        system: { ...existing.system, autoBackupEnabled: settings.system.autoBackupEnabled } } : existing
      if (!_.isEqual(global, existing)) await saveData('settings', global)
      return saveFamilySettings(user, settings, global)
    }
    if (process.env.DEMO === 'true' && !_.isEqual(settings.system, existing.system)) {
      throw new PermissionError('System changes are disabled in demo mode')
    }
    if (!user.isAdmin) {
      if (!_.isEqual(settings.system, existing.system) || !_.isEqual(settings.profile, existing.profile)) {
        throw new PermissionError('Only administrators can change system settings')
      }
      return saveData('settings', { ...existing, ui: settings.ui })
    }
    return saveData('settings', settings)
  })
}

async function removeCoinsImpl({
  amount,
  description,
  type = 'MANUAL_ADJUSTMENT',
  relatedItemId,
  note,
  userId,
}: {
  amount: number
  description: string
  type?: TransactionType
  relatedItemId?: string
  note?: string
  userId?: string
}): Promise<CoinsData> {
  return withDataWriteLock(async () => {
    const currentUser = await verifyPermission('coins', type === 'MANUAL_ADJUSTMENT' ? 'write' : 'interact')
    if (!['MANUAL_ADJUSTMENT', 'HABIT_UNDO', 'TASK_UNDO', 'WISH_REDEMPTION'].includes(type)) throw new Error('Invalid debit type')
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_COIN_LIMIT) throw new Error('Invalid coin amount')
    validateCoinText(description, note)
    if (!currentUser.isAdmin && userId && userId !== currentUser.id) throw new PermissionError('Cannot change another user\'s coins')
    const targetUserId = userId || currentUser.id
    if (type === 'WISH_REDEMPTION' && !currentUser.isAdmin &&
        !checkPermission(currentUser.permissions, 'wishlist', 'interact')) {
      throw new PermissionError('Wishlist interaction permission required')
    }
    if ((type === 'HABIT_UNDO' || type === 'TASK_UNDO') && !currentUser.isAdmin &&
        !checkPermission(currentUser.permissions, 'habit', 'interact')) {
      throw new PermissionError('Habit interaction permission required')
    }
    if (type === 'HABIT_UNDO' || type === 'TASK_UNDO') {
      const habits = await loadData<HabitsData>('habits')
      if (habits.habits.find(habit => habit.id === relatedItemId)?.completionRecords?.some(Boolean)) {
        throw new PermissionError('Habit rewards are managed by completion actions')
      }
    }
    await validateCoinTransaction(type, relatedItemId, amount, targetUserId)
    const data = await loadData<CoinsData>('coins')
    if (type === 'HABIT_UNDO' || type === 'TASK_UNDO') {
      await validateHabitRewardBalance(type, relatedItemId!, targetUserId, data.transactions)
    }
    if (type === 'WISH_REDEMPTION') {
      const balance = await walletBalance(data, currentUser, targetUserId)
      if (balance < amount) throw new PermissionError('Insufficient coins')
    }
    const newTransaction: CoinTransaction = {
      id: uuid(),
      amount: -amount,
      type,
      description,
      timestamp: d2t({ dateTime: getNow({}) }),
      ...(relatedItemId && { relatedItemId }),
      ...(note && note.trim() !== '' && { note }),
      userId: targetUserId
    }

    const newData: CoinsData = {
      balance: usesPostgres() && await getFamiliesEnabled() ? data.balance - amount : Math.max(0, data.balance - amount),
      transactions: [newTransaction, ...data.transactions]
    }

    await saveData('coins', newData)
    if (type === 'WISH_REDEMPTION') {
      const wishlist = await loadData<WishlistData>('wishlist')
      const item = wishlist.items.find(candidate => candidate.id === relatedItemId)!
      if (item.targetCompletions !== undefined) {
        item.targetCompletions--
        if (item.targetCompletions === 0) {
          item.targetCompletions = undefined
          item.archived = true
        }
        await saveData('wishlist', wishlist)
      }
    }
    return visibleCoinsData(newData, currentUser)
  })
}

async function uploadAvatarImpl(formData: FormData): Promise<string> {
  const user = await requireUser()
  const file = formData.get('avatar')
  if (!(file instanceof File)) throw new Error('No file provided')

  if (file.size > 5 * 1024 * 1024) { // 5MB
    throw new Error('File size must be less than 5MB')
  }

  const mimeType = file.type.toLowerCase()
  if (!ALLOWED_AVATAR_MIME_TYPES.has(mimeType)) {
    throw new Error('Unsupported avatar MIME type')
  }

  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_AVATAR_EXTENSIONS.has(ext)) {
    throw new Error('Unsupported avatar file extension')
  }

  // Create avatars directory if it doesn't exist
  return withDataWriteLock(async () => {
    const account = (await readAuthData()).users.find(candidate => candidate.id === user.id)
    if (!account) throw new PermissionError('User not authenticated')
    const avatarsDir = path.join(process.cwd(), 'data', 'avatars')
    await fs.mkdir(avatarsDir, { recursive: true, mode: 0o700 })
    const priorFiles = (await fs.readdir(avatarsDir)).filter(name => isGeneratedAvatarForUser(name, user.id)).sort()
    const filename = `${user.id}-${Date.now()}-${uuid()}${ext}`
    const bytes = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(path.join(avatarsDir, filename), bytes, { flag: 'wx', mode: 0o600 })
    try {
      await registerAttachment({ id: `avatar:${filename}`, owner_id: user.id,
        path: `avatars/${filename}`, mime_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif', bytes })
    } catch (error) {
      await fs.rm(path.join(avatarsDir, filename), { force: true }).catch(() => undefined)
      throw error
    }
    const referenced = new Set((await readAuthData()).users.map(account => account.avatarPath).filter(Boolean).map(value => path.basename(value!)))
    const unreferenced = priorFiles.filter(name => !referenced.has(name))
    const keep = Math.max(0, 2 - priorFiles.filter(name => referenced.has(name)).length)
    for (const old of unreferenced.slice(0, Math.max(0, unreferenced.length - keep))) {
      await scheduleAttachmentRemoval(`avatar:${old}`, `avatars/${old}`)
    }
    return `/data/avatars/${filename}`
  })
}

export async function getChangelog(): Promise<string> {
  try {
    const changelogPath = path.join(process.cwd(), 'CHANGELOG.md')
    return await fs.readFile(changelogPath, 'utf8')
  } catch (error) {
    log('error', 'Error loading changelog', error)
    return '# Changelog\n\nNo changelog available.'
  }
}

// user logic
async function loadUsersData(): Promise<UserData> {
  return readAuthData()
}

export async function loadAdministrationUsers(): Promise<PublicUserData> {
  const actor = await getCurrentUser()
  if (!actor?.isAdmin || !actor.email || process.env.DEMO === 'true') throw new PermissionError('Administrator access required')
  const read = async () => {
    const data = await readAuthData()
    const fresh = data.users.find(user => user.id === actor.id)
    if (!fresh?.isAdmin || !fresh.email || (fresh.authVersion ?? 0) !== (actor.authVersion ?? 0)) {
      throw new PermissionError('Administrator access required')
    }
    return sanitizeUserData(data, fresh.id, true)
  }
  return usesPostgres() ? withStorageTransaction(read, { readOnly: true }) : read()
}

async function loadUsersPublicDataImpl(): Promise<PublicUserData> {
  const viewer = await getCurrentDataUser()
  if (!viewer) return { users: [] }
  if (!viewer.email && process.env.DEMO !== 'true') return sanitizeUserData({ users: [viewer] }, viewer.id, !!viewer.isAdmin)
  const data = usesPostgres() && await getFamiliesEnabled() ? await readFamilyDirectory(viewer) : await loadUsersData()
  const visible = sanitizeUserData(data, viewer.id, !!viewer.isAdmin)
  if (usesPostgres() && await getFamiliesEnabled() && !visible.users.some(user => user.id === viewer.id)) {
    visible.currentUser = sanitizeUserData({ users: [viewer] }, viewer.id, !!viewer.isAdmin).users[0]
  }
  return visible
}

async function savePersonalFoldersImpl(folders: PersonalFolder[]): Promise<PersonalFolder[]> {
  const actor = await requireUser()
  if (process.env.DEMO === 'true') throw new PermissionError('Folder changes are disabled in demo mode')
  if (!Array.isArray(folders) || folders.length > 50 || folders.some(folder =>
    !folder || typeof folder.id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(folder.id) ||
    typeof folder.name !== 'string' || !folder.name.trim() || folder.name.length > 80 ||
    !Array.isArray(folder.itemIds) || folder.itemIds.length > 2000 ||
    folder.itemIds.some(id => typeof id !== 'string' || !id || id.length > 200))) {
    throw new Error('Invalid folders')
  }
  if (new Set(folders.map(folder => folder.id)).size !== folders.length ||
      new Set(folders.map(folder => folder.name.trim().toLowerCase())).size !== folders.length) {
    throw new Error('Duplicate folder')
  }
  const assignments = folders.flatMap(folder => folder.itemIds)
  if (new Set(assignments).size !== assignments.length) throw new Error('An item can belong to only one folder')
  return withDataWriteLock(async () => {
    const habits = await loadData<HabitsData>('habits')
    const visibleIds = new Set(habits.habits.filter(item => familyItemVisible(item, actor)).map(item => item.id))
    if (assignments.some(id => !visibleIds.has(id))) throw new PermissionError('Cannot file an inaccessible item')
    if (usesPostgres() && await getFamiliesEnabled()) {
      return (await saveFamilyPreferences(actor, { folders: folders.map(folder => ({ ...folder,
        name: folder.name.trim(), itemIds: [...folder.itemIds] })) })).folders
    }
    return updateAuthData(data => {
      const user = data.users.find(candidate => candidate.id === actor.id)
      if (!user) throw new PermissionError('User not authenticated')
      user.personalFolders = folders.map(folder => ({
        id: folder.id, name: folder.name.trim(), itemIds: [...folder.itemIds],
      }))
      return user.personalFolders
    })
  })
}

async function saveStatusDaysImpl(days: StatusDay[]): Promise<StatusDay[]> {
  const actor = await requireUser()
  if (process.env.DEMO === 'true') throw new PermissionError('Status changes are disabled in demo mode')
  const today = DateTime.now().setZone((await loadSettings()).system.timezone).startOf('day')
  if (!Array.isArray(days) || days.length > 90 || days.some(day =>
    !day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
    !DateTime.fromISO(day.date).isValid || !['sick', 'travel', 'rest', 'other'].includes(day.status) ||
    Math.abs(DateTime.fromISO(day.date).diff(today, 'days').days) > 366) ||
    new Set(days.map(day => day.date)).size !== days.length) throw new Error('Invalid status dates')
  if (usesPostgres() && await getFamiliesEnabled()) {
    return (await saveFamilyPreferences(actor, { statusDays: [...days].sort((a, b) => a.date.localeCompare(b.date)) })).statusDays
  }
  return updateAuthData(data => {
    const user = data.users.find(candidate => candidate.id === actor.id)
    if (!user) throw new PermissionError('User not authenticated')
    user.statusDays = [...days].sort((a, b) => a.date.localeCompare(b.date))
    return user.statusDays
  })
}

const inviteLifetimeMs = 7 * 24 * 60 * 60 * 1000

export async function listFamilyInvites(): Promise<{ tokenHash: string; email: string; expiresAt: string; managedBy?: string }[]> {
  await requireAdmin()
  if (usesPostgres() && await getFamiliesEnabled()) throw new PermissionError('Use invitations for the selected family')
  return ((await readAuthData()).invites ?? []).filter(invite => DateTime.fromISO(invite.expiresAt).toMillis() > Date.now())
    .map(({ tokenHash, email, expiresAt, managedBy }) => ({ tokenHash, email, expiresAt, managedBy }))
}

export async function createFamilyInvite(rawEmail: string, managedBy?: string): Promise<{ token: string; sent: boolean }> {
  const actor = await requireAdmin()
  if (usesPostgres() && await getFamiliesEnabled()) throw new PermissionError('Use invitations for the selected family')
  if (process.env.DEMO === 'true') throw new PermissionError('Invitations are disabled in demo mode')
  const email = validateEmail(rawEmail)!
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await updateAuthData(data => {
    if (!data.users.some(user => user.id === actor.id && user.isAdmin)) throw new PermissionError('Administrator access required')
    if (data.users.some(user => user.email?.toLowerCase() === email)) throw new Error('Email already belongs to an account')
    if (managedBy && !data.users.some(user => user.id === managedBy)) {
      throw new Error('Unknown family manager')
    }
    data.invites = (data.invites ?? []).filter(invite => DateTime.fromISO(invite.expiresAt).toMillis() > Date.now())
    if (data.invites.length >= 50) throw new Error('Too many pending invitations')
    if (data.invites.some(invite => invite.email === email)) throw new Error('Email already has a pending invitation')
    data.invites.push({ tokenHash, email, createdBy: actor.id, managedBy,
      expiresAt: new Date(Date.now() + inviteLifetimeMs).toISOString() })
  })
  const sent = await sendFamilyInvitation(email, token).catch(() => false)
  return { token, sent }
}

export async function revokeFamilyInvite(tokenHash: string): Promise<void> {
  await requireAdmin()
  if (usesPostgres() && await getFamiliesEnabled()) throw new PermissionError('Use invitations for the selected family')
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('Invalid invitation')
  await updateAuthData(data => { data.invites = (data.invites ?? []).filter(invite => invite.tokenHash !== tokenHash) })
}

export async function acceptFamilyInvite(token: string, username: string, password: string): Promise<void> {
  if (process.env.DEMO === 'true') throw new PermissionError('Invitations are disabled in demo mode')
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid invitation')
  usernameSchema.parse(username)
  newPasswordSchema.parse(password)
  if (usesPostgres() && currentDatabaseClient()) throw new Error('Invitation password hashing must run outside storage transactions')
  const household = usesPostgres() && await getFamiliesEnabled()
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const validLegacyOffer = (data: UserData) => {
    const invite = data.invites?.find(candidate => candidate.tokenHash === tokenHash)
    const expiresAt = invite ? DateTime.fromISO(invite.expiresAt).toMillis() : NaN
    if (!invite || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invitation expired or already used')
    if (data.users.some(user => user.username.toLowerCase() === username.toLowerCase() ||
      user.email?.toLowerCase() === invite.email)) throw new Error('Account already exists')
    return invite
  }
  const attemptKey = household
    ? await preflightNewHouseholdInvite(token, username)
    : validLegacyOffer(await readAuthData()).tokenHash
  const release = await acquirePasswordVerification()
  if (!release) throw new Error('Too many password requests; try again shortly')
  try {
    if (!await reserveAuthenticationAttempt('invite', attemptKey)) throw new Error('Too many invitation attempts; try again later')
    const passwordHash = await saltAndHashPasswordAsync(password)
    if (household) {
      await withHouseholdInviteEmail(token, email => updateAuthData(async data => {
        if (data.users.some(user => user.username.toLowerCase() === username.toLowerCase() || user.email?.toLowerCase() === email)) {
          throw new Error('Account already exists; sign in to accept this invitation')
        }
        const account: User = { id: uuid(), username, email, password: passwordHash, isAdmin: false, authVersion: 0 }
        data.users.push(account)
        await clearAuthenticationAttempts('invite', attemptKey)
        return account
      }))
      return
    }
    await updateAuthData(async data => {
      const invite = validLegacyOffer(data)
      const account: User = { id: uuid(), username, email: invite.email,
        password: passwordHash, isAdmin: false, authVersion: 0,
        permissions: [{ habit: { write: true, interact: true }, wishlist: { write: true, interact: true },
          coins: { write: true, interact: true } }] }
      data.users.push(account)
      const manager = data.users.find(user => user.id === invite.managedBy)
      if (manager) manager.managedUserIds = [...new Set([...(manager.managedUserIds ?? []), account.id])]
      data.invites = data.invites!.filter(candidate => candidate.tokenHash !== tokenHash)
      await clearAuthenticationAttempts('invite', attemptKey)
    })
  } finally {
    await release()
  }
}

export async function createUser(formData: FormData): Promise<PublicUser> {
  const administrator = await requireAdmin()
  if (process.env.DEMO === 'true') throw new PermissionError('Account changes are disabled in demo mode')
  const username = formData.get('username') as string;
  let password = formData.get('password') as string | undefined;
  const avatarPath = validateAvatarPath(formData.get('avatarPath'));
  const email = validateEmail(formData.get('email'))
  const oidcSubject = validateOidcSubject(formData.get('oidcSubject'))
  const oidcIssuer = oidcSubject ? (await getActiveOidcConfig())?.issuer : undefined
  if (oidcSubject && !oidcIssuer) throw new Error('Configure OIDC before linking an account')
  const isAdmin = formData.get('isAdmin') === 'true';
  const rawPermissions = formData.get('permissions')
  if (typeof rawPermissions === 'string' && rawPermissions.length > 4096) throw new Error('Invalid permissions')
  const permissions = !isAdmin && rawPermissions && rawPermissions !== 'undefined'
    ? permissionSchema.parse(JSON.parse(rawPermissions as string)) as Permission[]
    : undefined;

  if (password === null) password = undefined
  // Validate username and password against schema
  await signInSchema.parseAsync({ username, password });
  if (password) newPasswordSchema.parse(password)

  const hashedPassword = password ? saltAndHashPassword(password) : undefined;
  if (isAdmin && !hashedPassword && process.env.DEMO !== 'true') {
    throw new Error('Administrator accounts require a password')
  }
  if (!hashedPassword && !oidcSubject && process.env.DEMO !== 'true') {
    throw new Error('A password or OIDC subject is required')
  }

  const newUser = await withIdentityWrite(administrator, () => updateAuthData(async data => {
    if (!data.users.find(user => user.id === administrator.id)?.isAdmin) throw new PermissionError('Administrator access required')
    if (data.users.some(user => user.username === username)) throw new Error('Username already exists')
    if (email && data.users.some(user => user.email?.toLowerCase() === email)) throw new Error('Email already exists')
    if (oidcSubject && data.users.some(user => user.oidcSubject === oidcSubject)) {
      throw new Error('OIDC identity is already linked')
    }
    const user: User = {
      id: uuid(), username, password: hashedPassword, permissions, isAdmin,
      ...(email && { email }),
      authVersion: 0,
      ...(oidcSubject && { oidcSubject, oidcIssuer }),
      ...(avatarPath && { avatarPath }),
    }
    if (avatarPath) await assignAvatar(data, avatarPath, user.id, administrator)
    data.users.push(user)
    return user
  }))
  return sanitizeUserData({ users: [newUser] }, administrator.id, true).users[0]
}

export async function updateUser(userId: string, updates: Partial<Omit<User, 'id' | 'password' | 'authVersion' | 'oidcSubject' | 'oidcIssuer'>> & { oidcSubject?: string | null }): Promise<PublicUser> {
  const currentUser = await getCurrentUser()
  if (!currentUser) throw new PermissionError('User not authenticated')
  if (process.env.DEMO === 'true') throw new PermissionError('Account changes are disabled in demo mode')
  if (!currentUser.email && process.env.DEMO !== 'true' &&
      (currentUser.id !== userId || Object.keys(updates).some(key => key !== 'email'))) {
    throw new PermissionError('Email is required before using this account')
  }
  const oidcIssuer = updates.oidcSubject ? (await getActiveOidcConfig())?.issuer : undefined
  if (updates.oidcSubject && !oidcIssuer) throw new Error('Configure OIDC before linking an account')
  return withIdentityWrite(currentUser, () => updateAuthData(async data => {
    const actor = data.users.find(user => user.id === currentUser.id)
    if (!actor) throw new PermissionError('User not authenticated')
    const userIndex = data.users.findIndex(user => user.id === userId)

  if (userIndex === -1) {
    throw new Error('User not found')
  }

  if (!actor.isAdmin && actor.id !== userId) {
    throw new PermissionError('Cannot edit another user')
  }

  const allowedKeys = ['username', 'email', 'avatarPath', 'permissions', 'isAdmin', 'oidcSubject', 'managedUserIds']
  if (Object.keys(updates).some(key => !allowedKeys.includes(key))) {
    throw new Error('Invalid user update')
  }

  const existingUser = data.users[userIndex]
  if (actor.isAdmin && updates.isAdmin === false && existingUser.isAdmin &&
    data.users.filter(user => user.isAdmin).length === 1) {
    throw new Error('Cannot remove the last administrator')
  }
  if (actor.isAdmin && updates.isAdmin === true && !existingUser.password && process.env.DEMO !== 'true') {
    throw new Error('Administrator accounts require a password')
  }
  if (!actor.isAdmin &&
    (updates.isAdmin !== undefined && updates.isAdmin !== existingUser.isAdmin ||
      updates.permissions !== undefined && !_.isEqual(updates.permissions, existingUser.permissions) ||
      updates.oidcSubject !== undefined || updates.managedUserIds !== undefined)) {
    throw new PermissionError('Cannot change account permissions')
  }

  const validatedUpdates = {
    ...(updates.username !== undefined && { username: usernameSchema.parse(updates.username) }),
    ...(updates.email !== undefined && { email: validateEmail(updates.email) }),
    ...(updates.avatarPath !== undefined && { avatarPath: validateAvatarPath(updates.avatarPath) }),
    ...(actor.isAdmin && updates.isAdmin !== undefined && { isAdmin: z.boolean().parse(updates.isAdmin) }),
    ...(actor.isAdmin && updates.permissions !== undefined && { permissions: permissionSchema.parse(updates.permissions) }),
    ...(actor.isAdmin && updates.oidcSubject !== undefined && { oidcSubject: validateOidcSubject(updates.oidcSubject) }),
    ...(actor.isAdmin && updates.oidcSubject !== undefined && { oidcIssuer }),
    ...(actor.isAdmin && updates.managedUserIds !== undefined && {
      managedUserIds: z.array(z.string().min(1).max(128)).max(50).parse(updates.managedUserIds),
    }),
  }

  if (validatedUpdates.managedUserIds && (new Set(validatedUpdates.managedUserIds).size !== validatedUpdates.managedUserIds.length ||
      validatedUpdates.managedUserIds.includes(userId) ||
      validatedUpdates.managedUserIds.some(id => !data.users.some(candidate => candidate.id === id)))) {
    throw new Error('Invalid managed family members')
  }

  if (usesPostgres() && validatedUpdates.avatarPath && validatedUpdates.avatarPath !== existingUser.avatarPath) {
    await assignAvatar(data, validatedUpdates.avatarPath, userId, actor)
  }

  const subject = 'oidcSubject' in validatedUpdates ? validatedUpdates.oidcSubject : existingUser.oidcSubject
  if (subject && data.users.some(user => user.id !== userId && user.oidcSubject === subject)) {
    throw new Error('OIDC identity is already linked')
  }
  if (!existingUser.password && !subject && process.env.DEMO !== 'true') {
    throw new Error('A password or OIDC subject is required')
  }

  // If username is being updated, check for duplicates
  if (updates.username) {
    const isDuplicate = data.users.some(
      user => user.username === updates.username && user.id !== userId
    )
    if (isDuplicate) {
      throw new Error('Username already exists')
    }
  }
  if (validatedUpdates.email && data.users.some(user => user.id !== userId && user.email?.toLowerCase() === validatedUpdates.email)) {
    throw new Error('Email already exists')
  }

  const updatedUser = {
    ...data.users[userIndex],
    ...validatedUpdates,
    authVersion: (existingUser.authVersion ?? 0) + (updates.email !== undefined || updates.isAdmin !== undefined || updates.permissions !== undefined || updates.oidcSubject !== undefined || updates.managedUserIds !== undefined ? 1 : 0),
  }
  data.users[userIndex] = updatedUser
  return sanitizeUserData({ users: [updatedUser] }, actor.id, !!actor.isAdmin).users[0]
  }))
}

export async function updateUserPassword(userId: string, newPassword?: string, currentPassword?: string): Promise<void> {
  if (process.env.DEMO === 'true') throw new PermissionError('Password changes are disabled in demo mode')
  const currentUser = await requireUser()
  if (!currentUser.isAdmin && currentUser.id !== userId) {
    throw new PermissionError('Cannot change another user\'s password')
  }
  if (newPassword !== undefined) newPasswordSchema.parse(newPassword)
  const before = (await readAuthData()).users.find(user => user.id === userId)
  if (!before) throw new Error('User not found')
  if (currentUser.id === userId) {
    if (!before.password) throw new PermissionError('An administrator must set the initial local password')
    if (typeof currentPassword !== 'string' || currentPassword.length > 128 ||
        !(await verifyStepUpPassword(before, currentPassword))) {
      throw new PermissionError('Current password is incorrect')
    }
  }
  const passwordHash = newPassword ? saltAndHashPassword(newPassword) : undefined
  await withIdentityWrite(currentUser, () => updateAuthData(async data => {
    const actor = data.users.find(user => user.id === currentUser.id)
    const userIndex = data.users.findIndex(user => user.id === userId)
    if (!actor || (!actor.isAdmin && actor.id !== userId)) throw new PermissionError('Cannot change another user\'s password')
    if (userIndex === -1) throw new Error('User not found')
    const target = data.users[userIndex]
    if (target.password !== before.password || (target.authVersion ?? 0) !== (before.authVersion ?? 0)) {
      throw new PermissionError('Account changed; reload before changing the password')
    }
    if (target.isAdmin && newPassword === undefined && process.env.DEMO !== 'true') {
      throw new Error('Administrator accounts require a password')
    }
    if (!target.oidcSubject && newPassword === undefined && process.env.DEMO !== 'true') {
      throw new Error('A password or OIDC subject is required')
    }
    data.users[userIndex] = {
      ...target,
      password: passwordHash,
      authVersion: (target.authVersion ?? 0) + 1,
    }
  }))
}

async function deleteUserImpl(userId: string): Promise<void> {
  if (process.env.DEMO === 'true') throw new PermissionError('Account deletion is disabled in demo mode')
  return withDataWriteLock(async () => {
    const currentUser = await requireUser()
    const evidenceToRemove: string[] = []
    const collectEvidence = (record: HabitCompletionRecord | null) => {
      if (record?.evidenceId && record.evidenceMime && /^[0-9a-f-]{36}$/i.test(record.evidenceId) &&
          Object.prototype.hasOwnProperty.call(evidenceExtensions, record.evidenceMime)) {
        evidenceToRemove.push(evidencePath(record.evidenceId, record.evidenceMime))
      }
    }
    await updateAuthData(async authData => {
    const actor = authData.users.find(user => user.id === currentUser.id)
    if (!actor || (!actor.isAdmin && actor.id !== userId)) throw new PermissionError('Cannot delete another user')
    const targetUser = authData.users.find(user => user.id === userId)
    if (!targetUser) throw new Error('User not found')
    if (targetUser.isAdmin && authData.users.filter(user => user.isAdmin).length === 1) {
      throw new Error('Cannot delete the last administrator')
    }
    const familiesEnabled = usesPostgres() && await getFamiliesEnabled()
    if (familiesEnabled && (await currentDatabaseClient()!.query('SELECT 1 FROM habittrove.family_memberships WHERE user_id=$1 LIMIT 1', [userId])).rowCount) {
      throw new PermissionError('Accounts with family history are retained; remove family membership to revoke access')
    }
    const remainingUsers = authData.users.filter(user => user.id !== userId)
    for (const user of remainingUsers) {
      if (user.managedUserIds) user.managedUserIds = user.managedUserIds.filter(id => id !== userId)
    }
    authData.invites = authData.invites?.filter(invite => invite.managedBy !== userId)
    const fallbackAdmin = remainingUsers.find(user => user.isAdmin)?.id
    if (!fallbackAdmin) throw new Error('An administrator is required for approval recovery')
    const avatarsDir = path.join(process.cwd(), 'data', 'avatars')
    const avatarFiles = await fs.readdir(avatarsDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const assignedAvatar = targetUser.avatarPath ? path.basename(targetUser.avatarPath) : undefined
    for (const filename of avatarFiles.filter(name =>
      (isGeneratedAvatarForUser(name, userId) || name === assignedAvatar) &&
      !remainingUsers.some(user => user.avatarPath === `/data/avatars/${name}`))) {
      await scheduleAttachmentRemoval(`avatar:${filename}`, `avatars/${filename}`)
    }
    if (familiesEnabled) {
      authData.users = remainingUsers
      return
    }
    // Load all necessary data
    const wishlistData = await loadData<WishlistData>('wishlist')
    const habitsData = await loadData<HabitsData>('habits')
    const coinsData = await loadData<CoinsData>('coins')

    // Process Wishlist Data
    const updatedWishlistItems = wishlistData.items.reduce((acc, item) => {
      if (item.userIds?.includes(userId)) {
        if (item.userIds.length === 1) {
          // Remove item if this is the only user
          return acc
        } else {
          // Remove userId from item's userIds
          acc.push({
            ...item,
            userIds: item.userIds.filter(id => id !== userId)
          })
        }
      } else {
        // Keep item as is
        acc.push(item)
      }
      return acc
    }, [] as WishlistItemType[])
    wishlistData.items = updatedWishlistItems
    await saveData('wishlist', wishlistData)

    // Process Habits Data
    const updatedHabits = habitsData.habits.reduce((acc, habit) => {
      const deletedItem = habit.userIds?.length === 1 && habit.userIds[0] === userId
      if (deletedItem) {
        for (const record of habit.completionRecords ?? []) collectEvidence(record)
        return acc
      }
      const remainingApprovers = habit.approverIds?.filter(id => id !== userId)
      const fallbackApprover = remainingUsers.some(user => user.id === habit.createdBy)
        ? habit.createdBy! : fallbackAdmin
      acc.push({
        ...habit,
        ...(habit.userIds?.includes(userId) && { userIds: habit.userIds.filter(id => id !== userId) }),
        ...(habit.approverIds !== undefined && {
          approverIds: habit.requiresApproval && !remainingApprovers?.length
            ? [fallbackApprover] : remainingApprovers,
        }),
        ...(habit.completionRecords && { completionRecords: habit.completionRecords.map(record => {
          if (!record || record.actorId !== userId && record.beneficiaryId !== userId) return record
          collectEvidence(record)
          const { evidenceId: _evidenceId, evidenceMime: _evidenceMime, ...withoutEvidence } = record
          return record.approval === 'pending'
            ? { ...withoutEvidence, approval: 'rejected' as const } : withoutEvidence
        }),
        }),
      })
      return acc
    }, [] as HabitsData['habits'])
    habitsData.habits = updatedHabits
    await saveData('habits', habitsData)

    // Process Coins Data
    coinsData.transactions = coinsData.transactions.filter(
      transaction => transaction.userId !== userId
    )
    // Recalculate balance
    coinsData.balance = coinsData.transactions.reduce(
      (sum, transaction) => sum + transaction.amount,
      0
    )
    await saveData('coins', coinsData)

    // Delete User from Auth Data
    const userIndex = authData.users.findIndex(user => user.id === userId)

    if (userIndex === -1) {
      throw new Error('User not found')
    }

    authData.users = [
      ...authData.users.slice(0, userIndex),
      ...authData.users.slice(userIndex + 1)
    ]

    })
    for (const file of new Set(evidenceToRemove)) {
      try { await scheduleAttachmentRemoval(path.basename(file, path.extname(file)), `evidence/${path.basename(file)}`) }
      catch (error) { log('error', 'Could not remove deleted account evidence', error) }
    }
  })
}

async function updateLastNotificationReadTimestampImpl(userId: string, timestamp: string): Promise<void> {
  const currentUser = await requireUser()
  if (currentUser.id !== userId) throw new PermissionError('Cannot update another user')
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp')
  if (usesPostgres() && await getFamiliesEnabled()) {
    await saveFamilyPreferences(currentUser, { lastNotificationReadTimestamp: timestamp })
    return
  }
  await updateAuthData(data => {
    const userIndex = data.users.findIndex(user => user.id === userId)
    if (userIndex === -1) throw new Error('User not found for updating notification timestamp')
    data.users[userIndex] = { ...data.users[userIndex], lastNotificationReadTimestamp: timestamp }
  })
}


export async function loadServerSettings(): Promise<ServerSettings> {
  const [oidc, oidcDisplayName] = await Promise.all([getActiveOidcConfig(), getOidcDisplayName()])
  const familiesEnabled = usesPostgres() && await getFamiliesEnabled()
  let familyRole: ServerSettings['familyRole']
  let familyMember: boolean | undefined
  const actor = familiesEnabled ? await getCurrentUser() : undefined
  if (actor) {
    try {
      const selected = await withFamilyScope(actor, async scope => ({ role: scope?.role, member: !!scope?.memberIds.includes(actor.id) }),
        (await cookies()).get('habittrove-family')?.value, { readOnly: true })
      familyRole = selected.role
      familyMember = selected.member
    } catch (error) {
      if (!(error instanceof Error) || !['Family access denied', 'Invalid family'].includes(error.message)) throw error
    }
  }
  return {
    isDemo: process.env.DEMO === 'true',
    oidcEnabled: !!oidc,
    oidcDisplayName,
    familiesEnabled,
    familyRole,
    familyMember,
  }
}

/**
 * Checks if the client's data is fresh by comparing its token with the server's token.
 * @param clientToken The freshness token calculated by the client.
 * @returns A promise that resolves to an object { isFresh: boolean }.
 */
async function checkDataFreshnessImpl(clientToken: string): Promise<{ isFresh: boolean }> {
  await requireUser()
  if (typeof clientToken !== 'string' || clientToken.length > 128) {
    throw new Error('Invalid freshness token')
  }
  try {
    const serverToken = await calculateServerFreshnessToken();
    const isFresh = clientToken === serverToken;
    return { isFresh };
  } catch (error) {
    log('error', 'Error checking data freshness', error);
    // If server fails to determine its token, assume client might be stale to be safe,
    // or handle error reporting differently.
    return { isFresh: false };
  }
}


export async function loadWishlistData(...args: Parameters<typeof loadWishlistDataImpl>): Promise<Awaited<ReturnType<typeof loadWishlistDataImpl>>> {
  return withSelectedFamilyAction(() => loadWishlistDataImpl(...args), true, async actor => getDefaultWishlistData())
}

export async function loadFamilyOverview(...args: Parameters<typeof loadFamilyOverviewImpl>): Promise<Awaited<ReturnType<typeof loadFamilyOverviewImpl>>> {
  return withSelectedFamilyAction(() => loadFamilyOverviewImpl(...args), true, async actor => ({timezone:getDefaultSettings().system.timezone,weekStartDay:getDefaultSettings().system.weekStartDay,members:[]}))
}

export async function redeemFamilyReward(...args: Parameters<typeof redeemFamilyRewardImpl>): Promise<Awaited<ReturnType<typeof redeemFamilyRewardImpl>>> {
  return withSelectedFamilyAction(() => redeemFamilyRewardImpl(...args))
}

export async function saveWishlistItems(...args: Parameters<typeof saveWishlistItemsImpl>): Promise<Awaited<ReturnType<typeof saveWishlistItemsImpl>>> {
  return withSelectedFamilyAction(() => saveWishlistItemsImpl(...args))
}

export async function loadHabitsData(...args: Parameters<typeof loadHabitsDataImpl>): Promise<Awaited<ReturnType<typeof loadHabitsDataImpl>>> {
  return withSelectedFamilyAction(() => loadHabitsDataImpl(...args), true, async actor => getDefaultHabitsData())
}

export async function loadReminderData(...args: Parameters<typeof loadReminderDataImpl>): Promise<Awaited<ReturnType<typeof loadReminderDataImpl>>> {
  return withSelectedFamilyAction(() => loadReminderDataImpl(...args), true, async () => undefined)
}

export async function saveHabitsData(...args: Parameters<typeof saveHabitsDataImpl>): Promise<Awaited<ReturnType<typeof saveHabitsDataImpl>>> {
  return withSelectedFamilyAction(() => saveHabitsDataImpl(...args))
}

export async function reorderHabitItems(...args: Parameters<typeof reorderHabitItemsImpl>): Promise<Awaited<ReturnType<typeof reorderHabitItemsImpl>>> {
  return withSelectedFamilyAction(() => reorderHabitItemsImpl(...args))
}

export async function toggleTaskChecklistItem(...args: Parameters<typeof toggleTaskChecklistItemImpl>): Promise<Awaited<ReturnType<typeof toggleTaskChecklistItemImpl>>> {
  return withSelectedFamilyAction(() => toggleTaskChecklistItemImpl(...args))
}

export async function recordHabitCompletion(...args: Parameters<typeof recordHabitCompletionImpl>): Promise<Awaited<ReturnType<typeof recordHabitCompletionImpl>>> {
  return withSelectedFamilyAction(() => recordHabitCompletionImpl(...args))
}

export async function recordHabitSlip(...args: Parameters<typeof recordHabitSlipImpl>): Promise<Awaited<ReturnType<typeof recordHabitSlipImpl>>> {
  return withSelectedFamilyAction(() => recordHabitSlipImpl(...args))
}

export async function undoHabitSlip(...args: Parameters<typeof undoHabitSlipImpl>): Promise<Awaited<ReturnType<typeof undoHabitSlipImpl>>> {
  return withSelectedFamilyAction(() => undoHabitSlipImpl(...args))
}

export async function undoHabitCompletion(...args: Parameters<typeof undoHabitCompletionImpl>): Promise<Awaited<ReturnType<typeof undoHabitCompletionImpl>>> {
  return withSelectedFamilyAction(() => undoHabitCompletionImpl(...args))
}

export async function loadPendingApprovals(...args: Parameters<typeof loadPendingApprovalsImpl>): Promise<Awaited<ReturnType<typeof loadPendingApprovalsImpl>>> {
  return withSelectedFamilyAction(() => loadPendingApprovalsImpl(...args), true, async actor => [])
}

export async function reviewHabitCompletion(...args: Parameters<typeof reviewHabitCompletionImpl>): Promise<Awaited<ReturnType<typeof reviewHabitCompletionImpl>>> {
  return withSelectedFamilyAction(() => reviewHabitCompletionImpl(...args))
}

export async function loadCoinsData(...args: Parameters<typeof loadCoinsDataImpl>): Promise<Awaited<ReturnType<typeof loadCoinsDataImpl>>> {
  return withGlobalIdentityAction(() => loadCoinsDataImpl(...args), true)
}

export async function saveCoinsData(...args: Parameters<typeof saveCoinsDataImpl>): Promise<Awaited<ReturnType<typeof saveCoinsDataImpl>>> {
  return withSelectedFamilyAction(() => saveCoinsDataImpl(...args))
}

export async function addCoins(...args: Parameters<typeof addCoinsImpl>): Promise<Awaited<ReturnType<typeof addCoinsImpl>>> {
  return withSelectedFamilyAction(() => addCoinsImpl(...args))
}

export async function loadSettings(...args: Parameters<typeof loadSettingsImpl>): Promise<Awaited<ReturnType<typeof loadSettingsImpl>>> {
  return withSelectedFamilyAction(() => loadSettingsImpl(...args), true, async actor => loadSettingsImpl())
}

export async function saveSettings(...args: Parameters<typeof saveSettingsImpl>): Promise<Awaited<ReturnType<typeof saveSettingsImpl>>> {
  const saveWithoutFamily = () => withDataWriteLock(async () => {
    const actor = await requireUser()
    await savePersonalSettings(actor, args[0], await loadSettingsImpl())
  })
  try {
    return await withSelectedFamilyAction(() => saveSettingsImpl(...args), false, saveWithoutFamily)
  } catch (error) {
    if (usesPostgres() && await getFamiliesEnabled() && error instanceof Error &&
        ['Family access denied', 'Invalid family'].includes(error.message)) {
      return withGlobalIdentityAction(saveWithoutFamily, false)
    }
    throw error
  }
}

export async function removeCoins(...args: Parameters<typeof removeCoinsImpl>): Promise<Awaited<ReturnType<typeof removeCoinsImpl>>> {
  return withSelectedFamilyAction(() => removeCoinsImpl(...args))
}

export async function loadUsersPublicData(...args: Parameters<typeof loadUsersPublicDataImpl>): Promise<Awaited<ReturnType<typeof loadUsersPublicDataImpl>>> {
  return withSelectedFamilyAction(() => loadUsersPublicDataImpl(...args), true, async actor => sanitizeUserData({users:[{...actor,permissions:[],managedUserIds:[],personalFolders:[],statusDays:[]}]},actor.id,actor.isAdmin===true))
}

export async function savePersonalFolders(...args: Parameters<typeof savePersonalFoldersImpl>): Promise<Awaited<ReturnType<typeof savePersonalFoldersImpl>>> {
  return withSelectedFamilyAction(() => savePersonalFoldersImpl(...args))
}

export async function saveStatusDays(...args: Parameters<typeof saveStatusDaysImpl>): Promise<Awaited<ReturnType<typeof saveStatusDaysImpl>>> {
  return withSelectedFamilyAction(() => saveStatusDaysImpl(...args))
}

export async function updateLastNotificationReadTimestamp(...args: Parameters<typeof updateLastNotificationReadTimestampImpl>): Promise<Awaited<ReturnType<typeof updateLastNotificationReadTimestampImpl>>> {
  return withSelectedFamilyAction(() => updateLastNotificationReadTimestampImpl(...args))
}

export async function checkDataFreshness(...args: Parameters<typeof checkDataFreshnessImpl>): Promise<Awaited<ReturnType<typeof checkDataFreshnessImpl>>> {
  return withSelectedFamilyAction(() => checkDataFreshnessImpl(...args), true, async actor => ({isFresh:true}))
}

export async function uploadAvatar(...args: Parameters<typeof uploadAvatarImpl>): Promise<Awaited<ReturnType<typeof uploadAvatarImpl>>> {
  return withGlobalIdentityAction(() => uploadAvatarImpl(...args), false)
}

export async function deleteUser(...args: Parameters<typeof deleteUserImpl>): Promise<Awaited<ReturnType<typeof deleteUserImpl>>> {
  return withGlobalIdentityAction(() => deleteUserImpl(...args), false)
}
