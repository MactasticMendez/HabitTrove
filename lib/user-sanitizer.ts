import { PublicUserData, UserData } from './types'

export function sanitizeUserData(data: UserData, viewerId?: string, isAdmin = false): PublicUserData {
  return {
    users: data.users.map(({ password, authentikSubject, oidcIssuer, authVersion, email, ...user }) => ({
      ...user,
      ...((isAdmin || user.id === viewerId) && email ? { email } : {}),
      hasPassword: !!password,
      hasAuthentik: !!authentikSubject,
    })),
  }
}
