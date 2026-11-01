import { auth } from '@/auth'
import 'server-only'
import { User, UserId } from './types'
import { readAuthData } from './auth-store'
export { saltAndHashPassword, verifyPassword } from './password'

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
  const usersData = await readAuthData()
  return usersData.users.find((u) => u.id === currentUserId)
}
