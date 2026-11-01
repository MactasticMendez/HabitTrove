'use server'

import fs from 'fs/promises'
import path from 'path'
import {
  HabitsData,
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
  getDefaultUsersData,
  User,
  PublicUser,
  PublicUserData,
  getDefaultWishlistData,
  getDefaultHabitsData,
  getDefaultCoinsData,
  Permission,
  ServerSettings,
  SessionUser
} from '@/lib/types'
import { checkPermission, d2t, getNow, uuid } from '@/lib/utils';
import { verifyPassword } from "@/lib/server-helpers";
import { saltAndHashPassword } from "@/lib/server-helpers";
import { newPasswordSchema, signInSchema, usernameSchema } from '@/lib/zod';
import _ from 'lodash';
import { getCurrentUser } from '@/lib/server-helpers'
import { prepareDataForHashing, generateCryptoHash } from '@/lib/utils';
import { sanitizeUserData } from '@/lib/user-sanitizer'
import { ALLOWED_AVATAR_EXTENSIONS, ALLOWED_AVATAR_MIME_TYPES } from '@/lib/avatar'
import { PermissionError } from '@/lib/exceptions'
import { z } from 'zod'
import { MAX_COIN_LIMIT } from '@/lib/constants'
import { DateTime } from 'luxon'



type ResourceType = 'habit' | 'wishlist' | 'coins'
type ActionType = 'write' | 'interact'

const permissionSchema = z.array(z.object({
  habit: z.object({ write: z.boolean(), interact: z.boolean() }),
  wishlist: z.object({ write: z.boolean(), interact: z.boolean() }),
  coins: z.object({ write: z.boolean(), interact: z.boolean() }),
})).max(1)

function validateAvatarPath(avatarPath: unknown): string | undefined {
  if (avatarPath == null || avatarPath === '') return undefined
  if (typeof avatarPath !== 'string' || !/^\/data\/avatars\/[a-zA-Z0-9-]+\.(png|jpe?g|gif|webp|avif)$/.test(avatarPath)) {
    throw new Error('Invalid avatar path')
  }
  return avatarPath
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
  await fs.mkdir(dataDir, { recursive: true })
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

  console.log('Manual backup trigger requested...')
  try {
    // Import runBackup locally to avoid potential circular dependencies if moved
    const { runBackup } = await import('@/lib/backup')
    await runBackup()
    console.log('Manual backup trigger completed successfully.')
    return { success: true, message: 'Backup process completed successfully.' }
  } catch (error) {
    console.error('Manual backup trigger failed:', error)
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

  let initialData = getDefaultData<T>(type)
  if (type === 'auth' && !process.env.DEMO) {
    const initialPassword = process.env.INITIAL_ADMIN_PASSWORD
    if (!initialPassword || initialPassword.length < 12 || initialPassword.length > 32) {
      throw new Error('INITIAL_ADMIN_PASSWORD must be 12-32 characters for a new installation')
    }
    initialData = {
      users: getDefaultUsersData().users.map(user => ({
        ...user,
        password: saltAndHashPassword(initialPassword),
      })),
    } as T
  }
  try {
    await fs.writeFile(filePath, JSON.stringify(initialData, null, 2), { flag: 'wx' })
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
  await fs.writeFile(filePath, JSON.stringify(data, null, 2))
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
    console.error("Error calculating server freshness token:", error);
    throw error;
  }
}

// Wishlist specific functions
export async function loadWishlistData(): Promise<WishlistData> {
  const user = await getCurrentUser()
  if (!user) return getDefaultWishlistData()

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
  const user = await requireUser()
  const canWrite = user.isAdmin || checkPermission(user.permissions, 'wishlist', 'write')
  if (!canWrite) await verifyPermission('wishlist', 'interact')
  const existingData = await loadData<WishlistData>('wishlist')
  const items = mergeOwnedItems(data.items, existingData.items, user, canWrite, ['targetCompletions', 'archived'])
  return saveData('wishlist', { items })
}

// Habits specific functions
export async function loadHabitsData(): Promise<HabitsData> {
  const user = await getCurrentUser()
  if (!user) return getDefaultHabitsData()
  const data = await loadData<HabitsData>('habits')
  return {
    ...data,
    habits: data.habits.filter(x => user.isAdmin || x.userIds?.includes(user.id))
  }
}

export async function saveHabitsData(data: HabitsData): Promise<void> {
  const user = await requireUser()
  const canWrite = user.isAdmin || checkPermission(user.permissions, 'habit', 'write')
  if (!canWrite) await verifyPermission('habit', 'interact')
  const existingData = await loadData<HabitsData>('habits')
  const habits = mergeOwnedItems(data.habits, existingData.habits, user, canWrite, ['completions', 'archived'])
  return saveData('habits', { habits })
}


// Coins specific functions
export async function loadCoinsData(): Promise<CoinsData> {
  try {
    const user = await getCurrentUser()
    if (!user) return getDefaultCoinsData()
    const data = await loadData<CoinsData>('coins')
    return {
      ...data,
      transactions: user.isAdmin ? data.transactions : data.transactions.filter(x => x.userId === user.id)
    }
  } catch {
    return getDefaultCoinsData()
  }
}

export async function saveCoinsData(data: CoinsData): Promise<void> {
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
    return submitted.note !== undefined && typeof submitted.note !== 'string'
  })) {
    throw new PermissionError('Only transaction notes may be changed')
  }
  const transactions = existingData.transactions.map(transaction => {
    const submitted = submittedById.get(transaction.id)
    return submitted ? { ...transaction, note: submitted.note } : transaction
  })
  return saveData('coins', { ...existingData, transactions })
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
  const currentUser = await verifyPermission('coins', type === 'MANUAL_ADJUSTMENT' ? 'write' : 'interact')
  if (!['MANUAL_ADJUSTMENT', 'HABIT_COMPLETION', 'TASK_COMPLETION'].includes(type)) throw new Error('Invalid credit type')
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_COIN_LIMIT) throw new Error('Invalid coin amount')
  if (!currentUser.isAdmin && userId && userId !== currentUser.id) throw new PermissionError('Cannot change another user\'s coins')
  const targetUserId = userId || currentUser.id
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
  return currentUser.isAdmin ? newData : {
    ...newData,
    transactions: newData.transactions.filter(transaction => transaction.userId === currentUser.id)
  }
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
    if (!item || item.coinCost !== amount) throw new PermissionError('Invalid reward transaction')
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
    if (!user) return defaultSettings
    const data = await loadData<Settings>('settings')
    return { ...defaultSettings, ...data }
  } catch {
    return defaultSettings
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const user = await requireUser()
  if (!user.isAdmin) {
    const existing = await loadSettings()
    if (!_.isEqual(settings.system, existing.system) || !_.isEqual(settings.profile, existing.profile)) {
      throw new PermissionError('Only administrators can change system settings')
    }
  }
  return saveData('settings', settings)
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
  const currentUser = await verifyPermission('coins', type === 'MANUAL_ADJUSTMENT' ? 'write' : 'interact')
  if (!['MANUAL_ADJUSTMENT', 'HABIT_UNDO', 'TASK_UNDO', 'WISH_REDEMPTION'].includes(type)) throw new Error('Invalid debit type')
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_COIN_LIMIT) throw new Error('Invalid coin amount')
  if (!currentUser.isAdmin && userId && userId !== currentUser.id) throw new PermissionError('Cannot change another user\'s coins')
  const targetUserId = userId || currentUser.id
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
  return currentUser.isAdmin ? newData : {
    ...newData,
    transactions: newData.transactions.filter(transaction => transaction.userId === currentUser.id)
  }
}

export async function uploadAvatar(formData: FormData): Promise<string> {
  await requireUser()
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
  const avatarsDir = path.join(process.cwd(), 'data', 'avatars')
  await fs.mkdir(avatarsDir, { recursive: true })

  // Generate unique filename
  const filename = `${Date.now()}-${uuid()}${ext}`
  const filePath = path.join(avatarsDir, filename)

  // Save file
  const buffer = await file.arrayBuffer()
  await fs.writeFile(filePath, Buffer.from(buffer))

  return `/data/avatars/${filename}`
}

export async function getChangelog(): Promise<string> {
  try {
    const changelogPath = path.join(process.cwd(), 'CHANGELOG.md')
    return await fs.readFile(changelogPath, 'utf8')
  } catch (error) {
    console.error('Error loading changelog:', error)
    return '# Changelog\n\nNo changelog available.'
  }
}

// user logic
async function loadUsersData(): Promise<UserData> {
  return loadData<UserData>('auth')
}

export async function loadUsersPublicData(): Promise<PublicUserData> {
  const data = await loadUsersData()
  return sanitizeUserData(data)
}

async function saveUsersData(data: UserData): Promise<void> {
  return saveData('auth', data)
}

export async function getUser(username: string, plainTextPassword?: string): Promise<SessionUser | null> {
  const data = await loadUsersData()

  const user = data.users.find(user => user.username === username)
  if (!user) return null

  // Verify the plaintext password against the stored salt:hash
  const isValidPassword = verifyPassword(plainTextPassword, user.password)
  if (!isValidPassword) return null

  return { id: user.id }
}

export async function createUser(formData: FormData): Promise<PublicUser> {
  await requireAdmin()
  const username = formData.get('username') as string;
  let password = formData.get('password') as string | undefined;
  const avatarPath = validateAvatarPath(formData.get('avatarPath'));
  const isAdmin = formData.get('isAdmin') === 'true';
  const rawPermissions = formData.get('permissions')
  const permissions = !isAdmin && rawPermissions && rawPermissions !== 'undefined'
    ? permissionSchema.parse(JSON.parse(rawPermissions as string)) as Permission[]
    : undefined;

  if (password === null) password = undefined
  // Validate username and password against schema
  await signInSchema.parseAsync({ username, password });
  if (password) newPasswordSchema.parse(password)

  const data = await loadUsersData();

  // Check if username already exists
  if (data.users.some(user => user.username === username)) {
    throw new Error('Username already exists');
  }

  const hashedPassword = password ? saltAndHashPassword(password) : undefined;
  if (isAdmin && !hashedPassword && !process.env.DEMO) {
    throw new Error('Administrator accounts require a password')
  }


  const newUser: User = {
    id: uuid(),
    username,
    password: hashedPassword,
    permissions,
    isAdmin,
    lastNotificationReadTimestamp: undefined,
    ...(avatarPath && { avatarPath })
  };

  const newData: UserData = {
    users: [...data.users, newUser]
  };

  await saveUsersData(newData);
  return sanitizeUserData({ users: [newUser] }).users[0]
}

export async function updateUser(userId: string, updates: Partial<Omit<User, 'id' | 'password'>>): Promise<PublicUser> {
  const currentUser = await requireUser()
  const data = await loadUsersData()
  const userIndex = data.users.findIndex(user => user.id === userId)

  if (userIndex === -1) {
    throw new Error('User not found')
  }

  if (!currentUser.isAdmin && currentUser.id !== userId) {
    throw new PermissionError('Cannot edit another user')
  }

  const allowedKeys = ['username', 'avatarPath', 'permissions', 'isAdmin']
  if (Object.keys(updates).some(key => !allowedKeys.includes(key))) {
    throw new Error('Invalid user update')
  }

  const existingUser = data.users[userIndex]
  if (currentUser.isAdmin && updates.isAdmin === false && existingUser.isAdmin &&
    data.users.filter(user => user.isAdmin).length === 1) {
    throw new Error('Cannot remove the last administrator')
  }
  if (currentUser.isAdmin && updates.isAdmin === true && !existingUser.password && !process.env.DEMO) {
    throw new Error('Administrator accounts require a password')
  }
  if (!currentUser.isAdmin &&
    (updates.isAdmin !== undefined && updates.isAdmin !== existingUser.isAdmin ||
      updates.permissions !== undefined && !_.isEqual(updates.permissions, existingUser.permissions))) {
    throw new PermissionError('Cannot change account permissions')
  }

  const validatedUpdates = {
    ...(updates.username !== undefined && { username: usernameSchema.parse(updates.username) }),
    ...(updates.avatarPath !== undefined && { avatarPath: validateAvatarPath(updates.avatarPath) }),
    ...(currentUser.isAdmin && updates.isAdmin !== undefined && { isAdmin: z.boolean().parse(updates.isAdmin) }),
    ...(currentUser.isAdmin && updates.permissions !== undefined && { permissions: permissionSchema.parse(updates.permissions) }),
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

  const updatedUser = {
    ...data.users[userIndex],
    ...validatedUpdates
  }

  const newData: UserData = {
    users: [
      ...data.users.slice(0, userIndex),
      updatedUser,
      ...data.users.slice(userIndex + 1)
    ]
  }

  await saveUsersData(newData)
  return sanitizeUserData({ users: [updatedUser] }).users[0]
}

export async function updateUserPassword(userId: string, newPassword?: string): Promise<void> {
  const currentUser = await requireUser()
  if (!currentUser.isAdmin && currentUser.id !== userId) {
    throw new PermissionError('Cannot change another user\'s password')
  }
  if (newPassword) newPasswordSchema.parse(newPassword)
  const data = await loadUsersData()
  const userIndex = data.users.findIndex(user => user.id === userId)

  if (userIndex === -1) {
    throw new Error('User not found')
  }

  if (data.users[userIndex].isAdmin && !newPassword && !process.env.DEMO) {
    throw new Error('Administrator accounts require a password')
  }

  const hashedPassword = newPassword ? saltAndHashPassword(newPassword) : ''

  const updatedUser = {
    ...data.users[userIndex],
    password: hashedPassword
  }

  const newData: UserData = {
    users: [
      ...data.users.slice(0, userIndex),
      updatedUser,
      ...data.users.slice(userIndex + 1)
    ]
  }

  await saveUsersData(newData)
}

export async function deleteUser(userId: string): Promise<void> {
  const currentUser = await requireUser()
  if (!currentUser.isAdmin && currentUser.id !== userId) {
    throw new PermissionError('Cannot delete another user')
  }
  const authData = await loadUsersData()
  const targetUser = authData.users.find(user => user.id === userId)
  if (!targetUser) throw new Error('User not found')
  if (targetUser.isAdmin && authData.users.filter(user => user.isAdmin).length === 1) {
    throw new Error('Cannot delete the last administrator')
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

  await saveUsersData(authData)
}

export async function updateLastNotificationReadTimestamp(userId: string, timestamp: string): Promise<void> {
  const currentUser = await requireUser()
  if (currentUser.id !== userId) throw new PermissionError('Cannot update another user')
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp')
  const data = await loadUsersData()
  const userIndex = data.users.findIndex(user => user.id === userId)

  if (userIndex === -1) {
    throw new Error('User not found for updating notification timestamp')
  }

  const updatedUser = {
    ...data.users[userIndex],
    lastNotificationReadTimestamp: timestamp
  }

  const newData: UserData = {
    users: [
      ...data.users.slice(0, userIndex),
      updatedUser,
      ...data.users.slice(userIndex + 1)
    ]
  }

  await saveUsersData(newData)
}


export async function loadServerSettings(): Promise<ServerSettings> {
  return {
    isDemo: !!process.env.DEMO,
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
    console.error("Error in checkDataFreshness:", error);
    // If server fails to determine its token, assume client might be stale to be safe,
    // or handle error reporting differently.
    return { isFresh: false };
  }
}
