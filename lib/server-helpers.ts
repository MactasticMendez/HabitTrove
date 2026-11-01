import { auth } from '@/auth'
import 'server-only'
import { User, UserData, UserId } from './types'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import fs from 'fs/promises'
import path from 'path'

async function loadUsersDataFromStore(): Promise<UserData> {
  try {
    const filePath = path.join(process.cwd(), 'data', 'auth.json')
    const data = await fs.readFile(filePath, 'utf8')
    return JSON.parse(data) as UserData
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { users: [] }
    throw error
  }
}

export async function getCurrentUserId(): Promise<UserId | undefined> {
  const session = await auth()
  const user = session?.user
  return user?.id
}

export async function getCurrentUser(): Promise<User | undefined> {
  const currentUserId = await getCurrentUserId()
  if (!currentUserId) {
    return undefined
  }
  const usersData = await loadUsersDataFromStore()
  return usersData.users.find((u) => u.id === currentUserId)
}
export function saltAndHashPassword(password: string, salt?: string): string {
  if (password.length === 0) throw new Error('Password must not be empty')
  salt = salt || randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password?: string, storedHash?: string): boolean {
  if (!password && !storedHash) return true
  if (!password || !storedHash) return false

  const match = /^([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(storedHash)
  if (!match) return false
  const actual = scryptSync(password, match[1], 64)
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex'))
}
