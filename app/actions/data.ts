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
  PublicUser,
  PublicUserData,
  getDefaultWishlistData,
  getDefaultHabitsData,
  getDefaultCoinsData,
  Permission,
  ServerSettings
} from '@/lib/types'
import { checkPermission, d2t, getNow, uuid } from '@/lib/utils';
import { saltAndHashPassword } from '@/lib/password'
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
import { getActiveOidcConfig } from '@/lib/admin-config'
import { log } from '@/lib/logger'



type ResourceType = 'habit' | 'wishlist' | 'coins'
type ActionType = 'write' | 'interact'

const permissionSchema = z.array(z.object({
  habit: z.object({ write: z.boolean(), interact: z.boolean() }),
  wishlist: z.object({ write: z.boolean(), interact: z.boolean() }),
  coins: z.object({ write: z.boolean(), interact: z.boolean() }),
})).max(1)

let dataWriteQueue: Promise<void> = Promise.resolve()

async function withDataWriteLock<T>(operation: () => Promise<T>): Promise<T> {
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

function validateAvatarPath(avatarPath: unknown): string | undefined {
  if (avatarPath == null || avatarPath === '') return undefined
  if (typeof avatarPath !== 'string' || !/^\/data\/avatars\/[a-zA-Z0-9-]+\.(png|jpe?g|gif|webp|avif)$/.test(avatarPath)) {
    throw new Error('Invalid avatar path')
  }
  return avatarPath
}

function validateAuthentikSubject(subject: unknown): string | undefined {
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
  if (!user.isAdmin && !checkPermission(user.permissions, resource, action)) {
    throw new PermissionError(`User does not have ${action} permission for ${resource}`)
  }
  return user
}

async function requireUser(): Promise<User> {
  const user = await getCurrentUser()
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
  interactionFields: (keyof T)[]
): T[] {
  if (!Array.isArray(submitted)) throw new Error('Invalid item list')
  if (user.isAdmin) return submitted

  const existingById = new Map(existing.map(item => [item.id, item]))
  const visible = existing.filter(item => item.userIds?.includes(user.id))
  const seen = new Set<string>()

  const ownedItems = submitted.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) {
      throw new Error('Invalid item ID')
    }
    seen.add(item.id)
    const stored = existingById.get(item.id)
    if (stored && !stored.userIds?.includes(user.id)) {
      throw new PermissionError('Cannot change another user\'s item')
    }
    const userIds = item.userIds ?? [user.id]
    if (!Array.isArray(userIds) || !userIds.includes(user.id) || userIds.some(id => typeof id !== 'string')) {
      throw new PermissionError('Item must belong to the current user')
    }
    if (!canWrite) {
      if (!stored) throw new PermissionError('Cannot create items with interaction permission')
      const unchanged = (value: T) => Object.fromEntries(
        Object.entries(value).filter(([key]) => !interactionFields.includes(key as keyof T))
      )
      if (!_.isEqual(unchanged(item), unchanged(stored))) {
        throw new PermissionError('Only interaction fields may be changed')
      }
    }
    return { ...item, userIds }
  })

  if (!canWrite && (ownedItems.length !== visible.length || visible.some(item => !seen.has(item.id)))) {
    throw new PermissionError('Cannot delete items with interaction permission')
  }

  return [...existing.filter(item => !item.userIds?.includes(user.id)), ...ownedItems]
}

function getDefaultData<T>(type: DataType): T {
  return DATA_DEFAULTS[type]() as T;
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

async function loadData<T>(type: DataType): Promise<T> {
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

async function saveData<T>(type: DataType, data: T): Promise<void> {
  await requireUser()
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
export async function loadWishlistData(): Promise<WishlistData> {
  const user = await getCurrentUser()
  if (!user || (!user.email && process.env.DEMO !== 'true')) return getDefaultWishlistData()

  const data = await loadData<WishlistData>('wishlist')
  return {
    ...data,
    items: data.items.filter(x => user.isAdmin || x.userIds?.includes(user.id))
  }
}

export async function loadWishlistItems(): Promise<WishlistItemType[]> {
  const data = await loadWishlistData()
  return data.items
}

export async function saveWishlistItems(data: WishlistData): Promise<void> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('wishlist', 'write')
    const existingData = await loadData<WishlistData>('wishlist')
    if (!data || !Array.isArray(data.items)) throw new Error('Invalid reward list')
    const items = mergeOwnedItems(data.items.map(validateWishlistItem), existingData.items, user, true, [])
    return saveData('wishlist', { items })
  })
}

// Habits specific functions
export async function loadHabitsData(): Promise<HabitsData> {
  const user = await getCurrentUser()
  if (!user || (!user.email && process.env.DEMO !== 'true')) return getDefaultHabitsData()
  const data = await loadData<HabitsData>('habits')
  return {
    ...data,
    habits: data.habits.filter(x => user.isAdmin || x.userIds?.includes(user.id))
  }
}

export async function saveHabitsData(data: HabitsData): Promise<void> {
  return withDataWriteLock(async () => {
    const user = await requireUser()
    const canWrite = user.isAdmin || checkPermission(user.permissions, 'habit', 'write')
    if (!canWrite) await verifyPermission('habit', 'interact')
    const existingData = await loadData<HabitsData>('habits')
    if (!data || !Array.isArray(data.habits)) throw new Error('Invalid habit list')
    const previous = new Map(existingData.habits.map(habit => [habit.id, habit]))
    const submitted = data.habits.map(habit => {
      const stored = habit && typeof habit.id === 'string' ? previous.get(habit.id) : undefined
      if (
        (stored && !_.isEqual(habit.completions, stored.completions)) ||
        (!stored && Array.isArray(habit?.completions) && habit.completions.length > 0) ||
        (habit?.completionRecords !== undefined && !_.isEqual(habit.completionRecords, stored?.completionRecords))
      ) {
        throw new PermissionError('Use the completion action to change habit history')
      }
      return stored ? {
        ...habit,
        ...(habit.pinned === undefined && stored.pinned !== undefined && { pinned: stored.pinned }),
        ...(habit.isTask === undefined && stored.isTask !== undefined && { isTask: stored.isTask }),
        ...(habit.archived === undefined && stored.archived !== undefined && { archived: stored.archived }),
        ...(habit.completionRecords === undefined && stored.completionRecords !== undefined && { completionRecords: stored.completionRecords }),
      } : habit
    })
    const habits = mergeOwnedItems(
      submitted.map(habit => validateHabit(habit, previous.get(habit.id)?.frequency)),
      existingData.habits, user, canWrite, ['completions', 'archived'])
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
    return saveData('habits', { habits })
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

async function saveCompletionAndRewards(
  beforeHabits: HabitsData,
  afterHabits: HabitsData,
  beforeCoins: CoinsData,
  afterCoins: CoinsData,
): Promise<void> {
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

export async function recordHabitCompletion(habitId: string, timestamp: string): Promise<{
  habit: Habit
  coins: CoinsData
  rewarded: boolean
  targetReached: boolean
  completionIndex: number
  completionTimestamp: string
}> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('habit', 'interact')
    if (typeof habitId !== 'string' || habitId.length > 200) throw new Error('Invalid habit ID')
    checkedCompletionTimestamp(timestamp)
    const habits = await loadData<HabitsData>('habits')
    const habit = habits.habits.find(item => item.id === habitId)
    if (!habit || !habit.userIds?.includes(user.id) && !user.isAdmin) throw new PermissionError('Habit interaction is not allowed')
    validateHabit(habit, habit.frequency)
    if (habit.archived) throw new PermissionError('Cannot complete an archived habit')
    if (habit.completions.length >= 20_000) throw new Error('Habit completion limit reached')

    const timezone = (await loadSettings()).system.timezone
    const day = completionDay(timestamp, timezone)
    const count = habit.completions.filter(value => completionDay(value, timezone) === day).length
    const target = habit.targetCompletions ?? 1
    if (count >= target) throw new PermissionError('Habit is already completed for this day')

    const accountIds = new Set((await readAuthData()).users.map(account => account.id))
    const recipients = [...new Set(habit.userIds ?? [user.id])].filter(id => accountIds.has(id))
    if (!recipients.length || recipients.length > 100) throw new Error('Invalid habit assignees')
    const targetReached = count + 1 === target
    const history = habit.completionRecords ?? habit.completions.map(() => null)
    const alreadyRewarded = habit.completions.some((value, index) =>
      completionDay(value, timezone) === day &&
      (history[index] === null || history[index]?.rewardedUserIds !== undefined))
    const rewarded = targetReached && !alreadyRewarded
    const record: HabitCompletionRecord = {
      id: uuid(), actorId: user.id,
      ...(rewarded && { rewardedUserIds: recipients }),
      ...(targetReached && { autoArchived: !!habit.isTask }),
    }
    const updatedHabit: Habit = {
      ...habit,
      completions: [...habit.completions, timestamp],
      completionRecords: [...(habit.completionRecords ?? habit.completions.map(() => null)), record],
      archived: habit.isTask && targetReached ? true : habit.archived,
    }
    const coins = await loadData<CoinsData>('coins')
    const transactionType: TransactionType = habit.isTask ? 'TASK_COMPLETION' : 'HABIT_COMPLETION'
    const transactions: CoinTransaction[] = rewarded && habit.coinReward > 0
      ? recipients.map(recipientId => ({
          id: uuid(), userId: recipientId, actorId: user.id, completionId: record.id,
          amount: habit.coinReward, type: transactionType, relatedItemId: habit.id,
          description: `Completed: ${habit.name}`, timestamp: d2t({ dateTime: getNow({}) }),
        })) : []
    const updatedCoins = transactions.length ? {
      balance: coins.balance + habit.coinReward * transactions.length,
      transactions: [...transactions, ...coins.transactions],
    } : coins
    if (!Number.isSafeInteger(updatedCoins.balance)) throw new Error('Invalid coin balance')
    await saveCompletionAndRewards(habits, {
      ...habits, habits: habits.habits.map(item => item.id === habit.id ? updatedHabit : item),
    }, coins, updatedCoins)
    return {
      habit: updatedHabit, coins: visibleCoinsData(updatedCoins, user), rewarded, targetReached,
      completionIndex: updatedHabit.completions.length - 1, completionTimestamp: timestamp,
    }
  })
}

export async function undoHabitCompletion(habitId: string, completionIndex: number, expectedTimestamp: string): Promise<{
  habit: Habit
  coins: CoinsData
  rewardReversed: boolean
}> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('habit', 'interact')
    if (typeof habitId !== 'string' || habitId.length > 200 || !Number.isSafeInteger(completionIndex) ||
        completionIndex < 0 || typeof expectedTimestamp !== 'string' || expectedTimestamp.length > 64) {
      throw new Error('Invalid completion')
    }
    const habits = await loadData<HabitsData>('habits')
    const habit = habits.habits.find(item => item.id === habitId)
    if (!habit || !habit.userIds?.includes(user.id) && !user.isAdmin) throw new PermissionError('Habit interaction is not allowed')
    validateHabit(habit, habit.frequency)
    if (habit.completions[completionIndex] !== expectedTimestamp) throw new PermissionError('Completion has changed')
    checkedCompletionTimestamp(expectedTimestamp)
    const record = habit.completionRecords?.[completionIndex] ?? null
    if (!user.isAdmin && (record ? record.actorId !== user.id : habit.userIds?.length !== 1 || habit.userIds[0] !== user.id)) {
      throw new PermissionError('Only the person who recorded a completion may undo it')
    }
    const timezone = (await loadSettings()).system.timezone
    const day = completionDay(expectedTimestamp, timezone)
    const latestForDay = habit.completions.findLastIndex(value => completionDay(value, timezone) === day)
    if (completionIndex !== latestForDay) throw new PermissionError('Undo the latest completion for this day first')
    const beforeCount = habit.completions.filter(value => completionDay(value, timezone) === day).length
    const target = habit.targetCompletions ?? 1
    const completionRecords = habit.completionRecords ?? habit.completions.map(() => null)
    const updatedHabit: Habit = {
      ...habit,
      completions: habit.completions.filter((_, index) => index !== completionIndex),
      completionRecords: completionRecords.filter((_, index) => index !== completionIndex),
      archived: habit.isTask && (record?.autoArchived || !record && beforeCount === target) ? false : habit.archived,
    }
    const coins = await loadData<CoinsData>('coins')
    const transactions: CoinTransaction[] = []
    if (record?.rewardedUserIds) {
      for (const recipientId of record.rewardedUserIds) {
        const award = coins.transactions.find(tx => tx.completionId === record.id && tx.userId === recipientId &&
          (tx.type === 'HABIT_COMPLETION' || tx.type === 'TASK_COMPLETION') && tx.amount > 0)
        const alreadyReversed = coins.transactions.some(tx => tx.completionId === record.id && tx.userId === recipientId &&
          (tx.type === 'HABIT_UNDO' || tx.type === 'TASK_UNDO'))
        if (!award || alreadyReversed) continue
        transactions.push({
          id: uuid(), userId: recipientId, actorId: user.id, completionId: record.id,
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
      for (const transaction of [...coins.transactions].reverse()) {
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
    if (!Number.isSafeInteger(updatedCoins.balance)) throw new Error('Invalid coin balance')
    await saveCompletionAndRewards(habits, {
      ...habits, habits: habits.habits.map(item => item.id === habit.id ? updatedHabit : item),
    }, coins, updatedCoins)
    return { habit: updatedHabit, coins: visibleCoinsData(updatedCoins, user), rewardReversed: transactions.length > 0 }
  })
}


// Coins specific functions
export async function loadCoinsData(): Promise<CoinsData> {
  try {
    const user = await getCurrentUser()
    if (!user || (!user.email && process.env.DEMO !== 'true')) return getDefaultCoinsData()
    const data = await loadData<CoinsData>('coins')
    return visibleCoinsData(data, user)
  } catch {
    return getDefaultCoinsData()
  }
}

function visibleCoinsData(data: CoinsData, user: User): CoinsData {
  if (user.isAdmin) return data
  const transactions = data.transactions.filter(transaction => transaction.userId === user.id)
  return { balance: transactions.reduce((total, transaction) => total + transaction.amount, 0), transactions }
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

export async function saveCoinsData(data: CoinsData): Promise<void> {
  return withDataWriteLock(async () => {
    const user = await verifyPermission('coins', 'write')
    const existingData = await loadData<CoinsData>('coins')
    const visible = existingData.transactions.filter(transaction => user.isAdmin || transaction.userId === user.id)
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
    return saveData('coins', { ...existingData, transactions })
  })
}

export async function addCoins({
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

export async function loadSettings(): Promise<Settings> {
  const defaultSettings = getDefaultSettings()

  try {
    const user = await getCurrentUser()
    if (!user || (!user.email && process.env.DEMO !== 'true')) return defaultSettings
    const data = await loadData<Settings>('settings')
    return { ...defaultSettings, ...data }
  } catch {
    return defaultSettings
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
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

export async function removeCoins({
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
      const balance = data.transactions
        .filter(transaction => transaction.userId === targetUserId)
        .reduce((sum, transaction) => sum + transaction.amount, 0)
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
      balance: Math.max(0, data.balance - amount),
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

export async function uploadAvatar(formData: FormData): Promise<string> {
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
    await fs.writeFile(path.join(avatarsDir, filename), Buffer.from(await file.arrayBuffer()), { flag: 'wx', mode: 0o600 })
    for (const old of priorFiles.slice(0, Math.max(0, priorFiles.length - 2))) {
      await fs.unlink(path.join(avatarsDir, old))
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

export async function loadUsersPublicData(): Promise<PublicUserData> {
  const viewer = await getCurrentUser()
  if (!viewer) return { users: [] }
  if (!viewer.email && process.env.DEMO !== 'true') return sanitizeUserData({ users: [viewer] }, viewer.id, !!viewer.isAdmin)
  const data = await loadUsersData()
  return sanitizeUserData(data, viewer.id, !!viewer.isAdmin)
}

export async function createUser(formData: FormData): Promise<PublicUser> {
  const administrator = await requireAdmin()
  if (process.env.DEMO === 'true') throw new PermissionError('Account changes are disabled in demo mode')
  const username = formData.get('username') as string;
  let password = formData.get('password') as string | undefined;
  const avatarPath = validateAvatarPath(formData.get('avatarPath'));
  const email = validateEmail(formData.get('email'))
  const authentikSubject = validateAuthentikSubject(formData.get('authentikSubject'))
  const oidcIssuer = authentikSubject ? (await getActiveOidcConfig())?.issuer : undefined
  if (authentikSubject && !oidcIssuer) throw new Error('Configure OIDC before linking an account')
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
  if (!hashedPassword && !authentikSubject && process.env.DEMO !== 'true') {
    throw new Error('A password or OIDC subject is required')
  }

  const newUser = await updateAuthData(data => {
    if (!data.users.find(user => user.id === administrator.id)?.isAdmin) throw new PermissionError('Administrator access required')
    if (data.users.some(user => user.username === username)) throw new Error('Username already exists')
    if (email && data.users.some(user => user.email?.toLowerCase() === email)) throw new Error('Email already exists')
    if (authentikSubject && data.users.some(user => user.authentikSubject === authentikSubject)) {
      throw new Error('OIDC identity is already linked')
    }
    const user: User = {
      id: uuid(), username, password: hashedPassword, permissions, isAdmin,
      ...(email && { email }),
      authVersion: 0,
      ...(authentikSubject && { authentikSubject, oidcIssuer }),
      ...(avatarPath && { avatarPath }),
    }
    data.users.push(user)
    return user
  })
  return sanitizeUserData({ users: [newUser] }, administrator.id, true).users[0]
}

export async function updateUser(userId: string, updates: Partial<Omit<User, 'id' | 'password' | 'authVersion' | 'authentikSubject' | 'oidcIssuer'>> & { authentikSubject?: string | null }): Promise<PublicUser> {
  const currentUser = await getCurrentUser()
  if (!currentUser) throw new PermissionError('User not authenticated')
  if (process.env.DEMO === 'true') throw new PermissionError('Account changes are disabled in demo mode')
  if (!currentUser.email && process.env.DEMO !== 'true' &&
      (currentUser.id !== userId || Object.keys(updates).some(key => key !== 'email'))) {
    throw new PermissionError('Email is required before using this account')
  }
  const oidcIssuer = updates.authentikSubject ? (await getActiveOidcConfig())?.issuer : undefined
  if (updates.authentikSubject && !oidcIssuer) throw new Error('Configure OIDC before linking an account')
  return updateAuthData(data => {
    const actor = data.users.find(user => user.id === currentUser.id)
    if (!actor) throw new PermissionError('User not authenticated')
    const userIndex = data.users.findIndex(user => user.id === userId)

  if (userIndex === -1) {
    throw new Error('User not found')
  }

  if (!actor.isAdmin && actor.id !== userId) {
    throw new PermissionError('Cannot edit another user')
  }

  const allowedKeys = ['username', 'email', 'avatarPath', 'permissions', 'isAdmin', 'authentikSubject']
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
      updates.authentikSubject !== undefined)) {
    throw new PermissionError('Cannot change account permissions')
  }

  const validatedUpdates = {
    ...(updates.username !== undefined && { username: usernameSchema.parse(updates.username) }),
    ...(updates.email !== undefined && { email: validateEmail(updates.email) }),
    ...(updates.avatarPath !== undefined && { avatarPath: validateAvatarPath(updates.avatarPath) }),
    ...(actor.isAdmin && updates.isAdmin !== undefined && { isAdmin: z.boolean().parse(updates.isAdmin) }),
    ...(actor.isAdmin && updates.permissions !== undefined && { permissions: permissionSchema.parse(updates.permissions) }),
    ...(actor.isAdmin && updates.authentikSubject !== undefined && { authentikSubject: validateAuthentikSubject(updates.authentikSubject) }),
    ...(actor.isAdmin && updates.authentikSubject !== undefined && { oidcIssuer }),
  }

  const subject = 'authentikSubject' in validatedUpdates ? validatedUpdates.authentikSubject : existingUser.authentikSubject
  if (subject && data.users.some(user => user.id !== userId && user.authentikSubject === subject)) {
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
    authVersion: (existingUser.authVersion ?? 0) + (updates.email !== undefined || updates.isAdmin !== undefined || updates.permissions !== undefined || updates.authentikSubject !== undefined ? 1 : 0),
  }
  data.users[userIndex] = updatedUser
  return sanitizeUserData({ users: [updatedUser] }, actor.id, !!actor.isAdmin).users[0]
  })
}

export async function updateUserPassword(userId: string, newPassword?: string, currentPassword?: string): Promise<void> {
  if (process.env.DEMO === 'true') throw new PermissionError('Password changes are disabled in demo mode')
  const currentUser = await requireUser()
  if (!currentUser.isAdmin && currentUser.id !== userId) {
    throw new PermissionError('Cannot change another user\'s password')
  }
  if (newPassword !== undefined) newPasswordSchema.parse(newPassword)
  await updateAuthData(async data => {
    const actor = data.users.find(user => user.id === currentUser.id)
    const userIndex = data.users.findIndex(user => user.id === userId)
    if (!actor || (!actor.isAdmin && actor.id !== userId)) throw new PermissionError('Cannot change another user\'s password')
    if (userIndex === -1) throw new Error('User not found')
    const target = data.users[userIndex]
    if (actor.id === target.id && !target.password) {
      throw new PermissionError('An administrator must set the initial local password')
    }
    if (actor.id === target.id && target.password) {
      if (typeof currentPassword !== 'string' || currentPassword.length > 128 ||
          !(await verifyStepUpPassword(target, currentPassword))) {
        throw new PermissionError('Current password is incorrect')
      }
    }
    if (target.isAdmin && newPassword === undefined && process.env.DEMO !== 'true') {
      throw new Error('Administrator accounts require a password')
    }
    if (!target.authentikSubject && newPassword === undefined && process.env.DEMO !== 'true') {
      throw new Error('A password or OIDC subject is required')
    }
    data.users[userIndex] = {
      ...target,
      password: newPassword ? saltAndHashPassword(newPassword) : undefined,
      authVersion: (target.authVersion ?? 0) + 1,
    }
  })
}

export async function deleteUser(userId: string): Promise<void> {
  if (process.env.DEMO === 'true') throw new PermissionError('Account deletion is disabled in demo mode')
  return withDataWriteLock(async () => {
    const currentUser = await requireUser()
    await updateAuthData(async authData => {
    const actor = authData.users.find(user => user.id === currentUser.id)
    if (!actor || (!actor.isAdmin && actor.id !== userId)) throw new PermissionError('Cannot delete another user')
    const targetUser = authData.users.find(user => user.id === userId)
    if (!targetUser) throw new Error('User not found')
    if (targetUser.isAdmin && authData.users.filter(user => user.isAdmin).length === 1) {
      throw new Error('Cannot delete the last administrator')
    }
    const avatarsDir = path.join(process.cwd(), 'data', 'avatars')
    const avatarFiles = await fs.readdir(avatarsDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const filename of avatarFiles.filter(name => isGeneratedAvatarForUser(name, userId))) {
      await fs.unlink(path.join(avatarsDir, filename))
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
      if (habit.userIds?.includes(userId)) {
        if (habit.userIds.length === 1) {
          // Remove habit if this is the only user
          return acc
        } else {
          // Remove userId from habit's userIds
          acc.push({
            ...habit,
            userIds: habit.userIds.filter(id => id !== userId)
          })
        }
      } else {
        // Keep habit as is
        acc.push(habit)
      }
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
  })
}

export async function updateLastNotificationReadTimestamp(userId: string, timestamp: string): Promise<void> {
  const currentUser = await requireUser()
  if (currentUser.id !== userId) throw new PermissionError('Cannot update another user')
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp')
  await updateAuthData(data => {
    const userIndex = data.users.findIndex(user => user.id === userId)
    if (userIndex === -1) throw new Error('User not found for updating notification timestamp')
    data.users[userIndex] = { ...data.users[userIndex], lastNotificationReadTimestamp: timestamp }
  })
}


export async function loadServerSettings(): Promise<ServerSettings> {
  return {
    isDemo: process.env.DEMO === 'true',
    authentikEnabled: !!(await getActiveOidcConfig()),
  }
}

/**
 * Checks if the client's data is fresh by comparing its token with the server's token.
 * @param clientToken The freshness token calculated by the client.
 * @returns A promise that resolves to an object { isFresh: boolean }.
 */
export async function checkDataFreshness(clientToken: string): Promise<{ isFresh: boolean }> {
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
