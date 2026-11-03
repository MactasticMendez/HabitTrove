import { PublicUserData, UserData } from './types'

export function sanitizeUserData(data: UserData, viewerId?: string, isAdmin = false): PublicUserData {
  return {
    users: data.users.map(({ password, authentikSubject, oidcIssuer, authVersion, email, personalFolders, statusDays, managedUserIds, ...user }) => ({
      ...user,
      ...((isAdmin || user.id === viewerId) && email ? { email } : {}),
      ...(user.id === viewerId && { personalFolders, statusDays }),
      ...((isAdmin || user.id === viewerId) && { managedUserIds }),
      hasPassword: !!password,
      hasAuthentik: !!authentikSubject,
    })),
  }
}
