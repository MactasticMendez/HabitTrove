import { auth } from '@/auth'
import 'server-only'
import { User, UserId } from './types'
import { readAuthData } from './auth-store'
export { saltAndHashPassword, verifyPassword } from './password'

export async function getCurrentUserId(): Promise<UserId | undefined> {
  return (await getCurrentUser())?.id
}

export async function getCurrentUser(): Promise<User | undefined> {
  const session = await auth()
  const identity = session?.user
  if (!identity?.id || !Number.isSafeInteger(identity.authVersion) || (identity.authVersion ?? -1) < 0) {
    return undefined
  }
  const usersData = await readAuthData()
  const user = usersData.users.find((u) => u.id === identity.id)
  if (!user || (user.authVersion ?? 0) !== identity.authVersion) return undefined
  return { ...user, authVersion: identity.authVersion }
}
